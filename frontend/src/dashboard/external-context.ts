export const EXTERNAL_CONTEXT_POLICY =
  "external_context_not_ercot_operational_authority_or_live_emissions_measurement" as const;

export type ExternalContextStream = "eia930_demand" | "epa_egrid" | "henry_hub_daily";
export type ExternalContextSectionState = "available" | "disabled" | "failed" | "unavailable";
export type ExternalContextFreshness = "fresh" | "not_applicable" | "stale";

type SelectedBase = { content_version: string; url: string; retrieved_at: number };

export type Eia930Selected = SelectedBase & {
  latest_demand_interval_end: number;
  latest_interchange_interval_end: number;
  source_url: string;
};

export type HenryHubSelected = SelectedBase & {
  latest_market_date: string;
  source_url: string;
};

export type EgridSelected = SelectedBase & {
  data_year: number;
  revision: number;
  released_on: string;
  subregion: "ERCT";
  subregion_name: "ERCOT All";
  source_page_url: string;
  artifact_url: string;
};

export type ExternalContextSourceHealth = {
  source_id: "eia930_erco" | "eia_henry_hub" | "epa_egrid_erct";
  state: "disabled" | "failed" | "healthy" | "stale" | "unavailable";
  availability_status: "available" | "disabled" | "unavailable";
  content_version: string | null;
  last_attempt_ts: number | null;
  last_success_ts: number | null;
  source_updated_at: number | null;
  retrieved_at: number | null;
  cache_fresh_until: number | null;
  consecutive_failures: number;
  last_error: string | null;
  materialization: {
    state: "failed" | "healthy" | "unavailable";
    last_success_ts: number | null;
    consecutive_failures: number | null;
    last_error: string | null;
  };
};

type ExternalContextSection<T> = {
  state: ExternalContextSectionState;
  reason: string | null;
  freshness: ExternalContextFreshness | null;
  selected: T | null;
};

export type ExternalContextManifest = {
  schema: 1;
  kind: "external_context";
  policy: typeof EXTERNAL_CONTEXT_POLICY;
  generated_at: number;
  eia_930: ExternalContextSection<Eia930Selected>;
  natural_gas: ExternalContextSection<HenryHubSelected>;
  epa_egrid: ExternalContextSection<EgridSelected>;
  epa_camd: {
    state: "unavailable";
    reason: "ercot_footprint_and_coverage_methodology_not_frozen";
  };
  source_health: [
    ExternalContextSourceHealth,
    ExternalContextSourceHealth,
    ExternalContextSourceHealth,
  ];
};

export type Eia930Resource = {
  schema: 1;
  kind: "external_context_resource";
  policy: typeof EXTERNAL_CONTEXT_POLICY;
  stream: "eia930_demand";
  publication: { retrieved_at: number; source_url: string };
  interval_basis: "hour_ending_utc_half_open";
  rows: Array<{
    period: string;
    interval_start: number;
    interval_end: number;
    type: "D" | "TI";
    type_name: "Demand" | "Total Interchange";
    value_decimal: string;
    value_mwh: number;
  }>;
};

export type HenryHubResource = {
  schema: 1;
  kind: "external_context_resource";
  policy: typeof EXTERNAL_CONTEXT_POLICY;
  stream: "henry_hub_daily";
  publication: {
    retrieved_at: number;
    series_id: "NG.RNGWHHD.D";
    source_url: string;
    source_page_url: string;
    source_unit: "dollars per million Btu";
  };
  unit: "usd_per_mmbtu";
  date_basis: "source_market_date_no_timezone";
  rows: Array<{ market_date: string; value_decimal: string; price: number }>;
};

export const EGRID_METRICS = [
  ["co2", "CO₂"],
  ["ch4", "CH₄"],
  ["n2o", "N₂O"],
  ["co2e", "CO₂e"],
  ["annual_nox", "Annual NOₓ"],
  ["ozone_season_nox", "Ozone Season NOₓ"],
  ["so2", "SO₂"],
] as const;

