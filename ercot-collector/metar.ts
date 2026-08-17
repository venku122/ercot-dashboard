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

import { runMetricsLoop, type NormalizedMetric, headers, fetch } from "./_lib.ts";
export async function start() {
  await runMetricsLoop(grabUserMetrics, 30, "metar");
}
if (import.meta.main) start();

export type MetarEntry = {
  icaoId: string;
  obsTime?: number;
  temp?: number;
  dewp?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  altim?: number;
};

const HPA_TO_INHG = 0.0295299830714;
const KNOTS_TO_MPH = 1.15078;

async function grabUserMetrics(): Promise<NormalizedMetric[]> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${ids.join(",")}&format=json`;
  const body = (await fetch(url, headers("application/json")).then((resp) =>
    resp.json(),
  )) as MetarEntry[];

  const metrics = parseMetar(body);
  console.log(new Date(), "METAR", metrics[0]?.tags);
  return metrics;
}

export function parseMetar(body: MetarEntry[]): NormalizedMetric[] {
  const metrics = new Array<NormalizedMetric>();
  for (const entry of body) {
    const code = entry.icaoId;
    if (!code) continue;
    const tags = [`metar_code:${code}`, `metar_location:${code}`];
    const point = (value: number) => ({
      ...(typeof entry.obsTime === "number" ? { timestamp: entry.obsTime } : {}),
      value,
    });

    if (typeof entry.temp === "number") {
      metrics.push({
        metric_name: `metar.temperature`,
        tags,
        points: [point(entry.temp)],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.dewp === "number") {
      metrics.push({
        metric_name: `metar.dewpoint`,
        tags,
        points: [point(entry.dewp)],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.wspd === "number") {
      metrics.push({
        metric_name: `metar.winds.speed`,
        tags,
        points: [point(entry.wspd * KNOTS_TO_MPH)],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.wdir === "number") {
      metrics.push({
        metric_name: `metar.winds.direction_degrees`,
        tags,
        points: [point(entry.wdir)],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.wgst === "number") {
      metrics.push({
        metric_name: `metar.winds.gust_mph`,
        tags,
        points: [point(entry.wgst * KNOTS_TO_MPH)],
        interval: 60,
        metric_type: "gauge",
      });
    }

    if (typeof entry.altim === "number") {
      metrics.push({
        metric_name: `metar.pressure`,
        tags,
        points: [point(entry.altim * HPA_TO_INHG)],
        interval: 60,
        metric_type: "gauge",
      });
    }
  }

  return metrics;
}
