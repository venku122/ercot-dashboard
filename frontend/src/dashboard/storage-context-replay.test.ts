import { describe, expect, it } from "vitest";
import {
  deriveStorageContextReplay,
  STORAGE_CONTEXT_ALIGNMENT,
  STORAGE_CONTEXT_REPLAY_POLICY,
} from "./storage-context-replay";

const base = {
  end: 86_400,
  market: { current: null, previous: null },
  series: [
    { id: "frequency" as const, points: [[61, 59.99] as const] },
    { id: "charging" as const, points: [[300, -10] as const] },
    { id: "discharging" as const, points: [[300, 12] as const] },
    { id: "netOutput" as const, points: [[300, 2] as const] },
  ],
  start: 0,
};

describe("storage context replay", () => {
  it("preserves independent native timestamps and stable policies", () => {
    const replay = deriveStorageContextReplay(base);
    expect(replay.policy).toBe(STORAGE_CONTEXT_REPLAY_POLICY);
    expect(replay.alignment).toBe(STORAGE_CONTEXT_ALIGNMENT);
    expect(replay.series).toHaveLength(6);
    expect(replay.series.find(({ id }) => id === "frequency")?.points).toEqual([[61, 59.99]]);
    expect(replay.series.find(({ id }) => id === "charging")?.points).toEqual([[300, -10]]);
  });

  it("uses only coherent current and previous exact SCED markers", () => {
    const snapshot = (target_ts: number) => ({
      alignment: "exact_same_sced_timestamp" as const,
      readings: {
        "market.sced.as-capability.regup-rrs-ecrs-nonspin": {
          source: { product_id: "NP6-328-CD", source_id: "ercot_mis_np6_328" },
          value: 4500,
        },
        "market.sced.system-lambda": {
          source: { product_id: "NP6-322-CD", source_id: "ercot_mis_np6_322" },
          value: 32,
        },
      },
      target_ts,
    });
    const replay = deriveStorageContextReplay({
      ...base,
      market: { current: snapshot(607), previous: snapshot(302) },
    });
    expect(replay.series.find(({ id }) => id === "systemLambda")?.points).toEqual([
      [302, 32],
      [607, 32],
    ]);
    expect(replay.series.find(({ id }) => id === "availableAsCapability")?.points).toEqual([
      [302, 4500],
      [607, 4500],
    ]);
    expect(replay.series.find(({ id }) => id === "frequency")?.sourceId).toBe("ercot_realtime");
    expect(replay.series.find(({ id }) => id === "charging")?.sourceId).toBe("energy_storage");
    const atHalfOpenEnd = deriveStorageContextReplay({
      ...base,
      market: { current: snapshot(base.end), previous: null },
    });
    expect(atHalfOpenEnd.series.find(({ id }) => id === "systemLambda")?.points).toEqual([]);
  });

  it("fails closed on wide, duplicate, and half-open out-of-window input", () => {
    expect(() => deriveStorageContextReplay({ ...base, end: 86_401 })).toThrow(
      "invalid_storage_context_window",
    );
    const replaceFrequency = (points: readonly (readonly [number, number])[]) => ({
      ...base,
      series: base.series.map((series) =>
        series.id === "frequency" ? { ...series, points } : series,
      ),
    });
    expect(() =>
      deriveStorageContextReplay(
        replaceFrequency([
          [61, 1],
          [61, 2],
        ]),
      ),
    ).toThrow("duplicate_storage_context_observation");
    expect(() => deriveStorageContextReplay(replaceFrequency([[86_400, 60]]))).toThrow(
      "invalid_storage_context_observation",
    );
    expect(() =>
      deriveStorageContextReplay(
        replaceFrequency([
          [62, 60],
          [61, 59.9],
        ]),
      ),
    ).toThrow("unordered_storage_context_observation");
  });
});
