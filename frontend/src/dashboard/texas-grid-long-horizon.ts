export const TEXAS_GRID_POLICY =
  "official_planning_snapshots_not_committed_capacity_or_realization_forecast" as const;

export type TexasGridStream = "gis" | "resource_capacity_trend";
export type TexasGridSectionState = "available" | "failed" | "stale" | "unavailable";

export type TexasGridSelectedResource = {
  source_period: string;
  published_at: number;
  retrieved_at: number;
  content_version: string;
  url: string;
  source_page_url: string;
};

export type TexasGridSourceHealth = {
  source_id: "ercot_gis_report" | "ercot_resource_capacity_trend";
  state: "failed" | "healthy" | "stale" | "unavailable";
  availability_status: "available" | "unavailable" | null;
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

export type TexasGridManifest = {
  schema: 1;
  kind: "texas_grid_long_horizon";
  policy: typeof TEXAS_GRID_POLICY;
  generated_at: number;
  generator_interconnection: {
    state: TexasGridSectionState;
    selected: TexasGridSelectedResource | null;
  };
  resource_capacity_trend: {
    state: TexasGridSectionState;
    selected: TexasGridSelectedResource | null;
  };
  long_term_load_forecast: {
    state: "unavailable";
    reason: "units_not_authoritatively_frozen";
  };
  large_load: {
    state: "unavailable";
    reason: "no_stable_public_machine_readable_status_source";
  };
  retirements: {
    state: "unavailable";
    reason: "no_verified_gross_retirement_source";
  };
  source_health: [TexasGridSourceHealth, TexasGridSourceHealth];
};

export type TexasGridPhase = { id: string; label: string };
export type TexasGridFuel = { code: string; label: string };
export type TexasGridGisAggregate = {
  phase: string;
  fuel: string;
  count: number;
  capacity_mw: number;
};

export type TexasGridGisResource = {
  schema: 1;
  kind: "texas_grid_long_horizon";
  policy: typeof TEXAS_GRID_POLICY;
  stream: "gis";
  publication: {
    source_period: string;
    published_at: number;
    retrieved_at: number;
    source_page_url: string;
    workbook_sha256: string;
  };
  unit: "MW";
  statistic: "project_count_and_source_capacity_sum";
  phases: TexasGridPhase[];
  fuels: TexasGridFuel[];
  aggregates: TexasGridGisAggregate[];
  limits: { max_aggregates: 132 };
};

export type TexasGridCapacityRow = {
  official_total_mw: number;
  operational_mw: number;
  ia_financial_security_posted_mw: number;
  ia_no_financial_security_mw: number;
  other_planned_mw: number | null;
  small_generator_mw: number;
};

export type TexasGridTrendSeries = {
  series_id: "battery" | "gas_combined_cycle" | "gas_other" | "solar" | "wind";
  label: string;
  annual: Array<TexasGridCapacityRow & { year: number }>;
  planned_monthly: Array<TexasGridCapacityRow & { month: string }>;
};

export type TexasGridTrendResource = {
  schema: 1;
  kind: "texas_grid_long_horizon";
  policy: typeof TEXAS_GRID_POLICY;
  stream: "resource_capacity_trend";
  publication: {
    source_period: string;
    published_at: number;
    retrieved_at: number;
    source_page_url: string;
    annual_workbook_url: string;
    annual_workbook_sha256: string;
    planned_monthly_workbook_url: string;
    planned_monthly_workbook_sha256: string;
  };
  unit: "MW";
  series: TexasGridTrendSeries[];
  limits: { max_annual_rows_per_series: 100; max_planned_monthly_rows_per_series: 120 };
};

export type TexasGridResource = TexasGridGisResource | TexasGridTrendResource;

const VERSION = /^tg1-[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MONTH = /^(19|20|21|22)\d\d-(0[1-9]|1[0-2])$/;
const SAME_ORIGIN_RESOURCE =
  /^\/api\/v2\/texas-grid\/(gis|resource_capacity_trend)\/v1\/(tg1-[0-9a-f]{64})$/;
const SOURCE_IDS = ["ercot_gis_report", "ercot_resource_capacity_trend"] as const;
const SERIES_IDS = ["wind", "solar", "battery", "gas_combined_cycle", "gas_other"] as const;
const FUEL_CODES = [
  "BIO",
  "COA",
  "GAS",
  "GEO",
  "HYD",
  "NUC",
  "OIL",
  "OTH",
  "PET",
  "SOL",
  "WAT",
  "WIN",
] as const;
const FUEL_LABELS = [
  "Biomass",
  "Coal",
  "Gas",
  "Geothermal",
  "Hydrogen",
  "Nuclear",
  "Fuel Oil",
  "Other",
  "Petcoke",
  "Solar",
  "Water",
  "Wind",
] as const;
const FUEL_IDS = [
  "biomass",
  "coal",
  "gas",
  "geothermal",
  "hydrogen",
  "nuclear",
  "fuel_oil",
  "other",
  "petcoke",
  "solar",
  "water",
  "wind",
] as const;
const SERIES_LABELS = ["Wind", "Solar", "Battery", "Gas - Combined Cycle", "Gas - Other"] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const PHASES = [
  ["ss_started_fis_not_started_no_ia", "SS Started, FIS Not Started, No IA"],
  ["ss_started_fis_started_no_ia", "SS Started, FIS Started, No IA"],
  ["ss_completed_fis_not_started_no_ia", "SS Completed, FIS Not Started, No IA"],
  ["ss_completed_fis_started_no_ia", "SS Completed, FIS Started, No IA"],
  ["ss_completed_fis_completed_no_ia", "SS Completed, FIS Completed, No IA"],
  ["ss_started_fis_not_started_ia", "SS Started, FIS Not Started, IA"],
  ["ss_started_fis_started_ia", "SS Started, FIS Started, IA"],
  ["ss_completed_fis_not_started_ia", "SS Completed, FIS Not Started, IA"],
  ["ss_completed_fis_started_ia", "SS Completed, FIS Started, IA"],
  ["ss_completed_fis_completed_ia", "SS Completed, FIS Completed, IA"],
  ["small_generator", "Small Generator"],
] as const;

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function integer(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function timestamp(value: unknown, code: string): number {
  const result = integer(value, code);
  if (result < 1 || result > 4_102_444_800) throw new Error(code);
  return result;
}

function nullableInteger(value: unknown, code: string): number | null {
  return value === null ? null : integer(value, code);
}

function finiteMw(value: unknown, code: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) {
    throw new Error(code);
  }
  return Object.is(value, -0) ? 0 : value;
}

function signedCapacity(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000_000) {
    throw new Error(code);
  }
  return Object.is(value, -0) ? 0 : value;
}

function boundedString(value: unknown, code: string, max = 500): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > max) {
    throw new Error(code);
  }
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  return value === null ? null : boundedString(value, code, 2_000);
}

