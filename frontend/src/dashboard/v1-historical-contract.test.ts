import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalChunkUrl, loadSeries } from "./api";
import type { ChartDefinition, TimeState } from "./types";

const DAY = 86_400;

function chart(series: ChartDefinition["series"]): ChartDefinition {
  return {
    description: "Historical contract fixture",
    group: "Contract",
    id: "contract",
    sourceUrl: "https://example.test/source",
    statisticPolicy: "gauge",
    title: "Historical contract",
    unit: "MW",
    series,
  };
}

function fixedTime(start: number, end: number): TimeState {
  return { end, mode: "fixed", paused: false, rangeSeconds: end - start, start };
}

function jsonResponse<T>(value: T): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("v1 historical request and cache-key contract", () => {
  it("keeps the exact canonical chunk key, including rounding and normalized tags", () => {
    expect(
      canonicalChunkUrl({
        aggregation: "minmax",
        chunkSeconds: DAY,
        end: 172_800.6,
        metric: "ercot.pricing",
        resolution: 300.6,
        rollup: "sum",
        start: 86_400.4,
        tags: ["zone:b", "zone:a", "zone:b"],
      }),
    ).toBe(
      "/api/v1/series/chunk?aggregation=minmax&chunk_seconds=86400&end=172801&metric=ercot.pricing&resolution=301&start=86400&rollup=sum&tag=zone%3Aa&tag=zone%3Ab",
    );
  });

  it.each([
    ["6h", 6 * 3600, 1, 18],
    ["24h", DAY, 1, 72],
    ["7d", 7 * DAY, 7, 504],
    ["30d", 30 * DAY, 30, 2160],
    ["90d", 90 * DAY, 90, 6480],
    ["1y", 365 * DAY, 365, 26_280],
  ])(
    "plans the supported %s fixed range as sealed daily cache keys",
    async (_label, rangeSeconds, expectedRequests, expectedResolution) => {
      const end = 5000 * DAY;
      const start = end - rangeSeconds;
      vi.spyOn(Date, "now").mockReturnValue((end + 2 * DAY) * 1000);
      const requested: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          requested.push(url);
          if (url === "/api/v2/tile-catalog") return jsonResponse({ schema: 1 });
          return jsonResponse({
            aggregation: "average",
            end: 0,
            metric: "ercot.fixture",
            points: [],
            resolution: expectedResolution,
            start: 0,
            tags: [],
          });
        }),
      );

      await loadSeries(
        [
          chart([
            {
              color: "#fff",
              id: "raw",
              label: "Raw",
              metric: "ercot.fixture",
            },
          ]),
        ],
        fixedTime(start, end),
        "none",
        DAY,
        new AbortController().signal,
      );

      const chunkRequests = requested.filter((url) => url.startsWith("/api/v1/series/chunk?"));
      expect(requested[0]).toBe("/api/v2/tile-catalog");
      expect(chunkRequests).toHaveLength(expectedRequests);
      expect(chunkRequests[0]).toBe(
        canonicalChunkUrl({
          chunkSeconds: DAY,
          end: start < end - DAY ? start + DAY : end,
          metric: "ercot.fixture",
          resolution: expectedResolution,
          start: Math.floor(start / DAY) * DAY,
        }),
      );
      expect(chunkRequests.at(-1)).toBe(
        canonicalChunkUrl({
          chunkSeconds: DAY,
          end,
          metric: "ercot.fixture",
          resolution: expectedResolution,
          start: end - DAY,
        }),
      );
      for (const url of chunkRequests) {
        const params = new URL(url, "https://example.test").searchParams;
        expect(params.get("chunk_seconds")).toBe(String(DAY));
        expect(params.get("resolution")).toBe(String(expectedResolution));
      }
    },
  );

  it("plans a near-current 6h fixed range as six exact hourly cache keys", async () => {
    const end = 5000 * DAY + 12 * 3600;
    const start = end - 6 * 3600;
    vi.spyOn(Date, "now").mockReturnValue(end * 1000);
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/v2/tile-catalog") return jsonResponse({ schema: 1 });
        return jsonResponse({
          aggregation: "average",
          end: 0,
          metric: "ercot.fixture",
          points: [],
          resolution: 18,
          start: 0,
          tags: [],
        });
      }),
    );

    await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "ercot.fixture" }])],
      fixedTime(start, end),
      "none",
      DAY,
      new AbortController().signal,
    );

    const chunkRequests = requested.filter((url) => url.startsWith("/api/v1/series/chunk?"));
    expect(requested[0]).toBe("/api/v2/tile-catalog");
    expect(chunkRequests).toHaveLength(6);
    expect(chunkRequests[0]).toBe(
      canonicalChunkUrl({
        chunkSeconds: 3600,
        end: start + 3600,
        metric: "ercot.fixture",
        resolution: 18,
        start,
      }),
    );
    expect(chunkRequests.at(-1)).toBe(
      canonicalChunkUrl({
        chunkSeconds: 3600,
        end,
        metric: "ercot.fixture",
        resolution: 18,
        start: end - 3600,
      }),
    );
  });
});

