export const MARKET_SERIES = {
  "market.sced.system-lambda": "$/MWh",
  "market.sced.price-adder.energy": "$/MWh",
  "market.sced.price-adder.regup": "$/MW",
  "market.sced.price-adder.regdown": "$/MW",
  "market.sced.price-adder.rrs": "$/MW",
  "market.sced.price-adder.ecrs": "$/MW",
  "market.sced.price-adder.nonspin": "$/MW",
  "market.sced.adder-input.ruc-ldl-relaxed": "MW",
  "market.sced.adder-input.rmr-ldl-relaxed": "MW",
  "market.sced.adder-input.deployed-load-resource": "MW",
  "market.sced.adder-input.deployed-ers": "MW",
  "market.sced.adder-input.dc-tie-import": "MW",
  "market.sced.adder-input.dc-tie-export": "MW",
  "market.sced.adder-input.rtblt-import": "MW",
  "market.sced.adder-input.rtblt-export": "MW",
  "market.sced.adder-input.online-lsl": "MW",
  "market.sced.adder-input.online-hsl": "MW",
  "market.sced.adder-input.rtdll": "MW",
  "market.sced.as-capability.regup": "MW",
  "market.sced.as-capability.regdown": "MW",
  "market.sced.as-capability.rrs": "MW",
  "market.sced.as-capability.ecrs": "MW",
  "market.sced.as-capability.nonspin": "MW",
  "market.sced.as-capability.regup-rrs": "MW",
  "market.sced.as-capability.regup-rrs-ecrs": "MW",
  "market.sced.as-capability.regup-rrs-ecrs-nonspin": "MW",
  "market.sced.as-mcpc.ecrs": "$/MW",
  "market.sced.as-mcpc.nonspin": "$/MW",
  "market.sced.as-mcpc.regdown": "$/MW",
  "market.sced.as-mcpc.regup": "$/MW",
  "market.sced.as-mcpc.rrs": "$/MW",
} as const;
export type MarketSeriesKey = keyof typeof MARKET_SERIES;

export type MarketSource = {
  source_id: string;
  product_id: string;
  vintage_key: string;
  document_id: string;
  issued_at: number;
  raw_publish_datetime: string;
  raw_sced_timestamp: string;
  repeated_hour_flag: boolean;
};
export type MarketReading = { value: number; unit: string; source: MarketSource };
export type MarketSnapshot = {
  target_ts: number;
  alignment: "exact_same_sced_timestamp";
  readings: Record<MarketSeriesKey, MarketReading>;
  lambda_parity: { state: "match" | "mismatch"; delta: number; tolerance: number };
};
export type MarketResourceLink = {
  series_key: MarketSeriesKey;
  tile_start: number;
  content_version: string;
  lod: "native";
  url: string;
};
export type MarketManifest = {
  explanation_policy: "time_adjacent_context_not_causal_decomposition";
  current: MarketSnapshot | null;
  previous: MarketSnapshot | null;
  changes: Record<MarketSeriesKey, { delta: number | null; unit: string }>;
  elapsed_seconds: number | null;
  source_health: Array<{
    source_id: string;
    state: "healthy" | "delayed" | "stale" | "failed" | "unavailable";
    data_timestamp_ts: number | null;
    gap_count: number;
    last_error: string | null;
  }>;
  materialization_health: {
    state: "healthy" | "failed" | "unavailable";
    last_success_ts: number | null;
    consecutive_failures: number | null;
    last_error: string | null;
  };
  resources: MarketResourceLink[];
};
export type MarketResource = {
  series_key: MarketSeriesKey;
  tile_start: number;
  tile_end: number;
  unit: string;
  rows: Array<{ target_ts: number; value: number; source: MarketSource }>;
};