export type EgridResource = {
  schema: 1;
  kind: "external_context_resource";
  policy: typeof EXTERNAL_CONTEXT_POLICY;
  stream: "epa_egrid";
  publication: {
    data_year: number;
    revision: number;
    released_on: string;
    retrieved_at: number;
    source_page_url: string;
    artifact_url: string;
    workbook_sha256: string;
    table_title: string;
    production_model: string | null;
    production_version: string | null;
  };
  subregion: "ERCT";
  subregion_name: "ERCOT All";
  rates: Array<{
    metric_id: (typeof EGRID_METRICS)[number][0];
    source_header: (typeof EGRID_METRICS)[number][1];
    value: number;
    unit: "lb_mwh";
  }>;
};

export type ExternalContextResource = EgridResource | Eia930Resource | HenryHubResource;
export type ExternalContextSelected = EgridSelected | Eia930Selected | HenryHubSelected;

const VERSION = /^xc1-[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MARKET_DATE = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])T([01]\d|2[0-3])$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const STREAMS = ["eia930_demand", "henry_hub_daily", "epa_egrid"] as const;
const HEALTH_IDS = ["eia930_erco", "eia_henry_hub", "epa_egrid_erct"] as const;

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function integer(value: unknown, code: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(code);
  }
  return value as number;
}

function timestamp(value: unknown, code: string): number {
  const result = integer(value, code, 4_102_444_800);
  if (result < 1) throw new Error(code);
  return result;
}

function nullableTimestamp(value: unknown, code: string): number | null {
  return value === null ? null : timestamp(value, code);
}

function boundedString(value: unknown, code: string, max = 2_000): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    new TextEncoder().encode(value).length > max
  ) {
    throw new Error(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  return value === null ? null : boundedString(value, code);
}

function nullableProductionString(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) throw new Error(code);
  return value;
}

function finite(
  value: unknown,
  code: string,
  nonnegative = false,
  maximum = 1_000_000_000,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (nonnegative && value < 0) ||
    Math.abs(value) > maximum
  ) {
    throw new Error(code);
  }
  return Object.is(value, -0) ? 0 : value;
}

function decimal(value: unknown, numeric: number, code: string): string {
  const text = boundedString(value, code, 100);
  if (!DECIMAL.test(text) || !Number.isFinite(Number(text)) || Number(text) !== numeric) {
    throw new Error(code);
  }
  return text;
}

function date(value: unknown, code: string): string {
  if (typeof value !== "string" || !MARKET_DATE.test(value)) throw new Error(code);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(code);
  }
  return value;
}

function httpsUrl(value: unknown, code: string, host: string): string {
  const text = boundedString(value, code);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(code);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(code);
  }
  return text;
}

function eia930SourceUrl(value: unknown, code: string): string {
  const result = httpsUrl(value, code, "api.eia.gov");
  if (result !== "https://api.eia.gov/v2/electricity/rto/region-data/data/") throw new Error(code);
  return result;
}

function henrySourceUrl(value: unknown, code: string): string {
  const result = httpsUrl(value, code, "api.eia.gov");
  if (result !== "https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D") throw new Error(code);
  return result;
}

function egridPageUrl(value: unknown, code: string): string {
  const result = httpsUrl(value, code, "www.epa.gov");
  if (result !== "https://www.epa.gov/egrid/summary-data") throw new Error(code);
  return result;
}

function version(value: unknown, code: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error(code);
  return value;
}

function selectedUrl(
  value: unknown,
  stream: ExternalContextStream,
  contentVersion: string,
): string {
  const url = boundedString(value, "invalid_external_context_selected", 1_000);
  if (url !== `/api/v2/external-context/${stream}/v1/${contentVersion}`) {
    throw new Error("invalid_external_context_selected");
  }
  return url;
}

function selectedBase(
  value: Record<string, unknown>,
  stream: ExternalContextStream,
  generatedAt: number,
): SelectedBase {
  const contentVersion = version(value["content_version"], "invalid_external_context_selected");
  const retrievedAt = timestamp(value["retrieved_at"], "invalid_external_context_selected");
  if (retrievedAt > generatedAt) throw new Error("invalid_external_context_selected");
  return {
    content_version: contentVersion,
    url: selectedUrl(value["url"], stream, contentVersion),
    retrieved_at: retrievedAt,
  };
}

