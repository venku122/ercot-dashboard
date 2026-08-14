import {
  incrementalMetrics,
  type SourceAdapter,
  type SourceCheckpoint,
  type SourceResult,
} from "./_lib.ts";
import { adapter as fuelMix } from "./fuel_mix.ts";
import { adapter as generationOutages } from "./generation_outages.ts";
import { adapter as operationsMessages } from "./operations_messages.ts";
import { adapter as storage } from "./storage.ts";
import { adapter as supplyDemand } from "./supply_demand.ts";
import { adapter as windSolar } from "./wind_solar.ts";

const adapters = [fuelMix, storage, supplyDemand, generationOutages, operationsMessages, windSolar];
const results = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function metricPointCount(result: SourceResult, metricName: string) {
  return result.metrics
    .filter((metric) => metric.metric_name === metricName)
    .reduce((total, metric) => total + metric.points.length, 0);
}

function verifySeriesCheckpointMigration(adapter: SourceAdapter, result: SourceResult) {
  const latestMetricTimestamp = Math.max(
    0,
    ...result.metrics.flatMap((metric) => metric.points.map((point) => point.timestamp ?? 0)),
  );
  const legacyCheckpoint: SourceCheckpoint = {
    version: 1,
    high_water_ts: latestMetricTimestamp,
    values: {},
  };
  const migrated = incrementalMetrics(
    result.metrics,
    legacyCheckpoint,
    adapter.mutableMetricNames,
    adapter.overlapSeconds,
  );
  assert(migrated.checkpoint.version === 2, `${adapter.sourceId}_checkpoint_not_migrated`);
  assert(
    Object.keys(migrated.checkpoint.high_water_ts_by_series).length === result.metrics.length,
    `${adapter.sourceId}_series_watermarks_missing`,
  );

  if (adapter.sourceId === "supply_demand") {
    assert(
      metricPointCount(result, "ercot.supply_demand.demand_mw") > 0,
      "supply_demand_actual_missing",
    );
    assert(
      metricPointCount({ ...result, metrics: migrated.metrics }, "ercot.supply_demand.demand_mw") >
        0,
      "supply_demand_legacy_checkpoint_suppressed_actuals",
    );
  }
  if (adapter.sourceId === "wind_solar") {
    assert(metricPointCount(result, "ercot.renewables.actual_mw") > 0, "wind_solar_actual_missing");
    assert(
      metricPointCount({ ...result, metrics: migrated.metrics }, "ercot.renewables.actual_mw") > 0,
      "wind_solar_legacy_checkpoint_suppressed_actuals",
    );
  }
}

for (const adapter of adapters) {
  const result = await adapter.gather();
  verifySeriesCheckpointMigration(adapter, result);
  if (result.dataTimestamp !== undefined) {
    const dataAge = Math.floor(Date.now() / 1000) - result.dataTimestamp;
    const publicationInterval =
      adapter.publicationIntervalSeconds ?? adapter.expectedIntervalSeconds;
    assert(dataAge >= -publicationInterval, `${adapter.sourceId}_actual_data_is_future`);
    assert(dataAge <= publicationInterval * 4, `${adapter.sourceId}_actual_data_is_stale`);
  }
  results.push({
    source_id: adapter.sourceId,
    source_timestamp: result.sourceTimestamp,
    data_timestamp: result.dataTimestamp,
    metrics: result.metrics.length,
    metric_points: result.metrics.reduce((total, metric) => total + metric.points.length, 0),
    events: result.events.length,
    diagnostics: result.diagnostics,
  });
}
console.log(JSON.stringify(results, null, 2));
