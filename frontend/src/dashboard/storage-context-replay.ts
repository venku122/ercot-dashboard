export const STORAGE_CONTEXT_REPLAY_POLICY =
  "multi_cadence_context_not_battery_response_attribution" as const;
export const STORAGE_CONTEXT_ALIGNMENT = "display_window_only" as const;

export const STORAGE_CONTEXT_SERIES = {
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
} as const;

export type StorageContextSeriesId = keyof typeof STORAGE_CONTEXT_SERIES;
export type StorageContextPoint = readonly [timestamp: number, value: number];
type BaseSeriesId = Exclude<StorageContextSeriesId, "availableAsCapability" | "systemLambda">;
export type StorageContextInputSeries = {
  id: BaseSeriesId;
  points: readonly StorageContextPoint[];
};
export type StorageContextMarketReading = {
  source: { product_id: string; source_id: string };
  value: number;
};
export type StorageContextMarketSnapshot = {
  alignment: "exact_same_sced_timestamp";
  readings: {
    "market.sced.as-capability.regup-rrs-ecrs-nonspin": StorageContextMarketReading;
    "market.sced.system-lambda": StorageContextMarketReading;
  };
  target_ts: number;
};
export type StorageContextReplayInput = {
  end: number;
  market: {
    current: StorageContextMarketSnapshot | null;
    previous: StorageContextMarketSnapshot | null;
  };
  series: readonly StorageContextInputSeries[];
  start: number;
};

const CARDINALITY: Record<StorageContextSeriesId, number> = {
  availableAsCapability: 2,
  charging: 288,
  discharging: 288,
  frequency: 1440,
  netOutput: 288,
  systemLambda: 2,
};

function validatePoints(
  points: readonly StorageContextPoint[],
  start: number,
  end: number,
  limit: number,
) {
  if (points.length > limit) throw new Error("storage_context_cardinality_exceeded");
  const timestamps = new Set<number>();
  let previousTimestamp: number | null = null;
  for (const point of points) {
    if (
      point.length !== 2 ||
      !Number.isSafeInteger(point[0]) ||
      !Number.isFinite(point[1]) ||
      point[0] < start ||
      point[0] >= end
    )
      throw new Error("invalid_storage_context_observation");
    if (timestamps.has(point[0])) throw new Error("duplicate_storage_context_observation");
    if (previousTimestamp !== null && point[0] <= previousTimestamp)
      throw new Error("unordered_storage_context_observation");
    timestamps.add(point[0]);
    previousTimestamp = point[0];
  }
}

function marketPoints(snapshot: StorageContextMarketSnapshot | null, start: number, end: number) {
  if (!snapshot) return [];
  const lambda = snapshot.readings["market.sced.system-lambda"];
  const capability = snapshot.readings["market.sced.as-capability.regup-rrs-ecrs-nonspin"];
  if (
    snapshot.alignment !== "exact_same_sced_timestamp" ||
    !Number.isSafeInteger(snapshot.target_ts) ||
    !Number.isFinite(lambda.value) ||
    !Number.isFinite(capability.value) ||
    lambda.source.source_id !== "ercot_mis_np6_322" ||
    lambda.source.product_id !== "NP6-322-CD" ||
    capability.source.source_id !== "ercot_mis_np6_328" ||
    capability.source.product_id !== "NP6-328-CD"
  )
    throw new Error("invalid_storage_context_market_snapshot");
  if (snapshot.target_ts < start || snapshot.target_ts >= end) return [];
  return [
    {
      id: "systemLambda" as const,
      point: [snapshot.target_ts, lambda.value] as StorageContextPoint,
    },
    {
      id: "availableAsCapability" as const,
      point: [snapshot.target_ts, capability.value] as StorageContextPoint,
    },
  ];
}

export function deriveStorageContextReplay(input: StorageContextReplayInput) {
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    input.start >= input.end ||
    input.end - input.start > 86_400
  )
    throw new Error("invalid_storage_context_window");
  const required = new Set<BaseSeriesId>(["frequency", "charging", "discharging", "netOutput"]);
  const seen = new Set<BaseSeriesId>();
  const points = new Map<StorageContextSeriesId, StorageContextPoint[]>();
  for (const series of input.series) {
    if (!required.has(series.id) || seen.has(series.id))
      throw new Error("invalid_storage_context_series");
    seen.add(series.id);
    validatePoints(series.points, input.start, input.end, CARDINALITY[series.id]);
    points.set(series.id, [...series.points]);
  }
  if (seen.size !== required.size) throw new Error("missing_storage_context_series");
  for (const marker of [
    ...marketPoints(input.market.previous, input.start, input.end),
    ...marketPoints(input.market.current, input.start, input.end),
  ]) {
    points.set(marker.id, [...(points.get(marker.id) ?? []), marker.point]);
  }
  for (const id of ["systemLambda", "availableAsCapability"] as const)
    validatePoints(points.get(id) ?? [], input.start, input.end, CARDINALITY[id]);
  const series = (Object.keys(STORAGE_CONTEXT_SERIES) as StorageContextSeriesId[]).map((id) => ({
    ...STORAGE_CONTEXT_SERIES[id],
    id,
    points: points.get(id) ?? [],
  }));
  return {
    alignment: STORAGE_CONTEXT_ALIGNMENT,
    end: input.end,
    policy: STORAGE_CONTEXT_REPLAY_POLICY,
    series,
    start: input.start,
  };
}
