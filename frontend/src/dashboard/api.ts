import { seriesKey } from "./chart-config";
import { CanonicalUrlCache } from "./canonical-url-cache";
import { alignComparisonForMode, compareWindow } from "./compare";
import { deriveSeries } from "./derived";
import { parseOutlookResponse, type OutlookResponse } from "./outlook";
import {
  parseForecastQualityManifest,
  parseForecastQualityResource,
  type ForecastQualityManifest,
  type ForecastQualityResource,
} from "./forecast-quality";
import {
  parseNetLoadDailyResource,
  parseNetLoadManifest,
  parseNetLoadResource,
  type NetLoadDailyLink,
  type NetLoadDailyResource,
  type NetLoadManifest,
  type NetLoadResource,
  type NetLoadResourceLink,
} from "./net-load";
import {
  parsePredictiveWeatherManifest,
  type PredictiveWeatherManifest,
} from "./predictive-weather";
import {
  gridEventRequestUrl,
  parseGridEventTimeline,
  type GridEventTimeline,
} from "./grid-event-timeline";
import {
  parseTileCatalog,
  planTileRequests,
  resolveTileSeries,
  type TileCatalogSeries,
  type TileRequest,
} from "./tile-planner";
import { composeTileWindow, parseAggregateStateV2, type AggregateBucket } from "./tile-state";
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

type TileResult = {
  boundary_policy: "native_edges_coarse_aligned_interiors";
  buckets: AggregateBucket[];
  lod: TileRequest["lod"];
  native_interval_seconds: number;
  rollup: null | "sum";
  schema: 2;
  series_key: string;
  statistic_policy: "gauge" | "power";
  tile_end: number;
  tile_span: TileRequest["tileSpan"];
  tile_start: number;
  unit: string;
};

const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const RECENT_TILE_CACHE_TTL_MS = 30 * 1_000;
const SEALED_TILE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
let catalogCache = new CanonicalUrlCache<unknown>(4);
let tileCache = new CanonicalUrlCache<TileResult>(512);
let cacheFetchIdentity: typeof fetch | null = null;
let catalogFingerprint: string | null = null;

export function resetCanonicalApiCachesForTests(): void {
  catalogCache.clear();
  tileCache.clear();
  catalogCache = new CanonicalUrlCache<unknown>(4);
  tileCache = new CanonicalUrlCache<TileResult>(512);
  cacheFetchIdentity = null;
  catalogFingerprint = null;
}

function resetCachesForChangedTransport(): void {
  if (cacheFetchIdentity === fetch) return;
  catalogCache.clear();
  tileCache.clear();
  catalogFingerprint = null;
  cacheFetchIdentity = fetch;
}

async function fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`api_${response.status}:${detail.slice(0, 160)}`);
  }
  return (await response.json()) as T;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const output: U[] = [];
  output.length = values.length;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await worker(values[index]!);
      }
    }),
  );
  return output;
}

function parseTileResult(
  value: unknown,
  request: TileRequest,
  entry: TileCatalogSeries,
): TileResult {
  if (!value || typeof value !== "object") throw new Error("invalid_tile_response");
  const result = value as Partial<TileResult>;
  if (
    Object.keys(value).sort().join(",") !==
      "boundary_policy,buckets,lod,native_interval_seconds,rollup,schema,series_key,statistic_policy,tile_end,tile_span,tile_start,unit" ||
    result.schema !== 2 ||
    result.series_key !== entry.key ||
    result.tile_span !== request.tileSpan ||
    result.tile_start !== request.tileStart ||
    result.tile_end !== request.tileEnd ||
    result.lod !== request.lod ||
    result.native_interval_seconds !== entry.native_interval_seconds ||
    result.unit !== entry.unit ||
    result.statistic_policy !== entry.statistic_policy ||
    result.rollup !== entry.rollup ||
    result.boundary_policy !== "native_edges_coarse_aligned_interiors" ||
    !Array.isArray(result.buckets)
  ) {
    throw new Error("invalid_tile_response_contract");
  }
  let priorKey: readonly [number, number] = [-Infinity, -Infinity];
  const buckets = result.buckets.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid_tile_bucket");
    const bucket = raw as unknown as Record<string, unknown>;
    if (
      Object.keys(bucket).sort().join(",") !== "end,start,state" ||
      !Number.isSafeInteger(bucket["start"]) ||
      !Number.isSafeInteger(bucket["end"]) ||
      (bucket["start"] as number) < request.tileStart ||
      (bucket["start"] as number) >= request.tileEnd
    ) {
      throw new Error("invalid_tile_bucket_contract");
    }
    const start = bucket["start"] as number;
    const end = bucket["end"] as number;
    const state = parseAggregateStateV2(bucket["state"]);
    const lodSeconds =
      request.lod === "5m" ? 300 : request.lod === "15m" ? 900 : request.lod === "1h" ? 3600 : 0;
    if (
      (request.lod === "native" &&
        (end !== start ||
          state.count !== 1 ||
          state.first_ts !== start ||
          state.last_ts !== start)) ||
      (request.lod !== "native" &&
        (end - start !== lodSeconds ||
          start % lodSeconds !== 0 ||
          end > request.tileEnd ||
          state.count === 0 ||
          state.first_ts! < start ||
          state.last_ts! >= end))
    ) {
      throw new Error("invalid_tile_bucket_bounds");
    }
    const key: readonly [number, number] = [start, state.first_ordinal ?? -1];
    if (key[0] < priorKey[0] || (key[0] === priorKey[0] && key[1] <= priorKey[1])) {
      throw new Error("invalid_tile_bucket_order");
    }
    priorKey = key;
    return { end, start, state };
  });
  return { ...(result as TileResult), buckets };
}