function version(value: unknown, code: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error(code);
  return value;
}

function sourcePeriod(value: unknown, code: string): string {
  if (typeof value !== "string" || !MONTH.test(value)) throw new Error(code);
  return value;
}

function httpsUrl(value: unknown, code: string, host = "www.ercot.com"): string {
  const text = boundedString(value, code, 2_000);
  const parsed = new URL(text);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(code);
  }
  return text;
}

function selected(
  value: unknown,
  stream: TexasGridStream,
  generatedAt: number,
): TexasGridSelectedResource {
  const item = object(value, "invalid_texas_grid_selected");
  exact(
    item,
    ["source_period", "published_at", "retrieved_at", "content_version", "url", "source_page_url"],
    "invalid_texas_grid_selected",
  );
  const publishedAt = timestamp(item["published_at"], "invalid_texas_grid_selected");
  const retrievedAt = timestamp(item["retrieved_at"], "invalid_texas_grid_selected");
  const contentVersion = version(item["content_version"], "invalid_texas_grid_selected");
  const url = boundedString(item["url"], "invalid_texas_grid_selected", 1_000);
  const match = SAME_ORIGIN_RESOURCE.exec(url);
  if (
    !match ||
    match[1] !== stream ||
    match[2] !== contentVersion ||
    publishedAt > retrievedAt ||
    retrievedAt > generatedAt
  ) {
    throw new Error("invalid_texas_grid_selected");
  }
  return {
    source_period: sourcePeriod(item["source_period"], "invalid_texas_grid_selected"),
    published_at: publishedAt,
    retrieved_at: retrievedAt,
    content_version: contentVersion,
    url,
    source_page_url: httpsUrl(item["source_page_url"], "invalid_texas_grid_selected"),
  };
}

function section(value: unknown, stream: TexasGridStream, generatedAt: number) {
  const item = object(value, "invalid_texas_grid_section");
  exact(item, ["state", "selected"], "invalid_texas_grid_section");
  if (!["available", "stale", "unavailable", "failed"].includes(String(item["state"]))) {
    throw new Error("invalid_texas_grid_section");
  }
  const state = item["state"] as TexasGridSectionState;
  if ((state === "available" || state === "stale") !== (item["selected"] !== null)) {
    throw new Error("invalid_texas_grid_section");
  }
  return {
    state,
    selected: item["selected"] === null ? null : selected(item["selected"], stream, generatedAt),
  };
}

