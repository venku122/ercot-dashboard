export const MARKET_PRICE_POINTS = [
  ["HB_HOUSTON", "HU"],
  ["HB_NORTH", "HU"],
  ["HB_PAN", "HU"],
  ["HB_SOUTH", "HU"],
  ["HB_WEST", "HU"],
  ["LZ_AEN", "LZ"],
  ["LZ_CPS", "LZ"],
  ["LZ_HOUSTON", "LZ"],
  ["LZ_LCRA", "LZ"],
  ["LZ_NORTH", "LZ"],
  ["LZ_RAYBN", "LZ"],
  ["LZ_SOUTH", "LZ"],
  ["LZ_WEST", "LZ"],
] as const;
export const MARKET_REFERENCE_POINTS = [
  ["HB_BUSAVG", "SH"],
  ["HB_HUBAVG", "AH"],
] as const;
export const MARKET_DISPLAY_POINTS = [...MARKET_PRICE_POINTS, ...MARKET_REFERENCE_POINTS] as const;
export type MarketPoint = (typeof MARKET_DISPLAY_POINTS)[number][0];
export type MarketPointType = (typeof MARKET_DISPLAY_POINTS)[number][1];
export type MarketGeographyKind = "prices" | "lmp" | "constraints";

export type MarketGeographySource = {
  source_id: string;
  product_id: "NP6-788-CD" | "NP6-905-CD" | "NP6-86-CD";
  content_key: string;
  document_id: string;
  issued_at: number;
  retrieved_at: number;
  raw_publish_datetime: string;
};
export type PriceRow = {
  target_ts: number;
  raw_delivery_date: string;
  delivery_hour: number;
  delivery_interval: number;
  raw_dst_flag: "N" | "Y";
  repeated_hour_flag: boolean;
  settlement_point: MarketPoint;
  settlement_point_type: MarketPointType;
  value: number;
  unit: "$/MWh";
};
export type LmpRow = {
  target_ts: number;
  raw_sced_timestamp: string;
  repeated_hour_flag: boolean;
  settlement_point: MarketPoint;
  value: number;
  unit: "$/MWh";
};
export type ConstraintRow = {
  constraint_key: string;
  constraint_id: string;
  constraint_name: string;
  contingency_name: string;
  shadow_price: number;
  max_shadow_price: number;
  limit_mw: number;
  value_mw: number;
  violated_mw: number;
  from_station: string;
  to_station: string;
  from_station_kv: number;
  to_station_kv: number;
  cct_status: "COMP" | "NONCOMP";
  cct_status_label: "competitive" | "non-competitive";
  raw_sced_timestamp: string;
  repeated_hour_flag: boolean;
  target_ts: number;
};
export type MarketGeographyLink = {
  kind: MarketGeographyKind;
  identity: string;
  tile_start: number;
  content_version: string;
  lod: "native";
  url: string;
};
export type MarketGeographyManifest = {
  as_of: number;
  settlement_interval: {
    state: "available" | "partial" | "unavailable";
    target_ts: number | null;
    source?: MarketGeographySource;
    rows: PriceRow[];
    reference_prices: PriceRow[];
    missing: string[];
  };
  lmp_snapshot: {
    state: "available" | "partial" | "unavailable";
    target_ts: number | null;
    source?: MarketGeographySource;
    rows: LmpRow[];
    missing: string[];
  };
  constraints: {
    state: "available" | "valid_empty" | "unavailable" | "unavailable_no_exact_sced";
    target_ts: number | null;
    source?: MarketGeographySource;
    rows: ConstraintRow[];
    total_count: number;
    truncated: boolean;
  };
  source_health: Array<{
    source_id: string;
    state: "healthy" | "delayed" | "stale" | "failed" | "unavailable";
    availability_status: string;
    last_success_ts: number | null;
    data_timestamp_ts: number | null;
    data_age_seconds: number | null;
    consecutive_failures: number | null;
    gap_count: number;
    last_error: string | null;
  }>;
  materialization_health: {
    state: "healthy" | "failed" | "unavailable";
    last_attempt_ts: number | null;
    last_success_ts: number | null;
    consecutive_failures: number | null;
    last_error: string | null;
  };
  resources: MarketGeographyLink[];
};
export type MarketGeographyResource = {
  kind: MarketGeographyKind;
  identity: string;
  tile_start: number;
  tile_end: number;
  unit: string;
  rows: Array<Record<string, unknown>>;
};

