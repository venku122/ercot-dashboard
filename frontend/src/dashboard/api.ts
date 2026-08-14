import { seriesKey } from "./chart-config";
import { alignComparisonForMode, compareWindow } from "./compare";
import { deriveSeries } from "./derived";
import type {
  ChartDefinition,
  CompareMode,
  EventRecord,
  LoadedSeries,
  Point,
  SeriesMeta,
  SourceHealth,
  TimeState,
} from "./types";

type SeriesQuery = {
  aggregation?: "minmax";
  id: string;
  max_points: number;
  metric: string;
  rollup?: "sum";
  since: number;
  stats_since: number;
  tags: string[];
  until: number;
};

export type LatestQuery = { id: string; metric: string; tags?: readonly string[] };
export type LatestResult = { point: { tags: string[]; ts: number; value: number } | null };
export type RankingRow = { tag: string; ts: number; value: number };
export type TrendBaseline = Point | null;

type SeriesResult = {
  error?: string;
  id: string;
  meta?: SeriesMeta;
  points?: Point[];
};

type ChunkResult = {
  aggregation: "average" | "minmax";
  end: number;
  metric: string;
  points: Point[];
  resolution: number;
  start: number;
  tags: string[];
};

async function fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`api_${response.status}:${detail.slice(0, 160)}`);
  }
  return (await response.json()) as T;
}

export function canonicalChunkUrl({
  aggregation = "average",
  chunkSeconds,
  end,
  metric,
  resolution,
  rollup,
  start,
  tags = [],
}: {
  aggregation?: "average" | "minmax";
  chunkSeconds: 3600 | 86400;
  end: number;
  metric: string;
  resolution: number;
  rollup?: "sum";
  start: number;
  tags?: readonly string[];
}): string {
  const params = new URLSearchParams({
    aggregation,
    chunk_seconds: String(chunkSeconds),
    end: String(Math.round(end)),
    metric,
    resolution: String(Math.round(resolution)),
    start: String(Math.round(start)),
  });
  if (rollup) params.set("rollup", rollup);
  for (const tag of [...new Set(tags)].sort()) params.append("tag", tag);
  return `/api/v1/series/chunk?${params.toString()}`;
}

function historicalChunkWindows(start: number, end: number, current: number) {
  const output: Array<{ chunkSeconds: 3600 | 86400; end: number; start: number }> = [];
  let cursor = Math.floor(start / 86400) * 86400;
  while (cursor < end) {
    const canUseDay = cursor + 86400 <= current - 86400;
    const chunkSeconds = canUseDay ? 86400 : 3600;
    if (!canUseDay) cursor = Math.floor(Math.max(cursor, start) / 3600) * 3600;
    output.push({ chunkSeconds, end: cursor + chunkSeconds, start: cursor });
    cursor += chunkSeconds;
  }
  return output;
}

function pointStatistics(points: Point[]) {
  if (!points.length) {
    return {
      average: null,
      count: 0,
      energy_mwh: null,
      latest: null,
      maximum: null,
      minimum: null,
    };
  }
  const values = points.map((point) => point[1]);
  let energy = 0;
  for (let index = 1; index < points.length; index += 1) {
    energy += (points[index - 1]![1] * (points[index]![0] - points[index - 1]![0])) / 3600;
  }
  return {
    average: values.reduce((total, value) => total + value, 0) / values.length,
    count: values.length,
    energy_mwh: energy,
    latest: values.at(-1) ?? null,
    maximum: Math.max(...values),
    minimum: Math.min(...values),
  };
}

