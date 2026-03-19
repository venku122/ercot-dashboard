// deno run --allow-net --allow-env examples/emit-metrics.ts

import { runMetricsLoop, MetricSubmission, headers, fetch } from "./_lib.ts";
export async function start() {
  await runMetricsLoop(grabUserMetrics, 5, "ercot_ancillary");
}
if (import.meta.main) start();

type AncillaryResponse = {
  lastUpdated?: string;
  data?: Record<string, Array<[string, string | number]>>;
};

async function grabUserMetrics(): Promise<MetricSubmission[]> {
  const body = (await fetch(
    "https://www.ercot.com/api/1/services/read/dashboards/ancillary-service-capacity-monitor.json",
    headers("application/json"),
  ).then((x) => x.json())) as AncillaryResponse;

  const metrics = new Array<MetricSubmission>();
  const groups = body.data ?? {};
  let prcValue: number | undefined;
  for (const [group, rows] of Object.entries(groups)) {
    for (const row of rows.slice(1)) {
      const [key, rawValue] = row;
      if (!key) continue;
      const value = parseFloat(String(rawValue).replace(/,/g, ""));
      if (Number.isNaN(value)) continue;
      if (key === "prc") prcValue = value;
      metrics.push({
        metric_name: `ercot_ancillary.${key}`,
        tags: [`group:${group}`],
        points: [{ value }],
        interval: 60,
        metric_type: "gauge",
      });
    }
  }

  console.log(new Date(), "ancillary", body.lastUpdated ?? "unknown", prcValue);

  return metrics;
}
