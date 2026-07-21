import { start as startAncillary } from "./ancillary.ts";
import { start as startEea } from "./eea.ts";
import { start as startFuelMix } from "./fuel_mix.ts";
import { start as startGenerationOutages } from "./generation_outages.ts";
import { start as startGrid } from "./grid.ts";
import { start as startMetar } from "./metar.ts";
import { start as startOperationsMessages } from "./operations_messages.ts";
import { start as startOutages } from "./outages.ts";
import { start as startPrices } from "./prices.ts";
import { start as startStorage } from "./storage.ts";
import { start as startSupplyDemand } from "./supply_demand.ts";
import { start as startWindSolar } from "./wind_solar.ts";

import { runMetricsServer } from "./deps.ts";
if (Deno.args.includes("--serve-metrics")) {
  runMetricsServer({ port: 9090 });
  console.log("Now serving OpenMetrics @ :9090/metrics");
}

if (import.meta.main) {
  await Promise.race([
    // 60s loops
    // run these offset from each other for better utilization
    startGrid(),
    new Promise((ok) => setTimeout(ok, 30 * 1000)).then(startAncillary),

    // 10+ minute loops, they can overlap, it's ok
    startEea(),
    startMetar(),
    startOutages(),
    startPrices(),
    startFuelMix(),
    startStorage(),
    startSupplyDemand(),
    startGenerationOutages(),
    startOperationsMessages(),
    startWindSolar(),
  ]);
}
