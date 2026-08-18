export const REGIONAL_MODES = ["load", "wind", "solar"] as const;
export type RegionalMode = (typeof REGIONAL_MODES)[number];
export type RegionalPoint = {
  region: string;
  current_target_ts?: number | null;
  current_mw: number | null;
  share_percent: number | null;
  change_1h_mw: number | null;
  forecast_mw?: number | null;
  forecast_error_mw?: number | null;
  forecast_horizon_seconds?: 3600;
  forecast_error_available?: false;
  forecast_error_unavailable_reason?: string;
  next_24h_forecast_peak?: { target_ts: number; forecast_mw: number } | null;
};
export type RegionalManifest = {
  title: "ERCOT region schematic — not geographic boundaries";
  taxonomies: Record<RegionalMode, string[]>;
  deferred_products: ["NP4-743-CD", "NP4-746-CD"];
  current: Record<
    RegionalMode,
    {
      availability: string;
      unavailable_reason?: "no_data" | "source_parity";
      regions: RegionalPoint[];
      source?: Record<string, string | number | null>;
    }
  >;
  source_health: Array<{
    source_id: string;
    state: "healthy" | "stale" | "failed";
    data_age_seconds: number | null;
    last_success_ts: number | null;
  }>;
  materialization_health: {
    pipeline: "load";
    state: "unknown" | "healthy" | "failed";
    last_attempt_ts: number | null;
    last_success_ts: number | null;
    consecutive_failures: number;
    last_error: string | null;
  };
  resources: RegionalResourceLink[];
};
export type RegionalResourceLink = {
  series_key: string;
  tile_start: number;
  content_version: string;
  lod: "native";
  url: string;
};
export type RegionalResource = {
  series_key: string;
  region: string;
  kind: RegionalMode;
  rows: Array<{
    target_ts: number;
    current_mw: number | null;
    share_percent: number | null;
    change_1h_mw: number | null;
    forecast_mw: number | null;
    forecast_error_mw?: number | null;
  }>;
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_regional_manifest");
  return value as Record<string, unknown>;
}
function finite(value: unknown, nullable = true): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("invalid_regional_manifest");
  return value;
}
const TAXONOMIES = {
  load: [
    "coast",
    "east",
    "far-west",
    "north",
    "north-central",
    "south-central",
    "southern",
    "west",
  ],
  wind: ["panhandle", "coastal", "south", "west", "north"],
  solar: ["center-west", "north-west", "far-west", "far-east", "south-east", "center-east"],
} as const;