async function loadFixedSeriesFromChunks(
  charts: ChartDefinition[],
  time: TimeState,
  signal: AbortSignal,
): Promise<Map<string, LoadedSeries>> {
  const windows = historicalChunkWindows(time.start, time.end, Math.floor(Date.now() / 1000));
  const resolution = Math.max(1, Math.ceil(time.rangeSeconds / 1200));
  const output = new Map<string, LoadedSeries>();
  for (const chart of charts) {
    for (const series of chart.series) {
      if (!series.metric) continue;
      const chunks = await Promise.all(
        windows.map((window) =>
          fetchJson<ChunkResult>(
            canonicalChunkUrl({
              aggregation: chart.spikeCritical ? "minmax" : "average",
              ...window,
              metric: series.metric!,
              resolution,
              ...(series.rollup ? { rollup: series.rollup } : {}),
              ...(series.tags ? { tags: series.tags } : {}),
            }),
            { method: "GET" },
            signal,
          ),
        ),
      );
      const points = mergePoints(
        [],
        chunks.flatMap((chunk) => chunk.points),
        time.start,
        time.end,
      );
      output.set(seriesKey(chart.id, series.id), {
        compare: [],
        error: null,
        meta: {
          bucket_seconds: resolution,
          max_points: 1200,
          partial_current_bucket: false,
          since: time.start,
          stats: pointStatistics(points),
          until: time.end,
        },
        points,
      });
    }
    for (const series of chart.series) {
      if (!series.derive) continue;
      const inputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.points ?? [],
      );
      output.set(seriesKey(chart.id, series.id), {
        compare: [],
        error: null,
        meta: {},
        points: deriveSeries(series.derive.operation, inputs),
      });
    }
  }
  return output;
}

export async function loadSeries(
  charts: ChartDefinition[],
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
  signal: AbortSignal,
  previousData: Map<string, LoadedSeries> = new Map(),
): Promise<Map<string, LoadedSeries>> {
  if (time.mode === "fixed" && compare === "none") {
    try {
      return await loadFixedSeriesFromChunks(charts, time, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // Preserve compatibility while an older receiver is still serving production.
    }
  }
  const comparison = compareWindow(compare, time, customCompareSeconds);
  const queries: SeriesQuery[] = [];
  for (const chart of charts) {
    for (const series of chart.series) {
      if (!series.metric) continue;
      const key = seriesKey(chart.id, series.id);
      const prior = previousData.get(key)?.points ?? [];
      const base = {
        metric: series.metric,
        tags: series.tags ?? [],
        max_points: 1200,
        ...(series.rollup ? { rollup: series.rollup } : {}),
        ...(chart.spikeCritical ? { aggregation: "minmax" as const } : {}),
      };
      queries.push({
        ...base,
        id: `${key}:current`,
        since: Math.round(liveQuerySince(time, prior)),
        stats_since: Math.round(time.start),
        until: Math.round(time.end),
      });
      if (compare !== "none") {
        queries.push({
          ...base,
          id: `${seriesKey(chart.id, series.id)}:compare`,
          since: Math.round(comparison.start),
          stats_since: Math.round(comparison.start),
          until: Math.round(comparison.end),
        });
      }
    }
  }
  const response = await fetchJson<{ series: SeriesResult[] }>(
    "/api/series/batch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries }),
    },
    signal,
  );
  const byId = new Map(response.series.map((entry) => [entry.id, entry]));
  const output = new Map<string, LoadedSeries>();
  for (const chart of charts) {
    for (const series of chart.series) {
      const key = seriesKey(chart.id, series.id);
      if (!series.metric) continue;
      const current = byId.get(`${key}:current`);
      const comparisonResult = byId.get(`${key}:compare`);
      const prior = previousData.get(key)?.points ?? [];
      const merged = mergePoints(prior, current?.points ?? [], time.start, time.end);
      output.set(key, {
        points: merged,
        compare: alignComparisonForMode(comparisonResult?.points ?? [], compare, comparison.offset),
        error: current?.error ?? null,
        meta: current?.meta ?? {},
      });
    }
    for (const series of chart.series) {
      if (!series.derive) continue;
      const inputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.points ?? [],
      );
      const compareInputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.compare ?? [],
      );
      output.set(seriesKey(chart.id, series.id), {
        points: deriveSeries(series.derive.operation, inputs),
        compare: deriveSeries(series.derive.operation, compareInputs),
        error: null,
        meta: {},
      });
    }
  }
  return output;
}

export function liveQuerySince(time: TimeState, previous: Point[]): number {
  const lastTimestamp = previous.at(-1)?.[0];
  const canTail =
    time.mode === "live" &&
    previous.length > 0 &&
    previous[0]![0] <= time.start &&
    lastTimestamp !== undefined &&
    lastTimestamp < time.end;
  return canTail ? lastTimestamp + 1 : time.start;
}

