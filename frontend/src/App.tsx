import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

import { MobileDialog } from "./components/MobileDialog";
import { Button } from "./components/ui/button";
import {
  loadEvents,
  loadLatest,
  loadPriceRanking,
  loadSeries,
  loadSourceHealth,
  type RankingRow,
} from "./dashboard/api";
import { chartDefinitions, chartGroups, seriesKey } from "./dashboard/chart-config";
import { chartCoordinator } from "./dashboard/chart-coordinator";
import {
  navigateWindow,
  resetLive,
  setCustomRange,
  setRange,
  tickLive,
  togglePause,
  zoomTo,
} from "./dashboard/time-state";
import type {
  CompareMode,
  DashboardState,
  EventRecord,
  LegendMode,
  LoadedSeries,
  SourceHealth,
  TimeState,
} from "./dashboard/types";
import { dashboardStateFromUrl, dashboardStateToUrl } from "./dashboard/url-state";
import { mediaQueryMatches, MOBILE_MEDIA_QUERY, useMediaQuery } from "./dashboard/use-media-query";
import { formatAge, formatValue } from "./dashboard/units";
import { formatChicagoDateTimeInput, parseChicagoDateTime } from "./dashboard/zoned-time";

const ChartCard = lazy(() =>
  import("./dashboard/ChartCard").then((module) => ({ default: module.ChartCard })),
);

const nowSeconds = () => Math.floor(Date.now() / 1000);

const overviewQueries = [
  { id: "demand", metric: "ercot.supply_demand.demand_mw" },
  { id: "capacity", metric: "ercot.supply_demand.available_capacity_mw" },
  { id: "frequency", metric: "ercot.Frequency.Current_Frequency" },
  { id: "storage", metric: "ercot.storage.net_output_mw" },
  { id: "grid-demand", metric: "ercot.Real_Time_Data.Actual_System_Demand" },
  { id: "grid-capacity", metric: "ercot.Real_Time_Data.Total_System_Capacity" },
  { id: "inertia", metric: "ercot.Real_Time_Data.Current_System_Inertia" },
] as const;

const rangeOptions = [
  [3600, "1 hour"],
  [21600, "6 hours"],
  [43200, "12 hours"],
  [86400, "24 hours"],
  [259200, "3 days"],
  [604800, "7 days"],
  [2592000, "30 days"],
  [31536000, "12 months"],
] as const;

type MobileDialogName = "controls" | "events" | "more" | "prices" | "sources" | null;

type ControlProps = {
  onError: (message: string) => void;
  onExplicitLegend: () => void;
  onResetOrigin: () => void;
  setState: Dispatch<SetStateAction<DashboardState>>;
  state: DashboardState;
  surface: "desktop" | "sheet";
};

function TimeRangeSelect({ state, setState }: Pick<ControlProps, "setState" | "state">) {
  return (
    <label>
      <span>Time range</span>
      <select
        aria-label="Time range"
        onChange={(event) => {
          const range = Number(event.target.value);
          setState((current) => ({
            ...current,
            time: setRange(current.time, range, nowSeconds()),
          }));
        }}
        value={state.time.rangeSeconds}
      >
        {rangeOptions.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CustomRangeForm({
  onError,
  setState,
  state,
}: Pick<ControlProps, "onError" | "setState" | "state">) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const start = parseChicagoDateTime(String(form.get("start")));
      const end = parseChicagoDateTime(String(form.get("end")));
      setState((current) => ({ ...current, time: setCustomRange(start, end) }));
    } catch {
      onError("invalid_time_range");
    }
  };
  return (
    <form className="custom-range-form" onSubmit={submit}>
      <label>
        <span>From</span>
        <input
          defaultValue={formatChicagoDateTimeInput(state.time.start)}
          name="start"
          type="datetime-local"
        />
      </label>
      <label>
        <span>To</span>
        <input
          defaultValue={formatChicagoDateTimeInput(state.time.end)}
          name="end"
          type="datetime-local"
        />
      </label>
      <Button type="submit">Apply custom range</Button>
    </form>
  );
}