export function parseRegionalManifest(value: unknown): RegionalManifest {
  const input = object(value);
  if (
    input["schema_version"] !== 1 ||
    input["kind"] !== "regional_geography_manifest" ||
    input["methodology"] !== "v1" ||
    input["title"] !== "ERCOT region schematic — not geographic boundaries"
  )
    throw new Error("invalid_regional_manifest");
  const taxonomies = object(input["taxonomies"]);
  const current = object(input["current"]);
  const parsedCurrent = {} as RegionalManifest["current"];
  for (const mode of REGIONAL_MODES) {
    if (JSON.stringify(taxonomies[mode]) !== JSON.stringify(TAXONOMIES[mode]))
      throw new Error("invalid_regional_taxonomy");
    const snapshot = object(current[mode]);
    if (
      !["unavailable", "forecast_only", "available", "partial"].includes(
        String(snapshot["availability"]),
      ) ||
      !Array.isArray(snapshot["regions"])
    )
      throw new Error("invalid_regional_snapshot");
    const regions = snapshot["regions"].map((entry) => {
      const row = object(entry);
      if (typeof row["region"] !== "string" || !TAXONOMIES[mode].includes(row["region"] as never))
        throw new Error("invalid_regional_region");
      const parsed: RegionalPoint = {
        region: row["region"],
        ...(row["current_target_ts"] === undefined
          ? {}
          : { current_target_ts: finite(row["current_target_ts"]) }),
        current_mw: finite(row["current_mw"]),
        share_percent: finite(row["share_percent"]),
        change_1h_mw: finite(row["change_1h_mw"]),
      };
      if (mode === "load") {
        parsed.forecast_mw = finite(row["forecast_mw"]);
        parsed.forecast_error_mw = finite(row["forecast_error_mw"]);
        if (row["forecast_horizon_seconds"] !== 3600)
          throw new Error("invalid_regional_load_horizon");
        parsed.forecast_horizon_seconds = 3600;
        if (
          parsed.current_mw !== null &&
          parsed.forecast_mw !== null &&
          parsed.forecast_error_mw !== parsed.current_mw - parsed.forecast_mw
        )
          throw new Error("invalid_regional_load_error");
      } else {
        if (
          row["forecast_error_available"] !== false ||
          row["forecast_error_unavailable_reason"] !==
            "generation_is_curtailment_affected_forecast_targets_hsl"
        )
          throw new Error("invalid_regional_forecast_error_contract");
        parsed.forecast_error_available = false;
        parsed.forecast_error_unavailable_reason = row["forecast_error_unavailable_reason"];
        const peak = row["next_24h_forecast_peak"];
        if (peak !== null) {
          const peakRow = object(peak);
          parsed.next_24h_forecast_peak = {
            target_ts: finite(peakRow["target_ts"], false)!,
            forecast_mw: finite(peakRow["forecast_mw"], false)!,
          };
          if (!Number.isSafeInteger(parsed.next_24h_forecast_peak.target_ts))
            throw new Error("invalid_regional_peak_target");
        } else parsed.next_24h_forecast_peak = null;
      }
      return parsed;
    });
    if (
      (snapshot["availability"] === "unavailable" && regions.length !== 0) ||
      (snapshot["availability"] !== "unavailable" &&
        (regions.length !== TAXONOMIES[mode].length ||
          new Set(regions.map((row) => row.region)).size !== TAXONOMIES[mode].length))
    )
      throw new Error("invalid_regional_region_membership");
    let source: Record<string, string | number | null> | undefined;
    if (snapshot["source"] !== undefined) {
      const rawSource = object(snapshot["source"]);
      source = {};
      for (const [key, value] of Object.entries(rawSource)) {
        if (value !== null && typeof value !== "string" && !Number.isSafeInteger(value))
          throw new Error("invalid_regional_source");
        source[key] = value as string | number | null;
      }
      if (mode !== "load") {
        if (
          typeof source["vintage_key"] !== "string" ||
          !/^rgv1-[0-9a-f]{64}$/.test(source["vintage_key"]) ||
          !Number.isSafeInteger(source["issued_at"]) ||
          !Number.isSafeInteger(source["retrieved_at"]) ||
          Number(source["retrieved_at"]) < Number(source["issued_at"])
        )
          throw new Error("invalid_regional_source");
      }
    }
    const unavailableReason = snapshot["unavailable_reason"];
    if (
      unavailableReason !== undefined &&
      unavailableReason !== "no_data" &&
      unavailableReason !== "source_parity"
    )
      throw new Error("invalid_regional_unavailable_reason");
    parsedCurrent[mode] = {
      availability: String(snapshot["availability"]),
      regions,
      ...(unavailableReason === undefined
        ? {}
        : { unavailable_reason: unavailableReason as "no_data" | "source_parity" }),
      ...(source === undefined ? {} : { source }),
    };
  }
  if (JSON.stringify(input["deferred_products"]) !== JSON.stringify(["NP4-743-CD", "NP4-746-CD"]))
    throw new Error("invalid_regional_deferred_products");
  if (!Array.isArray(input["source_health"])) throw new Error("invalid_regional_health");
  const allowedHealth = new Set([
    "ercot_public_np3_565_weather_zone_forecast",
    "ercot_public_np6_345_weather_zone_actual_load",
    "ercot_mis_np4_742",
    "ercot_mis_np4_745",
  ]);
  const seenHealth = new Set<string>();
  const sourceHealth = input["source_health"].map((entry) => {
    const health = object(entry);
    if (
      typeof health["source_id"] !== "string" ||
      !["healthy", "stale", "failed"].includes(String(health["state"]))
    )
      throw new Error("invalid_regional_health");
    if (!allowedHealth.has(health["source_id"]) || seenHealth.has(health["source_id"]))
      throw new Error("invalid_regional_health");
    seenHealth.add(health["source_id"]);
    const dataAge = health["data_age_seconds"] ?? null;
    const lastSuccess = health["last_success_ts"] ?? null;
    if (
      (dataAge !== null && (!Number.isSafeInteger(dataAge) || Number(dataAge) < 0)) ||
      (lastSuccess !== null && !Number.isSafeInteger(lastSuccess))
    )
      throw new Error("invalid_regional_health");
    return {
      source_id: health["source_id"],
      state: health["state"] as "healthy" | "stale" | "failed",
      data_age_seconds: dataAge as number | null,
      last_success_ts: lastSuccess as number | null,
    };
  });
  const health = object(input["materialization_health"]);
  if (
    health["pipeline"] !== "load" ||
    !["unknown", "healthy", "failed"].includes(String(health["state"])) ||
    !Number.isSafeInteger(health["consecutive_failures"]) ||
    Number(health["consecutive_failures"]) < 0 ||
    (health["last_attempt_ts"] !== null && !Number.isSafeInteger(health["last_attempt_ts"])) ||
    (health["last_success_ts"] !== null && !Number.isSafeInteger(health["last_success_ts"])) ||
    ![null, "load_materialization_failed"].includes(health["last_error"] as never)
  )
    throw new Error("invalid_regional_materialization_health");
  const materializationHealth: RegionalManifest["materialization_health"] = {
    pipeline: "load",
    state: health["state"] as "unknown" | "healthy" | "failed",
    last_attempt_ts: health["last_attempt_ts"] as number | null,
    last_success_ts: health["last_success_ts"] as number | null,
    consecutive_failures: health["consecutive_failures"] as number,
    last_error: health["last_error"] as string | null,
  };
  if (!Array.isArray(input["resources"])) throw new Error("invalid_regional_resources");
  const resources = input["resources"].map((entry) => {
    const link = object(entry);
    if (typeof link["series_key"] !== "string") throw new Error("invalid_regional_resource_link");
    const renewableMatch = /^regional\.(wind|solar)\.([a-z-]+)\.hourly$/.exec(link["series_key"]);
    const loadMatch = /^regional\.load\.weather-zone\.([a-z-]+)\.(actual|forecast)$/.exec(
      link["series_key"],
    );
    const validSemantic = renewableMatch
      ? TAXONOMIES[renewableMatch[1] as "wind" | "solar"].includes(renewableMatch[2] as never)
      : loadMatch
        ? TAXONOMIES.load.includes(loadMatch[1] as never)
        : false;
    if (
      !validSemantic ||
      !Number.isSafeInteger(link["tile_start"]) ||
      typeof link["content_version"] !== "string" ||
      !/^rg1-[0-9a-f]{64}$/.test(link["content_version"]) ||
      link["lod"] !== "native"
    )
      throw new Error("invalid_regional_resource_link");
    const expected = `/api/v2/regional/${link["series_key"]}/v1/${link["content_version"]}/1d/${link["tile_start"]}/native`;
    if (link["url"] !== expected) throw new Error("invalid_regional_resource_url");
    return {
      series_key: link["series_key"],
      tile_start: link["tile_start"] as number,
      content_version: link["content_version"] as string,
      lod: "native" as const,
      url: expected,
    };
  });
  return {
    title: input["title"],
    taxonomies: TAXONOMIES as unknown as Record<RegionalMode, string[]>,
    deferred_products: ["NP4-743-CD", "NP4-746-CD"],
    current: parsedCurrent,
    source_health: sourceHealth,
    materialization_health: materializationHealth,
    resources,
  };
}

