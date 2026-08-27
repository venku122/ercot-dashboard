import type { Point, SeriesMeta } from "./types";

export type AggregateStateV2 = Readonly<{
  count: number;
  first_ordinal: number | null;
  first_ts: number | null;
  first_value: number | null;
  integral_value_seconds: number;
  last_ordinal: number | null;
  last_ts: number | null;
  last_value: number | null;
  maximum: number | null;
  maximum_ts: number | null;
  minimum: number | null;
  minimum_ts: number | null;
  value_sum: number;
  version: 2;
}>;

export type AggregateBucket = Readonly<{
  end: number;
  start: number;
  state: AggregateStateV2;
}>;

export type OrderedPoint = readonly [timestamp: number, value: number, ordinal: number];

export type FinalizedAggregate = Readonly<{
  average: number | null;
  count: number;
  energy_mwh?: number | null;
  first: Point | null;
  integral_value_seconds: number;
  last: Point | null;
  maximum: number | null;
  maximum_ts: number | null;
  minimum: number | null;
  minimum_ts: number | null;
  span_seconds: number | null;
  sum: number;
}>;

export type TileWindowProjection = Readonly<{
  points: Point[];
  state: AggregateStateV2;
  stats: NonNullable<SeriesMeta["stats"]>;
}>;

export type TileProjectionMode = "average" | "spike-envelope";

const STATE_KEYS = [
  "count",
  "first_ordinal",
  "first_ts",
  "first_value",
  "integral_value_seconds",
  "last_ordinal",
  "last_ts",
  "last_value",
  "maximum",
  "maximum_ts",
  "minimum",
  "minimum_ts",
  "value_sum",
  "version",
] as const;

