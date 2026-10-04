import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSeries, resetCanonicalApiCachesForTests } from "./api";
import { headroomChart, homepageSeries } from "./homepage-model";
import { parseTileCatalog } from "./tile-planner";

const pairing = {
  policy: "supply-demand-observed-exact-epoch-v1",
  contributors: [
    { metric: "ercot.supply_demand.available_capacity_mw", tags: ["source:supply_demand"] },
    { metric: "ercot.supply_demand.demand_mw", tags: ["source:supply_demand"] },
  ],
};
const entry = {
  key: "supply-demand.paired-headroom",
  metric: "ercot.supply_demand.paired_headroom_mw",
  tags: ["source:supply_demand"],
  match: "paired",
  pairing,
  source: "supply_demand",
  native_interval_seconds: 300,
  supported_lods: ["native", "5m", "15m", "1h"],
  rollup: null,
  unit: "MW",
  statistic_policy: "gauge",
};
const catalog = {
  schema: 2,
  tile_spans: { "1h": 3600, "1d": 86400 },
  lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": 3600 },
  boundary_policy: { coarse_partial_clipping: false, edge_lod: "native", rule: "native edges" },
  series: [entry],
  derived_resources: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  resetCanonicalApiCachesForTests();
});
describe("paired headroom semantic identity", () => {
  it("accepts the source-paired gauge contract and rejects an unrelated same-cadence pair", () => {
    expect(parseTileCatalog(catalog).series[0].match).toBe("paired");
    expect(() =>
      parseTileCatalog({
        ...catalog,
        series: [
          { ...entry, pairing: { ...pairing, contributors: [...pairing.contributors].reverse() } },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseTileCatalog({ ...catalog, series: [{ ...entry, statistic_policy: "power" }] }),
    ).toThrow();
  });
  it("never replaces a bounded paired response with independently averaged local contributors", () => {
    const paired = {
      points: [[90000, -10] as [number, number]],
      compare: [],
      error: null,
      meta: { bucket_seconds: 3600 },
    };
    const source = new Map([["overview-headroom:headroom", paired]]);
    expect(homepageSeries(source).get("overview-headroom:headroom")).toBe(paired);
  });
  it.each(["live", "fixed"] as const)(
    "fails closed in %s mode against an older receiver without fetching raw derived history",
    async (mode) => {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          urls.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ ...catalog, series: [] }), { status: 200 }),
          );
        }),
      );
      const result = await loadSeries(
        [
          {
            ...headroomChart,
            series: headroomChart.series.filter((series) => series.id === "headroom"),
          },
        ],
        { mode, start: 86400, end: 90000, rangeSeconds: 3600, paused: true },
        "none",
        0,
        new AbortController().signal,
      );
      expect(result.get("overview-headroom:headroom")?.error).toBe("paired_headroom_unavailable");
      expect(urls).toEqual(["/api/v2/tile-catalog?include=paired-headroom"]);
    },
  );
});

function headroomTile(
  url: string,
  raw = [
    [90000, 10],
    [90300, 5],
    [90600, -10],
  ],
) {
  const match = /\/tiles\/[^/]+\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/.exec(url)!;
  const start = Number(match[2]);
  const end = start + (match[1] === "1d" ? 86400 : 3600);
  const points = raw.filter(([ts]) => ts >= start && ts < end);
  const width =
    match[3] === "native" ? 0 : match[3] === "1h" ? 3600 : match[3] === "15m" ? 900 : 300;
  const groups = new Map<number, number[][]>();
  for (const point of points) {
    const key = width ? Math.floor(point[0] / width) * width : point[0];
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  const buckets = [...groups].map(([bucket, rows]) => {
    const first = rows[0];
    const last = rows.at(-1)!;
    const min = rows.reduce((a, b) => (a[1] <= b[1] ? a : b));
    const max = rows.reduce((a, b) => (a[1] >= b[1] ? a : b));
    return {
      start: bucket,
      end: bucket + width,
      state: {
        version: 2,
        count: rows.length,
        value_sum: rows.reduce((sum, row) => sum + row[1], 0),
        minimum: min[1],
        minimum_ts: min[0],
        maximum: max[1],
        maximum_ts: max[0],
        first_ts: first[0],
        first_value: first[1],
        first_ordinal: 0,
        last_ts: last[0],
        last_value: last[1],
        last_ordinal: 0,
        integral_value_seconds: rows
          .slice(1)
          .reduce((sum, row, index) => sum + rows[index][1] * (row[0] - rows[index][0]), 0),
      },
    };
  });
  return {
    schema: 2,
    series_key: entry.key,
    tile_span: match[1],
    tile_start: start,
    tile_end: end,
    lod: match[3],
    native_interval_seconds: 300,
    unit: "MW",
    statistic_policy: "gauge",
    rollup: null,
    boundary_policy: "native_edges_coarse_aligned_interiors",
    buckets,
    pairing: {
      policy: pairing.policy,
      paired_count: points.length,
      expected_count: (end - start) / 300,
      unpaired_count: 0,
      ambiguous_count: 0,
      first_observed_ts: points[0]?.[0] ?? null,
      last_observed_ts: points.at(-1)?.[0] ?? null,
      collection_history: "first_collection_time_not_recorded",
      reason: points.length ? null : "no_matching_native_epochs",
      partial_buckets: width ? buckets.map((bucket) => bucket.start) : [],
    },
  };
}

describe("populated paired tile projections", () => {
  it.each([21600, 86400, 7 * 86400, 30 * 86400, 90 * 86400, 365 * 86400])(
    "preserves raw oracle statistics and negative extrema across %s second windows",
    async (span) => {
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
          urls.push(url);
          return Promise.resolve(
            new Response(
              JSON.stringify(url.includes("tile-catalog") ? catalog : headroomTile(url)),
              { status: 200 },
            ),
          );
        }),
      );
      const result = await loadSeries(
        [
          {
            ...headroomChart,
            series: headroomChart.series.filter((series) => series.id === "headroom"),
          },
        ],
        { mode: "fixed", start: 86400, end: 86400 + span, rangeSeconds: span, paused: true },
        "none",
        0,
        new AbortController().signal,
      );
      const loaded = result.get("overview-headroom:headroom")!;
      expect(loaded.error).toBeNull();
      expect(loaded.meta.stats).toEqual({
        average: 5 / 3,
        count: 3,
        energy_mwh: null,
        latest: -10,
        minimum: -10,
        minimum_ts: 90600,
        maximum: 10,
        maximum_ts: 90000,
      });
      expect(loaded.meta.pairing?.paired_count).toBe(3);
      expect(loaded.points.some(([, value]) => value === -10)).toBe(true);
      expect(urls.every((url) => url.includes("/api/v2/"))).toBe(true);
      expect(urls.length).toBeLessThanOrEqual(Math.ceil(span / 86400) + 4);
    },
  );
});