function sourceHealth(
  value: unknown,
  expectedId: (typeof SOURCE_IDS)[number],
): TexasGridSourceHealth {
  const item = object(value, "invalid_texas_grid_source_health");
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
    "invalid_texas_grid_source_health",
  );
  if (
    item["source_id"] !== expectedId ||
    !["healthy", "stale", "failed", "unavailable"].includes(String(item["state"]))
  )
    throw new Error("invalid_texas_grid_source_health");
  if (![null, "available", "unavailable"].includes(item["availability_status"] as null | string))
    throw new Error("invalid_texas_grid_source_health");
  const materialization = object(item["materialization"], "invalid_texas_grid_source_health");
  exact(
    materialization,
    ["state", "last_success_ts", "consecutive_failures", "last_error"],
    "invalid_texas_grid_source_health",
  );
  if (!["healthy", "failed", "unavailable"].includes(String(materialization["state"])))
    throw new Error("invalid_texas_grid_source_health");
  return {
    source_id: expectedId,
    state: item["state"] as TexasGridSourceHealth["state"],
    availability_status: item[
      "availability_status"
    ] as TexasGridSourceHealth["availability_status"],
    content_version:
      item["content_version"] === null
        ? null
        : version(item["content_version"], "invalid_texas_grid_source_health"),
    last_attempt_ts: nullableInteger(item["last_attempt_ts"], "invalid_texas_grid_source_health"),
    last_success_ts: nullableInteger(item["last_success_ts"], "invalid_texas_grid_source_health"),
    source_updated_at: nullableInteger(
      item["source_updated_at"],
      "invalid_texas_grid_source_health",
    ),
    retrieved_at: nullableInteger(item["retrieved_at"], "invalid_texas_grid_source_health"),
    cache_fresh_until: nullableInteger(
      item["cache_fresh_until"],
      "invalid_texas_grid_source_health",
    ),
    consecutive_failures: integer(item["consecutive_failures"], "invalid_texas_grid_source_health"),
    last_error: nullableString(item["last_error"], "invalid_texas_grid_source_health"),
    materialization: {
      state: materialization["state"] as TexasGridSourceHealth["materialization"]["state"],
      last_success_ts: nullableInteger(
        materialization["last_success_ts"],
        "invalid_texas_grid_source_health",
      ),
      consecutive_failures: nullableInteger(
        materialization["consecutive_failures"],
        "invalid_texas_grid_source_health",
      ),
      last_error: nullableString(materialization["last_error"], "invalid_texas_grid_source_health"),
    },
  };
}

function unavailableSection(value: unknown, reason: string, code: string) {
  const item = object(value, code);
  exact(item, ["state", "reason"], code);
  if (item["state"] !== "unavailable" || item["reason"] !== reason) throw new Error(code);
  return { state: "unavailable" as const, reason };
}

export function parseTexasGridManifest(value: unknown): TexasGridManifest {
  const item = object(value, "invalid_texas_grid_manifest");
  exact(
    item,
    [
      "schema",
      "kind",
      "policy",
      "generated_at",
      "generator_interconnection",
      "resource_capacity_trend",
      "long_term_load_forecast",
      "large_load",
      "retirements",
      "source_health",
    ],
    "invalid_texas_grid_manifest",
  );
  if (
    item["schema"] !== 1 ||
    item["kind"] !== "texas_grid_long_horizon" ||
    item["policy"] !== TEXAS_GRID_POLICY
  )
    throw new Error("invalid_texas_grid_manifest");
  const generatedAt = integer(item["generated_at"], "invalid_texas_grid_manifest");
  if (!Array.isArray(item["source_health"]) || item["source_health"].length !== 2)
    throw new Error("invalid_texas_grid_manifest");
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
    generated_at: generatedAt,
    generator_interconnection: section(item["generator_interconnection"], "gis", generatedAt),
    resource_capacity_trend: section(
      item["resource_capacity_trend"],
      "resource_capacity_trend",
      generatedAt,
    ),
    long_term_load_forecast: unavailableSection(
      item["long_term_load_forecast"],
      "units_not_authoritatively_frozen",
      "invalid_texas_grid_long_term_load_forecast",
    ) as TexasGridManifest["long_term_load_forecast"],
    large_load: unavailableSection(
      item["large_load"],
      "no_stable_public_machine_readable_status_source",
      "invalid_texas_grid_large_load",
    ) as TexasGridManifest["large_load"],
    retirements: unavailableSection(
      item["retirements"],
      "no_verified_gross_retirement_source",
      "invalid_texas_grid_retirements",
    ) as TexasGridManifest["retirements"],
    source_health: [
      sourceHealth(item["source_health"][0], SOURCE_IDS[0]),
      sourceHealth(item["source_health"][1], SOURCE_IDS[1]),
    ],
  };
}