const EMPTY_STATE: AggregateStateV2 = Object.freeze({
  count: 0,
  first_ordinal: null,
  first_ts: null,
  first_value: null,
  integral_value_seconds: 0,
  last_ordinal: null,
  last_ts: null,
  last_value: null,
  maximum: null,
  maximum_ts: null,
  minimum: null,
  minimum_ts: null,
  value_sum: 0,
  version: 2,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function integer(value: unknown, field: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new RangeError(`${field} must be at least ${minimum}`);
  }
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : finiteNumber(value, field);
}

function nullableInteger(value: unknown, field: string, minimum?: number): number | null {
  return value === null ? null : integer(value, field, minimum);
}

function assertState(state: AggregateStateV2): void {
  const nullableFields = [
    state.first_ordinal,
    state.first_ts,
    state.first_value,
    state.last_ordinal,
    state.last_ts,
    state.last_value,
    state.maximum,
    state.maximum_ts,
    state.minimum,
    state.minimum_ts,
  ];
  if (state.count === 0) {
    if (nullableFields.some((value) => value !== null)) {
      throw new TypeError("empty aggregate must not contain point fields");
    }
    if (state.value_sum !== 0 || state.integral_value_seconds !== 0) {
      throw new TypeError("empty aggregate totals must be zero");
    }
    return;
  }
  if (nullableFields.some((value) => value === null)) {
    throw new TypeError("non-empty aggregate is missing point fields");
  }
  const firstKey = stateKey(state, "first");
  const lastKey = stateKey(state, "last");
  if (compareKeys(firstKey, lastKey) > 0) {
    throw new RangeError("aggregate endpoints are out of order");
  }
  if (state.minimum! > state.maximum!) {
    throw new RangeError("aggregate minimum exceeds maximum");
  }
  if (
    state.minimum_ts! < state.first_ts! ||
    state.minimum_ts! > state.last_ts! ||
    state.maximum_ts! < state.first_ts! ||
    state.maximum_ts! > state.last_ts!
  ) {
    throw new RangeError("aggregate extrema timestamp is outside endpoints");
  }
  if (
    state.first_value! < state.minimum! ||
    state.first_value! > state.maximum! ||
    state.last_value! < state.minimum! ||
    state.last_value! > state.maximum!
  ) {
    throw new RangeError("aggregate endpoint value is outside extrema");
  }
  if (state.count === 1) {
    if (
      compareKeys(firstKey, lastKey) !== 0 ||
      state.first_value !== state.last_value ||
      state.minimum !== state.maximum ||
      state.minimum !== state.first_value ||
      state.minimum_ts !== state.first_ts ||
      state.maximum_ts !== state.first_ts ||
      state.value_sum !== state.first_value ||
      state.integral_value_seconds !== 0
    ) {
      throw new TypeError("singleton aggregate fields are inconsistent");
    }
  }
}

export function parseAggregateStateV2(value: unknown): AggregateStateV2 {
  if (!isRecord(value)) throw new TypeError("aggregate state must be an object");
  const keys = Object.keys(value).sort();
  const expected = [...STATE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("aggregate state has unknown or missing fields");
  }
  if (value["version"] !== 2) throw new TypeError("aggregate state version must be 2");
  const state: AggregateStateV2 = Object.freeze({
    count: integer(value["count"], "count", 0),
    first_ordinal: nullableInteger(value["first_ordinal"], "first_ordinal", 0),
    first_ts: nullableInteger(value["first_ts"], "first_ts"),
    first_value: nullableNumber(value["first_value"], "first_value"),
    integral_value_seconds: finiteNumber(value["integral_value_seconds"], "integral_value_seconds"),
    last_ordinal: nullableInteger(value["last_ordinal"], "last_ordinal", 0),
    last_ts: nullableInteger(value["last_ts"], "last_ts"),
    last_value: nullableNumber(value["last_value"], "last_value"),
    maximum: nullableNumber(value["maximum"], "maximum"),
    maximum_ts: nullableInteger(value["maximum_ts"], "maximum_ts"),
    minimum: nullableNumber(value["minimum"], "minimum"),
    minimum_ts: nullableInteger(value["minimum_ts"], "minimum_ts"),
    value_sum: finiteNumber(value["value_sum"], "value_sum"),
    version: 2,
  });
  assertState(state);
  return state;
}

type StateEnd = "first" | "last";
type StateKey = readonly [timestamp: number, ordinal: number];

function stateKey(state: AggregateStateV2, end: StateEnd): StateKey {
  const timestamp = end === "first" ? state.first_ts : state.last_ts;
  const ordinal = end === "first" ? state.first_ordinal : state.last_ordinal;
  if (timestamp === null || ordinal === null) throw new TypeError("empty aggregate has no key");
  return [timestamp, ordinal];
}

function compareKeys(left: StateKey, right: StateKey): number {
  return left[0] - right[0] || left[1] - right[1];
}

export function aggregateOrderedPoints(points: readonly OrderedPoint[]): AggregateStateV2 {
  if (points.length === 0) return EMPTY_STATE;
  const ordered = points.map(([timestamp, value, ordinal]) => ({
    ordinal: integer(ordinal, "ordinal", 0),
    timestamp: integer(timestamp, "timestamp"),
    value: finiteNumber(value, "value"),
  }));
  ordered.sort((left, right) => left.timestamp - right.timestamp || left.ordinal - right.ordinal);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const point = ordered[index]!;
    if (previous.timestamp === point.timestamp && previous.ordinal === point.ordinal) {
      throw new RangeError("duplicate point timestamp and ordinal");
    }
  }
  let valueSum = 0;
  let integral = 0;
  let minimum = ordered[0]!.value;
  let minimumTs = ordered[0]!.timestamp;
  let maximum = minimum;
  let maximumTs = minimumTs;
  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index]!;
    valueSum += point.value;
    if (point.value < minimum || (point.value === minimum && point.timestamp < minimumTs)) {
      minimum = point.value;
      minimumTs = point.timestamp;
    }
    if (point.value > maximum || (point.value === maximum && point.timestamp < maximumTs)) {
      maximum = point.value;
      maximumTs = point.timestamp;
    }
    const next = ordered[index + 1];
    if (next) integral += point.value * (next.timestamp - point.timestamp);
  }
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  return Object.freeze({
    count: ordered.length,
    first_ordinal: first.ordinal,
    first_ts: first.timestamp,
    first_value: first.value,
    integral_value_seconds: Object.is(integral, -0) ? 0 : integral,
    last_ordinal: last.ordinal,
    last_ts: last.timestamp,
    last_value: last.value,
    maximum,
    maximum_ts: maximumTs,
    minimum,
    minimum_ts: minimumTs,
    value_sum: Object.is(valueSum, -0) ? 0 : valueSum,
    version: 2,
  });
}

