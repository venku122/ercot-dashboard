export const NET_LOAD_SERIES_KEYS = [
  "net-load.actual",
  "net-load.forecast.latest-capped-1h-before-utc-day",
  "net-load.forecast.latest-capped-6h-before-utc-day",
  "net-load.forecast.latest-capped-24h-before-utc-day",
] as const;

export type NetLoadSeriesKey = (typeof NET_LOAD_SERIES_KEYS)[number];
export const NET_LOAD_DAILY_SERIES_KEYS = [
  "net-load.actual",
  "net-load.forecast.latest-capped-1h-before-market-day",
  "net-load.forecast.latest-capped-6h-before-market-day",
  "net-load.forecast.latest-capped-24h-before-market-day",
] as const;
export type NetLoadDailySeriesKey = (typeof NET_LOAD_DAILY_SERIES_KEYS)[number];

export type NetLoadResourceLink = {
  content_version: string;
  day_start: number;
  lod: "native";
  point_count: number;
  policy_cutoff: number | null;
  effective_as_of: number | null;
  finalized: boolean;
  series_key: NetLoadSeriesKey;
  url: string;
  valid_point_count: number;
};

export type NetLoadDailyLink = {
  complete: boolean;
  content_version: string;
  delivery_date: string;
  policy_cutoff: number | null;
  effective_as_of: number | null;
  finalized: boolean;
  series_key: NetLoadDailySeriesKey;
  url: string;
};

export type NetLoadManifest = {
  kind: "net_load_manifest";
  formula: "demand_mw - wind_mw - solar_mw";
  official_ercot_net_load: false;
  resources: NetLoadResourceLink[];
  daily_resources: NetLoadDailyLink[];
  materialization_health: Array<{
    pipeline: "actual" | "forecast";
    state: "healthy" | "failed";
    last_attempt_ts: number;
    last_success_ts: number | null;
    last_error_code: string | null;
  }>;
  storage_policy: "context_only_not_in_formula";
};

export type NetLoadRow = {
  demand_mw: number | null;
  missing_reason: string | null;
  net_load_mw: number | null;
  published_average_net_load_mw?: number | null;
  published_residual_mw?: number | null;
  ramp_1h_mw: number | null;
  ramp_3h_mw: number | null;
  solar_mw: number | null;
  storage_net_output_mw?: number | null;
  target_ts: number;
  wind_mw: number | null;
};

export type NetLoadResource = {
  complete: boolean;
  content_version: string;
  contributors:
    | { same_timestamp_required: true; source_id: "ercot_realtime" }
    | Record<
        "load" | "solar" | "wind",
        { issued_at: number; retrieved_at: number; vintage_key: string }
      >;
  day_end: number;
  day_start: number;
  description: string;
  exclusions: Record<string, number>;
  kind: "net_load_tile";
  lod: "native";
  official_ercot_net_load: false;
  rows: NetLoadRow[];
  policy_cutoff: number | null;
  effective_as_of: number | null;
  finalized: boolean;
  selection_policy: "coherent_whole_curve_latest_capped_before_utc_day" | null;
  series_key: NetLoadSeriesKey;
  snapshot_lead_seconds: number | null;
  storage_policy: "context_only_not_in_formula";
};

export type NetLoadDailyResource = {
  complete: boolean;
  content_version: string;
  daily_ramp: null | {
    complete_day: true;
    elapsed_seconds: number;
    evening_peak_net_load_mw: number;
    evening_peak_target_ts: number;
    minimum_net_load_mw: number;
    minimum_target_ts: number;
    policy: "dashboard_evening_v1";
    ramp_mw: number;
  };
  daily_ramp_exclusion: "incomplete_day" | null;
  delivery_date: string;
  kind: "net_load_daily_ramp";
  series_key: NetLoadDailySeriesKey;
};

