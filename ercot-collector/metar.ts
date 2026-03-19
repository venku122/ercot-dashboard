// deno run --allow-net --allow-env examples/emit-metrics.ts

const ids = [
  "KABI", // Abilene (near Roscoe Wind Farm)
  "KAUS",
  "KDFW",
  "KEFD", // Houston/Ellington Ar
  "KGLS", // Galveston/Scholes In
  "KHOU", // Houston/Hobby Arpt
  "KIAH",
  "KLBX", // Angleton/Texas Gulf
  "KLRD", // Laredo (nearish Javelina Wind Energy Center)
  "KLVJ", // Houston/Pearland Rgn
  "KMAF",
  "KSAT",
  "KSGR", // Houston/Sugar Land R
  "KTKI",
];

import { runMetricsLoop, MetricSubmission, headers, fetch } from "./_lib.ts";
export async function start() {
  await runMetricsLoop(grabUserMetrics, 30, "metar");
}
if (import.meta.main) start();

type MetarEntry = {
  icaoId: string;
  obsTime?: number;
  temp?: number;
  dewp?: number;
  wspd?: number;
  altim?: number;
};

const HPA_TO_INHG = 0.0295299830714;
const KNOTS_TO_MPH = 1.15078;

async function grabUserMetrics(): Promise<MetricSubmission[]> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&format=json`;
  const body = (await fetch(url, headers("application/json")).then((resp) =>
    resp.json(),
  )) as MetarEntry[];

  const metrics = new Array<MetricSubmission>();
  for (const entry of body) {
    const code = entry.icaoId;
    if (!code) continue;
    const tags = [`metar_code:${code}`, `metar_location:${code}`];

    if (typeof entry.temp === "number") {
      metrics.push({
        metric_name: `metar.temperature`,
        tags,
        points: [{ value: entry.temp }],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.dewp === "number") {
      metrics.push({
        metric_name: `metar.dewpoint`,
        tags,
        points: [{ value: entry.dewp }],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.wspd === "number") {
      metrics.push({
        metric_name: `metar.winds.speed`,
        tags,
        points: [{ value: entry.wspd * KNOTS_TO_MPH }],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.altim === "number") {
      metrics.push({
        metric_name: `metar.pressure`,
        tags,
        points: [{ value: entry.altim * HPA_TO_INHG }],
        interval: 60,
        metric_type: "gauge",
      });
    }
  }

  console.log(new Date(), "METAR", metrics[0]?.tags);
  return metrics;
}
