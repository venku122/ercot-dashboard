import {
  epochSeconds,
  fetch,
  headers,
  metricSeries,
  numeric,
  parseErcotTimestamp,
  payloadHash,
  runSourceLoop,
  type NormalizedMetric,
  type SourceAdapter,
  type SourceResult,
} from "./_lib.ts";

const SOURCE_ID = "supply_demand";
const URL = "https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json";

type SupplyRow = Record<string, unknown> & { epoch?: unknown; timestamp?: unknown };
type SupplyPayload = {
  data?: SupplyRow[];
  forecast?: SupplyRow[];
  lastUpdated?: unknown;
};

function points(rows: SupplyRow[], field: string) {
  return rows
    .filter((row) => row[field] !== undefined && row[field] !== null)
    .map((row) => ({
      timestamp: row.epoch ? epochSeconds(row.epoch) : parseErcotTimestamp(row.timestamp),
      value: numeric(row[field], field),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);
}

export async function parseSupplyDemand(payload: SupplyPayload): Promise<SourceResult> {
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  const actualRows = payload.data ?? [];
  const forecastRows = payload.forecast ?? [];
  const definitions: Array<[string, SupplyRow[], string]> = [
    ["ercot.supply_demand.demand_mw", actualRows, "demand"],
    ["ercot.supply_demand.available_capacity_mw", actualRows, "capacity"],
    ["ercot.supply_demand.committed_capacity_mw", actualRows, "available"],
    ["ercot.supply_demand.forecast_demand_mw", forecastRows, "forecastedDemand"],
    ["ercot.supply_demand.forecast_available_capacity_mw", forecastRows, "availCapGen"],
  ];
  const metrics: NormalizedMetric[] = [];
  for (const [metricName, rows, field] of definitions) {
    const series = points(rows, field);
    if (series.length) metrics.push(metricSeries(SOURCE_ID, metricName, series));
  }
  if (!metrics.some((entry) => entry.metric_name.endsWith("demand_mw"))) {
    throw new Error("supply_demand_zero_core_rows");
  }
  return {
    metrics,
    events: [],
    sourceTimestamp,
    payloadHash: await payloadHash(payload),
    diagnostics: { actualRows: actualRows.length, forecastRows: forecastRows.length },
  };
}

async function gather() {
  const payload = (await fetch(URL, headers("application/json")).then((response) =>
    response.json(),
  )) as SupplyPayload;
  return parseSupplyDemand(payload);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Supply and Demand",
  expectedIntervalSeconds: 300,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 75);
}

if (import.meta.main) await start();
