// deno run --allow-net --allow-env examples/emit-metrics.ts

import { fetch, headers, runMetricsLoop, type NormalizedMetric } from "./_lib.ts";
export async function start() {
  await runMetricsLoop(grabUserMetrics, 1, "ercot_realtime");
}
if (import.meta.main) start();

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function metricKey(value: string): string {
  return value
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim()
    .replace(/[ -]+/g, "_");
}

function parseGridMetrics(body: string, capturedAt: number): NormalizedMetric[] {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
    throw new Error("ercot_realtime_capture_timestamp_invalid");
  }
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const headerPattern =
    /<td\b[^>]*class=["'][^"']*\bheaderValueClass\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i;
  const valuePattern =
    /<td\b[^>]*class=["'][^"']*\btdLeft\b[^"']*["'][^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*class=["'][^"']*\blabelClassCenter\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i;

  let section = "";
  const metrics = new Array<NormalizedMetric>();
  for (const [, row] of body.matchAll(rowPattern)) {
    const header = row.match(headerPattern);
    if (header) {
      section = stripTags(header[1]);
      continue;
    }

    const value = row.match(valuePattern);
    if (!value || !section) continue;

    const label = stripTags(value[1]);
    const parsedValue = Number.parseFloat(stripTags(value[2]).replace(/,/g, ""));
    if (!Number.isFinite(parsedValue)) continue;

    if (section === "DC Tie Flows") {
      metrics.push({
        metric_name: `ercot.${metricKey(section)}`,
        tags: [`ercot_dc_tie:${label.split("(")[0].trim()}`],
        points: [{ timestamp: capturedAt, value: parsedValue }],
        interval: 60,
        metric_type: "gauge",
      });
      continue;
    }

    metrics.push({
      metric_name: `ercot.${metricKey(section)}.${metricKey(label)}`,
      points: [{ timestamp: capturedAt, value: parsedValue }],
      interval: 60,
      metric_type: "gauge",
    });
  }
  return metrics;
}

const NET_LOAD_QUARTET = [
  "ercot.Real_Time_Data.Actual_System_Demand",
  "ercot.Real_Time_Data.Total_Wind_Output",
  "ercot.Real_Time_Data.Total_PVGR_Output",
  "ercot.Real_Time_Data.Average_Net_Load",
] as const;

function validateNetLoadQuartet(metrics: readonly NormalizedMetric[]): void {
  for (const metricName of NET_LOAD_QUARTET) {
    const count = metrics.filter((metric) => metric.metric_name === metricName).length;
    if (count === 0) throw new Error("ercot_realtime_net_load_contract_missing");
    if (count !== 1) throw new Error("ercot_realtime_net_load_contract_duplicate");
  }
}

async function grabUserMetrics(): Promise<NormalizedMetric[]> {
  const body = await fetch(
    "https://www.ercot.com/content/cdr/html/real_time_system_conditions.html",
    headers("text/html"),
  ).then((x) => x.text());

  const capturedAt = Math.floor(Date.now() / 1000);
  const metrics = parseGridMetrics(body, capturedAt);
  if (!metrics.length) throw new Error("ercot_realtime_parse_empty");
  validateNetLoadQuartet(metrics);

  console.log(new Date(), "grid", metrics[0]?.points[0]?.value);

  return metrics;
}

export { parseGridMetrics, validateNetLoadQuartet };
