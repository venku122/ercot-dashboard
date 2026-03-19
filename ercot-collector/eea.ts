// deno run --allow-net --allow-env examples/emit-metrics.ts

import { runMetricsLoop, MetricSubmission, headers, fetch } from "./_lib.ts";
export async function start() {
  await runMetricsLoop(grabUserMetrics, 10, "ercot_eea");
}
if (import.meta.main) start();

async function grabUserMetrics(): Promise<MetricSubmission[]> {
  const body = (await fetch(
    "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
    headers("application/json"),
  ).then((x) => x.json())) as { current_condition?: { eea_level?: number; state?: string } };

  const current = body?.current_condition;
  if (!current || typeof current.eea_level !== "number") {
    console.log(new Date(), "EEA Unknown");
    return [];
  }

  const level = current.eea_level;
  console.log(new Date(), "EEA Level", level, current.state ?? "");

  return [
    {
      metric_name: `ercot.eea_level`,
      points: [{ value: level }],
      interval: 60 * 10,
      metric_type: "gauge",
    },
  ];
}
