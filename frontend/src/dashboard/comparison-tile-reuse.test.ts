import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSeries, resetCanonicalApiCachesForTests } from "./api";
import type { ChartDefinition, TimeState } from "./types";

const DAY = 86_400;
const AUGUST_1 = Date.parse("2026-08-01T00:00:00Z") / 1_000;
const AUGUST_8 = Date.parse("2026-08-08T00:00:00Z") / 1_000;
const JULY_25 = Date.parse("2026-07-25T00:00:00Z") / 1_000;
const NOW = Date.parse("2026-09-01T00:00:00Z");

type CatalogEntry = ReturnType<typeof catalogEntry>;
type FetchCall = { method: string; url: string };

function catalogEntry(metric = "fixture.power", key = "fixture.power") {
  return {
    key,
    match: "exact" as const,
    metric,
    native_interval_seconds: 300,
    rollup: null,
    source: "fixture",
    statistic_policy: "power" as const,
    supported_lods: ["native", "5m", "15m", "1h"],
    tags: ["source:fixture"],
    unit: "MW",
  };
}

function catalog(series: readonly CatalogEntry[]) {
  return {
    boundary_policy: {
      coarse_partial_clipping: false,
      edge_lod: "native",
      rule: "native edges, aligned coarse interiors",
    },
    derived_resources: [],
    lod_seconds: { "15m": 900, "1h": 3600, "5m": 300, native: null },
    schema: 2,
    series,
    tile_spans: { "1d": DAY, "1h": 3600 },
  };
}

function chart(id = "contract", metric = "fixture.power"): ChartDefinition {
  return {
    description: "Comparison reuse fixture",
    group: "Contract",
    id,
    sourceUrl: "https://example.test/source",
    statisticPolicy: "power",
    title: "Comparison reuse",
    unit: "MW",
    series: [{ color: "#fff", id: "physical", label: "Physical", metric }],
  };
}