function DashboardControls({
  onError,
  onExplicitLegend,
  onResetOrigin,
  setState,
  state,
  surface,
}: ControlProps) {
  const customRange = <CustomRangeForm onError={onError} setState={setState} state={state} />;
  return (
    <>
      <TimeRangeSelect setState={setState} state={state} />
      <div className="button-cluster" aria-label="Window navigation">
        <Button
          aria-label="Previous time window"
          onClick={() =>
            setState((current) => ({ ...current, time: navigateWindow(current.time, -1) }))
          }
        >
          ← Window
        </Button>
        <Button
          aria-label="Next time window"
          onClick={() =>
            setState((current) => ({ ...current, time: navigateWindow(current.time, 1) }))
          }
        >
          Window →
        </Button>
      </div>
      <Button
        onClick={() =>
          setState((current) => ({
            ...current,
            time: togglePause(current.time, nowSeconds()),
          }))
        }
      >
        {state.time.mode === "fixed" ? "Resume live" : state.time.paused ? "Resume" : "Pause"}
      </Button>
      <Button
        onClick={() => {
          onResetOrigin();
          setState((current) => ({
            ...current,
            time: resetLive(current.time, nowSeconds()),
          }));
        }}
      >
        Reset to live
      </Button>
      {surface === "desktop" ? (
        <details className="custom-range">
          <summary>Custom range</summary>
          {customRange}
        </details>
      ) : (
        <fieldset className="sheet-fieldset">
          <legend>Custom range</legend>
          {customRange}
        </fieldset>
      )}
      <label>
        <span>Compare</span>
        <select
          aria-label="Compare time"
          onChange={(event) =>
            setState((current) => ({
              ...current,
              compare: event.target.value as CompareMode,
            }))
          }
          value={state.compare}
        >
          <option value="none">Off</option>
          <option value="previous_period">Previous period</option>
          <option value="day">Previous day</option>
          <option value="week">Previous week</option>
          <option value="custom">Custom offset</option>
        </select>
      </label>
      {state.compare === "custom" ? (
        <label>
          <span>Compare offset hours</span>
          <input
            aria-label="Custom comparison offset hours"
            max={8760}
            min={1 / 12}
            onChange={(event) => {
              const seconds = Number(event.target.value) * 3600;
              if (!Number.isFinite(seconds) || seconds < 300) return;
              setState((current) => ({ ...current, customCompareSeconds: seconds }));
            }}
            step={1}
            type="number"
            value={state.customCompareSeconds / 3600}
          />
        </label>
      ) : null}
      <label>
        <span>Legend</span>
        <select
          aria-label="Legend detail"
          onChange={(event) => {
            onExplicitLegend();
            setState((current) => ({
              ...current,
              legendMode: event.target.value as LegendMode,
            }));
          }}
          value={state.legendMode}
        >
          <option value="expanded">Statistics</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <label className="checkbox-control">
        <input
          checked={state.events}
          onChange={(event) =>
            setState((current) => ({ ...current, events: event.target.checked }))
          }
          type="checkbox"
        />
        <span>Operations events</span>
      </label>
    </>
  );
}

function sourcePriority(source: SourceHealth) {
  return { failed: 0, stale: 1, delayed: 2, healthy: 3 }[source.state];
}

function activeOperationalEvents(events: EventRecord[]) {
  return events.filter((event) => {
    const status = event.status?.toLowerCase() ?? "";
    const severity = event.severity?.toLowerCase() ?? "";
    return status === "active" && ["emergency", "warning", "watch"].includes(severity);
  });
}