function parseEia930Selected(value: unknown, generatedAt: number): Eia930Selected {
  const item = object(value, "invalid_external_context_selected");
  exact(
    item,
    [
      "content_version",
      "url",
      "retrieved_at",
      "latest_demand_interval_end",
      "latest_interchange_interval_end",
      "source_url",
    ],
    "invalid_external_context_selected",
  );
  const base = selectedBase(item, "eia930_demand", generatedAt);
  const latestDemand = timestamp(
    item["latest_demand_interval_end"],
    "invalid_external_context_selected",
  );
  const latestInterchange = timestamp(
    item["latest_interchange_interval_end"],
    "invalid_external_context_selected",
  );
  if (latestDemand > base.retrieved_at || latestInterchange > base.retrieved_at) {
    throw new Error("invalid_external_context_selected");
  }
  return {
    ...base,
    latest_demand_interval_end: latestDemand,
    latest_interchange_interval_end: latestInterchange,
    source_url: eia930SourceUrl(item["source_url"], "invalid_external_context_selected"),
  };
}

function parseHenrySelected(value: unknown, generatedAt: number): HenryHubSelected {
  const item = object(value, "invalid_external_context_selected");
  exact(
    item,
    ["content_version", "url", "retrieved_at", "latest_market_date", "source_url"],
    "invalid_external_context_selected",
  );
  return {
    ...selectedBase(item, "henry_hub_daily", generatedAt),
    latest_market_date: date(item["latest_market_date"], "invalid_external_context_selected"),
    source_url: henrySourceUrl(item["source_url"], "invalid_external_context_selected"),
  };
}

function parseEgridSelected(value: unknown, generatedAt: number): EgridSelected {
  const item = object(value, "invalid_external_context_selected");
  exact(
    item,
    [
      "content_version",
      "url",
      "data_year",
      "revision",
      "released_on",
      "retrieved_at",
      "subregion",
      "subregion_name",
      "source_page_url",
      "artifact_url",
    ],
    "invalid_external_context_selected",
  );
  const artifact = httpsUrl(
    item["artifact_url"],
    "invalid_external_context_selected",
    "www.epa.gov",
  );
  const revision = integer(item["revision"], "invalid_external_context_selected", 100);
  const dataYear = integer(item["data_year"], "invalid_external_context_selected", 2200);
  if (dataYear < 2000) throw new Error("invalid_external_context_selected");
  const suffix = revision === 0 ? "" : `_rev${String(revision)}`;
  if (
    !new RegExp(
      `^https://www\\.epa\\.gov/system/files/documents/\\d{4}-\\d{2}/summary_tables${suffix}\\.xlsx$`,
    ).test(artifact)
  ) {
    throw new Error("invalid_external_context_selected");
  }
  return {
    ...selectedBase(item, "epa_egrid", generatedAt),
    data_year: dataYear,
    revision,
    released_on: date(item["released_on"], "invalid_external_context_selected"),
    retrieved_at: timestamp(item["retrieved_at"], "invalid_external_context_selected"),
    subregion: item["subregion"] === "ERCT" ? "ERCT" : fail("invalid_external_context_selected"),
    subregion_name:
      item["subregion_name"] === "ERCOT All"
        ? "ERCOT All"
        : fail("invalid_external_context_selected"),
    source_page_url: egridPageUrl(item["source_page_url"], "invalid_external_context_selected"),
    artifact_url: artifact,
  };
}

function fail(code: string): never {
  throw new Error(code);
}

function section<T>(
  value: unknown,
  parseSelected: (selected: unknown) => T,
): ExternalContextSection<T> {
  const item = object(value, "invalid_external_context_section");
  exact(item, ["state", "reason", "freshness", "selected"], "invalid_external_context_section");
  if (
    !(["available", "disabled", "failed", "unavailable"] as const).includes(item["state"] as never)
  ) {
    throw new Error("invalid_external_context_section");
  }
  const state = item["state"] as ExternalContextSectionState;
  const available = state === "available";
  if (
    available !== (item["selected"] !== null) ||
    available !== (item["reason"] === null) ||
    available !== (item["freshness"] !== null)
  ) {
    throw new Error("invalid_external_context_section");
  }
  if (state === "disabled" && item["reason"] !== "eia_api_key_not_configured") {
    throw new Error("invalid_external_context_section");
  }
  const freshness = item["freshness"];
  if (
    freshness !== null &&
    !(["fresh", "stale", "not_applicable"] as const).includes(freshness as never)
  ) {
    throw new Error("invalid_external_context_section");
  }
  return {
    state,
    reason:
      item["reason"] === null
        ? null
        : boundedString(item["reason"], "invalid_external_context_section", 200),
    freshness: freshness as ExternalContextFreshness | null,
    selected: item["selected"] === null ? null : parseSelected(item["selected"]),
  };
}

