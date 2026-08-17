import { useCallback, useMemo } from "react";
import useSWR, { type SWRConfiguration } from "swr";

import {
  loadDerivedContext,
  loadEvents,
  loadLatest,
  loadPriceRanking,
  loadSourceHealth,
  loadTrendBaselines,
  type LatestQuery,
} from "./api";
import { derivedLatestQueries } from "./derived-metrics";
import { healthLatestQueries } from "./grid-health-score";
import type { EventRecord, TimeState } from "./types";

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
  eventsEnabled,
  overviewQueries,
  time,
}: {
  eventsEnabled: boolean;
  overviewQueries: readonly LatestQuery[];
  time: TimeState;
}) {
  const allLatestQueries = useMemo(
    () => [...overviewQueries, ...derivedLatestQueries, ...healthLatestQueries],
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
    ["latest", "fast", canonicalLatestKey(fastQueries)],
    () => loadLatest(fastQueries),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.fastTelemetry },
  );
  const latestStandard = useSWR(
    ["latest", "five-minute", canonicalLatestKey(standardQueries)],
    () => loadLatest(standardQueries),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const health = useSWR(["source-health"], () => loadSourceHealth(), {
    ...swrPolicy,
    refreshInterval: REFRESH_CADENCE_MS.sourceHealth,
  });
  const baselines = useSWR(
    ["trend-baselines", canonicalLatestKey(overviewQueries)],
    () => loadTrendBaselines([...overviewQueries], Math.floor(Date.now() / 1000)),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const context = useSWR(
    ["derived-context"],
    () => loadDerivedContext(Math.floor(Date.now() / 1000)),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute },
  );
  const ranking = useSWR(["price-ranking"], () => loadPriceRanking(), {
    ...swrPolicy,
    refreshInterval: REFRESH_CADENCE_MS.marketAndFiveMinute,
  });

  const statusWindow = normalizeEventWindow(
    { ...time, mode: "live", paused: false, rangeSeconds: 86_400 },
    REFRESH_CADENCE_MS.events / 1_000,
  );
  const selectedWindow = normalizeEventWindow(time, REFRESH_CADENCE_MS.events / 1_000);
  const statusEvents = useSWR(
    ["events", statusWindow.start, statusWindow.end],
    () => loadEvents(statusWindow),
    { ...swrPolicy, refreshInterval: REFRESH_CADENCE_MS.events },
  );
  const selectedMatchesStatus =
    selectedWindow.start === statusWindow.start && selectedWindow.end === statusWindow.end;
  const selectedEvents = useSWR(
    eventsEnabled && !selectedMatchesStatus
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
    ranking,
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
    priceRanking: ranking.data ?? [],
    retry,
    sourceHealth: health.data ?? [],
    statusEvents: statusEvents.data ?? [],
    trendBaselines: baselines.data ?? new Map(),
  };
}