function object(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function integer(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(error);
  return value as number;
}

function finite(value: unknown, error: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function seriesKey(value: unknown): NetLoadSeriesKey {
  if (!NET_LOAD_SERIES_KEYS.includes(value as NetLoadSeriesKey))
    throw new Error("invalid_net_load_series");
  return value as NetLoadSeriesKey;
}

function dailySeriesKey(value: unknown): NetLoadDailySeriesKey {
  if (!NET_LOAD_DAILY_SERIES_KEYS.includes(value as NetLoadDailySeriesKey))
    throw new Error("invalid_net_load_daily_series");
  return value as NetLoadDailySeriesKey;
}

function version(value: unknown) {
  if (typeof value !== "string" || !/^v1-[0-9a-f]{64}$/.test(value))
    throw new Error("invalid_net_load_version");
  return value;
}

function path(value: unknown, expected: string) {
  if (value !== expected) throw new Error("invalid_net_load_url");
  return value;
}

export function parseNetLoadManifest(value: unknown): NetLoadManifest {
  const input = object(value, "invalid_net_load_manifest");
  if (
    input["kind"] !== "net_load_manifest" ||
    input["schema_version"] !== 1 ||
    input["methodology_version"] !== "v1" ||
    input["formula"] !== "demand_mw - wind_mw - solar_mw" ||
    input["storage_policy"] !== "context_only_not_in_formula" ||
    input["official_ercot_net_load"] !== false ||
    !Array.isArray(input["resources"]) ||
    !Array.isArray(input["daily_resources"]) ||
    !Array.isArray(input["materialization_health"])
  )
    throw new Error("invalid_net_load_manifest");
  const resources = input["resources"].map((raw) => {
    const row = object(raw, "invalid_net_load_resource_link");
    const key = seriesKey(row["series_key"]);
    const dayStart = integer(row["day_start"], "invalid_net_load_day");
    if (dayStart < 0 || dayStart % 86_400 || row["lod"] !== "native")
      throw new Error("invalid_net_load_day");
    const content = version(row["content_version"]);
    const policy_cutoff = finite(row["policy_cutoff"], "invalid_net_load_snapshot", true);
    const effective_as_of = finite(row["effective_as_of"], "invalid_net_load_snapshot", true);
    if (
      typeof row["finalized"] !== "boolean" ||
      (key === "net-load.actual"
        ? policy_cutoff !== null || effective_as_of !== null || row["finalized"] !== true
        : policy_cutoff === null ||
          effective_as_of === null ||
          effective_as_of > policy_cutoff ||
          row["finalized"] !== effective_as_of >= policy_cutoff)
    )
      throw new Error("invalid_net_load_snapshot");
    const url = path(row["url"], `/api/v2/net-load/${key}/v1/${content}/1d/${dayStart}/native`);
    return {
      content_version: content,
      day_start: dayStart,
      lod: "native" as const,
      point_count: integer(row["point_count"], "invalid_net_load_counts"),
      policy_cutoff,
      effective_as_of,
      finalized: row["finalized"],
      series_key: key,
      url,
      valid_point_count: integer(row["valid_point_count"], "invalid_net_load_counts"),
    };
  });
  const daily_resources = input["daily_resources"].map((raw) => {
    const row = object(raw, "invalid_net_load_daily_link");
    const key = dailySeriesKey(row["series_key"]);
    const content = version(row["content_version"]);
    const policy_cutoff = finite(row["policy_cutoff"], "invalid_net_load_snapshot", true);
    const effective_as_of = finite(row["effective_as_of"], "invalid_net_load_snapshot", true);
    if (
      typeof row["finalized"] !== "boolean" ||
      (key === "net-load.actual"
        ? policy_cutoff !== null || effective_as_of !== null || row["finalized"] !== true
        : policy_cutoff === null ||
          effective_as_of === null ||
          effective_as_of > policy_cutoff ||
          row["finalized"] !== effective_as_of >= policy_cutoff)
    )
      throw new Error("invalid_net_load_snapshot");
    if (
      typeof row["delivery_date"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row["delivery_date"])
    )
      throw new Error("invalid_net_load_date");
    if (typeof row["complete"] !== "boolean") throw new Error("invalid_net_load_daily_link");
    return {
      complete: row["complete"],
      content_version: content,
      delivery_date: row["delivery_date"],
      policy_cutoff,
      effective_as_of,
      finalized: row["finalized"],
      series_key: key,
      url: path(row["url"], `/api/v2/net-load-daily/${key}/v1/${content}/${row["delivery_date"]}`),
    };
  });
  const materialization_health = input["materialization_health"].map((raw: unknown) => {
    const row = object(raw, "invalid_net_load_health");
    if (
      !["actual", "forecast"].includes(String(row["pipeline"])) ||
      !["healthy", "failed"].includes(String(row["state"])) ||
      (row["last_error_code"] !== null && typeof row["last_error_code"] !== "string")
    )
      throw new Error("invalid_net_load_health");
    return {
      pipeline: row["pipeline"] as "actual" | "forecast",
      state: row["state"] as "healthy" | "failed",
      last_attempt_ts: integer(row["last_attempt_ts"], "invalid_net_load_health"),
      last_success_ts:
        row["last_success_ts"] === null
          ? null
          : integer(row["last_success_ts"], "invalid_net_load_health"),
      last_error_code: row["last_error_code"] as string | null,
    };
  });
  return {
    kind: "net_load_manifest",
    formula: "demand_mw - wind_mw - solar_mw",
    official_ercot_net_load: false,
    resources,
    daily_resources,
    materialization_health,
    storage_policy: "context_only_not_in_formula",
  };
}

export function parseNetLoadResource(value: unknown, link: NetLoadResourceLink): NetLoadResource {
  const input = object(value, "invalid_net_load_resource");
  if (
    link.series_key === "net-load.actual"
      ? link.policy_cutoff !== null || link.effective_as_of !== null || !link.finalized
      : link.policy_cutoff === null ||
        link.effective_as_of === null ||
        link.effective_as_of > link.policy_cutoff ||
        link.finalized !== link.effective_as_of >= link.policy_cutoff
  )
    throw new Error("invalid_net_load_snapshot");
  if (
    input["kind"] !== "net_load_tile" ||
    input["schema_version"] !== 1 ||
    input["methodology_version"] !== "v1" ||
    input["series_key"] !== link.series_key ||
    input["content_version"] !== link.content_version ||
    input["day_start"] !== link.day_start ||
    input["day_end"] !== link.day_start + 86_400 ||
    input["lod"] !== "native" ||
    input["official_ercot_net_load"] !== false ||
    input["storage_policy"] !== "context_only_not_in_formula" ||
    !Array.isArray(input["rows"])
  )
    throw new Error("invalid_net_load_resource");
  const cadence = link.series_key === "net-load.actual" ? 300 : 3_600;
  const rows = input["rows"].map((raw, index) => {
    const row = object(raw, "invalid_net_load_row");
    const target = integer(row["target_ts"], "invalid_net_load_row");
    if (target !== link.day_start + index * cadence || target >= link.day_start + 86_400)
      throw new Error("invalid_net_load_row");
    const parsed: NetLoadRow = {
      target_ts: target,
      demand_mw: finite(row["demand_mw"], "invalid_net_load_row", true),
      wind_mw: finite(row["wind_mw"], "invalid_net_load_row", true),
      solar_mw: finite(row["solar_mw"], "invalid_net_load_row", true),
      net_load_mw: finite(row["net_load_mw"], "invalid_net_load_row", true),
      ramp_1h_mw: finite(row["ramp_1h_mw"], "invalid_net_load_row", true),
      ramp_3h_mw: finite(row["ramp_3h_mw"], "invalid_net_load_row", true),
      missing_reason: row["missing_reason"] === null ? null : String(row["missing_reason"]),
    };
    if (
      parsed.net_load_mw !== null &&
      (parsed.demand_mw === null ||
        parsed.wind_mw === null ||
        parsed.solar_mw === null ||
        Math.abs(parsed.net_load_mw - (parsed.demand_mw - parsed.wind_mw - parsed.solar_mw)) > 1e-6)
    )
      throw new Error("invalid_net_load_formula");
    for (const key of [
      "published_average_net_load_mw",
      "published_residual_mw",
      "storage_net_output_mw",
    ] as const) {
      if (key in row) parsed[key] = finite(row[key], "invalid_net_load_row", true);
    }
    return parsed;
  });
  if (rows.length !== 86_400 / cadence) throw new Error("invalid_net_load_row_count");
  const leadByKey: Record<NetLoadSeriesKey, number | null> = {
    "net-load.actual": null,
    "net-load.forecast.latest-capped-1h-before-utc-day": 3_600,
    "net-load.forecast.latest-capped-6h-before-utc-day": 21_600,
    "net-load.forecast.latest-capped-24h-before-utc-day": 86_400,
  };
  const expectedLead = leadByKey[link.series_key];
  const expectedPolicy =
    expectedLead === null ? null : "coherent_whole_curve_latest_capped_before_utc_day";
  if (
    input["selection_policy"] !== expectedPolicy ||
    input["snapshot_lead_seconds"] !== expectedLead
  ) {
    throw new Error("invalid_net_load_snapshot");
  }
  const policyCutoff = finite(input["policy_cutoff"], "invalid_net_load_snapshot", true);
  const expectedCutoff = expectedLead === null ? null : link.day_start - expectedLead;
  if (
    policyCutoff !== expectedCutoff ||
    link.policy_cutoff !== expectedCutoff ||
    input["finalized"] !== link.finalized
  ) {
    throw new Error("invalid_net_load_snapshot");
  }
  const contributorInput = object(input["contributors"], "invalid_net_load_contributors");
  let contributors: NetLoadResource["contributors"];
  if (expectedLead === null) {
    if (
      contributorInput["source_id"] !== "ercot_realtime" ||
      contributorInput["same_timestamp_required"] !== true
    )
      throw new Error("invalid_net_load_contributors");
    contributors = { source_id: "ercot_realtime", same_timestamp_required: true };
  } else {
    contributors = Object.fromEntries(
      (["load", "wind", "solar"] as const).map((name) => {
        const item = object(contributorInput[name], "invalid_net_load_contributors");
        if (typeof item["vintage_key"] !== "string" || item["vintage_key"].length > 100) {
          throw new Error("invalid_net_load_contributors");
        }
        const issued_at = integer(item["issued_at"], "invalid_net_load_contributors");
        const retrieved_at = integer(item["retrieved_at"], "invalid_net_load_contributors");
        if (issued_at > link.effective_as_of! || retrieved_at < issued_at) {
          throw new Error("invalid_net_load_contributors");
        }
        return [name, { issued_at, retrieved_at, vintage_key: item["vintage_key"] }];
      }),
    ) as NetLoadResource["contributors"];
  }
  return {
    complete: input["complete"] === true,
    content_version: link.content_version,
    contributors,
    day_start: link.day_start,
    day_end: link.day_start + 86_400,
    description: String(input["description"]),
    exclusions: object(input["exclusions"], "invalid_net_load_exclusions") as Record<
      string,
      number
    >,
    kind: "net_load_tile",
    lod: "native",
    official_ercot_net_load: false,
    rows,
    policy_cutoff: policyCutoff,
    effective_as_of: link.effective_as_of,
    finalized: input["finalized"] === true,
    selection_policy: expectedPolicy,
    series_key: link.series_key,
    snapshot_lead_seconds: finite(
      input["snapshot_lead_seconds"],
      "invalid_net_load_snapshot",
      true,
    ),
    storage_policy: "context_only_not_in_formula",
  };
}

export function parseNetLoadDailyResource(
  value: unknown,
  link: NetLoadDailyLink,
): NetLoadDailyResource {
  const input = object(value, "invalid_net_load_daily");
  if (
    link.series_key === "net-load.actual"
      ? link.policy_cutoff !== null || link.effective_as_of !== null || !link.finalized
      : link.policy_cutoff === null ||
        link.effective_as_of === null ||
        link.effective_as_of > link.policy_cutoff ||
        link.finalized !== link.effective_as_of >= link.policy_cutoff
  )
    throw new Error("invalid_net_load_snapshot");
  if (
    input["kind"] !== "net_load_daily_ramp" ||
    input["series_key"] !== link.series_key ||
    input["content_version"] !== link.content_version ||
    input["delivery_date"] !== link.delivery_date ||
    input["policy_cutoff"] !== link.policy_cutoff ||
    input["finalized"] !== link.finalized
  )
    throw new Error("invalid_net_load_daily");
  const ramp = input["daily_ramp"];
  let daily_ramp: NetLoadDailyResource["daily_ramp"] = null;
  if (ramp !== null) {
    const row = object(ramp, "invalid_net_load_daily_ramp");
    if (row["policy"] !== "dashboard_evening_v1" || row["complete_day"] !== true)
      throw new Error("invalid_net_load_daily_ramp");
    daily_ramp = {
      policy: "dashboard_evening_v1",
      complete_day: true,
      elapsed_seconds: integer(row["elapsed_seconds"], "invalid_net_load_daily_ramp"),
      evening_peak_net_load_mw: finite(
        row["evening_peak_net_load_mw"],
        "invalid_net_load_daily_ramp",
      )!,
      evening_peak_target_ts: integer(row["evening_peak_target_ts"], "invalid_net_load_daily_ramp"),
      minimum_net_load_mw: finite(row["minimum_net_load_mw"], "invalid_net_load_daily_ramp")!,
      minimum_target_ts: integer(row["minimum_target_ts"], "invalid_net_load_daily_ramp"),
      ramp_mw: finite(row["ramp_mw"], "invalid_net_load_daily_ramp")!,
    };
    const peakHour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: "America/Chicago",
      }).format(daily_ramp.evening_peak_target_ts * 1_000),
    );
    if (peakHour < 16 || peakHour >= 22) throw new Error("invalid_net_load_daily_ramp");
    if (
      daily_ramp.minimum_target_ts > daily_ramp.evening_peak_target_ts ||
      Math.abs(
        daily_ramp.ramp_mw - (daily_ramp.evening_peak_net_load_mw - daily_ramp.minimum_net_load_mw),
      ) > 1e-6
    )
      throw new Error("invalid_net_load_daily_ramp");
  }
  if ((input["complete"] === true) !== (daily_ramp !== null))
    throw new Error("invalid_net_load_daily_completeness");
  return {
    complete: input["complete"] === true,
    content_version: link.content_version,
    daily_ramp,
    daily_ramp_exclusion: daily_ramp ? null : "incomplete_day",
    delivery_date: link.delivery_date,
    kind: "net_load_daily_ramp",
    series_key: link.series_key,
  };
}
