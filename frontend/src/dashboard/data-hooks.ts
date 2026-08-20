import { useCallback, useEffect, useMemo, useRef } from "react";
import useSWR, { type SWRConfiguration } from "swr";

import {
  loadDerivedContext,
  loadEvents,
  loadForecastQualityManifest,
  loadForecastQualityResource,
  loadGridEventTimeline,
  loadLatest,
  loadNetLoadDailyResource,
  loadNetLoadManifest,
  loadNetLoadResource,
  loadOutlook,
  loadPredictiveWeather,
  loadSourceHealth,
  loadTrendBaselines,
  type LatestQuery,
} from "./api";
import type { ForecastQualityManifest } from "./forecast-quality";
import type { NetLoadDailyLink, NetLoadResourceLink } from "./net-load";
import { derivedLatestQueries } from "./derived-metrics";
import { healthLatestQueries } from "./grid-health-score";
import type { EventRecord, TimeState } from "./types";
import { weatherLatestQueries } from "./weather";

export const REFRESH_CADENCE_MS = {
  events: 180_000,
  fastTelemetry: 30_000,
  marketAndFiveMinute: 300_000,
  sourceHealth: 60_000,
} as const;

const swrPolicy: SWRConfiguration = {
  compare: Object.is,
  dedupingInterval: 2_000,
  keepPreviousData: true,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
};

const fastQueryIds = new Set(["frequency", "health-eea"]);

export function useOutlookData(enabled: boolean) {
  const controller = useRef<AbortController | null>(null);
  const fetchOutlook = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return loadOutlook(next.signal).finally(() => {
      if (controller.current === next) controller.current = null;
    });
  }, []);
  useEffect(() => {
    if (!enabled) controller.current?.abort();
    return () => {
      if (enabled) controller.current?.abort();
    };
  }, [enabled]);
  return useSWR(enabled ? ["outlook", "current"] : null, fetchOutlook, {
    ...swrPolicy,
    refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute,
  });
}

export function usePredictiveWeather(enabled: boolean) {
  const loader = useCallback((signal: AbortSignal) => loadPredictiveWeather(signal), []);
  return useAbortableResource(enabled, ["predictive-weather", "current"], loader);
}

export function useGridEventTimeline(enabled: boolean, from: number, to: number) {
  const loader = useCallback(
    (signal: AbortSignal) => loadGridEventTimeline(from, to, signal),
    [from, to],
  );
  return useAbortableResource(enabled, ["grid-events", from, to], loader);
}

export function useForecastQuality(enabled: boolean) {
  const controller = useRef<AbortController | null>(null);
  const fetchManifest = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return loadForecastQualityManifest(next.signal).finally(() => {
      if (controller.current === next) controller.current = null;
    });
  }, []);
  useEffect(() => {
    if (!enabled) controller.current?.abort();
    return () => {
      if (enabled) controller.current?.abort();
    };
  }, [enabled]);
  return useSWR(enabled ? ["forecast-quality", "manifest"] : null, fetchManifest, {
    ...swrPolicy,
    refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute,
  });
}

export function useForecastQualityResource(
  enabled: boolean,
  resource: ForecastQualityManifest["resources"][number] | null,
) {
  const controller = useRef<AbortController | null>(null);
  const fetchResource = useCallback(() => {
    if (resource === null) throw new Error("missing_forecast_quality_resource");
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return loadForecastQualityResource(resource, next.signal).finally(() => {
      if (controller.current === next) controller.current = null;
    });
  }, [resource]);
  useEffect(() => {
    if (!enabled) controller.current?.abort();
    return () => {
      if (enabled) controller.current?.abort();
    };
  }, [enabled]);
  return useSWR(enabled && resource ? ["forecast-quality", resource.url] : null, fetchResource, {
    ...swrPolicy,
    keepPreviousData: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

function useAbortableResource<T>(
  enabled: boolean,
  key: readonly unknown[],
  loader: (signal: AbortSignal) => Promise<T>,
) {
  const controller = useRef<AbortController | null>(null);
  const fetcher = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return loader(next.signal).finally(() => {
      if (controller.current === next) controller.current = null;
    });
  }, [loader]);
  useEffect(() => {
    if (!enabled) {
      controller.current?.abort();
      return;
    }
    return () => controller.current?.abort();
  }, [enabled]);
  return useSWR(enabled ? key : null, fetcher, {
    ...swrPolicy,
    keepPreviousData: false,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
}

export function useNetLoadManifest(enabled: boolean) {
  const loader = useCallback((signal: AbortSignal) => loadNetLoadManifest(signal), []);
  return useAbortableResource(enabled, ["net-load", "manifest"], loader);
}

export function useNetLoadResource(enabled: boolean, resource: NetLoadResourceLink | null) {
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!resource) return Promise.reject(new Error("missing_net_load_resource"));
      return loadNetLoadResource(resource, signal);
    },
    [resource],
  );
  return useAbortableResource(enabled && resource !== null, ["net-load", resource?.url], loader);
}