export async function loadRegionalManifest(signal?: AbortSignal): Promise<RegionalManifest> {
  const response = await fetch("/api/v1/regional-geography", { signal: signal ?? null });
  if (!response.ok) throw new Error(`regional_manifest_http_${response.status}`);
  return parseRegionalManifest(await response.json());
}

export async function loadRegionalResource(
  link: RegionalResourceLink,
  signal?: AbortSignal,
): Promise<RegionalResource> {
  const response = await fetch(link.url, { signal: signal ?? null });
  if (!response.ok) throw new Error(`regional_resource_http_${response.status}`);
  const input = object(await response.json());
  if (
    input["series_key"] !== link.series_key ||
    input["content_version"] !== link.content_version ||
    input["tile_start"] !== link.tile_start ||
    input["tile_end"] !== link.tile_start + 86_400 ||
    input["lod"] !== "native" ||
    !Array.isArray(input["rows"]) ||
    !REGIONAL_MODES.includes(input["kind"] as RegionalMode) ||
    typeof input["region"] !== "string"
  )
    throw new Error("invalid_regional_resource");
  const expectedRenewableKey = `regional.${input["kind"]}.${input["region"]}.hourly`;
  if (input["kind"] !== "load" && link.series_key !== expectedRenewableKey)
    throw new Error("invalid_regional_resource_context");
  const loadContext = /^regional\.load\.weather-zone\.([a-z-]+)\.(actual|forecast)$/.exec(
    link.series_key,
  );
  if (input["kind"] === "load" && (!loadContext || loadContext[1] !== input["region"]))
    throw new Error("invalid_regional_resource_context");
  if (
    input["kind"] !== "load" &&
    (input["forecast_error_available"] !== false ||
      input["forecast_error_unavailable_reason"] !==
        "generation_is_curtailment_affected_forecast_targets_hsl")
  )
    throw new Error("invalid_regional_forecast_error_contract");
  const rows = input["rows"].map((entry) => {
    const row = object(entry);
    return {
      target_ts: finite(row["target_ts"], false)!,
      current_mw: finite(row["current_mw"]),
      share_percent: finite(row["share_percent"]),
      change_1h_mw: finite(row["change_1h_mw"]),
      forecast_mw: finite(row["forecast_mw"]),
      forecast_error_mw: finite(row["forecast_error_mw"] ?? null),
    };
  });
  if (
    loadContext?.[2] === "actual" &&
    rows.some((row) => row.forecast_mw !== null || row.forecast_error_mw !== null)
  )
    throw new Error("invalid_regional_resource_flavor");
  if (
    loadContext?.[2] === "forecast" &&
    rows.some((row) => row.current_mw !== null || row.change_1h_mw !== null)
  )
    throw new Error("invalid_regional_resource_flavor");
  if (
    rows.some((row) => row.target_ts < link.tile_start || row.target_ts >= link.tile_start + 86_400)
  )
    throw new Error("invalid_regional_resource_bounds");
  for (let index = 1; index < rows.length; index += 1)
    if (rows[index]!.target_ts <= rows[index - 1]!.target_ts)
      throw new Error("invalid_regional_resource_order");
  return {
    series_key: input["series_key"] as string,
    region: input["region"] as string,
    kind: input["kind"] as RegionalMode,
    rows,
  };
}