function extreme(
  leftValue: number,
  leftTs: number,
  rightValue: number,
  rightTs: number,
  chooseMinimum: boolean,
): readonly [number, number] {
  if (leftValue === rightValue) return [leftValue, Math.min(leftTs, rightTs)];
  return leftValue < rightValue === chooseMinimum ? [leftValue, leftTs] : [rightValue, rightTs];
}

function mergeOrdered(left: AggregateStateV2, right: AggregateStateV2): AggregateStateV2 {
  if (left.count === 0) return right;
  if (right.count === 0) return left;
  const comparison = compareKeys(stateKey(left, "last"), stateKey(right, "first"));
  if (comparison === 0) throw new RangeError("aggregate fragments duplicate an endpoint");
  if (comparison > 0) throw new RangeError("aggregate ranges overlap or interleave");
  const [minimum, minimumTs] = extreme(
    left.minimum!,
    left.minimum_ts!,
    right.minimum!,
    right.minimum_ts!,
    true,
  );
  const [maximum, maximumTs] = extreme(
    left.maximum!,
    left.maximum_ts!,
    right.maximum!,
    right.maximum_ts!,
    false,
  );
  const bridge = left.last_value! * (right.first_ts! - left.last_ts!);
  return Object.freeze({
    count: left.count + right.count,
    first_ordinal: left.first_ordinal,
    first_ts: left.first_ts,
    first_value: left.first_value,
    integral_value_seconds: left.integral_value_seconds + bridge + right.integral_value_seconds,
    last_ordinal: right.last_ordinal,
    last_ts: right.last_ts,
    last_value: right.last_value,
    maximum,
    maximum_ts: maximumTs,
    minimum,
    minimum_ts: minimumTs,
    value_sum: left.value_sum + right.value_sum,
    version: 2,
  });
}

export function mergeAggregateStates(states: readonly AggregateStateV2[]): AggregateStateV2 {
  const ordered = states
    .filter((state) => state.count > 0)
    .sort((left, right) => compareKeys(stateKey(left, "first"), stateKey(right, "first")));
  return ordered.reduce(mergeOrdered, EMPTY_STATE);
}

export function finalizeAggregateState(
  state: AggregateStateV2,
  options: Readonly<{ power?: boolean }> = {},
): FinalizedAggregate {
  const result: FinalizedAggregate = {
    average: state.count ? state.value_sum / state.count : null,
    count: state.count,
    first: state.first_ts === null ? null : ([state.first_ts, state.first_value!] satisfies Point),
    integral_value_seconds: state.integral_value_seconds,
    last: state.last_ts === null ? null : ([state.last_ts, state.last_value!] satisfies Point),
    maximum: state.maximum,
    maximum_ts: state.maximum_ts,
    minimum: state.minimum,
    minimum_ts: state.minimum_ts,
    span_seconds:
      state.first_ts === null || state.last_ts === null ? null : state.last_ts - state.first_ts,
    sum: state.value_sum,
  };
  return options.power
    ? Object.freeze({
        ...result,
        energy_mwh: state.count > 1 ? state.integral_value_seconds / 3600 : null,
      })
    : Object.freeze(result);
}

export function projectNativePoints(buckets: readonly AggregateBucket[]): Point[] {
  return nativePointEntries(buckets)
    .sort((left, right) => compareKeys(left.key, right.key))
    .map(({ point }) => point);
}