function health(
  value: unknown,
  expectedId: (typeof HEALTH_IDS)[number],
): ExternalContextSourceHealth {
  const item = object(value, "invalid_external_context_source_health");
  exact(
    item,
    [
      "source_id",
      "state",
      "availability_status",
      "content_version",
      "last_attempt_ts",
      "last_success_ts",
      "source_updated_at",
      "retrieved_at",
      "cache_fresh_until",
      "consecutive_failures",
      "last_error",
      "materialization",
    ],
    "invalid_external_context_source_health",
  );
  if (
    item["source_id"] !== expectedId ||
    !(["healthy", "stale", "failed", "disabled", "unavailable"] as const).includes(
      item["state"] as never,
    ) ||
    !(["available", "disabled", "unavailable"] as const).includes(
      item["availability_status"] as never,
    )
  ) {
    throw new Error("invalid_external_context_source_health");
  }
  const materialization = object(item["materialization"], "invalid_external_context_source_health");
  exact(
    materialization,
    ["state", "last_success_ts", "consecutive_failures", "last_error"],
    "invalid_external_context_source_health",
  );
  if (
    !(["healthy", "failed", "unavailable"] as const).includes(materialization["state"] as never)
  ) {
    throw new Error("invalid_external_context_source_health");
  }
  const result: ExternalContextSourceHealth = {
    source_id: expectedId,
    state: item["state"] as ExternalContextSourceHealth["state"],
    availability_status: item[
      "availability_status"
    ] as ExternalContextSourceHealth["availability_status"],
    content_version:
      item["content_version"] === null
        ? null
        : version(item["content_version"], "invalid_external_context_source_health"),
    last_attempt_ts: nullableTimestamp(
      item["last_attempt_ts"],
      "invalid_external_context_source_health",
    ),
    last_success_ts: nullableTimestamp(
      item["last_success_ts"],
      "invalid_external_context_source_health",
    ),
    source_updated_at: nullableTimestamp(
      item["source_updated_at"],
      "invalid_external_context_source_health",
    ),
    retrieved_at: nullableTimestamp(item["retrieved_at"], "invalid_external_context_source_health"),
    cache_fresh_until: nullableTimestamp(
      item["cache_fresh_until"],
      "invalid_external_context_source_health",
    ),
    consecutive_failures: integer(
      item["consecutive_failures"],
      "invalid_external_context_source_health",
      1_000_000,
    ),
    last_error: nullableString(item["last_error"], "invalid_external_context_source_health"),
    materialization: {
      state: materialization["state"] as ExternalContextSourceHealth["materialization"]["state"],
      last_success_ts: nullableTimestamp(
        materialization["last_success_ts"],
        "invalid_external_context_source_health",
      ),
      consecutive_failures:
        materialization["consecutive_failures"] === null
          ? null
          : integer(
              materialization["consecutive_failures"],
              "invalid_external_context_source_health",
              1_000_000,
            ),
      last_error: nullableString(
        materialization["last_error"],
        "invalid_external_context_source_health",
      ),
    },
  };
  if (result.source_id === "epa_egrid_erct" && result.source_updated_at !== null) {
    throw new Error("invalid_external_context_source_health");
  }
  if (result.state === "disabled") {
    if (
      result.availability_status !== "disabled" ||
      result.content_version !== null ||
      result.last_attempt_ts !== null ||
      result.last_success_ts !== null ||
      result.source_updated_at !== null ||
      result.retrieved_at !== null ||
      result.cache_fresh_until !== null ||
      result.consecutive_failures !== 0 ||
      result.last_error !== null ||
      result.materialization.state !== "unavailable"
    ) {
      throw new Error("invalid_external_context_source_health");
    }
  }
  return result;
}