function fixedTime(start: number, end: number): TimeState {
  return { end, mode: "fixed", paused: false, rangeSeconds: end - start, start };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function tileResponse(url: string, entries: readonly CatalogEntry[]) {
  const match = url.match(/^\/api\/v2\/tiles\/([^/]+)\/(1h|1d)\/(\d+)\/(native|5m|15m|1h)$/);
  if (!match) throw new Error(`unexpected tile URL: ${url}`);
  const [, seriesKey, tileSpan, rawStart, lod] = match;
  const entry = entries.find((candidate) => candidate.key === seriesKey);
  if (!entry) throw new Error(`unknown fixture series: ${seriesKey}`);
  const tileStart = Number(rawStart);
  const tileEnd = tileStart + (tileSpan === "1d" ? DAY : 3600);
  const value = 10 + Math.floor((tileStart - JULY_25) / DAY);
  const native = lod === "native";
  const bucketEnd = native
    ? tileStart
    : tileStart + (lod === "5m" ? 300 : lod === "15m" ? 900 : 3600);
  const lastTimestamp = native ? tileStart : tileStart + 300;
  return {
    boundary_policy: "native_edges_coarse_aligned_interiors",
    buckets: [
      {
        end: bucketEnd,
        start: tileStart,
        state: {
          count: native ? 1 : 2,
          first_ordinal: 0,
          first_ts: tileStart,
          first_value: value,
          integral_value_seconds: native ? 0 : value * 300,
          last_ordinal: 0,
          last_ts: lastTimestamp,
          last_value: value,
          maximum: value,
          maximum_ts: tileStart,
          minimum: value,
          minimum_ts: tileStart,
          value_sum: native ? value : value * 2,
          version: 2,
        },
      },
    ],
    lod,
    native_interval_seconds: entry.native_interval_seconds,
    rollup: entry.rollup,
    schema: 2,
    series_key: entry.key,
    statistic_policy: entry.statistic_policy,
    tile_end: tileEnd,
    tile_span: tileSpan,
    tile_start: tileStart,
    unit: entry.unit,
  };
}

function installFixture(entries: readonly CatalogEntry[], calls: FetchCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url === "/api/v2/tile-catalog") return jsonResponse(catalog(entries));
      if (url.startsWith("/api/v2/tiles/")) return jsonResponse(tileResponse(url, entries));
      if (url.startsWith("/api/v1/series/chunk?")) {
        const parsed = new URL(url, "https://example.test");
        const start = Number(parsed.searchParams.get("start"));
        const end = Number(parsed.searchParams.get("end"));
        return jsonResponse({
          aggregation: parsed.searchParams.get("aggregation"),
          end,
          metric: parsed.searchParams.get("metric"),
          points: [[start, 5]],
          resolution: Number(parsed.searchParams.get("resolution")),
          start,
          tags: parsed.searchParams.getAll("tag"),
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  resetCanonicalApiCachesForTests();
});

afterEach(() => {
  resetCanonicalApiCachesForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("comparison tiles and canonical application reuse", () => {
  it("loads Aug 1-7 and Jul 25-31 with canonical v2 GETs only", async () => {
    const entry = catalogEntry();
    const calls: FetchCall[] = [];
    installFixture([entry], calls);

    const result = await loadSeries(
      [chart()],
      fixedTime(AUGUST_1, AUGUST_8),
      "previous_period",
      DAY,
      new AbortController().signal,
    );

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.startsWith("/api/v1/"))).toBe(false);
    expect(calls.some((call) => call.url === "/api/series/batch")).toBe(false);
    const tileCalls = calls.filter((call) => call.url.startsWith("/api/v2/tiles/"));
    expect(tileCalls).toHaveLength(16);
    expect(new Set(tileCalls.map((call) => call.url)).size).toBe(16);
    expect(
      tileCalls.every(
        ({ url }) =>
          !url.includes("?") &&
          /^\/api\/v2\/tiles\/fixture\.power\/1d\/\d+\/(?:native|15m)$/.test(url),
      ),
    ).toBe(true);
    const expectedUrls = new Set([
      ...Array.from(
        { length: 7 },
        (_, index) => `/api/v2/tiles/fixture.power/1d/${JULY_25 + index * DAY}/15m`,
      ),
      `/api/v2/tiles/fixture.power/1d/${AUGUST_1}/native`,
      ...Array.from(
        { length: 7 },
        (_, index) => `/api/v2/tiles/fixture.power/1d/${AUGUST_1 + index * DAY}/15m`,
      ),
      `/api/v2/tiles/fixture.power/1d/${AUGUST_8}/native`,
    ]);
    expect(new Set(tileCalls.map(({ url }) => url))).toEqual(expectedUrls);
    expect(result.get("contract:physical")?.points).toHaveLength(8);
    expect(result.get("contract:physical")?.compare).toHaveLength(8);
    expect(result.get("contract:physical")?.compare.map(([timestamp]) => timestamp)).toEqual(
      result.get("contract:physical")?.points.map(([timestamp]) => timestamp),
    );
  });

  it("keeps unsupported fixed comparison fallback on v1 chunk GETs, never POST", async () => {
    const calls: FetchCall[] = [];
    installFixture([], calls);

    const result = await loadSeries(
      [chart("unsupported", "fixture.unsupported")],
      fixedTime(AUGUST_1, AUGUST_8),
      "previous_period",
      DAY,
      new AbortController().signal,
    );

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url === "/api/series/batch")).toBe(false);
    const chunks = calls.filter((call) => call.url.startsWith("/api/v1/series/chunk?"));
    expect(chunks).toHaveLength(14);
    expect(result.get("unsupported:physical")?.points).toHaveLength(7);
    expect(result.get("unsupported:physical")?.compare).toHaveLength(7);
  });

  it.each([
    {
      aligned: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
      comparison: ["2026-03-07T07:30:00Z", "2026-03-07T10:30:00Z"],
      label: "spring-forward day",
      mode: "day",
      selected: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
    },
    {
      aligned: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
      comparison: ["2026-03-01T07:30:00Z", "2026-03-01T10:30:00Z"],
      label: "spring-forward week",
      mode: "week",
      selected: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
    },
    {
      aligned: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
      comparison: ["2026-03-08T05:30:00Z", "2026-03-08T07:30:00Z"],
      label: "spring-forward previous period",
      mode: "previous_period",
      selected: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
    },
    {
      aligned: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
      comparison: ["2026-03-08T06:30:00Z", "2026-03-08T08:30:00Z"],
      label: "spring-forward custom hour",
      mode: "custom",
      selected: ["2026-03-08T07:30:00Z", "2026-03-08T09:30:00Z"],
    },
    {
      aligned: ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
      comparison: ["2026-10-31T05:30:00Z", "2026-10-31T06:30:00Z"],
      label: "fall-back day chooses the first repeated hour",
      mode: "day",
      selected: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
    },
    {
      aligned: ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
      comparison: ["2026-10-25T05:30:00Z", "2026-10-25T06:30:00Z"],
      label: "fall-back week chooses the first repeated hour",
      mode: "week",
      selected: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
    },
    {
      aligned: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
      comparison: ["2026-11-01T03:30:00Z", "2026-11-01T05:30:00Z"],
      label: "fall-back previous period preserves elapsed time",
      mode: "previous_period",
      selected: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
    },
    {
      aligned: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
      comparison: ["2026-11-01T04:30:00Z", "2026-11-01T06:30:00Z"],
      label: "fall-back custom hour preserves elapsed time",
      mode: "custom",
      selected: ["2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
    },
  ] as const)("uses literal UTC parity for $label", async (fixture) => {
    const epoch = (iso: string) => Date.parse(iso) / 1_000;
    const selectedStart = epoch(fixture.selected[0]);
    const selectedEnd = epoch(fixture.selected[1]);
    const comparisonStart = epoch(fixture.comparison[0]);
    const comparisonEnd = epoch(fixture.comparison[1]);
    const expectedAligned = fixture.aligned.map(epoch);
    const calls: FetchCall[] = [];
    const comparisonCandidates = [
      [comparisonStart - 1, -1],
      [comparisonStart, 101],
      [comparisonEnd, 202],
      [comparisonEnd + 1, -2],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ method: init?.method ?? "GET", url });
        if (url === "/api/v2/tile-catalog") return jsonResponse(catalog([]));
        if (!url.startsWith("/api/v1/series/chunk?")) {
          throw new Error(`unexpected parity request: ${url}`);
        }
        const parsed = new URL(url, "https://example.test");
        return jsonResponse({
          aggregation: parsed.searchParams.get("aggregation"),
          end: Number(parsed.searchParams.get("end")),
          metric: parsed.searchParams.get("metric"),
          points: comparisonCandidates,
          resolution: Number(parsed.searchParams.get("resolution")),
          start: Number(parsed.searchParams.get("start")),
          tags: parsed.searchParams.getAll("tag"),
        });
      }),
    );

    const result = await loadSeries(
      [chart("dst-parity", "fixture.unsupported")],
      fixedTime(selectedStart, selectedEnd),
      fixture.mode,
      3600,
      new AbortController().signal,
    );

    expect(calls.every(({ method }) => method === "GET")).toBe(true);
    expect(result.get("dst-parity:physical")?.compare).toEqual([
      [expectedAligned[0], 101],
      [expectedAligned[1], 202],
    ]);
  });

  it("fetches once across selected/comparison overlap, duplicate charts, and later loads", async () => {
    const entry = catalogEntry();
    const calls: FetchCall[] = [];
    installFixture([entry], calls);
    const signal = new AbortController().signal;

    await loadSeries(
      [chart("first"), chart("second")],
      fixedTime(AUGUST_1, AUGUST_8),
      "day",
      DAY,
      signal,
    );
    await loadSeries(
      [chart("third")],
      fixedTime(AUGUST_1 + 4 * DAY, AUGUST_8 + 3 * DAY - 1),
      "none",
      DAY,
      signal,
    );

    const tileUrls = calls
      .filter((call) => call.url.startsWith("/api/v2/tiles/"))
      .map((call) => call.url);
    expect(tileUrls).toHaveLength(13);
    expect(new Set(tileUrls).size).toBe(13);
    expect(calls.filter((call) => call.url === "/api/v2/tile-catalog")).toHaveLength(1);
  });

  it("lets one consumer abort without cancelling or poisoning shared tile work", async () => {
    const entry = catalogEntry();
    let tileFetches = 0;
    let sharedSignal: AbortSignal | undefined;
    let releaseTile: (() => void) | undefined;
    let announceTile: (() => void) | undefined;
    const tileStarted = new Promise<void>((resolve) => {
      announceTile = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/v2/tile-catalog") {
          return Promise.resolve(jsonResponse(catalog([entry])));
        }
        tileFetches += 1;
        sharedSignal = init?.signal ?? undefined;
        announceTile?.();
        return new Promise<Response>((resolve) => {
          releaseTile = () => resolve(jsonResponse(tileResponse(url, [entry])));
        });
      }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const window = fixedTime(AUGUST_1, AUGUST_1 + DAY - 1);
    const first = loadSeries([chart("first")], window, "none", DAY, firstController.signal);
    const second = loadSeries([chart("second")], window, "none", DAY, secondController.signal);
    await tileStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    firstController.abort();
    const firstOutcome = await Promise.race([
      first.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(firstOutcome).toBe("AbortError");
    expect(sharedSignal?.aborted).toBe(false);
    releaseTile?.();
    await expect(second).resolves.toBeInstanceOf(Map);
    expect(tileFetches).toBe(1);

    await expect(
      loadSeries([chart("later")], window, "none", DAY, new AbortController().signal),
    ).resolves.toBeInstanceOf(Map);
    expect(tileFetches).toBe(1);
  });
});