function parsePublicationBase(item: Record<string, unknown>, code: string) {
  const publishedAt = timestamp(item["published_at"], code);
  const retrievedAt = timestamp(item["retrieved_at"], code);
  if (publishedAt > retrievedAt) throw new Error(code);
  return {
    source_period: sourcePeriod(item["source_period"], code),
    published_at: publishedAt,
    retrieved_at: retrievedAt,
    source_page_url: httpsUrl(item["source_page_url"], code),
  };
}

function sha(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(code);
  return value;
}

function parseGis(value: Record<string, unknown>): TexasGridGisResource {
  exact(
    value,
    [
      "schema",
      "kind",
      "policy",
      "stream",
      "publication",
      "unit",
      "statistic",
      "phases",
      "fuels",
      "aggregates",
      "limits",
    ],
    "invalid_texas_grid_gis",
  );
  if (
    value["schema"] !== 1 ||
    value["kind"] !== "texas_grid_long_horizon" ||
    value["policy"] !== TEXAS_GRID_POLICY ||
    value["stream"] !== "gis" ||
    value["unit"] !== "MW" ||
    value["statistic"] !== "project_count_and_source_capacity_sum"
  )
    throw new Error("invalid_texas_grid_gis");
  const publication = object(value["publication"], "invalid_texas_grid_gis");
  exact(
    publication,
    ["source_period", "published_at", "retrieved_at", "source_page_url", "workbook_sha256"],
    "invalid_texas_grid_gis",
  );
  const publicationBase = parsePublicationBase(publication, "invalid_texas_grid_gis");
  if (
    publicationBase.source_page_url !==
    "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er"
  )
    throw new Error("invalid_texas_grid_gis");
  const limits = object(value["limits"], "invalid_texas_grid_gis");
  exact(limits, ["max_aggregates"], "invalid_texas_grid_gis");
  if (
    limits["max_aggregates"] !== 132 ||
    !Array.isArray(value["phases"]) ||
    !Array.isArray(value["fuels"]) ||
    !Array.isArray(value["aggregates"]) ||
    value["aggregates"].length < 1 ||
    value["aggregates"].length > 132
  )
    throw new Error("invalid_texas_grid_gis");
  const phases = value["phases"].map((entry, index) => {
    const phase = object(entry, "invalid_texas_grid_gis_phase");
    exact(phase, ["id", "label"], "invalid_texas_grid_gis_phase");
    if (phase["id"] !== PHASES[index]?.[0] || phase["label"] !== PHASES[index]?.[1])
      throw new Error("invalid_texas_grid_gis_phase");
    return { id: PHASES[index]![0], label: PHASES[index]![1] };
  });
  const fuels = value["fuels"].map((entry, index) => {
    const fuel = object(entry, "invalid_texas_grid_gis_fuel");
    exact(fuel, ["code", "label"], "invalid_texas_grid_gis_fuel");
    if (fuel["code"] !== FUEL_CODES[index] || fuel["label"] !== FUEL_LABELS[index])
      throw new Error("invalid_texas_grid_gis_fuel");
    return { code: FUEL_CODES[index]!, label: FUEL_LABELS[index]! };
  });
  if (phases.length !== PHASES.length || fuels.length !== FUEL_CODES.length)
    throw new Error("invalid_texas_grid_gis");
  const phaseOrder = new Map<string, number>(phases.map((phase, index) => [phase.id, index]));
  const fuelOrder = new Map<string, number>(FUEL_IDS.map((fuel, index) => [fuel, index]));
  let previous = -1;
  const aggregates = value["aggregates"].map((entry) => {
    const row = object(entry, "invalid_texas_grid_gis_aggregate");
    exact(row, ["phase", "fuel", "count", "capacity_mw"], "invalid_texas_grid_gis_aggregate");
    const phase = boundedString(row["phase"], "invalid_texas_grid_gis_aggregate", 100);
    const fuel = boundedString(row["fuel"], "invalid_texas_grid_gis_aggregate", 10);
    const order = (phaseOrder.get(phase) ?? -1) * FUEL_CODES.length + (fuelOrder.get(fuel) ?? -1);
    if (order < 0 || order <= previous) throw new Error("invalid_texas_grid_gis_aggregate");
    previous = order;
    const count = integer(row["count"], "invalid_texas_grid_gis_aggregate");
    if (count > 10_000) throw new Error("invalid_texas_grid_gis_aggregate");
    return {
      phase,
      fuel,
      count,
      capacity_mw: signedCapacity(row["capacity_mw"], "invalid_texas_grid_gis_aggregate"),
    };
  });
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
    stream: "gis",
    publication: {
      ...publicationBase,
      workbook_sha256: sha(publication["workbook_sha256"], "invalid_texas_grid_gis"),
    },
    unit: "MW",
    statistic: "project_count_and_source_capacity_sum",
    phases,
    fuels,
    aggregates,
    limits: { max_aggregates: 132 },
  };
}

