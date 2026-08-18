import { describe, expect, it } from "vitest";

import { parseForecastQualityResource } from "./forecast-quality";

const DAY_START = 1_800_057_600;
const CONTENT_VERSION = `q1-${"a".repeat(64)}`;
const LINK = {
  series_key: "load.system" as const,
  horizon: "1h" as const,
  day_start: DAY_START,
  content_version: CONTENT_VERSION,
  url: `/api/v2/forecast-quality/load.system/v1/${CONTENT_VERSION}/1h/1d/${DAY_START}`,
};

function fixture() {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const target = DAY_START + index * 3_600;
    if (index === 0) {
      return {
        target_ts: target,
        delivery_date: "2027-01-15",
        forecast_mw: 100,
        actual_mw: 110,
        error_mw: 10,
        absolute_error_mw: 10,
        absolute_percentage_error: (100 * 10) / 110,
        revision_mw: 5,
        selected_issue_at: target - 3_600,
        effective_lead_seconds: 3_600,
        model: "A3",
        forecast_vintage_key: "forecast-selected",
        actual_vintage_key: "actual-selected",
        missing_reason: null,
      };
    }
    return {
      target_ts: target,
      delivery_date: "2027-01-15",
      forecast_mw: null,
      actual_mw: null,
      error_mw: null,
      absolute_error_mw: null,
      absolute_percentage_error: null,
      revision_mw: null,
      selected_issue_at: null,
      effective_lead_seconds: null,
      model: null,
      forecast_vintage_key: null,
      actual_vintage_key: null,
      missing_reason: "missing_forecast",
    };
  });
  return {
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
    content_version: CONTENT_VERSION,
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
    model_counts: { A3: 1 },
    missing_reasons: { missing_forecast: 23 },
    summary: {
      sample_count: 1,
      mape_sample_count: 1,
      expected_count: 24,
      joint_coverage: 1 / 24,
      chicago_delivery_date_count: 1,
      sample_span_seconds: 0,
      bias_mw: 10,
      mae_mw: 10,
      mape_percent: (100 * 10) / 110,
      signed_error_quantiles_mw: { p10: 10, p50: 10, p90: 10 },
      absolute_error_p80_mw: 10,
      empirical_interval: null,
      qualification: {
        qualified: false,
        reasons: [
          "insufficient_samples",
          "insufficient_delivery_dates",
          "insufficient_sample_span",
          "insufficient_joint_coverage",
        ],
        minimum_sample_count: 100,
        minimum_chicago_delivery_dates: 30,
        minimum_span_seconds: 2_419_200,
        minimum_joint_coverage: 0.8,
      },
    },
    rows,
  };
}

describe("independent forecast-quality semantic acceptance", () => {
  it("accepts the exact diagnostic load formula and elapsed-hour lead", () => {
    const parsed = parseForecastQualityResource(fixture(), LINK);
    expect(parsed.rows[0]).toMatchObject({
      error_mw: 10,
      absolute_error_mw: 10,
      effective_lead_seconds: 3_600,
    });
  });

  it("rejects a body whose numeric error no longer equals actual minus forecast", () => {
    const payload = fixture();
    payload.rows[0]!.error_mw = -10;
    expect(() => parseForecastQualityResource(payload, LINK)).toThrow();
  });

  it("rejects a selected issue whose stated lead is inconsistent with target UTC", () => {
    const payload = fixture();
    payload.rows[0]!.effective_lead_seconds = 7_200;
    expect(() => parseForecastQualityResource(payload, LINK)).toThrow();
  });

  it("rejects semantic pairing drift rather than accepting a GEN renewable actual", () => {
    const payload = fixture();
    payload.series_key = "wind.stwpf";
    payload.methodology.model_policy = "product_implicit_model";
    payload.methodology.diagnostic_pairing = "NP4-732 STWPF_SYSTEM_WIDE vs GEN";
    const windLink = {
      ...LINK,
      series_key: "wind.stwpf" as const,
      url: `/api/v2/forecast-quality/wind.stwpf/v1/${CONTENT_VERSION}/1h/1d/${DAY_START}`,
    };
    expect(() => parseForecastQualityResource(payload, windLink)).toThrow();
  });
});