export function parseExternalContextManifest(value: unknown): ExternalContextManifest {
  const item = object(value, "invalid_external_context_manifest");
  exact(
    item,
    [
      "schema",
      "kind",
      "policy",
      "generated_at",
      "eia_930",
      "natural_gas",
      "epa_egrid",
      "epa_camd",
      "source_health",
    ],
    "invalid_external_context_manifest",
  );
  if (
    item["schema"] !== 1 ||
    item["kind"] !== "external_context" ||
    item["policy"] !== EXTERNAL_CONTEXT_POLICY
  ) {
    throw new Error("invalid_external_context_manifest");
  }
  const generatedAt = timestamp(item["generated_at"], "invalid_external_context_manifest");
  const eia930 = section(item["eia_930"], (selected) => parseEia930Selected(selected, generatedAt));
  const naturalGas = section(item["natural_gas"], (selected) =>
    parseHenrySelected(selected, generatedAt),
  );
  const egrid = section(item["epa_egrid"], (selected) => parseEgridSelected(selected, generatedAt));
  const camd = object(item["epa_camd"], "invalid_external_context_manifest");
  exact(camd, ["state", "reason"], "invalid_external_context_manifest");
  if (
    camd["state"] !== "unavailable" ||
    camd["reason"] !== "ercot_footprint_and_coverage_methodology_not_frozen"
  ) {
    throw new Error("invalid_external_context_manifest");
  }
  if (!Array.isArray(item["source_health"]) || item["source_health"].length !== 3) {
    throw new Error("invalid_external_context_source_health");
  }
  const sourceHealth = [
    health(item["source_health"][0], HEALTH_IDS[0]),
    health(item["source_health"][1], HEALTH_IDS[1]),
    health(item["source_health"][2], HEALTH_IDS[2]),
  ] as const;
  if (
    (eia930.selected !== null &&
      sourceHealth[0].content_version !== eia930.selected.content_version) ||
    (naturalGas.selected !== null &&
      sourceHealth[1].content_version !== naturalGas.selected.content_version) ||
    (egrid.selected !== null && sourceHealth[2].content_version !== egrid.selected.content_version)
  ) {
    throw new Error("invalid_external_context_source_health");
  }
  return {
    schema: 1,
    kind: "external_context",
    policy: EXTERNAL_CONTEXT_POLICY,
    generated_at: generatedAt,
    eia_930: eia930,
    natural_gas: naturalGas,
    epa_egrid: egrid,
    epa_camd: {
      state: "unavailable",
      reason: "ercot_footprint_and_coverage_methodology_not_frozen",
    },
    source_health: [...sourceHealth],
  };
}

function commonResource(value: unknown): Record<string, unknown> {
  const item = object(value, "invalid_external_context_resource");
  if (
    item["schema"] !== 1 ||
    item["kind"] !== "external_context_resource" ||
    item["policy"] !== EXTERNAL_CONTEXT_POLICY ||
    !(STREAMS as readonly unknown[]).includes(item["stream"])
  ) {
    throw new Error("invalid_external_context_resource");
  }
  return item;
}