function capacityFields(item: Record<string, unknown>, code: string): TexasGridCapacityRow {
  const result = {
    official_total_mw: finiteMw(item["official_total_mw"], code)!,
    operational_mw: finiteMw(item["operational_mw"], code)!,
    ia_financial_security_posted_mw: finiteMw(item["ia_financial_security_posted_mw"], code)!,
    ia_no_financial_security_mw: finiteMw(item["ia_no_financial_security_mw"], code)!,
    other_planned_mw: finiteMw(item["other_planned_mw"], code, true),
    small_generator_mw: finiteMw(item["small_generator_mw"], code)!,
  };
  const componentTotal =
    result.operational_mw +
    result.ia_financial_security_posted_mw +
    result.ia_no_financial_security_mw +
    (result.other_planned_mw ?? 0) +
    result.small_generator_mw;
  if (Math.abs(result.official_total_mw - componentTotal) > 1e-6) throw new Error(code);
  return result;
}

function parseTrend(value: Record<string, unknown>): TexasGridTrendResource {
  exact(
    value,
    ["schema", "kind", "policy", "stream", "publication", "unit", "series", "limits"],
    "invalid_texas_grid_trend",
  );
  if (
    value["schema"] !== 1 ||
    value["kind"] !== "texas_grid_long_horizon" ||
    value["policy"] !== TEXAS_GRID_POLICY ||
    value["stream"] !== "resource_capacity_trend" ||
    value["unit"] !== "MW"
  )
    throw new Error("invalid_texas_grid_trend");
  const publication = object(value["publication"], "invalid_texas_grid_trend");
  exact(
    publication,
    [
      "source_period",
      "published_at",
      "retrieved_at",
      "source_page_url",
      "annual_workbook_url",
      "annual_workbook_sha256",
      "planned_monthly_workbook_url",
      "planned_monthly_workbook_sha256",
    ],
    "invalid_texas_grid_trend",
  );
  const publicationBase = parsePublicationBase(publication, "invalid_texas_grid_trend");
  if (publicationBase.source_page_url !== "https://www.ercot.com/gridinfo/resource")
    throw new Error("invalid_texas_grid_trend");
  const annualUrl = httpsUrl(publication["annual_workbook_url"], "invalid_texas_grid_trend");
  const monthlyUrl = httpsUrl(
    publication["planned_monthly_workbook_url"],
    "invalid_texas_grid_trend",
  );
  const annualMatch =
    /^https:\/\/www\.ercot\.com\/files\/docs\/(\d{4}\/\d{2}\/\d{2})\/Capacity-Changes-by-Fuel-Type-Charts_([A-Z][a-z]+)_(\d{4})\.xlsx$/.exec(
      annualUrl,
    );
  const monthlyMatch =
    /^https:\/\/www\.ercot\.com\/files\/docs\/(\d{4}\/\d{2}\/\d{2})\/Capacity-Changes-by-Fuel-Type-Charts_([A-Z][a-z]+)_(\d{4})_PlannedMonthly\.xlsx$/.exec(
      monthlyUrl,
    );
  const monthIndex = annualMatch
    ? MONTH_NAMES.indexOf(annualMatch[2] as (typeof MONTH_NAMES)[number])
    : -1;
  if (
    !annualMatch ||
    !monthlyMatch ||
    annualMatch[1] !== monthlyMatch[1] ||
    annualMatch[2] !== monthlyMatch[2] ||
    annualMatch[3] !== monthlyMatch[3] ||
    monthIndex < 0 ||
    `${annualMatch[3]}-${String(monthIndex + 1).padStart(2, "0")}` !== publicationBase.source_period
  )
    throw new Error("invalid_texas_grid_trend");
  const limits = object(value["limits"], "invalid_texas_grid_trend");
  exact(
    limits,
    ["max_annual_rows_per_series", "max_planned_monthly_rows_per_series"],
    "invalid_texas_grid_trend",
  );
  if (
    limits["max_annual_rows_per_series"] !== 100 ||
    limits["max_planned_monthly_rows_per_series"] !== 120 ||
    !Array.isArray(value["series"]) ||
    value["series"].length !== SERIES_IDS.length
  )
    throw new Error("invalid_texas_grid_trend");
  const series = value["series"].map((entry, index) => {
    const item = object(entry, "invalid_texas_grid_trend_series");
    exact(
      item,
      ["series_id", "label", "annual", "planned_monthly"],
      "invalid_texas_grid_trend_series",
    );
    if (
      item["series_id"] !== SERIES_IDS[index] ||
      item["label"] !== SERIES_LABELS[index] ||
      !Array.isArray(item["annual"]) ||
      !Array.isArray(item["planned_monthly"]) ||
      item["annual"].length < 1 ||
      item["annual"].length > 100 ||
      item["planned_monthly"].length < 1 ||
      item["planned_monthly"].length > 120
    )
      throw new Error("invalid_texas_grid_trend_series");
    let previousYear = -1;
    const annual = item["annual"].map((entry) => {
      const row = object(entry, "invalid_texas_grid_trend_annual");
      exact(
        row,
        [
          "year",
          "official_total_mw",
          "operational_mw",
          "ia_financial_security_posted_mw",
          "ia_no_financial_security_mw",
          "other_planned_mw",
          "small_generator_mw",
        ],
        "invalid_texas_grid_trend_annual",
      );
      const year = integer(row["year"], "invalid_texas_grid_trend_annual");
      if (year < 1900 || year > 2200 || year <= previousYear)
        throw new Error("invalid_texas_grid_trend_annual");
      previousYear = year;
      return { year, ...capacityFields(row, "invalid_texas_grid_trend_annual") };
    });
    let previousMonth = "";
    const plannedMonthly = item["planned_monthly"].map((entry) => {
      const row = object(entry, "invalid_texas_grid_trend_monthly");
      exact(
        row,
        [
          "month",
          "official_total_mw",
          "operational_mw",
          "ia_financial_security_posted_mw",
          "ia_no_financial_security_mw",
          "other_planned_mw",
          "small_generator_mw",
        ],
        "invalid_texas_grid_trend_monthly",
      );
      if (
        typeof row["month"] !== "string" ||
        !MONTH.test(row["month"]) ||
        row["month"] <= previousMonth
      )
        throw new Error("invalid_texas_grid_trend_monthly");
      previousMonth = row["month"];
      return { month: row["month"], ...capacityFields(row, "invalid_texas_grid_trend_monthly") };
    });
    return {
      series_id: SERIES_IDS[index]!,
      label: SERIES_LABELS[index]!,
      annual,
      planned_monthly: plannedMonthly,
    };
  });
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
    stream: "resource_capacity_trend",
    publication: {
      ...publicationBase,
      annual_workbook_url: annualUrl,
      annual_workbook_sha256: sha(
        publication["annual_workbook_sha256"],
        "invalid_texas_grid_trend",
      ),
      planned_monthly_workbook_url: monthlyUrl,
      planned_monthly_workbook_sha256: sha(
        publication["planned_monthly_workbook_sha256"],
        "invalid_texas_grid_trend",
      ),
    },
    unit: "MW",
    series,
    limits: { max_annual_rows_per_series: 100, max_planned_monthly_rows_per_series: 120 },
  };
}

export function parseTexasGridResource(
  value: unknown,
  selectedResource: TexasGridSelectedResource,
): TexasGridResource {
  const item = object(value, "invalid_texas_grid_resource");
  const resource = selectedResource.url.includes("/gis/") ? parseGis(item) : parseTrend(item);
  if (
    resource.publication.source_period !== selectedResource.source_period ||
    resource.publication.published_at !== selectedResource.published_at ||
    resource.publication.retrieved_at !== selectedResource.retrieved_at ||
    resource.publication.source_page_url !== selectedResource.source_page_url
  )
    throw new Error("texas_grid_resource_manifest_mismatch");
  return resource;
}
