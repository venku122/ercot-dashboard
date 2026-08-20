import { describe, expect, it } from "vitest";

import {
  parseTexasGridManifest,
  parseTexasGridResource,
  TEXAS_GRID_POLICY,
  type TexasGridManifest,
  type TexasGridSelectedResource,
} from "./texas-grid-long-horizon";

const VERSION = `tg1-${"a".repeat(64)}`;
const HASH = `sha256:${"b".repeat(64)}`;
const PUBLISHED = 1_785_528_000;
const RETRIEVED = PUBLISHED + 600;
const GENERATED = RETRIEVED + 60;
const GIS_PAGE = "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er";
const TREND_PAGE = "https://www.ercot.com/gridinfo/resource";

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
].map(([id, label]) => ({ id, label }));

const FUELS = [
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

function selected(stream: "gis" | "resource_capacity_trend"): TexasGridSelectedResource {
  return {
    source_period: "2026-07",
    published_at: PUBLISHED,
    retrieved_at: RETRIEVED,
    content_version: VERSION,
    url: `/api/v2/texas-grid/${stream}/v1/${VERSION}`,
    source_page_url: stream === "gis" ? GIS_PAGE : TREND_PAGE,
  };
}

function health(source_id: "ercot_gis_report" | "ercot_resource_capacity_trend") {
  return {
    source_id,
    state: "healthy" as const,
    availability_status: "available" as const,
    content_version: VERSION,
    last_attempt_ts: RETRIEVED,
    last_success_ts: RETRIEVED,
    source_updated_at: PUBLISHED,
    retrieved_at: RETRIEVED,
    cache_fresh_until: RETRIEVED + 86_400,
    consecutive_failures: 0,
    last_error: null,
    materialization: {
      state: "healthy" as const,
      last_success_ts: RETRIEVED,
      consecutive_failures: 0,
      last_error: null,
    },
  };
}

export function texasGridManifestFixture(): TexasGridManifest {
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
    generated_at: GENERATED,
    generator_interconnection: { state: "available", selected: selected("gis") },
    resource_capacity_trend: {
      state: "available",
      selected: selected("resource_capacity_trend"),
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
    source_health: [health("ercot_gis_report"), health("ercot_resource_capacity_trend")],
  };
}

export function texasGridGisFixture() {
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
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
    phases: PHASES,
    fuels: FUELS,
    aggregates: [
      {
        phase: "ss_started_fis_not_started_no_ia",
        fuel: "biomass",
        count: 2,
        capacity_mw: -25.5,
      },
    ],
    limits: { max_aggregates: 132 },
  };
}

const SERIES = [
  ["wind", "Wind"],
  ["solar", "Solar"],
  ["battery", "Battery"],
  ["gas_combined_cycle", "Gas - Combined Cycle"],
  ["gas_other", "Gas - Other"],
] as const;

function capacityRow(other: number | null) {
  return {
    official_total_mw: 100 + 20 + 10 + (other ?? 0) + 5,
    operational_mw: 100,
    ia_financial_security_posted_mw: 20,
    ia_no_financial_security_mw: 10,
    other_planned_mw: other,
    small_generator_mw: 5,
  };
}

export function texasGridTrendFixture() {
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    policy: TEXAS_GRID_POLICY,
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
    series: SERIES.map(([series_id, label]) => ({
      series_id,
      label,
      annual: [{ year: 2025, ...capacityRow(series_id === "gas_other" ? 7 : null) }],
      planned_monthly: [{ month: "2026-08", ...capacityRow(series_id === "gas_other" ? 8 : null) }],
    })),
    limits: { max_annual_rows_per_series: 100, max_planned_monthly_rows_per_series: 120 },
  };
}

describe("PR21 Texas Grid strict frontend contract", () => {
  it("accepts the exact manifest and preserves unavailable evidence as unavailable", () => {
    const result = parseTexasGridManifest(texasGridManifestFixture());
    expect(result.generator_interconnection.selected?.url).toContain("/gis/");
    expect(result.long_term_load_forecast.reason).toBe("units_not_authoritatively_frozen");
    expect(result.large_load.state).toBe("unavailable");
    expect(result.retirements.state).toBe("unavailable");
  });

  it("rejects poisoned top-level keys, source order, queryful URLs, and state/selection drift", () => {
    const extra = { ...texasGridManifestFixture(), invented_capacity: 1 };
    expect(() => parseTexasGridManifest(extra)).toThrow("invalid_texas_grid_manifest");

    const reversed = structuredClone(texasGridManifestFixture());
    reversed.source_health.reverse();
    expect(() => parseTexasGridManifest(reversed)).toThrow("invalid_texas_grid_source_health");

    const queryful = structuredClone(texasGridManifestFixture());
    queryful.generator_interconnection.selected!.url += "?latest=1";
    expect(() => parseTexasGridManifest(queryful)).toThrow("invalid_texas_grid_selected");

    const unavailable = structuredClone(texasGridManifestFixture());
    unavailable.generator_interconnection.state = "unavailable";
    expect(() => parseTexasGridManifest(unavailable)).toThrow("invalid_texas_grid_section");
  });

  it("preserves signed repowering adjustments without calling them installed capacity", () => {
    const resource = parseTexasGridResource(texasGridGisFixture(), selected("gis"));
    expect(resource.stream).toBe("gis");
    if (resource.stream === "gis") expect(resource.aggregates[0]?.capacity_mw).toBe(-25.5);

    const sourceCode = structuredClone(texasGridGisFixture());
    sourceCode.aggregates[0]!.fuel = "BIO";
    expect(() => parseTexasGridResource(sourceCode, selected("gis"))).toThrow(
      "invalid_texas_grid_gis_aggregate",
    );
  });

  it("accepts exact annual/monthly distinctions and nullable source-absent categories", () => {
    const resource = parseTexasGridResource(
      texasGridTrendFixture(),
      selected("resource_capacity_trend"),
    );
    expect(resource.stream).toBe("resource_capacity_trend");
    if (resource.stream === "resource_capacity_trend") {
      expect(resource.series[0]!.annual[0]!.other_planned_mw).toBeNull();
      expect(resource.series[4]!.planned_monthly[0]!.other_planned_mw).toBe(8);
    }
  });

  it("rejects old rollup naming and totals that would double-count components", () => {
    const old = structuredClone(texasGridTrendFixture()) as unknown as Record<string, unknown>;
    const oldSeries = old["series"] as Array<Record<string, unknown>>;
    const annual = oldSeries[0]!["annual"] as Array<Record<string, unknown>>;
    annual[0]!["operational_ia_rollup_mw"] = annual[0]!["official_total_mw"];
    delete annual[0]!["official_total_mw"];
    expect(() => parseTexasGridResource(old, selected("resource_capacity_trend"))).toThrow(
      "invalid_texas_grid_trend_annual",
    );

    const mismatch = structuredClone(texasGridTrendFixture());
    mismatch.series[0]!.annual[0]!.official_total_mw += 1;
    expect(() => parseTexasGridResource(mismatch, selected("resource_capacity_trend"))).toThrow(
      "invalid_texas_grid_trend_annual",
    );
  });
});
