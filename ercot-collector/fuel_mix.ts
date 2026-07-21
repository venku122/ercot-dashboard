import {
  fetch,
  headers,
  metric,
  metricSeries,
  numeric,
  parseErcotTimestamp,
  payloadHash,
  runSourceLoop,
  tagValue,
  type NormalizedMetric,
  type SourceAdapter,
  type SourceResult,
} from "./_lib.ts";

const SOURCE_ID = "fuel_mix";
const URL = "https://www.ercot.com/api/1/services/read/dashboards/fuel-mix.json";

type FuelPayload = {
  data?: Record<string, Record<string, Record<string, { gen?: unknown }>>>;
  lastUpdated?: unknown;
  monthlyCapacity?: Record<string, unknown>;
  types?: unknown;
};

export async function parseFuelMix(payload: FuelPayload): Promise<SourceResult> {
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  if (!payload.data || !Array.isArray(payload.types) || payload.types.length === 0) {
    throw new Error("fuel_mix_schema_invalid");
  }
  const byFuel = new Map<string, Array<{ timestamp: number; value: number }>>();
  for (const day of Object.values(payload.data)) {
    for (const [rawTimestamp, fuels] of Object.entries(day)) {
      const timestamp = parseErcotTimestamp(rawTimestamp);
      for (const [fuel, values] of Object.entries(fuels)) {
        if (values.gen === undefined || values.gen === null) continue;
        const points = byFuel.get(fuel) ?? [];
        points.push({ timestamp, value: numeric(values.gen, "fuel_generation") });
        byFuel.set(fuel, points);
      }
    }
  }
  const metrics: NormalizedMetric[] = [];
  for (const [fuel, points] of byFuel) {
    points.sort((left, right) => left.timestamp - right.timestamp);
    metrics.push(
      metricSeries(SOURCE_ID, "ercot.fuel_mix.generation_mw", points, [`fuel:${tagValue(fuel)}`]),
    );
  }
  for (const [fuel, rawCapacity] of Object.entries(payload.monthlyCapacity ?? {})) {
    metrics.push(
      metric(
        SOURCE_ID,
        "ercot.fuel_mix.seasonal_capacity_mw",
        sourceTimestamp,
        numeric(rawCapacity, "seasonal_capacity"),
        [`fuel:${tagValue(fuel)}`],
      ),
    );
  }
  if (byFuel.size === 0) throw new Error("fuel_mix_zero_core_rows");
  return {
    metrics,
    events: [],
    sourceTimestamp,
    payloadHash: await payloadHash(payload),
    diagnostics: { fuels: byFuel.size, generationPoints: [...byFuel.values()].flat().length },
  };
}

async function gather() {
  const payload = (await fetch(URL, headers("application/json")).then((response) =>
    response.json(),
  )) as FuelPayload;
  return parseFuelMix(payload);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Fuel Mix",
  expectedIntervalSeconds: 300,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 15);
}

if (import.meta.main) await start();