export function App() {
  const initialUrl = useMemo(() => new URL(window.location.href), []);
  const initialMobile = useRef(mediaQueryMatches(MOBILE_MEDIA_QUERY)).current;
  const explicitLegendRef = useRef(initialUrl.searchParams.has("legend"));
  const [state, setState] = useState<DashboardState>(() => {
    const parsed = dashboardStateFromUrl(initialUrl, nowSeconds());
    return initialMobile && !explicitLegendRef.current
      ? { ...parsed, legendMode: "compact" }
      : parsed;
  });
  const [seriesData, setSeriesData] = useState<Map<string, LoadedSeries>>(new Map());
  const seriesDataRef = useRef(seriesData);
  const zoomOriginRef = useRef<TimeState | null>(null);
  const [sourceHealth, setSourceHealth] = useState<SourceHealth[]>([]);
  const [latest, setLatest] = useState<Map<string, { ts: number; value: number } | null>>(
    new Map(),
  );
  const [priceRanking, setPriceRanking] = useState<RankingRow[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    if (!initialMobile) return new Set();
    const collapsed = new Set(chartGroups.filter((group) => group !== "Grid conditions"));
    const inspected = chartDefinitions.find((chart) => chart.id === state.expandedChart);
    if (inspected) collapsed.delete(inspected.group);
    return collapsed;
  });
  const [activeChartIds, setActiveChartIds] = useState<Set<string>>(new Set());
  const [mobileDialog, setMobileDialog] = useState<MobileDialogName>(null);
  const [selectedSection, setSelectedSection] = useState("Overview");
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const sourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const eventsTriggerRef = useRef<HTMLButtonElement>(null);
  const pricesTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const overviewRef = useRef<HTMLElement>(null);
  const groupHeadingRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    seriesDataRef.current = seriesData;
  }, [seriesData]);

  useEffect(() => {
    if (explicitLegendRef.current) return;
    setState((current) => ({
      ...current,
      legendMode: isMobile ? "compact" : "expanded",
    }));
  }, [isMobile]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setState((current) => ({ ...current, time: tickLive(current.time, nowSeconds()) }));
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const next = dashboardStateToUrl(state, new URL(window.location.href));
    window.history.replaceState(null, "", next);
  }, [state]);

  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      explicitLegendRef.current = url.searchParams.has("legend");
      const restored = dashboardStateFromUrl(url, nowSeconds());
      setState(
        isMobile && !explicitLegendRef.current ? { ...restored, legendMode: "compact" } : restored,
      );
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [isMobile]);

  useEffect(() => {
    const controller = new AbortController();
    const requestedCharts = chartDefinitions.filter(
      (chart) => activeChartIds.has(chart.id) && !collapsedGroups.has(chart.group),
    );
    if (!requestedCharts.length) return () => controller.abort();
    setLoading(true);
    setRequestError(null);
    void loadSeries(
      requestedCharts,
      state.time,
      state.compare,
      state.customCompareSeconds,
      controller.signal,
      seriesDataRef.current,
    )
      .then((nextSeries) => {
        setSeriesData((current) => new Map([...current, ...nextSeries]));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRequestError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    activeChartIds,
    collapsedGroups,
    state.compare,
    state.customCompareSeconds,
    state.time.end,
    state.time.start,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadSourceHealth(controller.signal),
      loadLatest([...overviewQueries], controller.signal),
      loadPriceRanking(controller.signal),
      state.events ? loadEvents(state.time, controller.signal) : Promise.resolve([]),
    ])
      .then(([nextHealth, nextLatest, nextRanking, nextEvents]) => {
        setSourceHealth(nextHealth);
        setLatest(nextLatest);
        setPriceRanking(nextRanking);
        setEvents(nextEvents);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRequestError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOverviewLoading(false);
      });
    return () => controller.abort();
  }, [state.events, state.time.end, state.time.start]);

  useEffect(() => {
    const closeInspect = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      chartCoordinator.clearPin();
      setState((current) => ({ ...current, expandedChart: null }));
    };
    window.addEventListener("keydown", closeInspect);
    return () => window.removeEventListener("keydown", closeInspect);
  }, []);

  useEffect(() => {
    if (!state.expandedChart) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [state.expandedChart]);

  const healthById = useMemo(
    () => new Map(sourceHealth.map((source) => [source.source_id, source])),
    [sourceHealth],
  );
  const sortedHealth = useMemo(
    () => [...sourceHealth].sort((left, right) => sourcePriority(left) - sourcePriority(right)),
    [sourceHealth],
  );
  const healthCounts = useMemo(() => {
    const counts = { healthy: 0, delayed: 0, stale: 0, failed: 0 };
    for (const source of sourceHealth) counts[source.state] += 1;
    return counts;
  }, [sourceHealth]);
  const activeEvents = useMemo(() => activeOperationalEvents(events), [events]);

  const onZoom = useCallback((start: number, end: number) => {
    setState((current) => {
      zoomOriginRef.current ??= current.time;
      return { ...current, time: zoomTo(current.time, start, end) };
    });
  }, []);

  const setChartVisible = useCallback((chartId: string, visible: boolean) => {
    setActiveChartIds((current) => {
      const next = new Set(current);
      if (visible) next.add(chartId);
      else next.delete(chartId);
      return next;
    });
  }, []);

  const toggleSeries = useCallback((key: string) => {
    setState((current) => {
      const hiddenSeries = new Set(current.hiddenSeries);
      if (hiddenSeries.has(key)) hiddenSeries.delete(key);
      else hiddenSeries.add(key);
      return { ...current, hiddenSeries };
    });
  }, []);

  const soloSeries = useCallback((chartId: string, key: string) => {
    setState((current) => {
      const chart = chartDefinitions.find((definition) => definition.id === chartId);
      if (!chart) return current;
      const keys = chart.series.map((series) => seriesKey(chart.id, series.id));
      const alreadySolo = keys.every(
        (candidate) => candidate === key || current.hiddenSeries.has(candidate),
      );
      const hiddenSeries = new Set(current.hiddenSeries);
      for (const candidate of keys) {
        if (alreadySolo || candidate === key) hiddenSeries.delete(candidate);
        else hiddenSeries.add(candidate);
      }
      return { ...current, hiddenSeries };
    });
  }, []);

  const navigateToGroup = useCallback((group: string, navigationLabel = group) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(group);
      return next;
    });
    setSelectedSection(navigationLabel);
    window.requestAnimationFrame(() => {
      const heading = groupHeadingRefs.current.get(group);
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
      heading?.focus({ preventScroll: true });
    });
  }, []);

  const overview = [
    { label: "Demand", value: latest.get("demand")?.value ?? null, unit: "MW" },
    { label: "Available capacity", value: latest.get("capacity")?.value ?? null, unit: "MW" },
    { label: "Frequency", value: latest.get("frequency")?.value ?? null, unit: "Hz" },
    {
      label: "Storage net output",
      value: latest.get("storage")?.value ?? null,
      unit: "MW",
      secondary: true,
    },
    {
      label: "Unused capacity",
      value:
        latest.get("grid-capacity") && latest.get("grid-demand")
          ? latest.get("grid-capacity")!.value - latest.get("grid-demand")!.value
          : null,
      unit: "MW",
    },
    {
      label: "System inertia",
      value: latest.get("inertia")?.value ?? null,
      unit: "GW·s",
      secondary: true,
    },
  ];

  const newestOverviewAge = Math.max(
    0,
    ...[...latest.values()].map((point) => (point ? nowSeconds() - point.ts : 0)),
  );
  const condition = activeEvents.length
    ? { label: "WATCH", detail: activeEvents[0]!.title, state: "warning" }
    : healthCounts.failed > 0
      ? {
          label: "DATA ISSUE",
          detail:
            String(healthCounts.failed) +
            " collector source" +
            (healthCounts.failed === 1 ? "" : "s") +
            " failed",
          state: "failure",
        }
      : {
          label: "NORMAL",
          detail: "Grid conditions are within the observed operating range",
          state: "normal",
        };
  const worstSource = sortedHealth.find((source) => source.state !== "healthy");
  const sourceSummary = worstSource
    ? worstSource.display_name.replace(/^ERCOT /, "") +
      " " +
      worstSource.state +
      " · data " +
      formatAge(worstSource.data_age_seconds)
    : "Sources: " + String(healthCounts.healthy) + " healthy";

  const controls = {
    onError: setRequestError,
    onExplicitLegend: () => {
      explicitLegendRef.current = true;
    },
    onResetOrigin: () => {
      zoomOriginRef.current = null;
    },
    setState,
    state,
  };

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Texas grid monitor</p>
          <h1>
            <span className="mobile-only-title">ERCOT Grid</span>
            <span className="desktop-only-title">ERCOT analytical dashboard</span>
          </h1>
          <p className="header-copy">
            Explore demand, generation, storage, outages, prices, and operations events with a
            shared time window.
          </p>
        </div>
        <div className="live-state" data-mode={state.time.mode}>
          <span className="live-dot" />
          {state.time.mode === "live"
            ? state.time.paused
              ? "Live paused"
              : "Live"
            : "Fixed window"}
        </div>
      </header>

      {!isMobile ? (
        <section aria-label="Global dashboard controls" className="control-bar">
          <DashboardControls {...controls} surface="desktop" />
        </section>
      ) : null}

      <main>
        {requestError ? (
          <div className="global-error" role="alert">
            Dashboard request failed. Existing data is preserved; this is not an empty-data state.{" "}
            {requestError}
          </div>
        ) : null}

        {isMobile ? (
          <section
            aria-label="Grid condition"
            className="mobile-grid-condition"
            data-condition={condition.state}
            ref={overviewRef}
            tabIndex={-1}
          >
            <div>
              <p className="eyebrow">Grid condition</p>
              <strong>{condition.label}</strong>
            </div>
            <p>{condition.detail}</p>
            <span>Updated {formatAge(newestOverviewAge).replace(" old", " ago")}</span>
          </section>
        ) : null}

        <section aria-label="Grid overview" className="overview-grid">
          {overview.map((item) => (
            <article
              className={"overview-card " + (item.secondary ? "overview-card-secondary" : "")}
              key={item.label}
            >
              <span>{item.label}</span>
              <strong>
                {overviewLoading ? "Loading…" : formatValue(item.value, item.unit, true)}
              </strong>
            </article>
          ))}
          <article className="overview-card source-overview">
            <span>Collector sources</span>
            <strong>
              {healthCounts.healthy} healthy · {healthCounts.delayed} delayed · {healthCounts.stale}{" "}
              stale · {healthCounts.failed} failed
            </strong>
          </article>
        </section>

        {isMobile ? (
          <section aria-label="Mobile quick controls" className="mobile-quick-controls">
            <TimeRangeSelect setState={setState} state={state} />
            <Button
              aria-haspopup="dialog"
              onClick={() => setMobileDialog("controls")}
              ref={controlsTriggerRef}
            >
              Controls
            </Button>
            <Button
              aria-label={state.time.paused ? "Resume live updates" : "Pause live updates"}
              className="quick-live-action"
              onClick={() =>
                setState((current) => ({
                  ...current,
                  time: togglePause(current.time, nowSeconds()),
                }))
              }
            >
              {state.time.paused ? "Resume" : "Pause"}
            </Button>
          </section>
        ) : null}

        {isMobile ? (
          <div className="mobile-summary-stack">
            <section aria-label="Operations notice summary" className="mobile-summary-row">
              <div>
                <span className="summary-label">Operations</span>
                <strong>
                  {state.events && activeEvents.length
                    ? activeEvents[0]!.title
                    : state.events
                      ? "No active operational notices"
                      : "Operations annotations are off"}
                </strong>
              </div>
              <Button
                aria-haspopup="dialog"
                aria-label="Review operations messages"
                onClick={() => setMobileDialog("events")}
                ref={eventsTriggerRef}
              >
                Review
              </Button>
            </section>
            <section aria-label="Source health summary" className="mobile-summary-row">
              <div>
                <span className="summary-label">Freshness</span>
                <strong>{sourceSummary}</strong>
              </div>
              <Button
                aria-haspopup="dialog"
                aria-label="Review source health"
                onClick={() => setMobileDialog("sources")}
                ref={sourcesTriggerRef}
              >
                Review
              </Button>
            </section>
            <section aria-label="Settlement price summary" className="mobile-ranking-summary">
              <div className="summary-heading">
                <div>
                  <span className="summary-label">Market</span>
                  <strong>Settlement prices</strong>
                </div>
                <Button
                  aria-haspopup="dialog"
                  onClick={() => setMobileDialog("prices")}
                  ref={pricesTriggerRef}
                >
                  Show all prices
                </Button>
              </div>
              {priceRanking.length ? (
                <ol>
                  {priceRanking.slice(0, 5).map((row) => (
                    <li key={row.tag}>
                      <span>{row.tag.replace("ercot_region:", "")}</span>
                      <strong className={row.value < 0 ? "negative-price" : ""}>
                        {formatValue(row.value, "$/MWh")}
                      </strong>
                      <time dateTime={new Date(row.ts * 1000).toISOString()}>
                        Observed {new Date(row.ts * 1000).toLocaleTimeString()}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No settlement prices have been reported yet.</p>
              )}
            </section>
          </div>
        ) : null}

        {!isMobile ? (
          <>
            <section aria-label="Source health" className="source-health-panel">
              <div>
                <p className="eyebrow">Freshness</p>
                <h2>Collector source health</h2>
              </div>
              <div className="source-health-list">
                {!sourceHealth.length && !loading ? (
                  <span>No source health has been reported yet.</span>
                ) : null}
                {sourceHealth.map((source) => (
                  <span
                    className={"source-health-item status-" + source.state}
                    key={source.source_id}
                  >
                    {source.display_name}: collection {source.collection_state} · data{" "}
                    {source.freshness_state} · {formatAge(source.data_age_seconds)}
                    {source.source_timestamp_ts
                      ? " · source " + new Date(source.source_timestamp_ts * 1000).toLocaleString()
                      : ""}
                    {source.last_error ? " · " + source.last_error : ""}
                  </span>
                ))}
              </div>
            </section>

            {state.events ? (
              <section aria-label="ERCOT operations messages" className="events-panel">
                <div>
                  <p className="eyebrow">Annotations</p>
                  <h2>ERCOT operations messages</h2>
                </div>
                {events.length ? (
                  <ol>
                    {events.slice(0, 8).map((event) => (
                      <li key={event.dedupe_key}>
                        <time dateTime={new Date(event.starts_at * 1000).toISOString()}>
                          {new Date(event.starts_at * 1000).toLocaleString()}
                        </time>
                        <span>{event.status ?? "Unknown"}</span>
                        <p>{event.title}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No operations messages in this window.</p>
                )}
              </section>
            ) : null}

            <section aria-label="Settlement price ranking" className="events-panel ranking-panel">
              <div>
                <p className="eyebrow">Market ranking</p>
                <h2>Latest settlement point prices</h2>
              </div>
              {priceRanking.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Settlement point</th>
                        <th>Price</th>
                        <th>Observed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceRanking.map((row) => (
                        <tr key={row.tag}>
                          <td>{row.tag.replace("ercot_region:", "")}</td>
                          <td>{formatValue(row.value, "$/MWh")}</td>
                          <td>{new Date(row.ts * 1000).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No settlement prices have been reported yet.</p>
              )}
            </section>
          </>
        ) : null}

        {chartGroups.map((group) => {
          const collapsed = collapsedGroups.has(group);
          return (
            <section className="chart-group" data-group={group} key={group}>
              <button
                aria-expanded={!collapsed}
                aria-label={group + " " + (collapsed ? "Expand" : "Collapse")}
                className="group-heading"
                onClick={() =>
                  setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group)) next.delete(group);
                    else next.add(group);
                    return next;
                  })
                }
                ref={(element) => {
                  if (element) groupHeadingRefs.current.set(group, element);
                  else groupHeadingRefs.current.delete(group);
                }}
              >
                <span>{group}</span>
                <span>{collapsed ? "Expand" : "Collapse"}</span>
              </button>
              {!collapsed ? (
                <div className="chart-grid">
                  {chartDefinitions
                    .filter((chart) => chart.group === group)
                    .map((chart) => (
                      <Suspense
                        fallback={
                          <article className="chart-card chart-card-lazy" key={chart.id}>
                            Loading chart workspace…
                          </article>
                        }
                        key={chart.id}
                      >
                        <ChartCard
                          chart={chart}
                          compare={state.compare}
                          events={state.events ? events : []}
                          hiddenSeries={state.hiddenSeries}
                          inspect={state.expandedChart === chart.id}
                          legendMode={state.legendMode}
                          loading={loading}
                          mobile={isMobile}
                          onInspect={() =>
                            setState((current) => ({
                              ...current,
                              expandedChart: current.expandedChart === chart.id ? null : chart.id,
                            }))
                          }
                          onResetZoom={() =>
                            setState((current) => {
                              const origin = zoomOriginRef.current;
                              zoomOriginRef.current = null;
                              return { ...current, time: origin ?? current.time };
                            })
                          }
                          onSetCompare={(compare) =>
                            setState((current) => ({ ...current, compare }))
                          }
                          onSoloSeries={soloSeries}
                          onToggleSeries={toggleSeries}
                          onVisibilityChange={setChartVisible}
                          onZoom={onZoom}
                          requestError={requestError}
                          seriesData={seriesData}
                          sourceHealth={
                            chart.sourceId ? (healthById.get(chart.sourceId) ?? null) : null
                          }
                          time={state.time}
                        />
                      </Suspense>
                    ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </main>

      {state.expandedChart ? <div aria-hidden="true" className="inspect-backdrop" /> : null}

      {isMobile ? (
        <nav aria-label="Dashboard sections" className="mobile-section-nav">
          {[
            ["Overview", null],
            ["Grid", "Grid conditions"],
            ["Generation", "Generation"],
            ["Reliability", "Reliability"],
            ["Market", "Market"],
          ].map(([label, group]) => (
            <button
              aria-current={selectedSection === label ? "page" : undefined}
              aria-label={label + " section"}
              key={label}
              onClick={() => {
                if (group) navigateToGroup(group, label ?? group);
                else {
                  setSelectedSection("Overview");
                  overviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                  overviewRef.current?.focus({ preventScroll: true });
                }
              }}
            >
              {label === "Generation" ? "Gen" : label}
            </button>
          ))}
          <button
            aria-current={selectedSection === "More" ? "page" : undefined}
            aria-label="More sections"
            aria-haspopup="dialog"
            onClick={() => {
              setSelectedSection("More");
              setMobileDialog("more");
            }}
            ref={moreTriggerRef}
          >
            More
          </button>
        </nav>
      ) : null}

      <MobileDialog
        description="Change the shared analytical time window, comparison, legend, and event settings."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "controls"}
        returnFocusRef={controlsTriggerRef}
        title="Dashboard controls"
      >
        <div className="sheet-controls">
          <DashboardControls {...controls} surface="sheet" />
        </div>
      </MobileDialog>

      <MobileDialog
        description="Collection health and observation freshness are shown separately for every source."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "sources"}
        returnFocusRef={sourcesTriggerRef}
        title="Source health details"
      >
        <div className="diagnostic-list">
          {sortedHealth.map((source) => (
            <article className={"diagnostic-item status-" + source.state} key={source.source_id}>
              <header>
                <strong>{source.display_name}</strong>
                <span>{source.state}</span>
              </header>
              <p>
                Collection {source.collection_state} · data {source.freshness_state} ·{" "}
                {formatAge(source.data_age_seconds)}
              </p>
              {source.source_timestamp_ts ? (
                <time dateTime={new Date(source.source_timestamp_ts * 1000).toISOString()}>
                  Source observation {new Date(source.source_timestamp_ts * 1000).toLocaleString()}
                </time>
              ) : null}
              {source.last_error ? <p className="diagnostic-error">{source.last_error}</p> : null}
            </article>
          ))}
        </div>
      </MobileDialog>

      <MobileDialog
        description="Active notices are prioritized; complete selected-window history remains available here."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "events"}
        returnFocusRef={eventsTriggerRef}
        title="Operations message history"
      >
        {events.length ? (
          <ol className="dialog-event-list">
            {events.map((event) => (
              <li key={event.dedupe_key}>
                <div>
                  <span className="event-severity">{event.severity ?? "information"}</span>
                  <span>{event.status ?? "Unknown"}</span>
                </div>
                <strong>{event.title}</strong>
                <time dateTime={new Date(event.starts_at * 1000).toISOString()}>
                  {new Date(event.starts_at * 1000).toLocaleString()}
                </time>
                {event.body ? <p>{event.body}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p>No operations messages in this window.</p>
        )}
      </MobileDialog>

      <MobileDialog
        description="Exact latest settlement-point values and source timestamps."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "prices"}
        returnFocusRef={pricesTriggerRef}
        title="Settlement price details"
      >
        <div className="table-scroll ranking-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Settlement point</th>
                <th>Price</th>
                <th>Observed</th>
              </tr>
            </thead>
            <tbody>
              {priceRanking.map((row) => (
                <tr key={row.tag}>
                  <td>{row.tag.replace("ercot_region:", "")}</td>
                  <td className={row.value < 0 ? "negative-price" : ""}>
                    {formatValue(row.value, "$/MWh")}
                  </td>
                  <td>{new Date(row.ts * 1000).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </MobileDialog>

      <MobileDialog
        description="Open the remaining analytical areas without traversing the full dashboard."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "more"}
        returnFocusRef={moreTriggerRef}
        title="More dashboard sections"
      >
        <div className="section-picker">
          {["Ancillary services", "Weather", "Operations"].map((group) => (
            <Button
              key={group}
              onClick={() => {
                setMobileDialog(null);
                window.setTimeout(() => navigateToGroup(group, "More"), 0);
              }}
            >
              {group}
            </Button>
          ))}
        </div>
      </MobileDialog>

      <footer>
        <p>
          Source data is collected from public ERCOT dashboards. Modifier-wheel zoom uses Ctrl/⌘;
          Shift-drag pans; click pins the shared cursor; Escape clears it.
        </p>
        <a href="https://github.com/venku122/ercot-dashboard">Source code</a>
      </footer>
    </div>
  );
}
