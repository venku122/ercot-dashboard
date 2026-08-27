import type { Page } from "@playwright/test";

import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const DAY_START = Math.floor((FIXED_NOW_SECONDS - 86_400) / 86_400) * 86_400;
const QUALITY_VERSION = `q1-${"d".repeat(64)}`;
const NET_VERSION = `v1-${"e".repeat(64)}`;

function qualitySummary(sampleCount: number) {
  const qualified = sampleCount >= 100;
  const reasons = qualified
    ? []
    : [
        "insufficient_samples",
        "insufficient_delivery_dates",
        "insufficient_sample_span",
        ...(sampleCount === 0 ? ["insufficient_joint_coverage"] : []),
      ];
  return {
    sample_count: sampleCount,
    mape_sample_count: sampleCount,
    expected_count: 24,
    joint_coverage: sampleCount / 24,
    chicago_delivery_date_count: sampleCount ? 1 : 0,
    sample_span_seconds: sampleCount ? 82_800 : 0,
    bias_mw: sampleCount ? 500 : null,
    mae_mw: sampleCount ? 500 : null,
    mape_percent: sampleCount ? 0.72 : null,
    signed_error_quantiles_mw: {
      p10: sampleCount ? 500 : null,
      p50: sampleCount ? 500 : null,
      p90: sampleCount ? 500 : null,
    },
    absolute_error_p80_mw: sampleCount ? 500 : null,
    empirical_interval: qualified
      ? { kind: "historical_signed_error_type7_p10_p90", lower_mw: 500, upper_mw: 500 }
      : null,
    qualification: {
      qualified,
      reasons,
      minimum_sample_count: 100,
      minimum_chicago_delivery_dates: 30,
      minimum_span_seconds: 2_419_200,
      minimum_joint_coverage: 0.8,
    },
  };
}

function health(sourceId: string) {
  return {
    source_id: sourceId,
    display_name: sourceId,
    availability_status: "available",
    consecutive_failures: 0,
    last_success_ts: FIXED_NOW_SECONDS - 300,
    source_timestamp_ts: FIXED_NOW_SECONDS - 600,
    data_timestamp_ts: FIXED_NOW_SECONDS - 600,
    expected_interval_seconds: 300,
    collection_age_seconds: 300,
    source_age_seconds: 600,
    data_age_seconds: 600,
    state: "healthy",
    collection_state: "healthy",
    freshness_state: "fresh",
  };
}

const sourceContracts = [
  {
    series_key: "load.system",
    source_ids: [
      "ercot_public_np3_565_weather_zone_forecast",
      "ercot_public_np6_345_weather_zone_actual_load",
    ],
    interpretation: "diagnostic_product_pairing",
    health: [
      health("ercot_public_np3_565_weather_zone_forecast"),
      health("ercot_public_np6_345_weather_zone_actual_load"),
    ],
  },
  {
    series_key: "wind.stwpf",
    source_ids: ["ercot_mis_np4_732"],
    interpretation: "forecast_vs_system_wide_hsl",
    health: [health("ercot_mis_np4_732")],
  },
  {
    series_key: "solar.stppf",
    source_ids: ["ercot_mis_np4_737"],
    interpretation: "forecast_vs_system_wide_hsl",
    health: [health("ercot_mis_np4_737")],
  },
];

const summaryIdentities = ["load.system", "wind.stwpf", "solar.stppf"].flatMap((seriesKey) =>
  ["1h", "6h", "24h"].map((horizon) => ({ seriesKey, horizon })),
);

export const forecastQualityManifest = {
  schema: 1,
  kind: "forecast_quality_manifest",
  methodology_version: "v1",
  dataset_updated_through: FIXED_NOW_SECONDS - 300,
  window_days: 90,
  supported_series: ["load.system", "wind.stwpf", "solar.stppf"],
  supported_horizons: ["1h", "6h", "24h"],
  source_contracts: sourceContracts,
  summaries: summaryIdentities.map(({ seriesKey, horizon }) => ({
    series_key: seriesKey,
    horizon,
    availability: seriesKey === "load.system" && horizon === "1h" ? "available" : "unavailable",
    summary: qualitySummary(seriesKey === "load.system" && horizon === "1h" ? 24 : 0),
    missing_reasons:
      seriesKey === "load.system" && horizon === "1h" ? {} : { missing_forecast: 24 },
  })),
  resources: [
    {
      series_key: "load.system",
      horizon: "1h",
      day_start: DAY_START,
      content_version: QUALITY_VERSION,
      url: `/api/v2/forecast-quality/load.system/v1/${QUALITY_VERSION}/1h/1d/${DAY_START}`,
    },
  ],
};

export const forecastQualityResource = {
  schema: 1,
  kind: "forecast_quality_daily",
  series_key: "load.system",
  horizon: "1h",
  horizon_seconds: 3_600,
  tile_span: "1d",
  day_start: DAY_START,
  day_end: DAY_START + 86_400,
  unit: "MW",
  methodology_version: "v1",
  content_version: QUALITY_VERSION,
  methodology: {
    selection: "per_target_latest_issue_at_or_before_cutoff",
    lead_window: "[horizon,horizon+3600)",
    model_policy: "exactly_one_in_use_row",
    error_formula: "actual_minus_forecast",
    positive_error_meaning: "underforecast",
    mape_denominator: "positive_actual_only",
    quantile_method: "Type 7",
    diagnostic_pairing: "NP3-565 systemTotal vs NP6-345 total",
  },
  model_counts: { A3: 24 },
  missing_reasons: {},
  summary: qualitySummary(24),
  rows: Array.from({ length: 24 }, (_, index) => {
    const actual = 66_000 + Math.sin(index / 3) * 4_500 + index * 220;
    const target = DAY_START + index * 3_600;
    return {
      target_ts: target,
      delivery_date: "2026-07-20",
      forecast_mw: actual - 500,
      actual_mw: actual,
      error_mw: 500,
      absolute_error_mw: 500,
      absolute_percentage_error: (100 * 500) / actual,
      revision_mw: 120 * Math.sin(index / 2),
      selected_issue_at: target - 3_600,
      effective_lead_seconds: 3_600,
      model: "A3",
      forecast_vintage_key: "forecast-review-vintage",
      actual_vintage_key: "actual-review-vintage",
      missing_reason: null,
    };
  }),
};