function object(value: unknown, code = "invalid_market_mechanics"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("invalid_market_mechanics");
  return value as number;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("invalid_market_mechanics");
  return value;
}
function expectedProduct(key: MarketSeriesKey) {
  if (key === "market.sced.system-lambda") return ["ercot_mis_np6_322", "NP6-322-CD"];
  if (key.includes("price-adder") || key.includes("adder-input"))
    return ["ercot_mis_np6_323", "NP6-323-CD"];
  if (key.includes("as-capability")) return ["ercot_mis_np6_328", "NP6-328-CD"];
  return ["ercot_mis_np6_332", "NP6-332-CD"];
}
const chicagoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function rawScedAt(target: number): string {
  const values = Object.fromEntries(
    chicagoParts
      .formatToParts(new Date(target * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values["month"]}/${values["day"]}/${values["year"]} ${values["hour"]}:${values["minute"]}:${values["second"]}`;
}

function rawPublishClockAt(target: number): string {
  const [date, clock] = rawScedAt(target).split(" ") as [string, string];
  const [month, day, year] = date.split("/") as [string, string, string];
  return `${year}-${month}-${day}T${clock}`;
}

function source(value: unknown, key: MarketSeriesKey, target: number): MarketSource {
  const item = object(value);
  const expected = expectedProduct(key);
  if (
    typeof item["source_id"] !== "string" ||
    typeof item["product_id"] !== "string" ||
    typeof item["vintage_key"] !== "string" ||
    !/^mm1-[0-9a-f]{64}$/.test(item["vintage_key"]) ||
    typeof item["document_id"] !== "string" ||
    !/^\d{1,20}$/.test(item["document_id"]) ||
    typeof item["raw_publish_datetime"] !== "string" ||
    typeof item["raw_sced_timestamp"] !== "string" ||
    typeof item["repeated_hour_flag"] !== "boolean" ||
    item["source_id"] !== expected[0] ||
    item["product_id"] !== expected[1]
  )
    throw new Error("invalid_market_mechanics_source");
  const issued = integer(item["issued_at"]);
  const rawPublish = item["raw_publish_datetime"];
  const rawSced = item["raw_sced_timestamp"];
  const repeated = item["repeated_hour_flag"];
  const parsedPublish = Date.parse(rawPublish) / 1000;
  const priorMatches = rawScedAt(target - 3600) === rawSced;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00$/.test(rawPublish) ||
    !Number.isInteger(parsedPublish) ||
    parsedPublish !== issued ||
    !rawPublish.startsWith(rawPublishClockAt(issued)) ||
    issued < target ||
    issued - target > 3600 ||
    !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(rawSced) ||
    rawScedAt(target) !== rawSced ||
    (repeated ? !priorMatches : priorMatches)
  )
    throw new Error("invalid_market_mechanics_source_time");
  return {
    source_id: item["source_id"],
    product_id: item["product_id"],
    vintage_key: item["vintage_key"],
    document_id: item["document_id"],
    issued_at: issued,
    raw_publish_datetime: rawPublish,
    raw_sced_timestamp: rawSced,
    repeated_hour_flag: repeated,
  };
}
function series(value: unknown): MarketSeriesKey {
  if (typeof value !== "string" || !(value in MARKET_SERIES))
    throw new Error("invalid_market_series");
  return value as MarketSeriesKey;
}

function snapshot(value: unknown): MarketSnapshot | null {
  if (value === null) return null;
  const item = object(value);
  const readingsValue = object(item["readings"]);
  if (
    item["alignment"] !== "exact_same_sced_timestamp" ||
    JSON.stringify(Object.keys(readingsValue).sort()) !==
      JSON.stringify(Object.keys(MARKET_SERIES).sort())
  )
    throw new Error("invalid_market_current");
  const readings = {} as Record<MarketSeriesKey, MarketReading>;
  for (const rawKey of Object.keys(MARKET_SERIES)) {
    const key = rawKey as MarketSeriesKey;
    const reading = object(readingsValue[key]);
    if (reading["unit"] !== MARKET_SERIES[key]) throw new Error("invalid_market_unit");
    readings[key] = {
      value: finite(reading["value"]),
      unit: MARKET_SERIES[key],
      source: source(reading["source"], key, integer(item["target_ts"])),
    };
  }
  const parity = object(item["lambda_parity"]);
  const tolerance = finite(parity["tolerance"]);
  const delta = finite(parity["delta"]);
  if (
    tolerance !== 0.00005 ||
    !["match", "mismatch"].includes(String(parity["state"])) ||
    (parity["state"] === "match") !== Math.abs(delta) <= tolerance
  )
    throw new Error("invalid_market_lambda_parity");
  return {
    target_ts: integer(item["target_ts"]),
    alignment: "exact_same_sced_timestamp",
    readings,
    lambda_parity: { state: parity["state"] as "match" | "mismatch", delta, tolerance },
  };
}

export function parseMarketManifest(value: unknown): MarketManifest {
  const input = object(value);
  if (
    input["schema_version"] !== 1 ||
    input["kind"] !== "market_mechanics_manifest" ||
    input["methodology"] !== "market-context-v1" ||
    input["explanation_policy"] !== "time_adjacent_context_not_causal_decomposition"
  )
    throw new Error("invalid_market_manifest");
  if (
    !Array.isArray(input["resources"]) ||
    !Array.isArray(input["source_health"]) ||
    input["materialization_health"] === undefined
  )
    throw new Error("invalid_market_manifest");
  const seenLinks = new Set<string>();
  let priorLink = "";
  const resources = input["resources"].map((entry) => {
    const item = object(entry);
    const key = series(item["series_key"]);
    const start = integer(item["tile_start"]);
    const version = item["content_version"];
    if (
      start % 86_400 ||
      item["lod"] !== "native" ||
      typeof version !== "string" ||
      !/^mmr1-[0-9a-f]{64}$/.test(version)
    )
      throw new Error("invalid_market_resource_link");
    const canonical = `/api/v2/market-mechanics/${key}/v1/${version}/1d/${start}/native`;
    const identity = `${key}:${start}`;
    const orderedIdentity = `${key}:${String(start).padStart(12, "0")}`;
    if (item["url"] !== canonical || seenLinks.has(identity) || orderedIdentity <= priorLink)
      throw new Error("invalid_market_resource_link");
    seenLinks.add(identity);
    priorLink = orderedIdentity;
    return {
      series_key: key,
      tile_start: start,
      content_version: version,
      lod: "native" as const,
      url: canonical,
    };
  });
  const current = snapshot(input["current"]);
  const previous = snapshot(input["previous"]);
  const elapsed = input["elapsed_seconds"] === null ? null : integer(input["elapsed_seconds"]);
  if (
    (previous === null) !== (elapsed === null) ||
    (previous && (!current || elapsed !== current.target_ts - previous.target_ts || elapsed <= 0))
  )
    throw new Error("invalid_market_elapsed");
  const changesValue = object(input["changes"]);
  if (
    JSON.stringify(Object.keys(changesValue).sort()) !==
    JSON.stringify((current ? Object.keys(MARKET_SERIES) : []).sort())
  )
    throw new Error("invalid_market_changes");
  const changes = {} as MarketManifest["changes"];
  if (current)
    for (const rawKey of Object.keys(MARKET_SERIES)) {
      const key = rawKey as MarketSeriesKey;
      const change = object(changesValue[key]);
      const expected = previous ? current.readings[key].value - previous.readings[key].value : null;
      if (change["unit"] !== MARKET_SERIES[key] || change["delta"] !== expected)
        throw new Error("invalid_market_changes");
      changes[key] = { delta: expected, unit: MARKET_SERIES[key] };
    }
  const expectedHealth = [
    "ercot_mis_np6_322",
    "ercot_mis_np6_323",
    "ercot_mis_np6_328",
    "ercot_mis_np6_332",
  ];
  const sourceHealth = input["source_health"].map((entry) => {
    const health = object(entry);
    if (
      typeof health["source_id"] !== "string" ||
      !expectedHealth.includes(health["source_id"]) ||
      !["healthy", "delayed", "stale", "failed", "unavailable"].includes(String(health["state"])) ||
      (health["data_timestamp_ts"] !== null &&
        !Number.isSafeInteger(health["data_timestamp_ts"])) ||
      !Number.isSafeInteger(health["gap_count"]) ||
      Number(health["gap_count"]) < 0 ||
      Number(health["gap_count"]) > 10_000 ||
      !(
        health["last_error"] === null ||
        health["last_error"] === "document_gap" ||
        health["last_error"] === "never_reported" ||
        (typeof health["last_error"] === "string" &&
          /^ercot_mis_[a-z0-9_]{1,96}$/.test(health["last_error"]))
      ) ||
      Number(health["gap_count"]) > 0 !== (health["last_error"] === "document_gap")
    )
      throw new Error("invalid_market_health");
    return {
      source_id: health["source_id"],
      state: health["state"] as MarketManifest["source_health"][number]["state"],
      data_timestamp_ts: health["data_timestamp_ts"] as number | null,
      gap_count: health["gap_count"] as number,
      last_error: health["last_error"] as string | null,
    };
  });
  if (sourceHealth.length !== 4 || new Set(sourceHealth.map((item) => item.source_id)).size !== 4)
    throw new Error("invalid_market_health");
  const materializationValue = object(input["materialization_health"]);
  const materializationState = String(materializationValue["state"]);
  const materializationFailures = materializationValue["consecutive_failures"];
  const materializationError = materializationValue["last_error"];
  const materializationSuccess = materializationValue["last_success_ts"];
  if (
    !["healthy", "failed", "unavailable"].includes(materializationState) ||
    (materializationSuccess !== null && !Number.isSafeInteger(materializationSuccess)) ||
    (materializationState === "healthy" &&
      (materializationFailures !== 0 || materializationError !== null)) ||
    (materializationState === "failed" &&
      (!Number.isSafeInteger(materializationFailures) ||
        Number(materializationFailures) < 1 ||
        materializationError !== "market_mechanics_materialization_failed")) ||
    (materializationState === "unavailable" &&
      (materializationFailures !== null || materializationError !== "never_run"))
  )
    throw new Error("invalid_market_materialization_health");
  return {
    explanation_policy: "time_adjacent_context_not_causal_decomposition",
    current,
    previous,
    changes,
    elapsed_seconds: elapsed,
    source_health: sourceHealth,
    materialization_health: {
      state: materializationValue["state"] as MarketManifest["materialization_health"]["state"],
      last_success_ts: materializationSuccess as number | null,
      consecutive_failures: materializationValue["consecutive_failures"] as number | null,
      last_error: materializationValue["last_error"] as string | null,
    },
    resources,
  };
}

export function parseMarketResource(value: unknown, link: MarketResourceLink): MarketResource {
  const input = object(value);
  if (
    input["schema_version"] !== 1 ||
    input["methodology"] !== "market-context-v1" ||
    input["series_key"] !== link.series_key ||
    input["tile_start"] !== link.tile_start ||
    input["tile_end"] !== link.tile_start + 86_400 ||
    input["lod"] !== "native" ||
    input["unit"] !== MARKET_SERIES[link.series_key] ||
    input["content_version"] !== link.content_version ||
    !Array.isArray(input["rows"])
  )
    throw new Error("invalid_market_resource");
  let prior = link.tile_start - 1;
  const rows = input["rows"].map((entry) => {
    const row = object(entry);
    const target = integer(row["target_ts"]);
    if (target <= prior || target < link.tile_start || target >= link.tile_start + 86_400)
      throw new Error("invalid_market_resource_rows");
    prior = target;
    return {
      target_ts: target,
      value: finite(row["value"]),
      source: source(row["source"], link.series_key, target),
    };
  });
  return {
    series_key: link.series_key,
    tile_start: link.tile_start,
    tile_end: link.tile_start + 86_400,
    unit: MARKET_SERIES[link.series_key],
    rows,
  };
}

export async function loadMarketManifest(signal?: AbortSignal): Promise<MarketManifest> {
  const response = await fetch("/api/v1/market-mechanics", signal ? { signal } : {});
  if (!response.ok) throw new Error(`market_manifest_${response.status}`);
  return parseMarketManifest(await response.json());
}
export async function loadMarketResource(
  link: MarketResourceLink,
  signal?: AbortSignal,
): Promise<MarketResource> {
  const response = await fetch(link.url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`market_resource_${response.status}`);
  return parseMarketResource(await response.json(), link);
}
