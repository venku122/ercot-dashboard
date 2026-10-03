#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const cases = [
  ["6h", 7],
  ["24h", 25],
  ["7d", 169],
  ["30d", 721],
  ["90d", 1001],
  ["1y", 1001],
];

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`invalid_${name.slice(2).replaceAll("-", "_")}`);
  }
  return value;
}

const iterations = integerArgument("--iterations", 1_000);
const operationsPerSample = integerArgument("--operations-per-sample", 50);
const warmups = integerArgument("--warmups", 100);
const vite = await createServer({
  root: new URL("../frontend", import.meta.url).pathname,
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await vite.listen();
  const origin = vite.resolvedUrls?.local[0];
  if (!origin) throw new Error("vite_origin_unavailable");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const measurements = await page.evaluate(
    async ({
      cases: benchmarkCases,
      iterations: sampleCount,
      operationsPerSample: operationCount,
      warmups: warmupCount,
    }) => {
      const { mergePoints } = await import("/src/dashboard/api.ts");
      const percentile = (values, fraction) => {
        const ordered = [...values].sort((left, right) => left - right);
        return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
      };
      const measure = (callback) => {
        for (let index = 0; index < warmupCount; index += 1) callback();
        const samples = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const started = performance.now();
          for (let operation = 0; operation < operationCount; operation += 1) callback();
          samples.push((performance.now() - started) / operationCount);
        }
        return {
          p50_milliseconds: percentile(samples, 0.5),
          p95_milliseconds: percentile(samples, 0.95),
        };
      };
      return benchmarkCases.map(([window, pointCount]) => {
        const points = Array.from({ length: pointCount }, (_, index) => [
          1_735_689_600 + index * 300,
          (index % 240) - 80,
        ]);
        const body = JSON.stringify({ points });
        return {
          window,
          points: pointCount,
          payload_bytes: new TextEncoder().encode(body).length,
          json_parse: measure(() => JSON.parse(body)),
          merge_points: measure(() => mergePoints([], points, points[0][0], points.at(-1)[0])),
        };
      });
    },
    { cases, iterations, operationsPerSample, warmups },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        browser: `Chromium ${browser.version()}`,
        iterations,
        measurements,
        operations_per_sample: operationsPerSample,
        runtime: "Playwright Chromium through the repository Vite module graph",
        warmups,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
