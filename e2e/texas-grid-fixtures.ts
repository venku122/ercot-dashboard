import type { Page } from "@playwright/test";

const POLICY = "official_planning_snapshots_not_committed_capacity_or_realization_forecast";
const GIS_VERSION = `tg1-${"a".repeat(64)}`;
const TREND_VERSION = `tg1-${"b".repeat(64)}`;
const HASH = `sha256:${"c".repeat(64)}`;
const PUBLISHED = 1_785_528_000;
const RETRIEVED = PUBLISHED + 600;
const GIS_PAGE = "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er";
const TREND_PAGE = "https://www.ercot.com/gridinfo/resource";

const phases = [
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
].map(([id, label]) => ({ id, label }));

const fuels = [
  ["BIO", "Biomass"],
  ["COA", "Coal"],
  ["GAS", "Gas"],
  ["GEO", "Geothermal"],
  ["HYD", "Hydrogen"],
  ["NUC", "Nuclear"],
  ["OIL", "Fuel Oil"],
  ["OTH", "Other"],
  ["PET", "Petcoke"],
  ["SOL", "Solar"],
  ["WAT", "Water"],
  ["WIN", "Wind"],
].map(([code, label]) => ({ code, label }));

function health(
  source_id: "ercot_gis_report" | "ercot_resource_capacity_trend",
  content_version: string,
) {
  return {
    source_id,
    state: "healthy",
    availability_status: "available",
    content_version,
    last_attempt_ts: RETRIEVED,
    last_success_ts: RETRIEVED,
    source_updated_at: PUBLISHED,
    retrieved_at: RETRIEVED,
    cache_fresh_until: RETRIEVED + 45 * 86_400,
    consecutive_failures: 0,
    last_error: null,
    materialization: {
      state: "healthy",
      last_success_ts: RETRIEVED,
      consecutive_failures: 0,
      last_error: null,
    },
  };
}

export function texasGridManifestFixture() {
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: POLICY,
    generated_at: RETRIEVED + 60,
    generator_interconnection: {
      state: "available",
      selected: {
        source_period: "2026-07",
        published_at: PUBLISHED,
        retrieved_at: RETRIEVED,
        content_version: GIS_VERSION,
        url: `/api/v2/texas-grid/gis/v1/${GIS_VERSION}`,
        source_page_url: GIS_PAGE,
      },
    },
    resource_capacity_trend: {
      state: "available",
      selected: {
        source_period: "2026-07",
        published_at: PUBLISHED,
        retrieved_at: RETRIEVED,
        content_version: TREND_VERSION,
        url: `/api/v2/texas-grid/resource_capacity_trend/v1/${TREND_VERSION}`,
        source_page_url: TREND_PAGE,
      },
    },
    long_term_load_forecast: {
      state: "unavailable",
      reason: "units_not_authoritatively_frozen",
    },
    large_load: {
      state: "unavailable",
      reason: "no_stable_public_machine_readable_status_source",
    },
    retirements: { state: "unavailable", reason: "no_verified_gross_retirement_source" },
    source_health: [
      health("ercot_gis_report", GIS_VERSION),
      health("ercot_resource_capacity_trend", TREND_VERSION),
    ],
  };
}

export function texasGridGisFixture() {
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: POLICY,
    stream: "gis",
    publication: {
      source_period: "2026-07",
      published_at: PUBLISHED,
      retrieved_at: RETRIEVED,
      source_page_url: GIS_PAGE,
      workbook_sha256: HASH,
    },
    unit: "MW",
    statistic: "project_count_and_source_capacity_sum",
    phases,
    fuels,
    aggregates: [
      {
        phase: "ss_started_fis_not_started_no_ia",
        fuel: "biomass",
        count: 2,
        capacity_mw: -25.5,
      },
      {
        phase: "ss_started_fis_started_no_ia",
        fuel: "wind",
        count: 14,
        capacity_mw: 3_250,
      },
    ],
    limits: { max_aggregates: 132 },
  };
}

function row(period: { month: string } | { year: number }, other: number | null) {
  return {
    ...period,
    official_total_mw: 100 + 20 + 10 + (other ?? 0) + 5,
    operational_mw: 100,
    ia_financial_security_posted_mw: 20,
    ia_no_financial_security_mw: 10,
    other_planned_mw: other,
    small_generator_mw: 5,
  };
}

export function texasGridTrendFixture() {
  const definitions = [
    ["wind", "Wind"],
    ["solar", "Solar"],
    ["battery", "Battery"],
    ["gas_combined_cycle", "Gas - Combined Cycle"],
    ["gas_other", "Gas - Other"],
  ] as const;
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: POLICY,
    stream: "resource_capacity_trend",
    publication: {
      source_period: "2026-07",
      published_at: PUBLISHED,
      retrieved_at: RETRIEVED,
      source_page_url: TREND_PAGE,
      annual_workbook_url:
        "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026.xlsx",
      annual_workbook_sha256: HASH,
      planned_monthly_workbook_url:
        "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026_PlannedMonthly.xlsx",
      planned_monthly_workbook_sha256: HASH,
    },
    unit: "MW",
    series: definitions.map(([series_id, label]) => ({
      series_id,
      label,
      annual: [row({ year: 2024 }, series_id === "gas_other" ? 7 : null)],
      planned_monthly: [row({ month: "2026-08" }, series_id === "gas_other" ? 8 : null)],
    })),
    limits: { max_annual_rows_per_series: 100, max_planned_monthly_rows_per_series: 120 },
  };
}

export async function installTexasGridApi(page: Page, requests: string[]) {
  await page.route("**/api/v1/texas-grid", async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(texasGridManifestFixture()),
    });
  });
  await page.route("**/api/v2/texas-grid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        path.includes("/gis/") ? texasGridGisFixture() : texasGridTrendFixture(),
      ),
    });
  });
}