function parseEia930Resource(
  item: Record<string, unknown>,
  selected: Eia930Selected,
): Eia930Resource {
  exact(
    item,
    ["schema", "kind", "policy", "stream", "publication", "interval_basis", "rows"],
    "invalid_external_context_resource",
  );
  if (item["stream"] !== "eia930_demand" || item["interval_basis"] !== "hour_ending_utc_half_open")
    fail("invalid_external_context_resource");
  const publication = object(item["publication"], "invalid_external_context_resource");
  exact(publication, ["retrieved_at", "source_url"], "invalid_external_context_resource");
  if (
    publication["retrieved_at"] !== selected.retrieved_at ||
    publication["source_url"] !== selected.source_url
  )
    fail("invalid_external_context_resource");
  if (!Array.isArray(item["rows"]) || item["rows"].length > 672)
    fail("invalid_external_context_resource");
  let previous = "";
  const identities = new Set<string>();
  const rows = item["rows"].map((raw) => {
    const row = object(raw, "invalid_external_context_resource");
    exact(
      row,
      [
        "period",
        "interval_start",
        "interval_end",
        "type",
        "type_name",
        "value_decimal",
        "value_mwh",
      ],
      "invalid_external_context_resource",
    );
    if (typeof row["period"] !== "string" || !PERIOD.test(row["period"]))
      fail("invalid_external_context_resource");
    const intervalStart = timestamp(row["interval_start"], "invalid_external_context_resource");
    const intervalEnd = timestamp(row["interval_end"], "invalid_external_context_resource");
    const expectedEnd = Date.parse(`${row["period"]}:00:00Z`) / 1_000;
    if (
      intervalEnd - intervalStart !== 3_600 ||
      intervalEnd !== expectedEnd ||
      intervalEnd > selected.retrieved_at
    )
      fail("invalid_external_context_resource");
    const type = row["type"];
    const typeName =
      type === "D"
        ? "Demand"
        : type === "TI"
          ? "Total Interchange"
          : fail("invalid_external_context_resource");
    if (row["type_name"] !== typeName) fail("invalid_external_context_resource");
    const value = finite(row["value_mwh"], "invalid_external_context_resource", type === "D");
    const identity = `${String(intervalEnd).padStart(12, "0")}:${type}`;
    if (identities.has(identity) || identity <= previous) fail("invalid_external_context_resource");
    identities.add(identity);
    previous = identity;
    return {
      period: row["period"],
      interval_start: intervalStart,
      interval_end: intervalEnd,
      type,
      type_name: typeName,
      value_decimal: decimal(row["value_decimal"], value, "invalid_external_context_resource"),
      value_mwh: value,
    } as Eia930Resource["rows"][number];
  });
  if (rows.length && rows.at(-1)!.interval_end - rows[0]!.interval_start > 14 * 86_400)
    fail("invalid_external_context_resource");
  const latestDemand = rows.filter((row) => row.type === "D").at(-1)?.interval_end;
  const latestInterchange = rows.filter((row) => row.type === "TI").at(-1)?.interval_end;
  if (
    latestDemand !== selected.latest_demand_interval_end ||
    latestInterchange !== selected.latest_interchange_interval_end
  ) {
    fail("invalid_external_context_resource");
  }
  return {
    schema: 1,
    kind: "external_context_resource",
    policy: EXTERNAL_CONTEXT_POLICY,
    stream: "eia930_demand",
    publication: { retrieved_at: selected.retrieved_at, source_url: selected.source_url },
    interval_basis: "hour_ending_utc_half_open",
    rows,
  };
}

function parseHenryResource(
  item: Record<string, unknown>,
  selected: HenryHubSelected,
): HenryHubResource {
  exact(
    item,
    ["schema", "kind", "policy", "stream", "publication", "unit", "date_basis", "rows"],
    "invalid_external_context_resource",
  );
  if (
    item["stream"] !== "henry_hub_daily" ||
    item["unit"] !== "usd_per_mmbtu" ||
    item["date_basis"] !== "source_market_date_no_timezone"
  )
    fail("invalid_external_context_resource");
  const publication = object(item["publication"], "invalid_external_context_resource");
  exact(
    publication,
    ["retrieved_at", "series_id", "source_url", "source_page_url", "source_unit"],
    "invalid_external_context_resource",
  );
  if (
    publication["retrieved_at"] !== selected.retrieved_at ||
    publication["series_id"] !== "NG.RNGWHHD.D" ||
    publication["source_url"] !== selected.source_url ||
    publication["source_page_url"] !== "https://www.eia.gov/dnav/ng/hist/rngwhhdd.htm" ||
    publication["source_unit"] !== "dollars per million Btu"
  )
    fail("invalid_external_context_resource");
  if (!Array.isArray(item["rows"]) || item["rows"].length > 400)
    fail("invalid_external_context_resource");
  let previous = "";
  const rows = item["rows"].map((raw) => {
    const row = object(raw, "invalid_external_context_resource");
    exact(row, ["market_date", "value_decimal", "price"], "invalid_external_context_resource");
    const marketDate = date(row["market_date"], "invalid_external_context_resource");
    if (marketDate <= previous) fail("invalid_external_context_resource");
    previous = marketDate;
    const price = finite(row["price"], "invalid_external_context_resource");
    return {
      market_date: marketDate,
      value_decimal: decimal(row["value_decimal"], price, "invalid_external_context_resource"),
      price,
    };
  });
  if (rows.at(-1)?.market_date !== selected.latest_market_date)
    fail("invalid_external_context_resource");
  return {
    schema: 1,
    kind: "external_context_resource",
    policy: EXTERNAL_CONTEXT_POLICY,
    stream: "henry_hub_daily",
    publication: {
      retrieved_at: selected.retrieved_at,
      series_id: "NG.RNGWHHD.D",
      source_url: selected.source_url,
      source_page_url: "https://www.eia.gov/dnav/ng/hist/rngwhhdd.htm",
      source_unit: "dollars per million Btu",
    },
    unit: "usd_per_mmbtu",
    date_basis: "source_market_date_no_timezone",
    rows,
  };
}

