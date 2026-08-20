import { describe, expect, it } from "vitest";

import {
  deriveStorageContextReplay,
  STORAGE_CONTEXT_ALIGNMENT,
  STORAGE_CONTEXT_REPLAY_POLICY,
  STORAGE_CONTEXT_SERIES,
  type StorageContextMarketSnapshot,
  type StorageContextReplayInput,
} from "./storage-context-replay";

const START = 1_774_176_000;
const END = START + 3_600;

function market(target_ts: number, lambda = -12.5, capability = 4_125) {
  return {
    alignment: "exact_same_sced_timestamp" as const,
    readings: {
      "market.sced.as-capability.regup-rrs-ecrs-nonspin": {
        source: { product_id: "NP6-328-CD", source_id: "ercot_mis_np6_328" },
        value: capability,
      },
      "market.sced.system-lambda": {
        source: { product_id: "NP6-322-CD", source_id: "ercot_mis_np6_322" },
        value: lambda,
      },
    },
    target_ts,
  } satisfies StorageContextMarketSnapshot;
}

function fixture(): StorageContextReplayInput {
  return {
    end: END,
    market: { current: market(START + 1_207), previous: market(START + 902, 18.75, 4_050) },
    series: [
      {
        id: "frequency",
        points: [
          [START + 1, 60.001],
          [START + 61, 59.987],
          [START + 181, 60.012],
        ],
      },
      {
        id: "charging",
        points: [
          [START + 300, -140],
          [START + 900, -220],
        ],
      },
      { id: "discharging", points: [[START + 300, 35]] },
      {
        id: "netOutput",
        points: [
          [START + 300, -105],
          [START + 900, -220],
        ],
      },
    ],
    start: START,
  };
}

function points(input: ReturnType<typeof deriveStorageContextReplay>, id: string) {
  return input.series.find((series) => series.id === id)?.points;
}

describe("PR17 independent storage context replay acceptance", () => {
  it("freezes a display-only noncausal policy and the exact six-source contract", () => {
    expect(STORAGE_CONTEXT_REPLAY_POLICY).toBe(
      "multi_cadence_context_not_battery_response_attribution",
    );
    expect(STORAGE_CONTEXT_ALIGNMENT).toBe("display_window_only");
    expect(STORAGE_CONTEXT_SERIES).toEqual({
      frequency: {
        cadenceSeconds: 60,
        metric: "ercot.Frequency.Current_Frequency",
        sourceId: "ercot_realtime",
        timeBasis: "collector_capture_time",
        unit: "Hz",
      },
      charging: {
        cadenceSeconds: 300,
        metric: "ercot.storage.charging_mw",
        sourceId: "energy_storage",
        timeBasis: "source_epoch",
        unit: "MW",
      },
      discharging: {
        cadenceSeconds: 300,
        metric: "ercot.storage.discharging_mw",
        sourceId: "energy_storage",
        timeBasis: "source_epoch",
        unit: "MW",
      },
      netOutput: {
        cadenceSeconds: 300,
        metric: "ercot.storage.net_output_mw",
        sourceId: "energy_storage",
        timeBasis: "source_epoch",
        unit: "MW",
      },
      systemLambda: {
        cadenceSeconds: 300,
        metric: "market.sced.system-lambda",
        sourceId: "ercot_mis_np6_322",
        timeBasis: "exact_sced_target_ts",
        unit: "$/MWh",
      },
      availableAsCapability: {
        cadenceSeconds: 300,
        metric: "market.sced.as-capability.regup-rrs-ecrs-nonspin",
        sourceId: "ercot_mis_np6_328",
        timeBasis: "exact_sced_target_ts",
        unit: "MW",
      },
    });
  });

  it("keeps native timestamps, gaps, and negative values without borrowing or interpolation", () => {
    const replay = deriveStorageContextReplay(fixture());
    expect(replay).toMatchObject({
      alignment: "display_window_only",
      end: END,
      policy: "multi_cadence_context_not_battery_response_attribution",
      start: START,
    });
    expect(points(replay, "frequency")).toEqual([
      [START + 1, 60.001],
      [START + 61, 59.987],
      [START + 181, 60.012],
    ]);
    expect(points(replay, "charging")).toEqual([
      [START + 300, -140],
      [START + 900, -220],
    ]);
    expect(points(replay, "discharging")).toEqual([[START + 300, 35]]);
    expect(points(replay, "netOutput")).toEqual([
      [START + 300, -105],
      [START + 900, -220],
    ]);
  });

  it("uses only coherent current and previous market markers at their exact SCED timestamps", () => {
    const replay = deriveStorageContextReplay(fixture());
    expect(points(replay, "systemLambda")).toEqual([
      [START + 902, 18.75],
      [START + 1_207, -12.5],
    ]);
    expect(points(replay, "availableAsCapability")).toEqual([
      [START + 902, 4_050],
      [START + 1_207, 4_125],
    ]);

    const withoutMarket = deriveStorageContextReplay({
      ...fixture(),
      market: { current: null, previous: null },
    });
    expect(points(withoutMarket, "systemLambda")).toEqual([]);
    expect(points(withoutMarket, "availableAsCapability")).toEqual([]);
  });

  it("rejects a source substitution instead of promoting it to an official market marker", () => {
    const invalid = market(START + 1_207);
    invalid.readings["market.sced.system-lambda"].source.source_id = "dashboard_derived";
    expect(() =>
      deriveStorageContextReplay({
        ...fixture(),
        market: { current: invalid, previous: null },
      }),
    ).toThrow("invalid_storage_context_market_snapshot");
  });

  it("fails closed on missing series, duplicate timestamps, invalid values, and unbounded windows", () => {
    const input = fixture();
    expect(() => deriveStorageContextReplay({ ...input, series: input.series.slice(1) })).toThrow(
      "missing_storage_context_series",
    );
    expect(() =>
      deriveStorageContextReplay({
        ...input,
        series: input.series.map((series) =>
          series.id === "frequency"
            ? {
                ...series,
                points: [
                  [START + 1, 60],
                  [START + 1, 59.9],
                ],
              }
            : series,
        ),
      }),
    ).toThrow("duplicate_storage_context_observation");
    expect(() =>
      deriveStorageContextReplay({
        ...input,
        series: input.series.map((series) =>
          series.id === "netOutput" ? { ...series, points: [[START + 300, Number.NaN]] } : series,
        ),
      }),
    ).toThrow("invalid_storage_context_observation");
    expect(() => deriveStorageContextReplay({ ...input, end: START + 86_401 })).toThrow(
      "invalid_storage_context_window",
    );
  });

  it("uses a half-open bounded window and does not leak out-of-window market markers", () => {
    const input = fixture();
    const replay = deriveStorageContextReplay({
      ...input,
      market: { current: market(END), previous: market(START - 1) },
    });
    expect(points(replay, "systemLambda")).toEqual([]);
    expect(points(replay, "availableAsCapability")).toEqual([]);
  });
});