function assertCachedTileContext(
  result: TileResult,
  request: TileRequest,
  entry: TileCatalogSeries,
): TileResult {
  if (
    result.schema !== 2 ||
    result.series_key !== entry.key ||
    result.tile_span !== request.tileSpan ||
    result.tile_start !== request.tileStart ||
    result.tile_end !== request.tileEnd ||
    result.lod !== request.lod ||
    result.native_interval_seconds !== entry.native_interval_seconds ||
    result.unit !== entry.unit ||
    result.statistic_policy !== entry.statistic_policy ||
    result.rollup !== entry.rollup ||
    result.boundary_policy !== "native_edges_coarse_aligned_interiors"
  ) {
    throw new Error("cached_tile_context_mismatch");
  }
  return result;
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
      const chunks = await mapWithConcurrency(windows, 8, (window) =>
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

async function loadFixedPhysicalSeriesFromChunks(
  chart: ChartDefinition,
  series: ChartDefinition["series"][number],
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
  signal: AbortSignal,
): Promise<LoadedSeries> {
  if (!series.metric) throw new Error("physical_series_metric_required");
  const comparison = compareWindow(compare, time, customCompareSeconds);
  const resolution = Math.max(1, Math.ceil(time.rangeSeconds / 1200));
  const current = Math.floor(Date.now() / 1000);
  const plans = [
    { id: "current", start: time.start, end: time.end },
    ...(compare === "none"
      ? []
      : [{ id: "compare", start: comparison.start, end: comparison.end }]),
  ].map((planned) => ({
    ...planned,
    urls: historicalChunkWindows(planned.start, planned.end, current).map((window) =>
      canonicalChunkUrl({
        aggregation: chart.spikeCritical ? "minmax" : "average",
        ...window,
        metric: series.metric!,
        resolution,
        ...(series.rollup ? { rollup: series.rollup } : {}),
        ...(series.tags ? { tags: series.tags } : {}),
      }),
    ),
  }));
  const chunkByUrl = new Map<string, ChunkResult>();
  await mapWithConcurrency([...new Set(plans.flatMap((plan) => plan.urls))], 8, async (url) => {
    chunkByUrl.set(url, await fetchJson<ChunkResult>(url, { method: "GET" }, signal));
  });
  const pointsFor = (plan: (typeof plans)[number]) =>
    mergePoints(
      [],
      plan.urls.flatMap((url) => chunkByUrl.get(url)?.points ?? []),
      plan.start,
      plan.end,
    );
  const points = pointsFor(plans[0]!);
  const comparisonPoints = plans[1] ? pointsFor(plans[1]) : [];
  return {
    compare: alignComparisonForMode(comparisonPoints, compare, comparison.offset),
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
  };
}

async function loadFixedComparedSeriesFromChunks(
  charts: ChartDefinition[],
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
  signal: AbortSignal,
): Promise<Map<string, LoadedSeries>> {
  const output = new Map<string, LoadedSeries>();
  for (const chart of charts) {
    for (const series of chart.series) {
      if (!series.metric) continue;
      output.set(
        seriesKey(chart.id, series.id),
        await loadFixedPhysicalSeriesFromChunks(
          chart,
          series,
          time,
          compare,
          customCompareSeconds,
          signal,
        ),
      );
    }
    for (const series of chart.series) {
      if (!series.derive) continue;
      const inputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.points ?? [],
      );
      const comparisonInputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.compare ?? [],
      );
      output.set(seriesKey(chart.id, series.id), {
        compare: deriveSeries(series.derive.operation, comparisonInputs),
        error: null,
        meta: {},
        points: deriveSeries(series.derive.operation, inputs),
      });
    }
  }
  return output;
}

