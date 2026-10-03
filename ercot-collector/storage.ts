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
  tagCLastTime?: unknown;
  timestamp?: unknown;
  totalCharging?: unknown;
  totalDischarging?: unknown;
};

type StoragePayload = {
  currentDay?: { data?: StorageRow[]; dayDate?: unknown };
  lastUpdated?: unknown;
  previousDay?: { data?: StorageRow[]; dayDate?: unknown };
};

const STORAGE_PAYLOAD_KEYS = ["currentDay", "lastUpdated", "previousDay"];
const STORAGE_DAY_KEYS = ["data", "dayDate"];
const STORAGE_ROW_KEYS = [
  "dstFlag",
  "epoch",
  "netOutput",
  "tagCLastTime",
  "timestamp",
  "totalCharging",
  "totalDischarging",
];

function hasExactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

export async function parseStorage(payload: StoragePayload): Promise<SourceResult> {
  if (!hasExactKeys(payload, STORAGE_PAYLOAD_KEYS)) throw new Error("storage_schema_mismatch");
  if (
    !hasExactKeys(payload.currentDay, STORAGE_DAY_KEYS) ||
    !hasExactKeys(payload.previousDay, STORAGE_DAY_KEYS) ||
    !Array.isArray(payload.currentDay.data) ||
    !Array.isArray(payload.previousDay.data) ||
    typeof payload.currentDay.dayDate !== "string" ||
    typeof payload.previousDay.dayDate !== "string"
  ) {
    throw new Error("storage_schema_mismatch");
  }
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  const rows = [...payload.previousDay.data, ...payload.currentDay.data];
  if (rows.length > 600) throw new Error("storage_row_limit");
  const fields = [
    ["ercot.storage.charging_mw", "totalCharging"],
    ["ercot.storage.discharging_mw", "totalDischarging"],
    ["ercot.storage.net_output_mw", "netOutput"],
  ] as const;
  const seen = new Set<number>();
  const normalizedRows = rows
    .map((row) => {
      if (!hasExactKeys(row, STORAGE_ROW_KEYS)) throw new Error("storage_schema_mismatch");
      if (
        !Number.isSafeInteger(row.epoch) ||
        (row.epoch as number) < 1_000_000_000_000 ||
        (row.epoch as number) > 9_999_999_999_999 ||
        (row.epoch as number) % 300_000 !== 0
      ) {
        throw new Error("storage_invalid_epoch_milliseconds");
      }
      if (
        typeof row.timestamp !== "string" ||
        !/[+-]\d{2}:?\d{2}$/.test(row.timestamp) ||
        typeof row.dstFlag !== "string" ||
        !row.dstFlag.trim() ||
        typeof row.tagCLastTime !== "string" ||
        !row.tagCLastTime.trim()
      ) {
        throw new Error("storage_schema_mismatch");
      }
      const timestamp = epochSeconds(row.epoch);
      if (parseErcotTimestamp(row.timestamp) !== timestamp) {
        throw new Error("storage_timestamp_mismatch");
      }
      if (seen.has(timestamp)) throw new Error("storage_duplicate_epoch");
      seen.add(timestamp);
      const totalCharging = numeric(row.totalCharging, "totalCharging");
      const totalDischarging = numeric(row.totalDischarging, "totalDischarging");
      const netOutput = numeric(row.netOutput, "netOutput");
      if (totalCharging > 0 || totalDischarging < 0) throw new Error("storage_invalid_sign");
      if (Math.abs(netOutput - (totalCharging + totalDischarging)) > 0.01) {
        throw new Error("storage_balance_mismatch");
      }
      return {
        timestamp,
        totalCharging,
        totalDischarging,
        netOutput,
      };
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  const metrics: NormalizedMetric[] = fields.map(([metricName, field]) =>
    metricSeries(
      SOURCE_ID,
      metricName,
      normalizedRows.map((row) => ({ timestamp: row.timestamp, value: row[field] })),
    ),
  );
  if (!normalizedRows.length) {
    throw new Error("storage_zero_core_rows");
  }
  const dataTimestamp = normalizedRows.at(-1)!.timestamp;
  return {
    metrics,
    events: [],
    dataTimestamp,
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
  overlapSeconds: 50 * 3_600,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 45);
}

if (import.meta.main) await start();