export function useNetLoadDailyResource(enabled: boolean, resource: NetLoadDailyLink | null) {
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!resource) return Promise.reject(new Error("missing_net_load_daily_resource"));
      return loadNetLoadDailyResource(resource, signal);
    },
    [resource],
  );
  return useAbortableResource(
    enabled && resource !== null,
    ["net-load", "daily", resource?.url],
    loader,
  );
}

export function canonicalLatestKey(queries: readonly LatestQuery[]): string {
  return queries
    .map((query) => `${query.id}:${query.metric}:${[...(query.tags ?? [])].sort().join(",")}`)
    .sort()
    .join("|");
}

function normalizeEventWindow(time: TimeState, cadenceSeconds: number): TimeState {
  if (time.mode !== "live") return time;
  const end = Math.floor(time.end / cadenceSeconds) * cadenceSeconds;
  return { ...time, end, start: end - time.rangeSeconds };
}

function errorMessage(errors: unknown[]): string | null {
  const error = errors.find(Boolean);
  return error ? (error instanceof Error ? error.message : String(error)) : null;
}

export function useOverviewData({
  enabled,
  eventsEnabled,
  overviewQueries,
  time,
}: {
  enabled: boolean;
  eventsEnabled: boolean;
  overviewQueries: readonly LatestQuery[];
  time: TimeState;
}) {
  const allLatestQueries = useMemo(
    () => [
      ...overviewQueries,
      ...derivedLatestQueries,
      ...healthLatestQueries,
      ...weatherLatestQueries,
    ],
    [overviewQueries],
  );
  const fastQueries = useMemo(
    () => allLatestQueries.filter((query) => fastQueryIds.has(query.id)),
    [allLatestQueries],
  );
  const standardQueries = useMemo(
    () => allLatestQueries.filter((query) => !fastQueryIds.has(query.id)),
    [allLatestQueries],
  );
  const latestFast = useSWR(
    enabled ? ["latest", "fast", canonicalLatestKey(fastQueries)] : null,
    () => loadLatest(fastQueries),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.fastTelemetry },
  );
  const latestStandard = useSWR(
    enabled ? ["latest", "five-minute", canonicalLatestKey(standardQueries)] : null,
    () => loadLatest(standardQueries),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const health = useSWR(enabled ? ["source-health"] : null, () => loadSourceHealth(), {
    ...swrPolicy,
    refreshInterval: REFRESH_CADENCE_MS.sourceHealth,
  });
  const baselines = useSWR(
    enabled ? ["trend-baselines", canonicalLatestKey(overviewQueries)] : null,
    () => loadTrendBaselines([...overviewQueries], Math.floor(Date.now() / 1000)),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const context = useSWR(
    enabled ? ["derived-context"] : null,
    () => loadDerivedContext(Math.floor(Date.now() / 1000)),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const statusWindow = normalizeEventWindow(
    { ...time, mode: "live", paused: false, rangeSeconds: 86_400 },
    REFRESH_CADENCE_MS.events / 1_000,
  );
  const selectedWindow = normalizeEventWindow(time, REFRESH_CADENCE_MS.events / 1_000);
  const statusEvents = useSWR(
    enabled ? ["events", statusWindow.start, statusWindow.end] : null,
    () => loadEvents(statusWindow),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.events },
  );
  const selectedMatchesStatus =
    selectedWindow.start === statusWindow.start && selectedWindow.end === statusWindow.end;
  const selectedEvents = useSWR(
    enabled && eventsEnabled && !selectedMatchesStatus
      ? ["events", selectedWindow.start, selectedWindow.end]
      : null,
    () => loadEvents(selectedWindow),
    {
      ...swrPolicy,
      refreshInterval: selectedWindow.mode === "live" ? REFRESH_CADENCE_MS.events : 0,
    },
  );

  const resources = [
    latestFast,
    latestStandard,
    health,
    baselines,
    context,
    statusEvents,
    selectedEvents,
  ];
  const retry = useCallback(async () => {
    await Promise.all(resources.map((resource) => resource.mutate()));
  }, [resources]);
  const latest = useMemo(
    () => new Map([...(latestStandard.data ?? new Map()), ...(latestFast.data ?? new Map())]),
    [latestFast.data, latestStandard.data],
  );
  const observedTimestamps = [...latest.values()]
    .map((point) => point?.ts ?? 0)
    .filter((timestamp) => timestamp > 0);

  return {
    derivedContext: context.data ?? new Map(),
    error: errorMessage(resources.map((resource) => resource.error)),
    events: eventsEnabled
      ? selectedMatchesStatus
        ? (statusEvents.data ?? [])
        : (selectedEvents.data ?? [])
      : ([] as EventRecord[]),
    isLoading: resources.slice(0, 7).some((resource) => resource.isLoading),
    isValidating: resources.some((resource) => resource.isValidating),
    latest,
    observedAt: observedTimestamps.length
      ? Math.max(...observedTimestamps)
      : Math.floor(Date.now() / 1000),
    retry,
    sourceHealth: health.data ?? [],
    statusEvents: statusEvents.data ?? [],
    trendBaselines: baselines.data ?? new Map(),
  };
}
