import { rehearsalOrigin } from "./rehearsal_guard.ts";
import { HttpNwsWeatherTransport, runNwsWeatherCycle } from "./nws_weather_runner.ts";
import { runLongHorizonCycle } from "./long_horizon_runner.ts";
import { runExternalContextCycle } from "./external_context_runner.ts";
import { HttpMisRenewableTransport, runRenewableCycle } from "./ercot_mis_renewable_runner.ts";
import {
  HttpRegionalRenewableTransport,
  runRegionalRenewableCycle,
} from "./ercot_mis_regional_runner.ts";
import {
  HttpMarketMechanicsTransport,
  runMarketMechanicsCycle,
} from "./ercot_mis_market_runner.ts";
import {
  HttpPublicMarketGeographyTransport,
  runPublicMarketGeographyCycle,
} from "./ercot_public_market_geography_runner.ts";

const family = Deno.args[0];
const origin = rehearsalOrigin(Deno.env.get("REHEARSAL_RECEIVER_ORIGIN") ?? "").origin;
const key = Deno.env.get("REHEARSAL_RECEIVER_KEY") ?? "";
if (!key) throw new Error("local_rehearsal_key_required");
const now = Math.floor(Date.now() / 1000);
try {
  if (family === "nws")
    await runNwsWeatherCycle(
      new HttpNwsWeatherTransport(
        origin + "/api/predictive-weather/ingest",
        key,
        "ERCOTDashboardLocalReview (https://github.com/venku122/ercot-dashboard)",
      ),
      now,
    );
  else if (family === "planning")
    await runLongHorizonCycle(origin + "/api/texas-grid/ingest", key, now);
  else if (family === "egrid")
    await runExternalContextCycle(origin + "/api/external-context/ingest", key, now);
  else if (family === "renewables")
    await runRenewableCycle(
      new HttpMisRenewableTransport(origin + "/api/renewable-publications/ingest", key),
      now,
    );
  else if (family === "regional")
    await runRegionalRenewableCycle(
      new HttpRegionalRenewableTransport(
        origin + "/api/regional-renewable-publications/ingest",
        key,
      ),
      now,
    );
  else if (family === "market")
    await runMarketMechanicsCycle(
      new HttpMarketMechanicsTransport(origin + "/api/market-mechanics-publications/ingest", key),
      now,
    );
  else if (family === "geography")
    await runPublicMarketGeographyCycle(
      new HttpPublicMarketGeographyTransport(
        origin + "/api/market-geography-publications/ingest",
        key,
      ),
      now,
    );
  else throw new Error("unsupported_rehearsal_family");
  console.log(
    JSON.stringify({
      family,
      mode: "ISOLATED_LOCAL_LIVE_SOURCE",
      upstream_and_delivery: "PASS",
      at: now,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      family,
      mode: "ISOLATED_LOCAL_LIVE_SOURCE",
      upstream_and_delivery: "FAIL",
      reason: error instanceof Error ? error.message : "unknown",
      at: now,
    }),
  );
  Deno.exitCode = 1;
}