function validateCoarseBuckets(
  buckets: readonly AggregateBucket[],
  start: number,
  end: number,
): void {
  let width: number | null = null;
  let previousEnd: number | null = null;
  for (const bucket of [...buckets].sort((left, right) => left.start - right.start)) {
    const candidateWidth = bucket.end - bucket.start;
    if (candidateWidth <= 0 || bucket.start % candidateWidth !== 0) {
      throw new RangeError("coarse bucket is not canonically aligned");
    }
    if (bucket.start < start || bucket.end > end) {
      throw new RangeError("partial coarse bucket clipping is forbidden");
    }
    if (width !== null && candidateWidth !== width) {
      throw new RangeError("coarse buckets must use one resolution");
    }
    if (previousEnd !== null && bucket.start < previousEnd) {
      throw new RangeError("coarse buckets overlap");
    }
    if (
      bucket.state.count > 0 &&
      (bucket.state.first_ts! < bucket.start || bucket.state.last_ts! >= bucket.end)
    ) {
      throw new RangeError("coarse aggregate points are outside the bucket");
    }
    width = candidateWidth;
    previousEnd = bucket.end;
  }
}

function nativePointEntries(buckets: readonly AggregateBucket[]) {
  return buckets.map(({ end, start, state }) => {
    if (
      state.count !== 1 ||
      state.first_ts !== state.last_ts ||
      state.first_ordinal !== state.last_ordinal ||
      state.first_value !== state.last_value ||
      start !== state.first_ts ||
      end !== state.first_ts
    ) {
      throw new TypeError("native bucket must contain exactly one point");
    }
    return {
      key: stateKey(state, "first"),
      point: [state.first_ts!, state.first_value!] satisfies Point,
    };
  });
}

function projectCoarseBucket(bucket: AggregateBucket, mode: TileProjectionMode): Point[] {
  const { state } = bucket;
  if (state.count === 0) return [];
  if (mode === "average") return [[bucket.start, state.value_sum / state.count]];
  const minimum = [state.minimum_ts!, state.minimum!] satisfies Point;
  const maximum = [state.maximum_ts!, state.maximum!] satisfies Point;
  if (minimum[0] === maximum[0] && minimum[1] === maximum[1]) return [minimum];
  return [minimum, maximum].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

export function composeTileWindow(
  input: Readonly<{
    coarseInterior: readonly AggregateBucket[];
    end: number;
    endInclusive?: boolean;
    nativeEdges: readonly AggregateBucket[];
    power?: boolean;
    projection?: TileProjectionMode;
    start: number;
  }>,
): TileWindowProjection {
  const start = integer(input.start, "start");
  const end = integer(input.end, "end");
  const exclusiveEnd = input.endInclusive ? end + 1 : end;
  if (!Number.isSafeInteger(exclusiveEnd)) throw new RangeError("window end is unsafe");
  if (start >= exclusiveEnd) throw new RangeError("tile window must be non-empty");
  validateCoarseBuckets(input.coarseInterior, start, exclusiveEnd);
  for (const bucket of input.nativeEdges) {
    if (
      bucket.state.first_ts === null ||
      bucket.state.first_ts < start ||
      bucket.state.first_ts >= exclusiveEnd
    ) {
      throw new RangeError("native edge point is outside the window");
    }
  }
  const state = mergeAggregateStates([
    ...input.nativeEdges.map((bucket) => bucket.state),
    ...input.coarseInterior.map((bucket) => bucket.state),
  ]);
  const nativePoints = nativePointEntries(input.nativeEdges).map(({ key, point }) => ({
    ordinal: key[1],
    point,
  }));
  const coarsePoints = input.coarseInterior.flatMap((bucket) =>
    projectCoarseBucket(bucket, input.projection ?? "average").map((point) => ({
      ordinal: -1,
      point,
    })),
  );
  const points = [...nativePoints, ...coarsePoints]
    .sort(
      (left, right) => left.point[0] - right.point[0] || (left.ordinal ?? 0) - (right.ordinal ?? 0),
    )
    .map(({ point }) => point);
  const finalized = finalizeAggregateState(state, { power: input.power === true });
  return Object.freeze({
    points,
    state,
    stats: {
      average: finalized.average,
      count: finalized.count,
      energy_mwh: finalized.energy_mwh ?? null,
      latest: finalized.last?.[1] ?? null,
      maximum: finalized.maximum,
      minimum: finalized.minimum,
    },
  });
}
