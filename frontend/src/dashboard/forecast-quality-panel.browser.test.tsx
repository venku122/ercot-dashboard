// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useForecastQuality, useForecastQualityResource } from "./data-hooks";
import { ForecastQualityPanel } from "./ForecastQualityPanel";

vi.mock("./data-hooks", () => ({
  useForecastQuality: vi.fn(),
  useForecastQualityResource: vi.fn(),
}));

const DAY = 1_799_884_800;
const VERSION = "q1-" + "a".repeat(64);

function qualitySummary(sample = 1) {
  return {
    sample_count: sample,
    mape_sample_count: sample,
    expected_count: 24,
    joint_coverage: sample / 24,
    chicago_delivery_date_count: sample,
    sample_span_seconds: 0,
    bias_mw: sample ? 10 : null,
    mae_mw: sample ? 10 : null,
    mape_percent: sample ? 10 : null,
    signed_error_quantiles_mw: {
      p10: sample ? 10 : null,
      p50: sample ? 10 : null,
      p90: sample ? 10 : null,
    },
    absolute_error_p80_mw: sample ? 10 : null,
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
  };
}

function resource(horizon: "1h" | "6h") {
  const lead = horizon === "1h" ? 3_600 : 21_600;
  return {
    rows: Array.from({ length: 24 }, (_, index) => ({
      target_ts: DAY + index * 3_600,
      forecast_mw: index === 0 ? 100 : null,
      actual_mw: index === 0 ? 110 : null,
      error_mw: index === 0 ? 10 : null,
      absolute_error_mw: index === 0 ? 10 : null,
      revision_mw: index === 0 ? 5 : null,
      model: index === 0 ? "A3" : null,
      missing_reason: index === 0 ? null : "missing_forecast",
      selected_issue_at: DAY - lead,
    })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("forecast quality panel disclosure", () => {
  it("renders exact accessible data and removes stale rows during a horizon switch", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(Date, "now").mockReturnValue((DAY + 10 * 86_400) * 1_000);
    vi.mocked(useForecastQuality).mockImplementation(
      (enabled) =>
        ({
          data: enabled
            ? {
                summaries: (["1h", "6h"] as const).map((horizon) => ({
                  series_key: "load.system",
                  horizon,
                  availability: "available",
                  summary: qualitySummary(),
                  missing_reasons: { missing_forecast: 23 },
                })),
                resources: (["1h", "6h"] as const).map((horizon) => ({
                  series_key: "load.system",
                  horizon,
                  day_start: DAY,
                  content_version: VERSION,
                  url:
                    "/api/v2/forecast-quality/load.system/v1/" +
                    VERSION +
                    "/" +
                    horizon +
                    "/1d/" +
                    DAY,
                })),
                source_contracts: [
                  {
                    series_key: "load.system",
                    source_ids: ["forecast", "actual"],
                    interpretation: "diagnostic_product_pairing",
                    health: [
                      {
                        availability_status: "available",
                        consecutive_failures: 0,
                        state: "healthy",
                      },
                    ],
                  },
                ],
              }
            : undefined,
          error: undefined,
        }) as ReturnType<typeof useForecastQuality>,
    );
    vi.mocked(useForecastQualityResource).mockImplementation(
      (_enabled, link) =>
        ({
          data: link?.horizon === "1h" ? resource("1h") : undefined,
          error: undefined,
        }) as ReturnType<typeof useForecastQualityResource>,
    );

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<ForecastQualityPanel enabled />));
    expect(vi.mocked(useForecastQuality).mock.calls.at(-1)?.[0]).toBe(false);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Load quality details")!
        .click();
    });
    expect(
      host.querySelector('table[aria-label="System load 1-hour ahead exact forecast quality"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain("Insufficient history for an empirical interval");
    expect(host.textContent).toContain("Signed error = actual − forecast");

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "6-hour ahead")!
        .click();
    });
    expect(
      host.querySelector('table[aria-label="System load 1-hour ahead exact forecast quality"]'),
    ).toBeNull();
    expect(host.textContent).toContain("Loading…");
    await act(async () => root.unmount());
  });

  it("distinguishes no actual outcomes from insufficient nonzero history", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(useForecastQuality).mockImplementation(
      (enabled) =>
        ({
          data: enabled
            ? {
                summaries: [
                  {
                    series_key: "load.system",
                    horizon: "1h",
                    availability: "available",
                    summary: qualitySummary(0),
                    missing_reasons: { missing_actual: 24 },
                  },
                ],
                resources: [],
                source_contracts: [],
              }
            : undefined,
          error: undefined,
        }) as ReturnType<typeof useForecastQuality>,
    );
    vi.mocked(useForecastQualityResource).mockReturnValue({
      data: undefined,
      error: undefined,
    } as ReturnType<typeof useForecastQualityResource>);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<ForecastQualityPanel enabled />));
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Load quality details")!
        .click();
    });
    expect(host.textContent).toContain("No matched actual outcomes are available");
    expect(host.textContent).not.toContain("Insufficient history for an empirical interval");
    await act(async () => root.unmount());
  });
});
