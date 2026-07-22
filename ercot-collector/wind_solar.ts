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

const SOURCE_ID = "wind_solar";
const URL = "https://www.ercot.com/api/1/services/read/dashboards/combine-wind-solar.json";

type RenewableRow = Record<string, unknown> & { epoch?: unknown; timestamp?: unknown };
type RenewablePayload = {
  currentDay?: { data?: Record<string, RenewableRow> };
  lastUpdated?: unknown;
  nextDay?: { data?: Record<string, RenewableRow> };
};

export async function parseWindSolar(payload: RenewablePayload): Promise<SourceResult> {
  const sourceTimestamp = parseErcotTimestamp(payload.lastUpdated);
  const rows = {
    ...payload.currentDay?.data,
    ...payload.nextDay?.data,
  };
  const definitions = [
    ["actual_mw", "wind", "actualWind"],
    ["forecast_mw", "wind", "stwpf"],
    ["hsl_mw", "wind", "copHslWind"],
    ["forecast_day_ahead_mw", "wind", "stwpfDayAhead"],
    ["hsl_day_ahead_mw", "wind", "copHslWindDayAhead"],
    ["actual_mw", "solar", "actualSolar"],
    ["forecast_mw", "solar", "stppf"],
    ["hsl_mw", "solar", "copHslSolar"],
    ["forecast_day_ahead_mw", "solar", "stppfDayAhead"],
    ["hsl_day_ahead_mw", "solar", "copHslSolarDayAhead"],
  ] as const;
  const metrics: NormalizedMetric[] = [];
  for (const [suffix, resource, field] of definitions) {
    const points = Object.entries(rows)
      .flatMap(([epoch, row]) => {
        const raw = row[field];
        if (raw === null || raw === undefined) return [];
        return [
          {
            timestamp: row.epoch ? epochSeconds(row.epoch) : epochSeconds(epoch),
            value: numeric(raw, field),
          },
        ];
      })
      .sort((left, right) => left.timestamp - right.timestamp);
    if (points.length) {
      metrics.push(
        metricSeries(
          SOURCE_ID,
          `ercot.renewables.${suffix}`,
          points,
          [`resource:${resource}`],
          3600,
        ),
      );
    }
  }
  if (!metrics.length) throw new Error("wind_solar_zero_core_rows");
  return {
    metrics,
    events: [],
    sourceTimestamp,
    payloadHash: await payloadHash(payload),
    diagnostics: { rows: Object.keys(rows).length },
  };
}

async function gather() {
  const payload = (await fetch(URL, headers("application/json")).then((response) =>
    response.json(),
  )) as RenewablePayload;
  return parseWindSolar(payload);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Combined Wind and Solar",
  expectedIntervalSeconds: 300,
  mutableMetricNames: [
    "ercot.renewables.forecast_mw",
    "ercot.renewables.hsl_mw",
    "ercot.renewables.forecast_day_ahead_mw",
    "ercot.renewables.hsl_day_ahead_mw",
  ],
  overlapSeconds: 7200,
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 135);
}

if (import.meta.main) await start();