function object(value: unknown, code = "invalid_market_geography"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("invalid_market_geography");
  return value as number;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("invalid_market_geography");
  return value;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error("invalid_market_geography");
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
const chicagoClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function chicagoRaw(target: number) {
  const parts = Object.fromEntries(
    chicagoClock
      .formatToParts(new Date(target * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts["month"]}/${parts["day"]}/${parts["year"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
}
function validateFold(target: number, raw: string, repeated: boolean) {
  if (chicagoRaw(target) !== raw) throw new Error("invalid_market_geography_time");
  const priorMatches = chicagoRaw(target - 3_600) === raw;
  const nextMatches = chicagoRaw(target + 3_600) === raw;
  if ((repeated && !priorMatches) || (!repeated && priorMatches) || (repeated && nextMatches))
    throw new Error("invalid_market_geography_time");
}
function pointIdentity(point: string, pointType: string) {
  return `${point}--${pointType}`;
}
const pointTypes = new Map<string, string>(
  MARKET_DISPLAY_POINTS.map(([point, pointType]) => [point, pointType]),
);
const pointIdentities = new Set(
  MARKET_DISPLAY_POINTS.map(([point, kind]) => pointIdentity(point, kind)),
);
const heatmapIdentities = new Set(
  MARKET_PRICE_POINTS.map(([point, kind]) => pointIdentity(point, kind)),
);
const referenceIdentities = new Set(
  MARKET_REFERENCE_POINTS.map(([point, kind]) => pointIdentity(point, kind)),
);

function source(value: unknown, expectedProduct: MarketGeographySource["product_id"]) {
  const item = object(value);
  const expectedSource = {
    "NP6-788-CD": "ercot_mis_np6_788",
    "NP6-905-CD": "ercot_mis_np6_905",
    "NP6-86-CD": "ercot_mis_np6_86",
  }[expectedProduct];
  if (
    item["product_id"] !== expectedProduct ||
    item["source_id"] !== expectedSource ||
    typeof item["content_key"] !== "string" ||
    !/^mgp1-[0-9a-f]{64}$/.test(item["content_key"]) ||
    typeof item["document_id"] !== "string" ||
    !/^\d{1,20}$/.test(item["document_id"]) ||
    typeof item["raw_publish_datetime"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?-0[56]:00$/.test(item["raw_publish_datetime"])
  )
    throw new Error("invalid_market_geography_source");
  const issued = integer(item["issued_at"]);
  const retrieved = integer(item["retrieved_at"]);
  if (Date.parse(item["raw_publish_datetime"]) / 1000 !== issued || retrieved < issued)
    throw new Error("invalid_market_geography_source");
  return {
    source_id: expectedSource,
    product_id: expectedProduct,
    content_key: item["content_key"],
    document_id: item["document_id"],
    issued_at: issued,
    retrieved_at: retrieved,
    raw_publish_datetime: item["raw_publish_datetime"],
  } as MarketGeographySource;
}

function priceRow(value: unknown): PriceRow {
  const item = object(value);
  const point = text(item["settlement_point"], 256) as MarketPoint;
  const pointType = text(item["settlement_point_type"], 32) as MarketPointType;
  if (
    pointTypes.get(point) !== pointType ||
    item["unit"] !== "$/MWh" ||
    !["N", "Y"].includes(String(item["raw_dst_flag"])) ||
    typeof item["repeated_hour_flag"] !== "boolean" ||
    item["repeated_hour_flag"] !== (item["raw_dst_flag"] === "Y")
  )
    throw new Error("invalid_market_geography_price");
  const target = integer(item["target_ts"]);
  const deliveryHour = integer(item["delivery_hour"]);
  const deliveryInterval = integer(item["delivery_interval"]);
  if (deliveryHour < 1 || deliveryHour > 24 || deliveryInterval < 1 || deliveryInterval > 4)
    throw new Error("invalid_market_geography_price");
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(item["raw_delivery_date"], 16));
  if (!dateMatch) throw new Error("invalid_market_geography_price");
  const [, month, day, year] = dateMatch.map(Number);
  const wall = new Date(
    Date.UTC(year!, month! - 1, day!, 0, (deliveryHour - 1) * 60 + deliveryInterval * 15),
  );
  const rawEnd = `${String(wall.getUTCMonth() + 1).padStart(2, "0")}/${String(wall.getUTCDate()).padStart(2, "0")}/${wall.getUTCFullYear()} ${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}:00`;
  validateFold(target, rawEnd, item["repeated_hour_flag"]);
  return {
    target_ts: target,
    raw_delivery_date: text(item["raw_delivery_date"], 16),
    delivery_hour: deliveryHour,
    delivery_interval: deliveryInterval,
    raw_dst_flag: item["raw_dst_flag"] as "N" | "Y",
    repeated_hour_flag: item["repeated_hour_flag"],
    settlement_point: point,
    settlement_point_type: pointType,
    value: finite(item["value"]),
    unit: "$/MWh",
  };
}

function lmpRow(value: unknown): LmpRow {
  const item = object(value);
  const point = text(item["settlement_point"], 256) as MarketPoint;
  if (
    !pointTypes.has(point) ||
    item["unit"] !== "$/MWh" ||
    typeof item["repeated_hour_flag"] !== "boolean"
  )
    throw new Error("invalid_market_geography_lmp");
  const target = integer(item["target_ts"]);
  validateFold(target, text(item["raw_sced_timestamp"], 32), item["repeated_hour_flag"]);
  return {
    target_ts: target,
    raw_sced_timestamp: text(item["raw_sced_timestamp"], 32),
    repeated_hour_flag: item["repeated_hour_flag"],
    settlement_point: point,
    value: finite(item["value"]),
    unit: "$/MWh",
  };
}

function constraintRow(value: unknown): ConstraintRow {
  const item = object(value);
  if (
    typeof item["constraint_key"] !== "string" ||
    !/^[0-9a-f]{24}$/.test(item["constraint_key"]) ||
    typeof item["repeated_hour_flag"] !== "boolean" ||
    !["COMP", "NONCOMP"].includes(String(item["cct_status"])) ||
    item["cct_status_label"] !== (item["cct_status"] === "COMP" ? "competitive" : "non-competitive")
  )
    throw new Error("invalid_market_geography_constraint");
  const target = integer(item["target_ts"]);
  validateFold(target, text(item["raw_sced_timestamp"], 32), item["repeated_hour_flag"]);
  return {
    constraint_key: item["constraint_key"],
    constraint_id: text(item["constraint_id"], 64),
    constraint_name: text(item["constraint_name"]),
    contingency_name: text(item["contingency_name"]),
    shadow_price: finite(item["shadow_price"]),
    max_shadow_price: finite(item["max_shadow_price"]),
    limit_mw: finite(item["limit_mw"]),
    value_mw: finite(item["value_mw"]),
    violated_mw: finite(item["violated_mw"]),
    from_station: text(item["from_station"], 256),
    to_station: text(item["to_station"], 256),
    from_station_kv: finite(item["from_station_kv"]),
    to_station_kv: finite(item["to_station_kv"]),
    cct_status: item["cct_status"] as "COMP" | "NONCOMP",
    cct_status_label: item["cct_status_label"] as "competitive" | "non-competitive",
    raw_sced_timestamp: text(item["raw_sced_timestamp"], 32),
    repeated_hour_flag: item["repeated_hour_flag"],
    target_ts: target,
  };
}

function parseLinks(value: unknown): MarketGeographyLink[] {
  if (!Array.isArray(value)) throw new Error("invalid_market_geography_links");
  const seen = new Set<string>();
  let prior = "";
  return value.map((entry) => {
    const item = object(entry);
    if (!(["prices", "lmp", "constraints"] as unknown[]).includes(item["kind"]))
      throw new Error("invalid_market_geography_link");
    const kind = item["kind"] as MarketGeographyKind;
    const identity = text(item["identity"], 160);
    if (
      (kind === "prices" && !pointIdentities.has(identity)) ||
      (kind === "lmp" && !pointTypes.has(identity)) ||
      (kind === "constraints" && !/^[0-9a-f]{24}$/.test(identity))
    )
      throw new Error("invalid_market_geography_link");
    const start = integer(item["tile_start"]);
    const version = text(item["content_version"], 80);
    if (start % 86_400 || item["lod"] !== "native" || !/^mgr1-[0-9a-f]{64}$/.test(version))
      throw new Error("invalid_market_geography_link");
    const canonical = `/api/v2/market-geography/${kind}/${identity}/v1/${version}/1d/${start}/native`;
    const ordering = `${kind}\0${identity}\0${String(start).padStart(12, "0")}`;
    const key = `${kind}:${identity}:${start}`;
    if (item["url"] !== canonical || seen.has(key) || ordering <= prior)
      throw new Error("invalid_market_geography_link");
    prior = ordering;
    seen.add(key);
    return {
      kind,
      identity,
      tile_start: start,
      content_version: version,
      lod: "native",
      url: canonical,
    };
  });
}

export function parseMarketGeographyManifest(value: unknown): MarketGeographyManifest {
  const input = object(value);
  const expectedTopLevel = [
    "as_of",
    "attribution_policy",
    "attribution_status",
    "constraints",
    "deferred",
    "kind",
    "lmp_snapshot",
    "materialization_health",
    "methodology",
    "resources",
    "schema_version",
    "settlement_interval",
    "source_health",
    "visualization_policy",
  ];
  if (
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedTopLevel) ||
    input["schema_version"] !== 1 ||
    input["kind"] !== "market_geography_manifest" ||
    input["methodology"] !== "market-geography-v1" ||
    input["visualization_policy"] !== "settlement_price_matrix_not_geographic_boundaries" ||
    input["attribution_status"] !== "unavailable_without_shift_factors" ||
    input["attribution_policy"] !== "coincident_constraint_not_point_price_attribution"
  )
    throw new Error("invalid_market_geography_manifest");
  const settlementValue = object(input["settlement_interval"]);
  const settlementState = String(settlementValue["state"]);
  if (
    !Array.isArray(settlementValue["rows"]) ||
    !Array.isArray(settlementValue["reference_prices"]) ||
    !Array.isArray(settlementValue["missing"]) ||
    !["available", "partial", "unavailable"].includes(settlementState)
  )
    throw new Error("invalid_market_geography_settlement");
  const settlementRows = settlementValue["rows"].map(priceRow);
  const references = settlementValue["reference_prices"].map(priceRow);
  const settlementIds = [...settlementRows, ...references].map((row) =>
    pointIdentity(row.settlement_point, row.settlement_point_type),
  );
  if (
    new Set(settlementIds).size !== settlementIds.length ||
    settlementRows.some(
      (row) =>
        !heatmapIdentities.has(pointIdentity(row.settlement_point, row.settlement_point_type)),
    ) ||
    references.some(
      (row) =>
        !referenceIdentities.has(pointIdentity(row.settlement_point, row.settlement_point_type)),
    )
  )
    throw new Error("invalid_market_geography_settlement");
  const missing = settlementValue["missing"].map((item) => text(item, 160));
  const expectedMissing = [...pointIdentities]
    .filter((identity) => !settlementIds.includes(identity))
    .sort();
  if (
    JSON.stringify([...missing].sort()) !== JSON.stringify(expectedMissing) ||
    (settlementState === "available") !== (expectedMissing.length === 0)
  )
    throw new Error("invalid_market_geography_settlement");
  const settlementTarget = nullableInteger(settlementValue["target_ts"]);
  if ([...settlementRows, ...references].some((row) => row.target_ts !== settlementTarget))
    throw new Error("invalid_market_geography_settlement");
  const settlementSource =
    settlementValue["source"] === undefined
      ? undefined
      : source(settlementValue["source"], "NP6-905-CD");

  const lmpValue = object(input["lmp_snapshot"]);
  const lmpState = String(lmpValue["state"]);
  if (
    !Array.isArray(lmpValue["rows"]) ||
    !Array.isArray(lmpValue["missing"]) ||
    !["available", "partial", "unavailable"].includes(lmpState)
  )
    throw new Error("invalid_market_geography_lmp");
  const lmpRows = lmpValue["rows"].map(lmpRow);
  const lmpSeen = new Set<string>(lmpRows.map((row) => row.settlement_point));
  if (lmpSeen.size !== lmpRows.length) throw new Error("invalid_market_geography_lmp");
  const lmpMissing = lmpValue["missing"].map((item) => text(item, 256));
  const expectedLmpMissing = [...pointTypes.keys()].filter((point) => !lmpSeen.has(point)).sort();
  if (
    JSON.stringify([...lmpMissing].sort()) !== JSON.stringify(expectedLmpMissing) ||
    (lmpState === "available") !== (expectedLmpMissing.length === 0)
  )
    throw new Error("invalid_market_geography_lmp");
  const lmpTarget = nullableInteger(lmpValue["target_ts"]);
  if (lmpRows.some((row) => row.target_ts !== lmpTarget))
    throw new Error("invalid_market_geography_lmp");
  const lmpSource =
    lmpValue["source"] === undefined ? undefined : source(lmpValue["source"], "NP6-788-CD");

  const constraintValue = object(input["constraints"]);
  const constraintState = String(constraintValue["state"]);
  if (
    !Array.isArray(constraintValue["rows"]) ||
    !["available", "valid_empty", "unavailable", "unavailable_no_exact_sced"].includes(
      constraintState,
    ) ||
    typeof constraintValue["truncated"] !== "boolean"
  )
    throw new Error("invalid_market_geography_constraints");
  const constraints = constraintValue["rows"].map(constraintRow);
  const constraintTarget = nullableInteger(constraintValue["target_ts"]);
  const totalCount = integer(constraintValue["total_count"]);
  if (
    constraints.length > 20 ||
    constraints.some((row) => row.target_ts !== constraintTarget) ||
    new Set(constraints.map((row) => row.constraint_key)).size !== constraints.length ||
    constraintValue["truncated"] !== totalCount > 20 ||
    (constraintState === "available" && constraintTarget !== lmpTarget) ||
    (constraintState === "valid_empty" && (constraints.length !== 0 || totalCount !== 0)) ||
    (constraintState.startsWith("unavailable") && constraints.length !== 0) ||
    (constraintState === "available" &&
      (constraintValue["attribution_status"] !== "unavailable_without_shift_factors" ||
        constraintValue["attribution_policy"] !==
          "coincident_constraint_not_point_price_attribution"))
  )
    throw new Error("invalid_market_geography_constraints");
  const constraintSource =
    constraintValue["source"] === undefined
      ? undefined
      : source(constraintValue["source"], "NP6-86-CD");

  if (!Array.isArray(input["source_health"])) throw new Error("invalid_market_geography_health");
  const expectedHealth = ["ercot_mis_np6_788", "ercot_mis_np6_86", "ercot_mis_np6_905"];
  const sourceHealth = input["source_health"].map((entry) => {
    const item = object(entry);
    if (
      !expectedHealth.includes(String(item["source_id"])) ||
      !["healthy", "delayed", "stale", "failed", "unavailable"].includes(String(item["state"])) ||
      ![
        item["last_success_ts"],
        item["data_timestamp_ts"],
        item["data_age_seconds"],
        item["consecutive_failures"],
      ].every((value) => value === null || Number.isSafeInteger(value)) ||
      !Number.isSafeInteger(item["gap_count"]) ||
      Number(item["gap_count"]) < 0 ||
      Number(item["gap_count"]) > 10_000 ||
      !(item["last_error"] === null || typeof item["last_error"] === "string") ||
      Number(item["gap_count"]) > 0 !== (item["last_error"] === "document_gap")
    )
      throw new Error("invalid_market_geography_health");
    return item as MarketGeographyManifest["source_health"][number];
  });
  if (sourceHealth.length !== 3 || new Set(sourceHealth.map((item) => item.source_id)).size !== 3)
    throw new Error("invalid_market_geography_health");
  const materialization = object(input["materialization_health"]);
  if (!["healthy", "failed", "unavailable"].includes(String(materialization["state"])))
    throw new Error("invalid_market_geography_materialization");
  return {
    as_of: integer(input["as_of"]),
    settlement_interval: {
      state: settlementState as MarketGeographyManifest["settlement_interval"]["state"],
      target_ts: settlementTarget,
      ...(settlementSource ? { source: settlementSource } : {}),
      rows: settlementRows,
      reference_prices: references,
      missing,
    },
    lmp_snapshot: {
      state: lmpState as MarketGeographyManifest["lmp_snapshot"]["state"],
      target_ts: lmpTarget,
      ...(lmpSource ? { source: lmpSource } : {}),
      rows: lmpRows,
      missing: lmpMissing,
    },
    constraints: {
      state: constraintState as MarketGeographyManifest["constraints"]["state"],
      target_ts: constraintTarget,
      ...(constraintSource ? { source: constraintSource } : {}),
      rows: constraints,
      total_count: totalCount,
      truncated: constraintValue["truncated"],
    },
    source_health: sourceHealth,
    materialization_health: materialization as MarketGeographyManifest["materialization_health"],
    resources: parseLinks(input["resources"]),
  };
}

export function parseMarketGeographyResource(
  value: unknown,
  link: MarketGeographyLink,
): MarketGeographyResource {
  const input = object(value);
  if (
    input["schema_version"] !== 1 ||
    input["methodology"] !== "market-geography-v1" ||
    input["kind"] !== link.kind ||
    input["identity"] !== link.identity ||
    input["tile_start"] !== link.tile_start ||
    input["tile_end"] !== link.tile_start + 86_400 ||
    input["lod"] !== "native" ||
    input["content_version"] !== link.content_version ||
    !Array.isArray(input["rows"])
  )
    throw new Error("invalid_market_geography_resource");
  let prior = link.tile_start - 1;
  const rows = input["rows"].map((entry) => {
    const row = object(entry);
    const target = integer(row["target_ts"]);
    if (target < link.tile_start || target >= link.tile_start + 86_400 || target <= prior)
      throw new Error("invalid_market_geography_resource_rows");
    prior = target;
    if (link.kind === "prices") {
      if (
        pointIdentity(text(row["settlement_point"]), text(row["settlement_point_type"])) !==
        link.identity
      )
        throw new Error("invalid_market_geography_resource_rows");
      finite(row["value"]);
      source(row["source"], "NP6-905-CD");
    } else if (link.kind === "lmp") {
      if (row["settlement_point"] !== link.identity)
        throw new Error("invalid_market_geography_resource_rows");
      finite(row["value"]);
      source(row["source"], "NP6-788-CD");
    } else {
      if (row["constraint_key"] !== link.identity)
        throw new Error("invalid_market_geography_resource_rows");
      constraintRow(row);
      source(row["source"], "NP6-86-CD");
    }
    return row;
  });
  return {
    kind: link.kind,
    identity: link.identity,
    tile_start: link.tile_start,
    tile_end: link.tile_start + 86_400,
    unit: text(input["unit"], 64),
    rows,
  };
}

export async function loadMarketGeographyManifest(signal?: AbortSignal) {
  const response = await fetch("/api/v1/market-geography", signal ? { signal } : {});
  if (!response.ok) throw new Error(`market_geography_manifest_${response.status}`);
  return parseMarketGeographyManifest(await response.json());
}

export async function loadMarketGeographyResource(link: MarketGeographyLink, signal?: AbortSignal) {
  const response = await fetch(link.url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`market_geography_resource_${response.status}`);
  return parseMarketGeographyResource(await response.json(), link);
}
