// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useNetLoadDailyResource, useNetLoadManifest, useNetLoadResource } from "./data-hooks";
import { NetLoadPanel } from "./NetLoadPanel";

vi.mock("./data-hooks", () => ({
  useNetLoadDailyResource: vi.fn(),
  useNetLoadManifest: vi.fn(),
  useNetLoadResource: vi.fn(),
}));

const DAY_START = 1_768_435_200;
const VERSION = `v1-${"a".repeat(64)}`;
const ACTUAL = "net-load.actual" as const;
const FORECAST = "net-load.forecast.latest-capped-1h-before-utc-day" as const;

function tileLink(series_key: typeof ACTUAL | typeof FORECAST) {
  return {
    content_version: VERSION,
    day_start: DAY_START,
    lod: "native" as const,
    point_count: 1,
    policy_cutoff: series_key === ACTUAL ? null : DAY_START - 3_600,
    effective_as_of: series_key === ACTUAL ? null : DAY_START - 3_600,
    finalized: true,
    series_key,
    url: `/api/v2/net-load/${series_key}/v1/${VERSION}/1d/${DAY_START}/native`,
    valid_point_count: 1,
  };
}

function dailyLink(series_key: typeof ACTUAL | typeof FORECAST) {
  const dailySeries =
    series_key === ACTUAL ? ACTUAL : "net-load.forecast.latest-capped-1h-before-market-day";
  return {
    complete: true,
    content_version: VERSION,
    delivery_date: "2026-01-15",
    policy_cutoff: series_key === ACTUAL ? null : DAY_START - 3_600,
    effective_as_of: series_key === ACTUAL ? null : DAY_START - 3_600,
    finalized: true,
    series_key: dailySeries,
    url: `/api/v2/net-load-daily/${dailySeries}/v1/${VERSION}/2026-01-15`,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("net-load panel request lifecycle", () => {
  it("is collapsed-lazy, switches atomically, and disables every owned request", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(useNetLoadManifest).mockImplementation(
      (enabled) =>
        ({
          data: enabled
            ? {
                daily_resources: [dailyLink(ACTUAL), dailyLink(FORECAST)],
                formula: "demand_mw - wind_mw - solar_mw",
                kind: "net_load_manifest",
                materialization_health: [
                  {
                    last_attempt_ts: DAY_START - 60,
                    last_error_code: null,
                    last_success_ts: DAY_START - 60,
                    pipeline: "forecast",
                    state: "healthy",
                  },
                ],
                official_ercot_net_load: false,
                resources: [tileLink(ACTUAL), tileLink(FORECAST)],
                storage_policy: "context_only_not_in_formula",
              }
            : undefined,
          error: undefined,
        }) as ReturnType<typeof useNetLoadManifest>,
    );
    vi.mocked(useNetLoadResource).mockImplementation(
      (enabled, link) =>
        ({
          data:
            enabled && link
              ? {
                  complete: true,
                  contributors:
                    link.series_key === ACTUAL
                      ? { same_timestamp_required: true, source_id: "ercot_realtime" }
                      : {
                          load: {
                            issued_at: DAY_START - 7_200,
                            retrieved_at: DAY_START - 7_100,
                            vintage_key: "load",
                          },
                          solar: {
                            issued_at: DAY_START - 7_200,
                            retrieved_at: DAY_START - 7_100,
                            vintage_key: "solar",
                          },
                          wind: {
                            issued_at: DAY_START - 7_200,
                            retrieved_at: DAY_START - 7_100,
                            vintage_key: "wind",
                          },
                        },
                  content_version: VERSION,
                  day_end: DAY_START + 86_400,
                  day_start: DAY_START,
                  description: "Derived net load",
                  exclusions: {},
                  kind: "net_load_tile",
                  lod: "native",
                  official_ercot_net_load: false,
                  effective_as_of: link.series_key === ACTUAL ? null : DAY_START - 3_600,
                  finalized: true,
                  policy_cutoff: link.series_key === ACTUAL ? null : DAY_START - 3_600,
                  rows: [
                    {
                      demand_mw: 70_000,
                      missing_reason: null,
                      net_load_mw: 50_000,
                      ramp_1h_mw: 1_000,
                      ramp_3h_mw: 3_000,
                      solar_mw: 5_000,
                      storage_net_output_mw: -2_000,
                      target_ts: DAY_START,
                      wind_mw: 15_000,
                    },
                  ],
                  selection_policy:
                    link.series_key === ACTUAL
                      ? null
                      : "coherent_whole_curve_latest_capped_before_utc_day",
                  series_key: link.series_key,
                  snapshot_lead_seconds: link.series_key === ACTUAL ? null : 3_600,
                  storage_policy: "context_only_not_in_formula",
                }
              : undefined,
          error: undefined,
        }) as ReturnType<typeof useNetLoadResource>,
    );
    vi.mocked(useNetLoadDailyResource).mockImplementation(
      (enabled, link) =>
        ({
          data:
            enabled && link
              ? {
                  complete: true,
                  content_version: VERSION,
                  daily_ramp: {
                    complete_day: true,
                    elapsed_seconds: 21_600,
                    evening_peak_net_load_mw: 70_000,
                    evening_peak_target_ts: DAY_START + 72_000,
                    minimum_net_load_mw: 30_000,
                    minimum_target_ts: DAY_START + 50_400,
                    policy: "dashboard_evening_v1",
                    ramp_mw: 40_000,
                  },
                  daily_ramp_exclusion: null,
                  delivery_date: "2026-01-15",
                  kind: "net_load_daily_ramp",
                  series_key: link.series_key,
                }
              : undefined,
          error: undefined,
        }) as ReturnType<typeof useNetLoadDailyResource>,
    );

    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<NetLoadPanel enabled />));
    expect(vi.mocked(useNetLoadManifest).mock.calls.at(-1)?.[0]).toBe(false);
    expect(vi.mocked(useNetLoadResource).mock.calls.at(-1)?.[0]).toBe(false);
    expect(host.querySelector("table")).toBeNull();

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Load net-load details")!
        .click();
    });
    expect(vi.mocked(useNetLoadManifest).mock.calls.at(-1)?.[0]).toBe(true);
    expect(host.querySelector('table[aria-label="Actual exact net-load values"]')).not.toBeNull();

    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Latest coherent, capped 1h before UTC day")!
        .click();
    });
    expect(host.querySelector('table[aria-label="Actual exact net-load values"]')).toBeNull();
    expect(
      host.querySelector(
        'table[aria-label="Latest coherent, capped 1h before UTC day exact net-load values"]',
      ),
    ).not.toBeNull();
    expect(host.querySelector('[aria-label="Net-load summary"]')?.textContent).toContain("40.0 GW");
    expect(host.textContent).toContain("not a per-target lead-time claim");
    expect(host.textContent).toContain("Finalized policy snapshot");

    await act(async () => root.render(<NetLoadPanel enabled={false} />));
    expect(vi.mocked(useNetLoadManifest).mock.calls.at(-1)?.[0]).toBe(false);
    expect(vi.mocked(useNetLoadResource).mock.calls.at(-1)?.[0]).toBe(false);
    expect(vi.mocked(useNetLoadDailyResource).mock.calls.at(-1)?.[0]).toBe(false);
    await act(async () => root.unmount());
  });
});
