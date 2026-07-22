import { adapter as fuelMix } from "./fuel_mix.ts";
import { adapter as generationOutages } from "./generation_outages.ts";
import { adapter as operationsMessages } from "./operations_messages.ts";
import { adapter as storage } from "./storage.ts";
import { adapter as supplyDemand } from "./supply_demand.ts";
import { adapter as windSolar } from "./wind_solar.ts";

const adapters = [fuelMix, storage, supplyDemand, generationOutages, operationsMessages, windSolar];
const results = [];
for (const adapter of adapters) {
  const result = await adapter.gather();
  results.push({
    source_id: adapter.sourceId,
    source_timestamp: result.sourceTimestamp,
    metrics: result.metrics.length,
    metric_points: result.metrics.reduce((total, metric) => total + metric.points.length, 0),
    events: result.events.length,
    diagnostics: result.diagnostics,
  });
}
console.log(JSON.stringify(results, null, 2));