export function mergePoints(previous: Point[], next: Point[], start: number, end: number): Point[] {
  const merged = new Map<number, number>();
  for (const [timestamp, value] of [...previous, ...next]) {
    if (timestamp >= start && timestamp <= end) merged.set(timestamp, value);
  }
  return [...merged.entries()].sort((left, right) => left[0] - right[0]);
}

export async function loadLatest(
  queries: LatestQuery[],
  signal?: AbortSignal,
): Promise<Map<string, LatestResult["point"]>> {
  const response = await fetchJson<{
    latest: Array<{ id: string; point: LatestResult["point"] }>;
  }>(
    "/api/latest/batch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: queries.map((query) => ({ ...query, tags: query.tags ?? [] })),
      }),
    },
    signal,
  );
  return new Map(response.latest.map((entry) => [entry.id, entry.point]));
}

export async function loadTrendBaselines(
  queries: LatestQuery[],
  until: number,
  signal?: AbortSignal,
): Promise<Map<string, TrendBaseline>> {
  const since = Math.round(until - 3600);
  const response = await fetchJson<{ series: SeriesResult[] }>(
    "/api/series/batch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: queries.map((query) => ({
          id: `hero:${query.id}`,
          max_points: 120,
          metric: query.metric,
          since,
          stats_since: since,
          tags: [...(query.tags ?? [])],
          until: Math.round(until),
        })),
      }),
    },
    signal,
  );
  const byId = new Map(response.series.map((entry) => [entry.id, entry]));
  return new Map(
    queries.map((query) => {
      const point = byId
        .get(`hero:${query.id}`)
        ?.points?.filter(
          ([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value),
        )
        .reduce<Point | undefined>(
          (earliest, candidate) =>
            earliest === undefined || candidate[0] < earliest[0] ? candidate : earliest,
          undefined,
        );
      return [query.id, point ?? null];
    }),
  );
}

export async function loadDerivedContext(
  now: number,
  signal?: AbortSignal,
): Promise<Map<string, Point[]>> {
  const queries: SeriesQuery[] = [
    {
      id: "derived:forecast-demand",
      max_points: 288,
      metric: "ercot.supply_demand.forecast_demand_mw",
      since: Math.round(now),
      stats_since: Math.round(now),
      tags: [],
      until: Math.round(now + 24 * 3600),
    },
    {
      id: "derived:price-history",
      max_points: 288,
      metric: "ercot.pricing",
      since: Math.round(now - 24 * 3600),
      stats_since: Math.round(now - 24 * 3600),
      tags: ["ercot_region:HB_HOUSTON"],
      until: Math.round(now),
    },
    {
      id: "derived:demand-yesterday",
      max_points: 60,
      metric: "ercot.supply_demand.demand_mw",
      since: Math.round(now - 25 * 3600),
      stats_since: Math.round(now - 25 * 3600),
      tags: [],
      until: Math.round(now - 23 * 3600),
    },
  ];
  const response = await fetchJson<{ series: SeriesResult[] }>(
    "/api/series/batch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries }),
    },
    signal,
  );
  return new Map(
    response.series.map((entry) => [
      entry.id,
      (entry.points ?? []).filter(
        ([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value),
      ),
    ]),
  );
}

export async function loadPriceRanking(signal?: AbortSignal): Promise<RankingRow[]> {
  const params = new URLSearchParams({
    metric: "ercot.pricing",
    tag_prefix: "ercot_region:",
    limit: "12",
  });
  const response = await fetchJson<{ rows: RankingRow[] }>(
    `/api/v1/ranking?${params.toString()}`,
    { method: "GET" },
    signal,
  );
  return response.rows;
}

export async function loadSourceHealth(signal?: AbortSignal): Promise<SourceHealth[]> {
  const response = await fetchJson<{ sources: SourceHealth[] }>(
    "/api/v1/source-health",
    { method: "GET" },
    signal,
  );
  return response.sources;
}

export async function loadEvents(time: TimeState, signal?: AbortSignal): Promise<EventRecord[]> {
  const params = new URLSearchParams({
    since: String(Math.round(time.start)),
    until: String(Math.round(time.end)),
    limit: "500",
  });
  const response = await fetchJson<{ events: EventRecord[] }>(
    `/api/v1/events?${params.toString()}`,
    { method: "GET" },
    signal,
  );
  return response.events;
}
