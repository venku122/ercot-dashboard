import {
  epochSeconds,
  fetch,
  headers,
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

const SOURCE_ID = "generation_outages";
const URL = "https://www.ercot.com/api/1/services/read/dashboards/generation-outages.json";
const CATEGORIES = ["Combined", "Dispatchable", "Renewable"] as const;
const OUTAGE_TYPES = ["planned", "unplanned", "total"] as const;

type OutageRecord = Record<string, unknown>;
type OutagePayload = {
  current?: Record<string, OutageRecord>;
  lastUpdated?: unknown;
  previous?: Record<string, OutageRecord>;
};

export async function parseGenerationOutages(payload: OutagePayload): Promise<SourceResult> {
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  const rows = { ...payload.previous, ...payload.current };
  const metrics: NormalizedMetric[] = [];
  for (const category of CATEGORIES) {
    for (const outageType of OUTAGE_TYPES) {
      const points = Object.entries(rows)
        .flatMap(([epoch, row]) => {
          const categoryValues = row[category];
          if (!categoryValues || typeof categoryValues !== "object") return [];
          const value = (categoryValues as Record<string, unknown>)[outageType];
          if (value === undefined || value === null) return [];
          return [{ timestamp: epochSeconds(epoch), value: numeric(value, outageType) }];
        })
        .sort((left, right) => left.timestamp - right.timestamp);
      if (!points.length) continue;
      metrics.push(
        metricSeries(SOURCE_ID, "ercot.generation_outages.mw", points, [
          `category:${tagValue(category)}`,
          `outage_type:${outageType}`,
        ]),
      );
      if (category === "Combined" && outageType === "total") {
        metrics.push(metricSeries(SOURCE_ID, "ercot.generation_outages.total_mw", points));
      }
    }
  }
  if (!metrics.length) throw new Error("generation_outages_zero_core_rows");
  return {
    metrics,
    events: [],
    sourceTimestamp,
    payloadHash: await payloadHash(payload),
    diagnostics: { rows: Object.keys(rows).length, categories: CATEGORIES },
  };
}

async function gather() {
  const payload = (await fetch(URL, headers("application/json")).then((response) =>
    response.json(),
  )) as OutagePayload;
  return parseGenerationOutages(payload);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Generation Outages",
  expectedIntervalSeconds: 300,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 105);
}

if (import.meta.main) await start();
