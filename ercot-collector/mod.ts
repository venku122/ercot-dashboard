import { start as startAncillary } from "./ancillary.ts";
import { start as startEea } from "./eea.ts";
import { start as startFuelMix } from "./fuel_mix.ts";
import { startForecastPublications } from "./ercot_public_load_collector.ts";
import { startMisRenewablePublications } from "./ercot_mis_renewable_runner.ts";
import { startMisRegionalRenewablePublications } from "./ercot_mis_regional_runner.ts";
import { startMisMarketMechanics } from "./ercot_mis_market_runner.ts";
import { startPublicMarketGeography } from "./ercot_public_market_geography_runner.ts";
import { start as startGenerationOutages } from "./generation_outages.ts";
import { start as startGrid } from "./grid.ts";
import { start as startMetar } from "./metar.ts";
import { startNwsWeather } from "./nws_weather_runner.ts";
import { startLongHorizon } from "./long_horizon_runner.ts";
import { startExternalContext } from "./external_context_runner.ts";
import { start as startOperationsMessages } from "./operations_messages.ts";
import { start as startPrices } from "./prices.ts";
import { start as startStorage } from "./storage.ts";
import { start as startSupplyDemand } from "./supply_demand.ts";
import { start as startWindSolar } from "./wind_solar.ts";
import { startCollectorHealthServer, superviseCollectorRunner } from "./collector_health.ts";

import { runMetricsServer } from "./deps.ts";
if (Deno.args.includes("--serve-metrics")) {
  runMetricsServer({ port: 9090 });
  console.log("Now serving OpenMetrics @ :9090/metrics");
}

if (import.meta.main) {
  await Promise.race([
    startCollectorHealthServer(),
    // 60s loops
    // run these offset from each other for better utilization
    superviseCollectorRunner("ercot_realtime", true, 60, startGrid),
    superviseCollectorRunner("ercot_ancillary", true, 300, async () => {
      await new Promise((ok) => setTimeout(ok, 30 * 1000));
      return await startAncillary();
    }),

    // 10+ minute loops, they can overlap, it's ok
    superviseCollectorRunner("ercot_eea", true, 600, startEea),
    superviseCollectorRunner("metar", true, 1_800, startMetar),
    superviseCollectorRunner("ercot_pricing", true, 900, startPrices),
    superviseCollectorRunner("fuel_mix", true, 300, startFuelMix),
    superviseCollectorRunner("energy_storage", true, 300, startStorage),
    superviseCollectorRunner("supply_demand", true, 300, startSupplyDemand),
    superviseCollectorRunner("generation_outages", true, 300, startGenerationOutages),
    superviseCollectorRunner("operations_messages", true, 180, startOperationsMessages),
    superviseCollectorRunner("wind_solar", true, 300, startWindSolar),
    superviseCollectorRunner(
      "forecast_publications",
      Deno.env.get("ERCOT_FORECAST_INGEST_ENABLED") === "true",
      300,
      startForecastPublications,
    ),
    superviseCollectorRunner(
      "renewable_publications",
      Deno.env.get("ERCOT_RENEWABLE_INGEST_ENABLED") === "true",
      300,
      startMisRenewablePublications,
    ),
    superviseCollectorRunner(
      "regional_renewable_publications",
      Deno.env.get("ERCOT_REGIONAL_RENEWABLE_INGEST_ENABLED") === "true",
      300,
      startMisRegionalRenewablePublications,
    ),
    superviseCollectorRunner(
      "market_mechanics",
      Deno.env.get("ERCOT_MARKET_MECHANICS_INGEST_ENABLED") === "true",
      300,
      startMisMarketMechanics,
    ),
    superviseCollectorRunner(
      "market_geography",
      Deno.env.get("ERCOT_MARKET_GEOGRAPHY_INGEST_ENABLED") === "true",
      300,
      startPublicMarketGeography,
    ),
    superviseCollectorRunner(
      "nws_weather",
      Deno.env.get("NWS_WEATHER_INGEST_ENABLED") === "true",
      300,
      startNwsWeather,
    ),
    superviseCollectorRunner(
      "long_horizon",
      Deno.env.get("ERCOT_LONG_HORIZON_INGEST_ENABLED") === "true",
      21_600,
      startLongHorizon,
    ),
    superviseCollectorRunner(
      "external_context",
      Deno.env.get("EXTERNAL_CONTEXT_INGEST_ENABLED") === "true",
      3_600,
      startExternalContext,
    ),
  ]);
}
