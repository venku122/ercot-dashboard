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

const SOURCE_ID = "energy_storage";
const URL = "https://www.ercot.com/api/1/services/read/dashboards/energy-storage-resources.json";

type StorageRow = {
  dstFlag?: unknown;
  epoch?: unknown;
  netOutput?: unknown;
  timestamp?: unknown;
  totalCharging?: unknown;
  totalDischarging?: unknown;
};

type StoragePayload = {
  currentDay?: { data?: StorageRow[] };
  lastUpdated?: unknown;
  previousDay?: { data?: StorageRow[] };
};

export async function parseStorage(payload: StoragePayload): Promise<SourceResult> {
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  const rows = [...(payload.previousDay?.data ?? []), ...(payload.currentDay?.data ?? [])];
  const fields = [
    ["ercot.storage.charging_mw", "totalCharging"],
    ["ercot.storage.discharging_mw", "totalDischarging"],
    ["ercot.storage.net_output_mw", "netOutput"],
  ] as const;
  const metrics: NormalizedMetric[] = [];
  for (const [metricName, field] of fields) {
    const points = rows
      .filter((row) => row[field] !== undefined && row[field] !== null)
      .map((row) => ({
        timestamp: row.epoch ? epochSeconds(row.epoch) : parseErcotTimestamp(row.timestamp),
        value: numeric(row[field], field),
      }))
      .sort((left, right) => left.timestamp - right.timestamp);
    if (points.length) metrics.push(metricSeries(SOURCE_ID, metricName, points));
  }
  if (!metrics.length) throw new Error("storage_zero_core_rows");
  return {
    metrics,
    events: [],
    sourceTimestamp,
    payloadHash: await payloadHash(payload),
    diagnostics: {
      rows: rows.length,
      dstRows: rows.filter((row) => String(row.dstFlag ?? "N") !== "N").length,
    },
  };
}

async function gather() {
  const payload = (await fetch(URL, headers("application/json")).then((response) =>
    response.json(),
  )) as StoragePayload;
  return parseStorage(payload);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Energy Storage Resources",
  expectedIntervalSeconds: 300,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 45);
}

if (import.meta.main) await start();
