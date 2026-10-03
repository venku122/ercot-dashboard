import {
  collectorCycleStarted,
  collectorDeliveryFailed,
  collectorDeliverySucceeded,
  collectorHealthSnapshot,
  collectorUpstreamSucceeded,
  configureCollectorRunner,
} from "./collector_health.ts";

function assert(value: unknown, message = "assertion_failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("disabled runner differs from failed delivery and exposes no secret", () => {
  configureCollectorRunner("external_context", false, 604_800);
  configureCollectorRunner("ercot_realtime", true, 60);
  collectorCycleStarted("ercot_realtime");
  collectorUpstreamSucceeded("ercot_realtime");
  collectorDeliveryFailed("ercot_realtime");
  const snapshot = collectorHealthSnapshot();
  const disabled = snapshot.runners.find((row) => row.runner === "external_context")!;
  const failed = snapshot.runners.find((row) => row.runner === "ercot_realtime")!;
  assert(disabled.enabled === false && disabled.total_failures === 0);
  assert(failed.enabled && failed.last_upstream_success !== null);
  assert(failed.last_receiver_delivery_failure !== null && failed.consecutive_failures > 0);
  assert(!JSON.stringify(snapshot).toLowerCase().includes("api_key"));
});

Deno.test("successful receiver delivery resets consecutive failures", () => {
  collectorDeliverySucceeded("ercot_realtime");
  const row = collectorHealthSnapshot().runners.find((item) => item.runner === "ercot_realtime")!;
  assert(row.consecutive_failures === 0 && row.total_successes > 0);
});
