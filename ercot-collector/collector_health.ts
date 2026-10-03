export const COLLECTOR_RUNNERS = Object.freeze([
  "ercot_realtime",
  "ercot_ancillary",
  "ercot_eea",
  "metar",
  "ercot_pricing",
  "fuel_mix",
  "energy_storage",
  "supply_demand",
  "generation_outages",
  "operations_messages",
  "wind_solar",
  "forecast_publications",
  "renewable_publications",
  "regional_renewable_publications",
  "market_mechanics",
  "market_geography",
  "nws_weather",
  "long_horizon",
  "external_context",
] as const);

export type CollectorRunnerName = (typeof COLLECTOR_RUNNERS)[number];
type RunnerState = {
  runner: CollectorRunnerName;
  enabled: boolean;
  cadence_seconds: number;
  last_cycle_start: number | null;
  last_upstream_success: number | null;
  last_upstream_failure: number | null;
  last_receiver_delivery_success: number | null;
  last_receiver_delivery_failure: number | null;
  consecutive_failures: number;
  total_successes: number;
  total_failures: number;
  fatal_error_at: number | null;
};

const startedAt = Math.floor(Date.now() / 1_000);
let supervisorAlive = false;
const states = new Map<CollectorRunnerName, RunnerState>(
  COLLECTOR_RUNNERS.map((runner) => [
    runner,
    {
      runner,
      enabled: false,
      cadence_seconds: 0,
      last_cycle_start: null,
      last_upstream_success: null,
      last_upstream_failure: null,
      last_receiver_delivery_success: null,
      last_receiver_delivery_failure: null,
      consecutive_failures: 0,
      total_successes: 0,
      total_failures: 0,
      fatal_error_at: null,
    },
  ]),
);

function now(): number {
  return Math.floor(Date.now() / 1_000);
}
function state(name: string): RunnerState | null {
  return states.get(name as CollectorRunnerName) ?? null;
}
export function configureCollectorRunner(
  name: CollectorRunnerName,
  enabled: boolean,
  cadence: number,
) {
  const value = states.get(name)!;
  value.enabled = enabled;
  value.cadence_seconds = cadence;
}
export function collectorCycleStarted(name: string): void {
  const value = state(name);
  if (value) value.last_cycle_start = now();
}
export function collectorUpstreamSucceeded(name: string): void {
  const value = state(name);
  if (value) value.last_upstream_success = now();
}
export function collectorUpstreamFailed(name: string): void {
  const value = state(name);
  if (!value) return;
  value.last_upstream_failure = now();
  value.consecutive_failures++;
  value.total_failures++;
}
export function collectorDeliverySucceeded(name: string): void {
  const value = state(name);
  if (!value) return;
  value.last_receiver_delivery_success = now();
  value.consecutive_failures = 0;
  value.total_successes++;
}
export function collectorDeliveryFailed(name: string): void {
  const value = state(name);
  if (!value) return;
  value.last_receiver_delivery_failure = now();
  value.consecutive_failures++;
  value.total_failures++;
}

export async function superviseCollectorRunner(
  name: CollectorRunnerName,
  enabled: boolean,
  cadenceSeconds: number,
  runner: () => Promise<unknown>,
): Promise<never> {
  configureCollectorRunner(name, enabled, cadenceSeconds);
  if (!enabled) return await new Promise<never>(() => {});
  collectorCycleStarted(name);
  try {
    await runner();
  } catch (error) {
    const value = states.get(name)!;
    value.fatal_error_at = now();
    collectorDeliveryFailed(name);
    console.error(JSON.stringify({ event: "collector_runner_fatal", runner: name }));
    throw error;
  }
  const value = states.get(name)!;
  value.fatal_error_at = now();
  throw new Error(`collector_runner_ended:${name}`);
}

export function collectorHealthSnapshot(at = now()) {
  const runners = COLLECTOR_RUNNERS.map((name) => ({ ...states.get(name)! }));
  const unhealthy = runners.some((runner) => {
    if (!runner.enabled) return false;
    if (runner.fatal_error_at !== null) return true;
    if (runner.last_cycle_start === null)
      return at - startedAt > Math.max(300, runner.cadence_seconds * 2);
    const cycleTelemetryExists =
      runner.last_upstream_success !== null ||
      runner.last_upstream_failure !== null ||
      runner.last_receiver_delivery_success !== null ||
      runner.last_receiver_delivery_failure !== null;
    return (
      cycleTelemetryExists &&
      at - runner.last_cycle_start > Math.max(300, runner.cadence_seconds * 3)
    );
  });
  return {
    schema: 1,
    process_alive: true,
    supervisor_alive: supervisorAlive,
    healthy: supervisorAlive && !unhealthy,
    started_at: startedAt,
    build_revision: Deno.env.get("BUILD_REVISION")?.slice(0, 80) || null,
    runners,
  };
}

export function startCollectorHealthServer(port = 9091): Promise<never> {
  supervisorAlive = true;
  const server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/healthz" || url.search)
      return new Response("not found", { status: 404 });
    const body = collectorHealthSnapshot();
    return Response.json(body, {
      status: body.healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  });
  return server.finished.then(() => {
    supervisorAlive = false;
    throw new Error("collector_health_server_ended");
  });
}
