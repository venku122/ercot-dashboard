import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSeries } from "./api";
import type { ChartDefinition, TimeState } from "./types";

const HOUR = 3_600;
const DAY = 86_400;

function chart(
  series: ChartDefinition["series"],
  options: Partial<ChartDefinition> = {},
): ChartDefinition {
  return {
    description: "Tile client fixture",
    group: "Contract",
    id: "contract",
    sourceUrl: "https://example.test/source",
    statisticPolicy: "power",
    title: "Tile client",
    unit: "MW",
    series,
    ...options,
  };
}

function fixedTime(start: number, end: number): TimeState {
  return { end, mode: "fixed", paused: false, rangeSeconds: end - start, start };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    key: "fixture.power",
    match: "exact",
    metric: "fixture.power",
    native_interval_seconds: 300,
    rollup: null,
    source: "fixture",
    statistic_policy: "power",
    supported_lods: ["native", "5m", "15m", "1h"],
    tags: ["source:fixture"],
    unit: "MW",
    ...overrides,
  };
}

function catalog(entries = [catalogEntry()]) {
  return {
    boundary_policy: {
      coarse_partial_clipping: false,
      edge_lod: "native",
      rule: "native edges",
    },
    lod_seconds: { native: null, "5m": 300, "15m": 900, "1h": HOUR },
    schema: 2,
    series: entries,
    tile_spans: { "1d": DAY, "1h": HOUR },
  };
}

function state(points: Array<[number, number, number]>) {
  const ordered = [...points].sort((left, right) => left[0] - right[0] || left[2] - right[2]);
  const first = ordered[0];
  const last = ordered.at(-1);
  const values = ordered.map((point) => point[1]);
  const minimum = values.length ? Math.min(...values) : null;
  const maximum = values.length ? Math.max(...values) : null;
  const minimumPoint = ordered.find((point) => point[1] === minimum);
  const maximumPoint = ordered.find((point) => point[1] === maximum);
  return {
    count: ordered.length,
    first_ordinal: first?.[2] ?? null,
    first_ts: first?.[0] ?? null,
    first_value: first?.[1] ?? null,
    integral_value_seconds: ordered
      .slice(1)
      .reduce(
        (total, point, index) => total + ordered[index]![1] * (point[0] - ordered[index]![0]),
        0,
      ),
    last_ordinal: last?.[2] ?? null,
    last_ts: last?.[0] ?? null,
    last_value: last?.[1] ?? null,
    maximum,
    maximum_ts: maximumPoint?.[0] ?? null,
    minimum,
    minimum_ts: minimumPoint?.[0] ?? null,
    value_sum: values.reduce((total, value) => total + value, 0),
    version: 2,
  };
}

