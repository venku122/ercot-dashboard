import { describe, expect, it } from "vitest";

import {
  aggregateOrderedPoints,
  composeTileWindow,
  finalizeAggregateState,
  mergeAggregateStates,
  parseAggregateStateV2,
  projectNativePoints,
  type AggregateBucket,
  type AggregateStateV2,
  type OrderedPoint,
} from "./tile-state";

function bucket(start: number, end: number, points: readonly OrderedPoint[]): AggregateBucket {
  return { end, start, state: aggregateOrderedPoints(points) };
}

function native(timestamp: number, value: number, ordinal = 0): AggregateBucket {
  return bucket(timestamp, timestamp, [[timestamp, value, ordinal]]);
}

function expectStateClose(actual: AggregateStateV2, expected: AggregateStateV2): void {
  expect(actual.count).toBe(expected.count);
  for (const field of [
    "first_ordinal",
    "first_ts",
    "last_ordinal",
    "last_ts",
    "maximum_ts",
    "minimum_ts",
  ] as const) {
    expect(actual[field], field).toBe(expected[field]);
  }
  for (const field of [
    "first_value",
    "integral_value_seconds",
    "last_value",
    "maximum",
    "minimum",
    "value_sum",
  ] as const) {
    expect(actual[field], field).toBeCloseTo(expected[field]!, 9);
  }
}

describe("aggregate state v2 parsing", () => {
  it("strictly parses the exact v2 shape and canonicalizes signed zero", () => {
    const raw = {
      ...aggregateOrderedPoints([[10, 0, 0]]),
      first_value: -0,
      integral_value_seconds: -0,
      last_value: -0,
      maximum: -0,
      minimum: -0,
      value_sum: -0,
    };
    const parsed = parseAggregateStateV2(raw);
    expect(Object.is(parsed.first_value, -0)).toBe(false);
    expect(Object.is(parsed.integral_value_seconds, -0)).toBe(false);
    expect(Object.is(parsed.value_sum, -0)).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    null,
    {},
    { ...aggregateOrderedPoints([]), version: 1 },
    { ...aggregateOrderedPoints([]), surprise: true },
    { ...aggregateOrderedPoints([]), count: 0.5 },
    { ...aggregateOrderedPoints([]), value_sum: Number.NaN },
    { ...aggregateOrderedPoints([[1, 2, 0]]), first_ordinal: -1 },
    { ...aggregateOrderedPoints([[1, 2, 0]]), integral_value_seconds: 1 },
  ])("rejects malformed state %#", (raw) => {
    expect(() => parseAggregateStateV2(raw)).toThrow();
  });
});

describe("aggregate algebra and native reconstruction", () => {
  it("preserves timestamp/ordinal order and left-step bridges", () => {
    const points: OrderedPoint[] = [
      [10, 8, 2],
      [20, -1, 0],
      [10, 3, 0],
      [10, 5, 1],
    ];
    const direct = aggregateOrderedPoints(points);
    expect(direct.first_ordinal).toBe(0);
    expect(direct.last_ts).toBe(20);
    expect(direct.integral_value_seconds).toBe(8 * 10);
    expect(
      projectNativePoints(points.map(([ts, value, ordinal]) => native(ts, value, ordinal))),
    ).toEqual([
      [10, 3],
      [10, 5],
      [10, 8],
      [20, -1],
    ]);
  });

  it("keeps energy power-only", () => {
    const state = aggregateOrderedPoints([
      [0, 2, 0],
      [1800, 4, 0],
      [3600, 1, 0],
    ]);
    expect(finalizeAggregateState(state)).not.toHaveProperty("energy_mwh");
    expect(finalizeAggregateState(state, { power: true }).energy_mwh).toBe(3);
    expect(
      finalizeAggregateState(aggregateOrderedPoints([[1, 9, 0]]), { power: true }).energy_mwh,
    ).toBeNull();
  });

  it("matches direct aggregation and both association orders for seeded partitions", () => {
    let seed = 0x6a09e667;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 300; sample += 1) {
      const count = 1 + Math.floor(random() * 70);
      let timestamp = Math.floor(random() * 20_000) - 10_000;
      const ordinals = new Map<number, number>();
      const points: OrderedPoint[] = [];
      for (let index = 0; index < count; index += 1) {
        timestamp += [0, 1, 2, 7, 60, 300][Math.floor(random() * 6)]!;
        const ordinal = ordinals.get(timestamp) ?? 0;
        ordinals.set(timestamp, ordinal + 1);
        points.push([timestamp, random() * 40_000 - 20_000, ordinal]);
      }
      const firstCut = Math.floor(random() * (count + 1));
      const secondCut = firstCut + Math.floor(random() * (count - firstCut + 1));
      const [left, middle, right] = [
        aggregateOrderedPoints(points.slice(0, firstCut)),
        aggregateOrderedPoints(points.slice(firstCut, secondCut)),
        aggregateOrderedPoints(points.slice(secondCut)),
      ];
      const direct = aggregateOrderedPoints(points);
      expectStateClose(mergeAggregateStates([right, left, middle]), direct);
      expectStateClose(mergeAggregateStates([mergeAggregateStates([left, middle]), right]), direct);
      expectStateClose(mergeAggregateStates([left, mergeAggregateStates([middle, right])]), direct);
      expect(
        finalizeAggregateState(mergeAggregateStates([left, middle, right]), { power: true })
          .energy_mwh,
      ).toBeCloseTo(finalizeAggregateState(direct, { power: true }).energy_mwh!, 9);
    }
  });
});