describe("v1 historical numeric semantics", () => {
  it("filters to the exact requested window and computes current fixed-series statistics", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10 * DAY * 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          aggregation: "average",
          end: DAY,
          metric: "ercot.fixture",
          points: [
            [-1, 99],
            [0, 10],
            [3600, 20],
            [7200, -5],
            [10_800, 15],
            [10_801, 100],
          ],
          resolution: 9,
          start: 0,
          tags: [],
        }),
      ),
    );

    const result = await loadSeries(
      [chart([{ color: "#fff", id: "raw", label: "Raw", metric: "ercot.fixture" }])],
      fixedTime(0, 10_800),
      "none",
      DAY,
      new AbortController().signal,
    );

    expect(result.get("contract:raw")).toEqual({
      compare: [],
      error: null,
      meta: {
        bucket_seconds: 9,
        max_points: 1200,
        partial_current_bucket: false,
        since: 0,
        stats: {
          average: 10,
          count: 4,
          energy_mwh: 25,
          latest: 15,
          maximum: 20,
          minimum: -5,
        },
        until: 10_800,
      },
      points: [
        [0, 10],
        [3600, 20],
        [7200, -5],
        [10_800, 15],
      ],
    });
  });

  it("preserves fixed comparison alignment and derivation through v1 chunk GET fallback", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === "/api/v2/tile-catalog") return jsonResponse({ schema: 1 });
        const metric = new URL(url, "https://example.test").searchParams.get("metric");
        return jsonResponse({
          aggregation: "average",
          end: DAY,
          metric,
          points:
            metric === "ercot.a"
              ? [
                  [1400, 7],
                  [2000, 10],
                  [2600, 20],
                ]
              : [
                  [1400, 2],
                  [2000, 3],
                  [2600, 5],
                ],
          resolution: 1,
          start: 0,
          tags: [],
        });
      }),
    );
    const definition = chart([
      { color: "#fff", id: "a", label: "A", metric: "ercot.a", tags: ["zone:a"] },
      { color: "#fff", id: "b", label: "B", metric: "ercot.b" },
      {
        color: "#fff",
        derive: { from: ["a", "b"], operation: "subtract" },
        id: "net",
        label: "A minus B",
      },
    ]);

    const result = await loadSeries(
      [definition],
      fixedTime(2000, 2600),
      "previous_period",
      DAY,
      new AbortController().signal,
    );

    expect(requested[0]).toBe("/api/v2/tile-catalog");
    expect(requested.filter((url) => url.startsWith("/api/v1/series/chunk?"))).toHaveLength(2);
    expect(requested.some((url) => url === "/api/series/batch")).toBe(false);
    expect(result.get("contract:a")?.compare).toEqual([
      [2000, 7],
      [2600, 10],
    ]);
    expect(result.get("contract:net")).toEqual({
      compare: [
        [2000, 5],
        [2600, 7],
      ],
      error: null,
      meta: {},
      points: [
        [2000, 7],
        [2600, 15],
      ],
    });
  });
});