function parseEgridResource(item: Record<string, unknown>, selected: EgridSelected): EgridResource {
  exact(
    item,
    ["schema", "kind", "policy", "stream", "publication", "subregion", "subregion_name", "rates"],
    "invalid_external_context_resource",
  );
  if (
    item["stream"] !== "epa_egrid" ||
    item["subregion"] !== "ERCT" ||
    item["subregion_name"] !== "ERCOT All"
  )
    fail("invalid_external_context_resource");
  const publication = object(item["publication"], "invalid_external_context_resource");
  exact(
    publication,
    [
      "data_year",
      "revision",
      "released_on",
      "retrieved_at",
      "source_page_url",
      "artifact_url",
      "workbook_sha256",
      "table_title",
      "production_model",
      "production_version",
    ],
    "invalid_external_context_resource",
  );
  if (
    publication["data_year"] !== selected.data_year ||
    publication["revision"] !== selected.revision ||
    publication["released_on"] !== selected.released_on ||
    publication["retrieved_at"] !== selected.retrieved_at ||
    publication["source_page_url"] !== selected.source_page_url ||
    publication["artifact_url"] !== selected.artifact_url ||
    typeof publication["workbook_sha256"] !== "string" ||
    !SHA256.test(publication["workbook_sha256"])
  )
    fail("invalid_external_context_resource");
  const expectedTitle = `1. Subregion Output Emission Rates (eGRID${String(selected.data_year)})`;
  if (publication["table_title"] !== expectedTitle) fail("invalid_external_context_resource");
  if (!Array.isArray(item["rates"]) || item["rates"].length !== EGRID_METRICS.length)
    fail("invalid_external_context_resource");
  const rates = item["rates"].map((raw, index) => {
    const rate = object(raw, "invalid_external_context_resource");
    exact(
      rate,
      ["metric_id", "source_header", "value", "unit"],
      "invalid_external_context_resource",
    );
    const expected = EGRID_METRICS[index]!;
    if (
      rate["metric_id"] !== expected[0] ||
      rate["source_header"] !== expected[1] ||
      rate["unit"] !== "lb_mwh"
    )
      fail("invalid_external_context_resource");
    return {
      metric_id: expected[0],
      source_header: expected[1],
      value: finite(rate["value"], "invalid_external_context_resource", true, 10_000_000),
      unit: "lb_mwh" as const,
    };
  });
  return {
    schema: 1,
    kind: "external_context_resource",
    policy: EXTERNAL_CONTEXT_POLICY,
    stream: "epa_egrid",
    publication: {
      data_year: selected.data_year,
      revision: selected.revision,
      released_on: selected.released_on,
      retrieved_at: selected.retrieved_at,
      source_page_url: selected.source_page_url,
      artifact_url: selected.artifact_url,
      workbook_sha256: publication["workbook_sha256"],
      table_title: expectedTitle,
      production_model: nullableProductionString(
        publication["production_model"],
        "invalid_external_context_resource",
      ),
      production_version: nullableProductionString(
        publication["production_version"],
        "invalid_external_context_resource",
      ),
    },
    subregion: "ERCT",
    subregion_name: "ERCOT All",
    rates,
  };
}

export function parseExternalContextResource(
  value: unknown,
  stream: ExternalContextStream,
  selected: ExternalContextSelected,
): ExternalContextResource {
  const item = commonResource(value);
  if (item["stream"] !== stream) throw new Error("invalid_external_context_resource");
  if (stream === "eia930_demand") return parseEia930Resource(item, selected as Eia930Selected);
  if (stream === "henry_hub_daily") return parseHenryResource(item, selected as HenryHubSelected);
  return parseEgridResource(item, selected as EgridSelected);
}
