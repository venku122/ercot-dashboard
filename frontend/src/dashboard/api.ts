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

export type LatestQuery = { id: string; metric: string; tags?: string[] };
export type LatestResult = { point: { tags: string[]; ts: number; value: number } | null };
export type RankingRow = { tag: string; ts: number; value: number };

type SeriesResult = {
  error?: string;
  id: string;
  meta?: SeriesMeta;
  points?: Point[];
};

async function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`api_${response.status}:${detail.slice(0, 160)}`);
  }
  return (await response.json()) as T;
}

export async function loadSeries(
  charts: ChartDefinition[],
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
  signal: AbortSignal,
  previousData: Map<string, LoadedSeries> = new Map(),
): Promise<Map<string, LoadedSeries>> {
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
  signal: AbortSignal,
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

export async function loadPriceRanking(signal: AbortSignal): Promise<RankingRow[]> {
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

export async function loadSourceHealth(signal: AbortSignal): Promise<SourceHealth[]> {
  const response = await fetchJson<{ sources: SourceHealth[] }>(
    "/api/v1/source-health",
    { method: "GET" },
    signal,
  );
  return response.sources;
}

export async function loadEvents(time: TimeState, signal: AbortSignal): Promise<EventRecord[]> {
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
