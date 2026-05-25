// deno run --allow-net --allow-env examples/emit-metrics.ts

import { runMetricsLoop, MetricSubmission, headers, fetch } from "./_lib.ts";
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

function parseGridMetrics(body: string): MetricSubmission[] {
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const headerPattern =
    /<td\b[^>]*class=["'][^"']*\bheaderValueClass\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i;
  const valuePattern =
    /<td\b[^>]*class=["'][^"']*\btdLeft\b[^"']*["'][^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*class=["'][^"']*\blabelClassCenter\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i;

  let section = "";
  const metrics = new Array<MetricSubmission>();
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
        points: [{ value: parsedValue }],
        interval: 60,
        metric_type: "gauge",
      });
      continue;
    }

    metrics.push({
      metric_name: `ercot.${metricKey(section)}.${metricKey(label)}`,
      points: [{ value: parsedValue }],
      interval: 60,
      metric_type: "gauge",
    });
  }
  return metrics;
}

async function grabUserMetrics(): Promise<MetricSubmission[]> {
  const body = await fetch(
    "https://www.ercot.com/content/cdr/html/real_time_system_conditions.html",
    headers("text/html"),
  ).then((x) => x.text());

  const metrics = parseGridMetrics(body);
  if (!metrics.length) throw new Error("ercot_realtime_parse_empty");

  console.log(new Date(), "grid", metrics[0]?.points[0]?.value);

  return metrics;
}

export { parseGridMetrics };