describe("mixed native-edge and coarse-interior projection", () => {
  const coarseA = bucket(200, 300, [
    [210, 10, 0],
    [250, 30, 0],
  ]);
  const coarseB = bucket(300, 400, [
    [310, 25, 0],
    [350, 5, 0],
  ]);
  const edges = [native(100, 1), native(110, 2), native(450, 4)];

  it("projects averages while stats come from the merged raw aggregate", () => {
    const result = composeTileWindow({
      coarseInterior: [coarseA, coarseB],
      end: 500,
      nativeEdges: edges,
      power: true,
      projection: "average",
      start: 100,
    });
    expect(result.points).toEqual([
      [100, 1],
      [110, 2],
      [200, 20],
      [300, 15],
      [450, 4],
    ]);
    expect(result.stats.count).toBe(7);
    expect(result.stats.maximum).toBe(30);
    expect(result.stats.latest).toBe(4);
    expect(result.stats.energy_mwh).toBe(
      finalizeAggregateState(result.state, { power: true }).energy_mwh,
    );
  });

  it("projects spike envelopes chronologically without changing stats", () => {
    const average = composeTileWindow({
      coarseInterior: [coarseA, coarseB],
      end: 500,
      nativeEdges: edges,
      projection: "average",
      start: 100,
    });
    const spike = composeTileWindow({
      coarseInterior: [coarseA, coarseB],
      end: 500,
      nativeEdges: edges,
      projection: "spike-envelope",
      start: 100,
    });
    expect(spike.points).toEqual([
      [100, 1],
      [110, 2],
      [210, 10],
      [250, 30],
      [310, 25],
      [350, 5],
      [450, 4],
    ]);
    expect(spike.stats).toEqual(average.stats);
    expect(spike.state).toEqual(average.state);
  });

  it("projects one spike point when extrema share timestamp and value", () => {
    const constant = bucket(200, 300, [
      [210, 7, 0],
      [250, 7, 0],
    ]);
    expect(
      composeTileWindow({
        coarseInterior: [constant],
        end: 300,
        nativeEdges: [],
        projection: "spike-envelope",
        start: 200,
      }).points,
    ).toEqual([[210, 7]]);
  });

  it("omits empty coarse buckets and rejects partial coarse clipping", () => {
    const empty = { end: 500, start: 400, state: aggregateOrderedPoints([]) };
    const result = composeTileWindow({
      coarseInterior: [empty],
      end: 500,
      nativeEdges: [native(450, 4)],
      start: 400,
    });
    expect(result.points).toEqual([[450, 4]]);
    expect(() =>
      composeTileWindow({
        coarseInterior: [bucket(0, 300, [[150, 1, 0]])],
        end: 500,
        nativeEdges: [],
        start: 100,
      }),
    ).toThrow(/partial coarse bucket clipping/);
  });

  it("supports inclusive v1 end boundaries without adjacent-tile duplication", () => {
    expect(
      composeTileWindow({
        coarseInterior: [],
        end: 100,
        endInclusive: true,
        nativeEdges: [native(99, 1), native(100, 2)],
        start: 99,
      }).points,
    ).toEqual([
      [99, 1],
      [100, 2],
    ]);
    expect(() =>
      composeTileWindow({
        coarseInterior: [],
        end: 100,
        nativeEdges: [native(100, 2)],
        start: 99,
      }),
    ).toThrow(/outside the window/);
  });
});
