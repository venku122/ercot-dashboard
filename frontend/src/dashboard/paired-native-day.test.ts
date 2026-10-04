import { afterEach, expect, it, vi } from "vitest";
import { observedTileFixture, pairedCatalogEntry } from "../../../e2e/paired-headroom-fixtures";
import { loadSeries, resetCanonicalApiCachesForTests } from "./api";
import { headroomChart } from "./homepage-model";
import { parseTileCatalog, planTileRequests } from "./tile-planner";

const DAY = 86400;
const NOW = 1784674800;
const catalog = {
  schema: 2,
  tile_spans: { "1h": 3600, "1d": DAY },
  lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": 3600 },
  boundary_policy: { coarse_partial_clipping: false, edge_lod: "native", rule: "native edges" },
  derived_resources: [],
  series: [pairedCatalogEntry],
};
const chart = { ...headroomChart, series: headroomChart.series.filter((s) => s.id === "headroom") };
afterEach(() => {
  resetCanonicalApiCachesForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([6 * 3600, DAY])(
  "recent paired native %i-second windows use bounded UTC days including the closing edge",
  (duration) => {
    const parsed = parseTileCatalog(catalog);
    const requests = planTileRequests({
      catalog: parsed,
      entry: parsed.series[0]!,
      start: NOW - duration,
      end: NOW,
      now: NOW,
      targetPoints: 600,
    });
    expect(requests).toHaveLength(duration === DAY ? 2 : 1);
    expect(requests.every((r) => r.tileSpan === "1d" && r.lod === "native")).toBe(true);
    expect(requests[0]!.tileStart).toBe(Math.floor((NOW - duration) / DAY) * DAY);
    expect(requests.at(-1)!.tileEnd).toBeGreaterThan(NOW);
  },
);

it("day transport clips every selected tuple, support, counts, clock and extrema while keeping recent tiles at 30 seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  let correction = 0;
  const urls: string[] = [];
  const value = (metric: string, index: number) =>
    metric.includes("capacity")
      ? 88500 + Math.sin(index / 5) * 1800 + correction
      : 68200 + Math.sin(index / 5) * 3200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("tile-catalog")) return new Response(JSON.stringify(catalog));
      urls.push(url);
      return new Response(JSON.stringify(observedTileFixture(url, NOW, value, false, true)));
    }),
  );
  // End before now: day transport contains both older and newer off-window rows.
  const end = NOW - 3600,
    start = end - DAY;
  const time = { mode: "fixed" as const, paused: true, rangeSeconds: DAY, start, end };
  const get = async () =>
    (await loadSeries([chart], time, "none", 0, new AbortController().signal)).get(
      "overview-headroom:headroom",
    )!;
  const expected: Array<[number, number]> = [];
  for (let ts = start; ts <= end; ts += 300) {
    const index = 63 + (ts - Math.floor((NOW - 30) / 300) * 300) / 300;
    expected.push([ts, value("capacity", index) - value("demand", index)]);
  }
  const first = await get();
  expect(urls).toHaveLength(2);
  expect(first.error).toBeNull();
  expect(first.points).toEqual(expected);
  expect(first.meta.pairing).toMatchObject({ paired_count: 289, expected_count: 289 });
  expect(first.meta.stats).toMatchObject({
    count: 289,
    latest: expected.at(-1)![1],
    minimum: Math.min(...expected.map((p) => p[1])),
    maximum: Math.max(...expected.map((p) => p[1])),
  });
  expect(first.meta).toMatchObject({
    since: start,
    until: end,
    observed_envelope_support: [{ start, end }],
  });
  correction = 100;
  vi.setSystemTime(NOW * 1000 + 29999);
  expect((await get()).points).toEqual(expected);
  expect(urls).toHaveLength(2);
  vi.setSystemTime(NOW * 1000 + 30000);
  const corrected = await get();
  expect(urls).toHaveLength(4);
  expect(corrected.points).toEqual(expected.map(([t, v]) => [t, v + 100]));
  expect(corrected.meta.pairing?.paired_count).toBe(289);
});

it("paired day comparison preserves all 289 selected observations and aligned source support", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  const urls: string[] = [];
  const value = (metric: string, index: number) =>
    metric.includes("capacity") ? 90000 + index : 70000 + index / 2;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("tile-catalog")) return new Response(JSON.stringify(catalog));
      urls.push(url);
      return new Response(JSON.stringify(observedTileFixture(url, NOW, value, false, true)));
    }),
  );
  const start = NOW - DAY,
    end = NOW;
  const loaded = (
    await loadSeries(
      [chart],
      { mode: "fixed", paused: true, rangeSeconds: DAY, start, end },
      "previous_period",
      0,
      new AbortController().signal,
    )
  ).get("overview-headroom:headroom")!;
  expect(urls).toHaveLength(3);
  expect(loaded.points).toHaveLength(289);
  const expected = [];
  for (let ts = start - DAY; ts <= end - DAY; ts += 300) {
    const index = 63 + (ts - Math.floor((NOW - 30) / 300) * 300) / 300;
    expected.push([ts + DAY, value("capacity", index) - value("demand", index)]);
  }
  expect(loaded.compare).toEqual(expected);
  expect(loaded.meta.comparison_observed_envelope_support).toEqual([{ start, end }]);
});

it("paired longer native and coarse windows keep the existing recent-hour correction plan", () => {
  const parsed = parseTileCatalog(catalog),
    entry = parsed.series[0]!;
  for (const duration of [DAY + 300, 7 * DAY, 365 * DAY]) {
    const requests = planTileRequests({
      catalog: parsed,
      entry,
      start: NOW - duration,
      end: NOW,
      now: NOW,
      targetPoints: 600,
    });
    expect(requests.filter((r) => r.tileEnd > NOW - DAY).every((r) => r.tileSpan === "1h")).toBe(
      true,
    );
  }
});