it("starts operational plots while the optional paired catalog is pending", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("tile-catalog")) {
        await gate;
        return new Response(JSON.stringify({ ...catalog, series: [] }));
      }
      return new Response(JSON.stringify({ series: [] }));
    }),
  );
  const operational = {
    ...headroomChart,
    id: "operational",
    series: [
      { id: "demand", label: "Demand", color: "blue", metric: "ercot.supply_demand.demand_mw" },
    ],
  };
  const pending = loadSeries(
    [
      {
        ...headroomChart,
        series: headroomChart.series.filter((series) => series.id === "headroom"),
      },
      operational,
    ],
    { mode: "live", start: 86400, end: 90000, rangeSeconds: 3600, paused: false },
    "none",
    0,
    new AbortController().signal,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(urls).toContain("/api/series/batch");
  } finally {
    release();
    await pending;
  }
});

it("preserves an explicit unavailable reason for a window without matching native epochs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(JSON.stringify(url.includes("tile-catalog") ? catalog : headroomTile(url))),
      ),
    ),
  );
  const result = await loadSeries(
    [
      {
        ...headroomChart,
        series: headroomChart.series.filter((series) => series.id === "headroom"),
      },
    ],
    { mode: "fixed", start: 172800, end: 194400, rangeSeconds: 21600, paused: true },
    "none",
    0,
    new AbortController().signal,
  );
  expect(result.get("overview-headroom:headroom")?.error).toBe(
    "paired_headroom_no_matching_native_epochs",
  );
  expect(result.get("overview-headroom:headroom")?.points).toEqual([]);
});

it("retains current and comparison non-extreme final observations with coarse labels", async () => {
  const raw = [
    [694800, 10],
    [695100, 5],
    [695400, 7],
    [90000, 20],
    [90300, 15],
    [90600, 17],
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(url.includes("tile-catalog") ? catalog : headroomTile(url, raw)),
        ),
    ),
  );
  const result = await loadSeries(
    [
      {
        ...headroomChart,
        series: headroomChart.series.filter((series) => series.id === "headroom"),
      },
    ],
    { mode: "fixed", start: 691200, end: 1296000, rangeSeconds: 604800, paused: true },
    "custom",
    604800,
    new AbortController().signal,
  );
  const loaded = result.get("overview-headroom:headroom")!;
  expect(loaded.points).toEqual(raw.slice(0, 3));
  expect(loaded.compare).toEqual([
    [694800, 20],
    [695100, 15],
    [695400, 17],
  ]);
  expect(loaded.meta.stats?.latest).toBe(7);
  expect(loaded.meta.bucket_seconds).toBeGreaterThan(300);
  expect(loaded.meta.observed_envelope_support).toEqual([]);
});

it("does not invent comparison continuity across the Chicago fall-back calendar gap", async () => {
  const start = Date.parse("2026-11-01T05:00:00Z") / 1000;
  const end = Date.parse("2026-11-01T10:00:00Z") / 1000;
  const sourceStart = Date.parse("2026-10-31T05:00:00Z") / 1000;
  const raw = Array.from({ length: 48 }, (_, index) => [sourceStart + index * 300, 7]);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(url.includes("tile-catalog") ? catalog : headroomTile(url, raw)),
        ),
    ),
  );
  const result = await loadSeries(
    [
      {
        ...headroomChart,
        series: headroomChart.series.filter((series) => series.id === "headroom"),
      },
    ],
    { mode: "fixed", start, end, rangeSeconds: end - start, paused: true },
    "day",
    0,
    new AbortController().signal,
  );
  const loaded = result.get("overview-headroom:headroom")!;
  const gapStart = Date.parse("2026-11-01T06:55:00Z") / 1000;
  const gapEnd = Date.parse("2026-11-01T08:00:00Z") / 1000;
  expect(loaded.compare).toContainEqual([gapStart, 7]);
  expect(loaded.compare).toContainEqual([gapEnd, 7]);
  expect(
    loaded.meta.comparison_observed_envelope_support?.some(
      (range) => range.start <= gapStart && range.end >= gapEnd,
    ),
  ).toBe(false);
});