const actualSeries = "net-load.actual";
const netLink = {
  content_version: NET_VERSION,
  day_start: DAY_START,
  lod: "native",
  point_count: 288,
  policy_cutoff: null,
  effective_as_of: null,
  finalized: true,
  series_key: actualSeries,
  url: `/api/v2/net-load/${actualSeries}/v1/${NET_VERSION}/1d/${DAY_START}/native`,
  valid_point_count: 288,
};
const dailyLink = {
  complete: true,
  content_version: NET_VERSION,
  delivery_date: "2026-07-20",
  policy_cutoff: null,
  effective_as_of: null,
  finalized: true,
  series_key: actualSeries,
  url: `/api/v2/net-load-daily/${actualSeries}/v1/${NET_VERSION}/2026-07-20`,
};

export const netLoadManifest = {
  schema_version: 1,
  methodology_version: "v1",
  kind: "net_load_manifest",
  formula: "demand_mw - wind_mw - solar_mw",
  official_ercot_net_load: false,
  resources: [netLink],
  daily_resources: [dailyLink],
  materialization_health: [
    {
      pipeline: "actual",
      state: "healthy",
      last_attempt_ts: FIXED_NOW_SECONDS - 60,
      last_success_ts: FIXED_NOW_SECONDS - 60,
      last_error_code: null,
    },
  ],
  storage_policy: "context_only_not_in_formula",
};

export const netLoadResource = {
  schema_version: 1,
  methodology_version: "v1",
  complete: true,
  contributors: { same_timestamp_required: true, source_id: "ercot_realtime" },
  content_version: NET_VERSION,
  day_end: DAY_START + 86_400,
  day_start: DAY_START,
  description: "Derived actual net load from same-timestamp source observations",
  exclusions: {},
  kind: "net_load_tile",
  lod: "native",
  official_ercot_net_load: false,
  effective_as_of: null,
  finalized: true,
  policy_cutoff: null,
  rows: Array.from({ length: 288 }, (_, index) => {
    const hour = index / 12;
    const demand = 67_000 + Math.sin(hour / 3) * 4_000;
    const wind = 14_000 + Math.sin(hour / 2) * 2_400;
    const solar = Math.max(0, 11_000 * Math.sin((Math.PI * (hour - 6)) / 14));
    return {
      demand_mw: demand,
      missing_reason: null,
      net_load_mw: demand - wind - solar,
      ramp_1h_mw: index >= 12 ? 650 * Math.cos(hour / 2) : null,
      ramp_3h_mw: index >= 36 ? 1_800 * Math.cos(hour / 3) : null,
      solar_mw: solar,
      storage_net_output_mw: 750 * Math.sin(hour / 2),
      target_ts: DAY_START + index * 300,
      wind_mw: wind,
    };
  }),
  selection_policy: null,
  series_key: actualSeries,
  snapshot_lead_seconds: null,
  storage_policy: "context_only_not_in_formula",
};

export const netLoadDailyResource = {
  complete: true,
  content_version: NET_VERSION,
  daily_ramp: {
    complete_day: true,
    elapsed_seconds: 28_800,
    evening_peak_net_load_mw: 56_400,
    evening_peak_target_ts: DAY_START + 75_600,
    minimum_net_load_mw: 31_900,
    minimum_target_ts: DAY_START + 46_800,
    policy: "dashboard_evening_v1",
    ramp_mw: 24_500,
  },
  daily_ramp_exclusion: null,
  delivery_date: "2026-07-20",
  kind: "net_load_daily_ramp",
  policy_cutoff: null,
  finalized: true,
  series_key: actualSeries,
};

export async function installReviewEvidenceApi(page: Page) {
  await installMobileApi(page, "normal");
  await page.route("**/api/v1/forecast-quality", (route) =>
    route.fulfill({ json: forecastQualityManifest }),
  );
  await page.route("**/api/v2/forecast-quality/**", (route) =>
    route.fulfill({ json: forecastQualityResource }),
  );
  await page.route("**/api/v1/net-load", (route) => route.fulfill({ json: netLoadManifest }));
  await page.route("**/api/v2/net-load/**", (route) => route.fulfill({ json: netLoadResource }));
  await page.route("**/api/v2/net-load-daily/**", (route) =>
    route.fulfill({ json: netLoadDailyResource }),
  );
}

export async function labelSyntheticFixture(page: Page, selector: string) {
  await page.locator(selector).evaluate((element) => {
    const label = document.createElement("p");
    label.textContent = "DETERMINISTIC SYNTHETIC REVIEW FIXTURE";
    label.setAttribute("data-review-fixture-label", "true");
    label.style.cssText =
      "margin:0 0 12px;padding:8px 10px;border:1px solid #22d3ee;color:#67e8f9;font:700 12px/1.2 ui-monospace,monospace;letter-spacing:.05em";
    element.prepend(label);
  });
}