function tileResult(
  url: string,
  buckets: Array<{ end: number; start: number; state: ReturnType<typeof state> }>,
  entry = catalogEntry(),
) {
  const match = url.match(/^\/api\/v2\/tiles\/([^/]+)\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/);
  if (!match) throw new Error(`unexpected tile URL ${url}`);
  const [, seriesKey, tileSpan, rawStart, lod] = match;
  const tileStart = Number(rawStart);
  return {
    boundary_policy: "native_edges_coarse_aligned_interiors",
    buckets,
    lod,
    native_interval_seconds: entry.native_interval_seconds,
    rollup: entry.rollup,
    schema: 2,
    series_key: seriesKey,
    statistic_policy: entry.statistic_policy,
    tile_end: tileStart + (tileSpan === "1d" ? DAY : HOUR),
    tile_span: tileSpan,
    tile_start: tileStart,
    unit: entry.unit,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fixed-history semantic tile client", () => {
  it("preserves inclusive points and raw-state statistics and energy", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * DAY * 1000);
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        return response(
          tileResult(url, [
            { end: 0, start: 0, state: state([[0, 10, 0]]) },
            { end: HOUR, start: HOUR, state: state([[HOUR, 20, 0]]) },
            { end: 2 * HOUR, start: 2 * HOUR, state: state([[2 * HOUR, -5, 0]]) },
            { end: 3 * HOUR, start: 3 * HOUR, state: state([[3 * HOUR, 999, 0]]) },
          ]),
        );
      }),
    );

    const result = await loadSeries(
      [
        chart([
          { color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" },
          {
            color: "#aaa",
            derive: { from: ["raw"], operation: "sum" },
            id: "derived",
            label: "Derived",
          },
        ]),
      ],
      fixedTime(0, 2 * HOUR),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(requested.filter((url) => url.startsWith("/api/v2/tiles/"))).toHaveLength(1);
    expect(requested.some((url) => url.startsWith("/api/v1/"))).toBe(false);
    expect(result.get("contract:raw")).toEqual({
      compare: [],
      error: null,
      meta: {
        bucket_seconds: null,
        max_points: 1200,
        partial_current_bucket: false,
        since: 0,
        stats: {
          average: 25 / 3,
          count: 3,
          energy_mwh: 30,
          latest: -5,
          maximum: 20,
          minimum: -5,
        },
        until: 2 * HOUR,
      },
      points: [
        [0, 10],
        [HOUR, 20],
        [2 * HOUR, -5],
      ],
    });
    expect(result.get("contract:derived")?.points).toEqual([
      [0, 10],
      [HOUR, 20],
      [2 * HOUR, -5],
    ]);
  });

  it("deduplicates shared canonical tile URLs within one load", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * DAY * 1000);
    const tileCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        tileCalls.push(url);
        return response(tileResult(url, [{ end: 0, start: 0, state: state([[0, 1, 0]]) }]));
      }),
    );

    const shared = { color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" };
    await loadSeries(
      [chart([shared], { id: "first" }), chart([shared], { id: "second" })],
      fixedTime(0, HOUR),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(tileCalls).toHaveLength(1);
  });

  it("falls back atomically per series while leaving eligible siblings on v2", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * DAY * 1000);
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        if (url.includes("/api/v2/tiles/")) {
          return response(tileResult(url, [{ end: 0, start: 0, state: state([[0, 7, 0]]) }]));
        }
        return response({
          aggregation: "average",
          end: DAY,
          metric: "fixture.unsupported",
          points: [[0, 9]],
          resolution: 3,
          start: 0,
          tags: [],
        });
      }),
    );

    const result = await loadSeries(
      [
        chart([
          { color: "#fff", id: "supported", label: "Supported", metric: "fixture.power" },
          {
            color: "#aaa",
            id: "unsupported",
            label: "Unsupported",
            metric: "fixture.unsupported",
          },
        ]),
      ],
      fixedTime(0, HOUR),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(result.get("contract:supported")?.points).toEqual([[0, 7]]);
    expect(result.get("contract:unsupported")?.points).toEqual([[0, 9]]);
    expect(requested.filter((url) => url.startsWith("/api/v1/series/chunk"))).toHaveLength(1);
  });

  it("rejects a malformed tile atomically and uses only its v1 fallback", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * DAY * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        if (url.includes("/api/v2/tiles/")) {
          const malformed = tileResult(url, [
            { end: 0, start: 0, state: state([[0, 1, 0]]) },
            { end: HOUR, start: HOUR, state: state([[HOUR, 2, 0]]) },
          ]);
          malformed.series_key = "wrong.series";
          return response(malformed);
        }
        return response({
          aggregation: "average",
          end: DAY,
          metric: "fixture.power",
          points: [[0, 50]],
          resolution: 3,
          start: 0,
          tags: [],
        });
      }),
    );

    const result = await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" }])],
      fixedTime(0, HOUR),
      "none",
      DAY,
      new AbortController().signal,
    );
    expect(result.get("contract:raw")?.points).toEqual([[0, 50]]);
  });

  it("falls back atomically when one request in a multi-tile series fails", async () => {
    const end = 7 * DAY;
    vi.spyOn(Date, "now").mockReturnValue((end + 3 * DAY) * 1000);
    let failed = false;
    let v1Calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        if (url.startsWith("/api/v2/tiles/")) {
          if (!failed) {
            failed = true;
            return new Response("transient", { status: 503 });
          }
          return response(tileResult(url, []));
        }
        v1Calls += 1;
        return response({
          aggregation: "average",
          end: DAY,
          metric: "fixture.power",
          points: [[0, 77]],
          resolution: 504,
          start: 0,
          tags: [],
        });
      }),
    );

    const result = await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" }])],
      fixedTime(0, end),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(result.get("contract:raw")?.points).toEqual([[0, 77]]);
    expect(v1Calls).toBe(7);
  });

  it("propagates AbortError without attempting v1 fallback", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        throw new DOMException("cancelled", "AbortError");
      }),
    );

    await expect(
      loadSeries(
        [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" }])],
        fixedTime(0, HOUR),
        "none",
        DAY,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requested.some((url) => url.startsWith("/api/v1/"))).toBe(false);
  });

  it("projects spike envelopes while statistics remain raw aggregate semantics", async () => {
    const frequency = catalogEntry({
      key: "frequency.system",
      metric: "fixture.frequency",
      native_interval_seconds: 60,
      statistic_policy: "gauge",
      supported_lods: ["native", "5m", "15m", "1h"],
      tags: [],
      unit: "Hz",
    });
    vi.spyOn(Date, "now").mockReturnValue(20 * DAY * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") return response(catalog([frequency]));
        const coarse = url.endsWith("/1d/0/1h")
          ? [
              {
                end: HOUR,
                start: 0,
                state: state([
                  [100, 59.8, 0],
                  [200, 60.2, 0],
                ]),
              },
            ]
          : [];
        return response(tileResult(url, coarse, frequency));
      }),
    );

    const result = await loadSeries(
      [
        chart(
          [{ color: "#fff", id: "frequency", label: "Frequency", metric: "fixture.frequency" }],
          { spikeCritical: true, statisticPolicy: "gauge", unit: "Hz" },
        ),
      ],
      fixedTime(0, 7 * DAY),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(result.get("contract:frequency")?.points).toEqual([
      [100, 59.8],
      [200, 60.2],
    ]);
    expect(result.get("contract:frequency")?.meta.stats).toEqual({
      average: 60,
      count: 2,
      energy_mwh: null,
      latest: 60.2,
      maximum: 60.2,
      minimum: 59.8,
    });
  });

  it("bounds a year of tile fetches to eight concurrent requests", async () => {
    const end = 365 * DAY;
    vi.spyOn(Date, "now").mockReturnValue((end + 3 * DAY) * 1000);
    let active = 0;
    let maximumActive = 0;
    let tileCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") return response(catalog());
        tileCount += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return response(tileResult(url, []));
      }),
    );

    await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" }])],
      fixedTime(0, end),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(tileCount).toBe(366);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it.each([
    ["live", "none"],
    ["fixed", "previous_period"],
  ] as const)("leaves %s/%s loading on the established batch API", async (mode, compare) => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requested.push(String(input));
        return response({ series: [] });
      }),
    );
    const time = { ...fixedTime(HOUR, 2 * HOUR), mode };

    await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "fixture.power" }])],
      time,
      compare,
      DAY,
      new AbortController().signal,
    );

    expect(requested).toEqual(["/api/series/batch"]);
  });
});
