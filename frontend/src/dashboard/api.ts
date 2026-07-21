import { seriesKey } from "./chart-config";
import { alignComparison, compareWindow } from "./compare";
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
  since: number;
  tags: string[];
  until: number;
};

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
): Promise<Map<string, LoadedSeries>> {
  const comparison = compareWindow(compare, time, customCompareSeconds);
  const queries: SeriesQuery[] = [];
  for (const chart of charts) {
    for (const series of chart.series) {
      const base = {
        metric: series.metric,
        tags: series.tags ?? [],
        max_points: 1200,
        ...(chart.spikeCritical ? { aggregation: "minmax" as const } : {}),
      };
      queries.push({
        ...base,
        id: `${seriesKey(chart.id, series.id)}:current`,
        since: Math.round(time.start),
        until: Math.round(time.end),
      });
      if (compare !== "none") {
        queries.push({
          ...base,
          id: `${seriesKey(chart.id, series.id)}:compare`,
          since: Math.round(comparison.start),
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
      const current = byId.get(`${key}:current`);
      const previous = byId.get(`${key}:compare`);
      output.set(key, {
        points: current?.points ?? [],
        compare: alignComparison(previous?.points ?? [], comparison.offset),
        error: current?.error ?? null,
        meta: current?.meta ?? {},
      });
    }
  }
  return output;
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