async function loadFixedSeriesFromTiles(
  charts: ChartDefinition[],
  time: TimeState,
  compare: CompareMode,
  customCompareSeconds: number,
  signal: AbortSignal,
): Promise<Map<string, LoadedSeries>> {
  resetCachesForChangedTransport();
  const catalog = parseTileCatalog(
    await catalogCache.get(
      "/api/v2/tile-catalog",
      (sharedSignal) => fetchJson<unknown>("/api/v2/tile-catalog", { method: "GET" }, sharedSignal),
      signal,
      CATALOG_CACHE_TTL_MS,
    ),
  );
  const nextCatalogFingerprint = JSON.stringify(catalog);
  if (catalogFingerprint !== null && catalogFingerprint !== nextCatalogFingerprint) {
    tileCache.clear();
  }
  catalogFingerprint = nextCatalogFingerprint;
  const now = Math.floor(Date.now() / 1000);
  const comparison = compareWindow(compare, time, customCompareSeconds);
  const comparisonTime: TimeState = {
    ...time,
    end: comparison.end,
    rangeSeconds: comparison.end - comparison.start,
    start: comparison.start,
  };
  const jobs = charts.flatMap((chart) =>
    chart.series.flatMap((series) => {
      if (!series.metric) return [];
      const entry = resolveTileSeries(catalog, {
        metric: series.metric,
        ...(series.rollup ? { rollup: series.rollup } : {}),
        statisticPolicy: chart.statisticPolicy,
        ...(series.tags ? { tags: series.tags } : {}),
        unit: chart.unit,
      });
      return [
        {
          chart,
          entry,
          key: seriesKey(chart.id, series.id),
          comparisonRequests:
            entry && compare !== "none"
              ? planTileRequests({
                  catalog,
                  end: Math.round(comparison.end),
                  entry,
                  now,
                  start: Math.round(comparison.start),
                  targetPoints: chart.spikeCritical ? 600 : 1200,
                })
              : [],
          currentRequests: entry
            ? planTileRequests({
                catalog,
                end: Math.round(time.end),
                entry,
                now,
                start: Math.round(time.start),
                targetPoints: chart.spikeCritical ? 600 : 1200,
              })
            : [],
          series,
        },
      ];
    }),
  );
  const requestByUrl = new Map<string, { entry: TileCatalogSeries; request: TileRequest }>();
  for (const job of jobs) {
    if (!job.entry) continue;
    for (const request of [...job.currentRequests, ...job.comparisonRequests]) {
      requestByUrl.set(request.url, { entry: job.entry, request });
    }
  }
  const tileByUrl = new Map<string, TileResult | Error>();
  await mapWithConcurrency([...requestByUrl.entries()], 8, async ([url, context]) => {
    try {
      const ttlMs =
        context.request.tileEnd <= now - 86_400
          ? SEALED_TILE_CACHE_TTL_MS
          : RECENT_TILE_CACHE_TTL_MS;
      const cached = await tileCache.get(
        url,
        async (sharedSignal) =>
          parseTileResult(
            await fetchJson<unknown>(url, { method: "GET" }, sharedSignal),
            context.request,
            context.entry,
          ),
        signal,
        ttlMs,
      );
      tileByUrl.set(url, assertCachedTileContext(cached, context.request, context.entry));
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      tileByUrl.set(url, error instanceof Error ? error : new Error("tile_request_failed"));
    }
  });

  const output = new Map<string, LoadedSeries>();
  for (const job of jobs) {
    let loaded: LoadedSeries | null = null;
    if (job.entry) {
      try {
        const project = (requests: TileRequest[], window: TimeState) => {
          const tiles = requests.map((request) => {
            const tile = tileByUrl.get(request.url);
            if (!tile || tile instanceof Error) throw tile ?? new Error("missing_tile_response");
            return { request, tile };
          });
          return composeTileWindow({
            coarseInterior: tiles.flatMap(({ request, tile }) =>
              request.lod === "native"
                ? []
                : tile.buckets.filter(
                    (bucket) => bucket.start >= window.start && bucket.end <= window.end + 1,
                  ),
            ),
            end: Math.round(window.end),
            endInclusive: true,
            nativeEdges: tiles.flatMap(({ request, tile }) =>
              request.lod === "native"
                ? tile.buckets.filter(
                    (bucket) =>
                      bucket.state.first_ts !== null &&
                      bucket.state.first_ts >= window.start &&
                      bucket.state.first_ts <= window.end,
                  )
                : [],
            ),
            power: job.entry!.statistic_policy === "power",
            projection: job.chart.spikeCritical ? "spike-envelope" : "average",
            start: Math.round(window.start),
          });
        };
        const projection = project(job.currentRequests, time);
        const comparisonProjection =
          compare === "none" ? null : project(job.comparisonRequests, comparisonTime);
        loaded = {
          compare: alignComparisonForMode(
            comparisonProjection?.points ?? [],
            compare,
            comparison.offset,
          ),
          error: null,
          meta: {
            bucket_seconds: null,
            max_points: 1200,
            partial_current_bucket: false,
            since: time.start,
            stats: projection.stats,
            until: time.end,
          },
          points: projection.points,
        };
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
      }
    }
    output.set(
      job.key,
      loaded ??
        (await loadFixedPhysicalSeriesFromChunks(
          job.chart,
          job.series,
          time,
          compare,
          customCompareSeconds,
          signal,
        )),
    );
  }
  for (const chart of charts) {
    for (const series of chart.series) {
      if (!series.derive) continue;
      const inputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.points ?? [],
      );
      const comparisonInputs = series.derive.from.map(
        (id) => output.get(seriesKey(chart.id, id))?.compare ?? [],
      );
      output.set(seriesKey(chart.id, series.id), {
        compare: deriveSeries(series.derive.operation, comparisonInputs),
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
  if (time.mode === "fixed") {
    try {
      return await loadFixedSeriesFromTiles(charts, time, compare, customCompareSeconds, signal);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      // Preserve compatibility while an older receiver is still serving production.
      return compare === "none"
        ? await loadFixedSeriesFromChunks(charts, time, signal)
        : await loadFixedComparedSeriesFromChunks(
            charts,
            time,
            compare,
            customCompareSeconds,
            signal,
          );
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

export async function loadOutlook(signal?: AbortSignal): Promise<OutlookResponse> {
  const response = await fetchJson<unknown>("/api/v1/outlook", { method: "GET" }, signal);
  return parseOutlookResponse(response);
}

export async function loadPredictiveWeather(
  signal?: AbortSignal,
): Promise<PredictiveWeatherManifest> {
  return parsePredictiveWeatherManifest(
    await fetchJson<unknown>("/api/v1/predictive-weather", { method: "GET" }, signal),
  );
}

export async function loadGridEventTimeline(
  from: number,
  to: number,
  signal?: AbortSignal,
  cursor?: string | null,
): Promise<GridEventTimeline> {
  return parseGridEventTimeline(
    await fetchJson<unknown>(gridEventRequestUrl(from, to, cursor), { method: "GET" }, signal),
  );
}

export async function loadForecastQualityManifest(
  signal?: AbortSignal,
): Promise<ForecastQualityManifest> {
  const response = await fetchJson<unknown>("/api/v1/forecast-quality", { method: "GET" }, signal);
  return parseForecastQualityManifest(response);
}

export async function loadForecastQualityResource(
  resource: ForecastQualityManifest["resources"][number],
  signal?: AbortSignal,
): Promise<ForecastQualityResource> {
  const response = await fetchJson<unknown>(resource.url, { method: "GET" }, signal);
  return parseForecastQualityResource(response, resource);
}

export async function loadNetLoadManifest(signal?: AbortSignal): Promise<NetLoadManifest> {
  return parseNetLoadManifest(
    await fetchJson<unknown>("/api/v1/net-load", { method: "GET" }, signal),
  );
}

export async function loadNetLoadResource(
  resource: NetLoadResourceLink,
  signal?: AbortSignal,
): Promise<NetLoadResource> {
  return parseNetLoadResource(
    await fetchJson<unknown>(resource.url, { method: "GET" }, signal),
    resource,
  );
}

export async function loadNetLoadDailyResource(
  resource: NetLoadDailyLink,
  signal?: AbortSignal,
): Promise<NetLoadDailyResource> {
  return parseNetLoadDailyResource(
    await fetchJson<unknown>(resource.url, { method: "GET" }, signal),
    resource,
  );
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
