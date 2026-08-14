import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from "react";

import { MobileDialog } from "./components/MobileDialog";
import { DataLifecycleMessage } from "./components/DataLifecycleMessage";
import { Button } from "./components/ui/button";
import { loadSeries } from "./dashboard/api";
import { rationalizeAlerts, type PublicAlert } from "./dashboard/alert-policy";
import { chartDefinitions, chartGroups, seriesKey } from "./dashboard/chart-config";
import { chartCoordinator } from "./dashboard/chart-coordinator";
import { sortDiagnostics, summarizeDiagnostics } from "./dashboard/diagnostics";
import {
  dataLifecycleCopy,
  resolveDataLifecycleState,
  type DataLifecycleState,
} from "./dashboard/data-lifecycle";
import { OperationsTimeline } from "./dashboard/OperationsTimeline";
import { buildDerivedMetrics } from "./dashboard/derived-metrics";
import { useOverviewData } from "./dashboard/data-hooks";
import {
  chartGroupDefinition,
  criticalMetricDefinitions,
  dashboardViewDefinition,
  dashboardViewDefinitions,
  dashboardViewForGroup,
  initiallyCollapsedGroups,
  moreDashboardViewIds,
  mobilePrimaryCriticalMetricIds,
  mobileSupportingCriticalMetricIds,
  primaryDashboardViewIds,
  reserveMarginPercent,
  type CriticalMetricId,
  type DashboardViewId,
} from "./dashboard/information-architecture";
import { buildHeroTrend, unavailableHeroTrend, type HeroTrend } from "./dashboard/hero-trends";
import { buildGridHealthScore } from "./dashboard/grid-health-score";
import { buildOperatingSummary } from "./dashboard/operating-summary";
import { settlementFreshness, settlementPointMetadata } from "./dashboard/settlement-points";
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
  LegendMode,
  LoadedSeries,
  SourceHealth,
  TimeState,
} from "./dashboard/types";
import {
  dashboardStateFromUrl,
  dashboardStateToUrl,
  dashboardViewFromUrl,
  dashboardViewToUrl,
} from "./dashboard/url-state";
import { mediaQueryMatches, MOBILE_MEDIA_QUERY, useMediaQuery } from "./dashboard/use-media-query";
import { formatAge, formatValue } from "./dashboard/units";
import { formatChicagoDateTimeInput, parseChicagoDateTime } from "./dashboard/zoned-time";

const ChartCard = lazy(() =>
  import("./dashboard/ChartCard").then((module) => ({ default: module.ChartCard })),
);

const nowSeconds = () => Math.floor(Date.now() / 1000);

function dashboardViewForUrl(url: URL): DashboardViewId {
  if (!url.searchParams.has("view")) {
    const inspected = chartDefinitions.find(
      (chart) => chart.id === url.searchParams.get("inspect"),
    );
    if (inspected) return dashboardViewForGroup(inspected.group);
  }
  return dashboardViewFromUrl(url);
}

const overviewQueries = [
  { id: "demand", metric: "ercot.supply_demand.demand_mw" },
  { id: "capacity", metric: "ercot.supply_demand.available_capacity_mw" },
  { id: "frequency", metric: "ercot.Frequency.Current_Frequency" },
  { id: "price", metric: "ercot.pricing", tags: ["ercot_region:HB_HOUSTON"] },
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

type MobileDialogName = "controls" | "events" | "more" | "sources" | null;

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

function HeroTrendDetail({
  id,
  label,
  loading,
  trend,
}: {
  id: CriticalMetricId;
  label: string;
  loading: boolean;
  trend: HeroTrend;
}) {
  const directionLabel =
    trend.direction === "up"
      ? "increasing"
      : trend.direction === "down"
        ? "decreasing"
        : trend.direction === "steady"
          ? "unchanged"
          : "unavailable";
  const accessibleLabel = loading
    ? `${label} trend is loading for the last hour.`
    : `${label} trend is ${directionLabel}: ${trend.deltaLabel}, ${trend.comparisonLabel}. ${trend.timestampLabel}.`;
  return (
    <div
      aria-label={accessibleLabel}
      className="hero-trend"
      data-direction={loading ? "unavailable" : trend.direction}
      data-hero-trend={id}
      role="group"
    >
      <span className="hero-trend-delta">
        <span aria-hidden="true">{loading ? "…" : trend.arrow}</span>{" "}
        {loading ? "Loading trend…" : trend.deltaLabel}
      </span>
      <span className="hero-trend-meta">
        <span>{trend.comparisonLabel}</span>
        {trend.observedAt === null ? (
          <span>{trend.timestampLabel}</span>
        ) : (
          <time dateTime={new Date(trend.observedAt * 1000).toISOString()}>
            {trend.timestampLabel}
          </time>
        )}
      </span>
    </div>
  );
}

function MetricOverviewCard({
  item,
  loading,
}: {
  item: {
    id: CriticalMetricId;
    label: string;
    trend: HeroTrend;
    unit: string | null;
    value: number | null;
  };
  loading: boolean;
}) {
  const trendUnavailable = !loading && item.trend.direction === "unavailable";
  const valueLabel = loading
    ? "Loading…"
    : item.unit === null
      ? "—"
      : formatValue(item.value, item.unit);
  return (
    <article
      aria-label={`${item.label}: ${loading ? "loading" : item.unit === null ? "unavailable" : valueLabel}.`}
      className="overview-card"
      data-metric-id={item.id}
    >
      <span>{item.label}</span>
      <strong>{valueLabel}</strong>
      {trendUnavailable ? (
        <div aria-hidden="true" className="hero-trend hero-trend-empty" />
      ) : (
        <HeroTrendDetail id={item.id} label={item.label} loading={loading} trend={item.trend} />
      )}
    </article>
  );
}

function GridHealthSummary({
  gridHealth,
}: {
  gridHealth: ReturnType<typeof buildGridHealthScore>;
}) {
  const pressures = gridHealth.factors
    .filter((factor) => factor.penalty !== null && factor.penalty > 0)
    .sort((left, right) => (right.penalty ?? 0) - (left.penalty ?? 0))
    .slice(0, 2)
    .map((factor) => factor.label.toLowerCase());
  const accessibleFactors = gridHealth.factors
    .map((factor) => {
      if (factor.penalty === null) {
        return `${factor.label}: unavailable, ${String(factor.weight)} points possible`;
      }
      return `${factor.label}: ${String(Math.round(factor.weight - factor.penalty))} of ${String(factor.weight)} points retained`;
    })
    .join(". ");
  return (
    <section
      aria-label={`Grid Health: ${gridHealth.label}. ${gridHealth.score === null ? "Not enough fresh inputs to calculate the score." : `${String(gridHealth.score)} of 100 with ${String(gridHealth.coveragePercent)} percent input coverage.`} ${accessibleFactors}`}
      className="grid-health-summary"
      data-health-status={gridHealth.status}
    >
      <div className="grid-health-summary-heading">
        <div>
          <span>Grid Health</span>
          <strong>{gridHealth.label}</strong>
        </div>
        <div className="grid-health-summary-score">
          {gridHealth.score === null ? (
            <strong>Not enough fresh inputs</strong>
          ) : (
            <strong>
              {String(gridHealth.score)} <span>/ 100</span>
            </strong>
          )}
          <small>{String(gridHealth.coveragePercent)}% input coverage</small>
        </div>
      </div>
      <div aria-hidden="true" className="grid-health-contribution-bar">
        {gridHealth.factors.map((factor) => {
          const retained = factor.penalty === null ? 0 : factor.weight - factor.penalty;
          const style = {
            "--factor-retained": `${String((retained / factor.weight) * 100)}%`,
            "--factor-weight": String(factor.weight),
          } as CSSProperties;
          return (
            <span
              className="grid-health-contribution"
              data-available={factor.available}
              key={factor.id}
              style={style}
              title={`${factor.label}: ${factor.available ? `${String(Math.round(retained))} of ${String(factor.weight)} points` : "input unavailable"}`}
            />
          );
        })}
      </div>
      <p>
        {gridHealth.score === null
          ? "Fresh demand, capacity, frequency, and sufficient weighted coverage are required."
          : pressures.length
            ? `Main pressure: ${pressures.join(", ")}.`
            : "No material pressure is present in the available inputs."}
      </p>
    </section>
  );
}

function DashboardViewNavigation({
  activeView,
  mobile,
  onNavigate,
  onOpenMore,
  moreTriggerRef,
}: {
  activeView: DashboardViewId;
  mobile: boolean;
  onNavigate: (view: DashboardViewId) => void;
  onOpenMore: () => void;
  moreTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const primaryViews = dashboardViewDefinitions.filter((view) =>
    primaryDashboardViewIds.includes(view.id),
  );
  const moreActive = moreDashboardViewIds.includes(activeView);
  return (
    <nav
      aria-label="Dashboard views"
      className={`dashboard-view-nav ${mobile ? "mobile-section-nav" : "desktop-view-nav"}`}
      data-navigation-surface={mobile ? "mobile" : "desktop"}
    >
      {primaryViews.map((view) => (
        <button
          aria-current={activeView === view.id ? "page" : undefined}
          aria-label={`${view.label} view`}
          key={view.id}
          onClick={() => onNavigate(view.id)}
          type="button"
        >
          {view.label}
        </button>
      ))}
      <button
        aria-current={moreActive ? "page" : undefined}
        aria-haspopup="dialog"
        aria-label={
          moreActive
            ? `More views, ${dashboardViewDefinition(activeView).label} selected`
            : "More views"
        }
        onClick={onOpenMore}
        ref={moreTriggerRef}
        type="button"
      >
        More
      </button>
    </nav>
  );
}

function DiagnosticList({
  lifecycleState,
  sources,
}: {
  lifecycleState: DataLifecycleState;
  sources: readonly SourceHealth[];
}) {
  if (lifecycleState !== "ready") {
    return (
      <DataLifecycleMessage
        detail={
          lifecycleState === "waiting"
            ? "No source-health sample has been reported yet."
            : undefined
        }
        state={lifecycleState}
      />
    );
  }
  return (
    <div className="diagnostic-list">
      {sources.map((source) => (
        <article className={`diagnostic-item status-${source.state}`} key={source.source_id}>
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
  );
}

export function App() {
  const initialUrl = useMemo(() => new URL(window.location.href), []);
  const initialMobile = useRef(mediaQueryMatches(MOBILE_MEDIA_QUERY)).current;
  const initialView = useMemo(() => dashboardViewForUrl(initialUrl), [initialUrl]);
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
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestRevision, setRequestRevision] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const collapsed = initiallyCollapsedGroups(initialMobile);
    for (const group of dashboardViewDefinition(initialView).groups) collapsed.delete(group);
    const inspected = chartDefinitions.find((chart) => chart.id === state.expandedChart);
    if (inspected) collapsed.delete(inspected.group);
    return collapsed;
  });
  const [activeChartIds, setActiveChartIds] = useState<Set<string>>(new Set());
  const [mobileDialog, setMobileDialog] = useState<MobileDialogName>(null);
  const [selectedView, setSelectedView] = useState<DashboardViewId>(initialView);
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const sourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const eventsTriggerRef = useRef<HTMLButtonElement>(null);
  const dashboardTitleRef = useRef<HTMLHeadingElement>(null);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const {
    derivedContext,
    error: overviewError,
    events,
    isLoading: overviewLoading,
    isValidating: overviewValidating,
    latest,
    observedAt: overviewAsOf,
    priceRanking,
    retry: retryOverview,
    sourceHealth,
    statusEvents,
    trendBaselines,
  } = useOverviewData({ eventsEnabled: state.events, overviewQueries, time: state.time });
  const effectiveRequestError = overviewError ?? requestError;

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
    const next = dashboardViewToUrl(
      selectedView,
      dashboardStateToUrl(state, new URL(window.location.href)),
    );
    window.history.replaceState(null, "", next);
  }, [selectedView, state]);

  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      explicitLegendRef.current = url.searchParams.has("legend");
      setSelectedView(dashboardViewForUrl(url));
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
      (chart) =>
        dashboardViewForGroup(chart.group) === selectedView &&
        activeChartIds.has(chart.id) &&
        !collapsedGroups.has(chart.group),
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
    requestRevision,
    selectedView,
  ]);

  useEffect(() => {
    const groups = dashboardViewDefinition(selectedView).groups;
    setCollapsedGroups((current) => {
      const next = new Set(current);
      for (const group of groups) next.delete(group);
      return next;
    });
  }, [selectedView]);

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
  const sortedHealth = useMemo(() => sortDiagnostics(sourceHealth), [sourceHealth]);
  const diagnostics = useMemo(() => summarizeDiagnostics(sourceHealth), [sourceHealth]);
  const healthCounts = diagnostics.counts;
  const publicAlerts = useMemo(
    () => rationalizeAlerts(statusEvents, sourceHealth, Boolean(effectiveRequestError)),
    [effectiveRequestError, sourceHealth, statusEvents],
  );

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

  const navigateToView = useCallback(
    (view: DashboardViewId) => {
      if (view === selectedView) {
        window.scrollTo({ behavior: "smooth", top: 0 });
        (view === "overview" ? dashboardTitleRef.current : viewHeadingRef.current)?.focus({
          preventScroll: true,
        });
        return;
      }
      window.history.pushState(
        null,
        "",
        dashboardViewToUrl(
          view,
          dashboardStateToUrl({ ...state, expandedChart: null }, new URL(window.location.href)),
        ),
      );
      const groups = dashboardViewDefinition(view).groups;
      chartCoordinator.clearPin();
      setState((current) => ({ ...current, expandedChart: null }));
      setSelectedView(view);
      setMobileDialog(null);
      setCollapsedGroups((current) => {
        const next = new Set(current);
        for (const group of groups) next.delete(group);
        return next;
      });
      window.requestAnimationFrame(() => {
        window.scrollTo({ behavior: "smooth", top: 0 });
        (view === "overview" ? dashboardTitleRef.current : viewHeadingRef.current)?.focus({
          preventScroll: true,
        });
      });
    },
    [selectedView, state],
  );

  const demandPoint = latest.get("demand") ?? null;
  const capacityPoint = latest.get("capacity") ?? null;
  const frequencyPoint = latest.get("frequency") ?? null;
  const pricePoint = latest.get("price") ?? null;
  const demand = demandPoint?.value ?? null;
  const availableCapacity = capacityPoint?.value ?? null;
  const reserveMargin = reserveMarginPercent(demand, availableCapacity);
  const criticalValues: Record<CriticalMetricId, number | null> = {
    "available-capacity": availableCapacity,
    demand,
    frequency: frequencyPoint?.value ?? null,
    "grid-status": null,
    "real-time-price": pricePoint?.value ?? null,
    "reserve-margin": reserveMargin,
  };
  const reserveBaseline = reserveMarginPercent(
    trendBaselines.get("demand")?.[1] ?? null,
    trendBaselines.get("capacity")?.[1] ?? null,
  );
  const reserveObservedAt =
    demandPoint && capacityPoint ? Math.min(demandPoint.ts, capacityPoint.ts) : null;
  const heroTrends: Record<CriticalMetricId, HeroTrend> = {
    "available-capacity": buildHeroTrend(
      availableCapacity,
      trendBaselines.get("capacity")?.[1] ?? null,
      "MW",
      capacityPoint?.ts ?? null,
    ),
    demand: buildHeroTrend(
      demand,
      trendBaselines.get("demand")?.[1] ?? null,
      "MW",
      demandPoint?.ts ?? null,
    ),
    frequency: buildHeroTrend(
      frequencyPoint?.value ?? null,
      trendBaselines.get("frequency")?.[1] ?? null,
      "Hz",
      frequencyPoint?.ts ?? null,
    ),
    "grid-status": unavailableHeroTrend(null),
    "real-time-price": buildHeroTrend(
      pricePoint?.value ?? null,
      trendBaselines.get("price")?.[1] ?? null,
      "$/MWh",
      pricePoint?.ts ?? null,
    ),
    "reserve-margin": buildHeroTrend(reserveMargin, reserveBaseline, "%", reserveObservedAt),
  };
  const derivedMetrics = useMemo(
    () =>
      buildDerivedMetrics({
        context: derivedContext,
        latest,
        now: overviewAsOf,
        trendBaselines,
      }),
    [derivedContext, latest, overviewAsOf, trendBaselines],
  );
  const gridHealth = useMemo(
    () => buildGridHealthScore({ context: derivedContext, latest, now: overviewAsOf }),
    [derivedContext, latest, overviewAsOf],
  );
  const overview = criticalMetricDefinitions
    .filter((definition) => definition.id !== "grid-status")
    .map((definition) => ({
      ...definition,
      trend: heroTrends[definition.id],
      value: criticalValues[definition.id],
    }));
  const mobilePrimaryOverview = overview.filter((item) =>
    mobilePrimaryCriticalMetricIds.includes(item.id),
  );
  const mobileSupportingOverview = overview.filter((item) =>
    mobileSupportingCriticalMetricIds.includes(item.id),
  );
  const visibleOverview = isMobile ? mobilePrimaryOverview : overview;
  const operatingSummary = useMemo(
    () =>
      buildOperatingSummary({
        events: statusEvents,
        latest,
        now: overviewAsOf,
        requestFailed: Boolean(effectiveRequestError),
        sources: sourceHealth,
      }),
    [effectiveRequestError, latest, overviewAsOf, sourceHealth, statusEvents],
  );
  const compactOperatingLabel = overviewLoading
    ? "Checking…"
    : {
        clear: "Normal",
        emergency: "Emergency",
        unavailable: "Unavailable",
        watch: "Watch",
      }[operatingSummary.operatingState];
  const compactCoreDataLabel = overviewLoading
    ? "Checking…"
    : {
        current: "Current",
        limited: "Limited",
        unavailable: "Unavailable",
      }[operatingSummary.coreDataState];
  const updatedAge = operatingSummary.coreObservedAt
    ? formatAge(Math.max(0, nowSeconds() - operatingSummary.coreObservedAt)).replace(" old", " ago")
    : null;
  const freshnessLabel =
    state.time.mode === "fixed"
      ? "Viewing a fixed analysis window"
      : state.time.paused
        ? updatedAge
          ? `Paused · updated ${updatedAge}`
          : "Paused"
        : updatedAge
          ? `Updated ${updatedAge}`
          : "Live";
  const sourceDetail = diagnostics.worstSource
    ? diagnostics.worstSource.display_name.replace(/^ERCOT /, "") +
      " " +
      diagnostics.worstSource.state +
      " · data " +
      formatAge(diagnostics.worstSource.data_age_seconds)
    : diagnostics.state === "healthy"
      ? String(healthCounts.healthy) +
        " source" +
        (healthCounts.healthy === 1 ? " is" : "s are") +
        " reporting normally"
      : dataLifecycleCopy.waiting.detail;
  const sourceLifecycleState = resolveDataLifecycleState({
    hasData: sourceHealth.length > 0,
    loading: overviewLoading,
    unavailable: Boolean(effectiveRequestError),
  });
  const priceLifecycleState = resolveDataLifecycleState({
    hasData: priceRanking.length > 0,
    loading: overviewLoading,
    unavailable: Boolean(effectiveRequestError),
  });
  const settlementRows = priceRanking.map((row) => ({
    ...row,
    metadata: settlementPointMetadata(row.tag),
  }));
  const houstonSettlement = settlementRows.find((row) => row.metadata.code === "HB_HOUSTON");
  const settlementValues = settlementRows.map((row) => row.value);
  const settlementSpread = settlementValues.length
    ? Math.max(...settlementValues) - Math.min(...settlementValues)
    : null;
  const settlementObservedAt = Math.max(...settlementRows.map((row) => row.ts), 0);
  const settlementAge = settlementObservedAt
    ? Math.max(0, nowSeconds() - settlementObservedAt)
    : null;
  const sourceHeadline =
    sourceLifecycleState === "ready"
      ? diagnostics.headline
      : dataLifecycleCopy[sourceLifecycleState].title;
  const lifecycleSourceDetail =
    sourceLifecycleState === "ready"
      ? sourceDetail
      : sourceLifecycleState === "waiting"
        ? "No source-health sample has been reported yet."
        : dataLifecycleCopy[sourceLifecycleState].detail;
  const eventsLoading = Boolean(state.events && overviewLoading && !events.length);
  const eventsUnavailable = Boolean(
    state.events && !overviewLoading && effectiveRequestError && !events.length,
  );
  const activeView = dashboardViewDefinition(selectedView);
  const activeChartGroups = chartGroups.filter(
    (group) => dashboardViewForGroup(group) === selectedView,
  );
  const featuredChart = chartDefinitions.find((chart) => chart.id === "supply-demand")!;

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

  const actOnAlert = (alert: PublicAlert) => {
    if (alert.action === "review-operations") setMobileDialog("events");
    else if (alert.action === "review-diagnostics") setMobileDialog("sources");
    else {
      setRequestError(null);
      setRequestRevision((current) => current + 1);
      void retryOverview();
    }
  };

  const renderChart = (
    chart: (typeof chartDefinitions)[number],
    presentation: "featured" | "standard" = "standard",
  ) => (
    <Suspense
      fallback={<article className="chart-card chart-card-lazy">Loading chart workspace…</article>}
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
        onSetCompare={(compare) => setState((current) => ({ ...current, compare }))}
        onSoloSeries={soloSeries}
        onToggleSeries={toggleSeries}
        onVisibilityChange={setChartVisible}
        onZoom={onZoom}
        presentation={presentation}
        requestError={effectiveRequestError}
        seriesData={seriesData}
        sourceHealth={chart.sourceId ? (healthById.get(chart.sourceId) ?? null) : null}
        time={state.time}
      />
    </Suspense>
  );

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <h1 ref={dashboardTitleRef} tabIndex={-1}>
            ERCOT Grid Status
          </h1>
        </div>
        {state.time.mode === "fixed" ? null : (
          <p className="freshness-state" data-mode={state.time.mode}>
            {freshnessLabel}
          </p>
        )}
        <section aria-label="Global dashboard controls" className="control-bar compact-control-bar">
          <TimeRangeSelect setState={setState} state={state} />
          <Button
            aria-haspopup="dialog"
            onClick={() => setMobileDialog("controls")}
            ref={controlsTriggerRef}
          >
            Analyze
          </Button>
        </section>
      </header>

      {!isMobile ? (
        <DashboardViewNavigation
          activeView={selectedView}
          mobile={false}
          moreTriggerRef={moreTriggerRef}
          onNavigate={navigateToView}
          onOpenMore={() => setMobileDialog("more")}
        />
      ) : null}

      <main
        aria-busy={overviewValidating && !overviewLoading}
        aria-label={`${activeView.label} dashboard view`}
        data-dashboard-view={selectedView}
        data-overview-refresh={overviewValidating && !overviewLoading ? "background" : "idle"}
      >
        {selectedView !== "overview" ? (
          <section className="dashboard-view-heading">
            <p className="eyebrow">Dashboard view</p>
            <h2 ref={viewHeadingRef} tabIndex={-1}>
              {activeView.label}
            </h2>
            <p>{activeView.description}</p>
          </section>
        ) : null}

        {selectedView === "overview" ? (
          <>
            <section
              aria-label="Grid overview"
              className="overview-grid overview-readings"
              data-mobile-tier="primary"
            >
              {visibleOverview.map((item) => (
                <MetricOverviewCard item={item} key={item.id} loading={overviewLoading} />
              ))}
            </section>
            <section aria-label="Featured grid trend" className="featured-chart-section">
              {renderChart(featuredChart, "featured")}
            </section>

            <GridHealthSummary gridHealth={gridHealth} />

            {isMobile ? (
              <details className="mobile-supporting-metrics">
                <summary>
                  <span>Supporting grid readings</span>
                  <small>Available capacity and frequency</small>
                  <span aria-hidden="true" className="mobile-supporting-indicator">
                    <span className="mobile-supporting-indicator-closed">+</span>
                    <span className="mobile-supporting-indicator-open">−</span>
                  </span>
                </summary>
                <section aria-label="Supporting grid readings" className="overview-grid">
                  {mobileSupportingOverview.map((item) => (
                    <MetricOverviewCard item={item} key={item.id} loading={overviewLoading} />
                  ))}
                </section>
              </details>
            ) : null}

            <section
              aria-label="Current ERCOT status"
              className="status-strip"
              data-core-state={operatingSummary.coreDataState}
              data-operating-state={operatingSummary.operatingState}
            >
              <div className="status-strip-item">
                <span>Grid status</span>
                <strong aria-label={operatingSummary.operatingLabel}>
                  {compactOperatingLabel}
                </strong>
              </div>
              <div className="status-strip-item" aria-live="polite">
                <span>Data</span>
                <strong aria-label={operatingSummary.coreDataLabel}>{compactCoreDataLabel}</strong>
                {!overviewLoading && operatingSummary.optionalProblemCount ? (
                  <small>
                    {String(operatingSummary.optionalProblemCount)} optional source
                    {operatingSummary.optionalProblemCount === 1 ? " is" : "s are"} degraded
                  </small>
                ) : null}
              </div>
              {!overviewLoading &&
              (operatingSummary.coreDataState !== "current" ||
                operatingSummary.optionalProblemCount > 0) ? (
                <Button
                  aria-label="View diagnostics"
                  onClick={() => setMobileDialog("sources")}
                  ref={sourcesTriggerRef}
                >
                  Diagnostics
                </Button>
              ) : null}
            </section>

            {publicAlerts.length ? (
              <details aria-label="Active grid alerts" className="alert-stack compact-alerts">
                <summary role="alert">
                  <span>
                    {String(publicAlerts.length)} active notice
                    {publicAlerts.length === 1 ? "" : "s"}
                  </span>
                  <strong>{publicAlerts[0]?.label}</strong>
                  <span>Review details</span>
                </summary>
                <div>
                  {publicAlerts.map((alert) => (
                    <article
                      className="public-alert"
                      data-alert-severity={alert.severity}
                      key={alert.id}
                    >
                      <header>
                        <span>{alert.severity}</span>
                        <h2>{alert.label}</h2>
                      </header>
                      <dl>
                        <div>
                          <dt>Cause</dt>
                          <dd>{alert.cause}</dd>
                        </div>
                        <div>
                          <dt>Impact</dt>
                          <dd>{alert.impact}</dd>
                        </div>
                        <div>
                          <dt>Recommended action</dt>
                          <dd>{alert.recommendedAction}</dd>
                        </div>
                      </dl>
                      <Button onClick={() => actOnAlert(alert)}>
                        {alert.action === "retry-data"
                          ? "Retry data"
                          : alert.action === "review-diagnostics"
                            ? "Review System health"
                            : "Review operations"}
                      </Button>
                    </article>
                  ))}
                </div>
              </details>
            ) : null}

            <details className="grid-health-details">
              <summary>How status is determined</summary>
              <div>
                <h3>Analytical Grid Health Score</h3>
                <p>
                  Eight weighted factors contribute 100 possible points. Threshold penalties are
                  normalized across available factors; fresh demand, capacity, and frequency plus at
                  least 70% weighted coverage are required. Any missing factor prevents a NORMAL
                  label, and EEA levels 1, 2, and 3 override the label to WATCH, STRAINED, and
                  CRITICAL.
                </p>
                <p className="grid-health-current-result">
                  Current result:{" "}
                  {gridHealth.score === null
                    ? "not enough fresh inputs"
                    : `${String(gridHealth.score)} / 100`}{" "}
                  · {gridHealth.detail}
                </p>
                <ol aria-label="Grid Health Score factors">
                  {gridHealth.factors.map((factor) => (
                    <li data-factor-available={factor.available} key={factor.id}>
                      <div>
                        <strong>{factor.label}</strong>
                        <span>{formatValue(factor.weight, "points")} maximum</span>
                      </div>
                      <p>{factor.detail}</p>
                      <small>
                        {factor.penalty === null
                          ? "Unavailable"
                          : `${formatValue(factor.weight - factor.penalty, "points")} retained`}
                      </small>
                    </li>
                  ))}
                </ol>
                <p className="grid-health-thresholds">
                  Score bands: NORMAL 85–100 · WATCH 70–84 · STRAINED 50–69 · CRITICAL below 50.
                </p>
              </div>
            </details>
          </>
        ) : null}

        {selectedView === "overview" ? (
          <details className="derived-insights-section" data-information-level="operational">
            <summary>Calculated grid insights</summary>
            <div>
              <p>Transparent calculations from current readings and bounded comparison windows.</p>
              <div aria-label="Derived grid metrics" className="derived-insights-grid">
                {derivedMetrics.map((metric) => {
                  const valueLabel = overviewLoading ? "…" : metric.valueLabel;
                  const detail = overviewLoading ? "Loading required source data…" : metric.detail;
                  return (
                    <article
                      aria-label={`${metric.label}: ${valueLabel}. ${detail} Formula: ${metric.formula}.`}
                      className="derived-insight-card"
                      data-derived-available={!overviewLoading && metric.available}
                      data-derived-metric={metric.id}
                      key={metric.id}
                    >
                      <span>{metric.label}</span>
                      <strong>{valueLabel}</strong>
                      <small>{detail}</small>
                      <p>
                        <span>Formula</span>
                        {metric.formula}
                      </p>
                    </article>
                  );
                })}
              </div>
            </div>
          </details>
        ) : null}

        {selectedView === "reliability" ? (
          <section aria-label="ERCOT operations messages" className="events-panel">
            <div>
              <p className="eyebrow">History</p>
              <h2>Operations timeline</h2>
              <p>ERCOT notices in the selected time window, classified for faster review.</p>
            </div>
            {state.events ? (
              <OperationsTimeline
                events={events}
                loading={eventsLoading}
                unavailable={eventsUnavailable}
              />
            ) : (
              <div className="view-empty-note">
                <p>Operations annotations are off for the shared dashboard window.</p>
                <Button aria-haspopup="dialog" onClick={() => setMobileDialog("controls")}>
                  Review controls
                </Button>
              </div>
            )}
          </section>
        ) : null}

        {selectedView === "market" ? (
          <section aria-label="Settlement price ranking" className="events-panel ranking-panel">
            <div>
              <p className="eyebrow">Market ranking</p>
              <h2>Latest settlement point prices</h2>
            </div>
            {priceLifecycleState === "ready" ? (
              <div className="market-price-context">
                <div aria-label="Settlement price summary" className="market-summary-grid">
                  <article>
                    <span>Houston Hub</span>
                    <strong>
                      {houstonSettlement
                        ? formatValue(houstonSettlement.value, "$/MWh")
                        : "Not reported"}
                    </strong>
                  </article>
                  <article>
                    <span>High–low spread</span>
                    <strong>
                      {settlementSpread === null
                        ? "Not reported"
                        : formatValue(settlementSpread, "$/MWh")}
                    </strong>
                  </article>
                  <article>
                    <span>Regional context</span>
                    <strong>
                      {settlementSpread !== null && settlementSpread >= 100
                        ? "Material divergence"
                        : "Broadly aligned"}
                    </strong>
                  </article>
                  <article>
                    <span>Publication</span>
                    <strong>
                      {settlementAge === null ? "Not reported" : formatAge(settlementAge)}
                    </strong>
                    {settlementAge === null ? null : (
                      <small>{settlementFreshness(settlementAge)}</small>
                    )}
                  </article>
                </div>
                <details className="market-ranking-details">
                  <summary>Complete hub and load-zone ranking</summary>
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
                        {settlementRows.map((row) => (
                          <tr key={row.tag}>
                            <td>
                              <strong>{row.metadata.label}</strong>
                              <small>
                                {row.metadata.type} · {row.metadata.code}
                              </small>
                            </td>
                            <td>{formatValue(row.value, "$/MWh")}</td>
                            <td>{new Date(row.ts * 1000).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            ) : (
              <DataLifecycleMessage
                className="panel-lifecycle-message"
                detail={
                  priceLifecycleState === "waiting"
                    ? "No settlement-price sample has been reported yet."
                    : undefined
                }
                state={priceLifecycleState}
              />
            )}
          </section>
        ) : null}

        {activeChartGroups.map((group) => {
          const showGroupHeading = activeView.groups.length > 1;
          const collapsed = showGroupHeading && collapsedGroups.has(group);
          const groupInformation = chartGroupDefinition(group);
          return (
            <section
              className="chart-group"
              data-group={group}
              data-information-level={groupInformation.level}
              key={group}
            >
              {showGroupHeading ? (
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
                >
                  <span>
                    {group}
                    <small>{groupInformation.description}</small>
                  </span>
                  <span>{collapsed ? "Expand" : "Collapse"}</span>
                </button>
              ) : null}
              {!collapsed ? (
                <div className="chart-grid">
                  {chartDefinitions
                    .filter(
                      (chart) =>
                        chart.group === group &&
                        !(selectedView === "overview" && chart.id === featuredChart.id),
                    )
                    .map((chart) => renderChart(chart))}
                </div>
              ) : null}
            </section>
          );
        })}

        {selectedView === "diagnostics" ? (
          <>
            <section
              aria-label="System health summary"
              className="source-health-panel diagnostics-summary"
              data-diagnostics-state={diagnostics.state}
              data-information-level="diagnostics"
            >
              <div>
                <p className="eyebrow">Diagnostics</p>
                <h2>System health</h2>
              </div>
              <div className="diagnostics-summary-content">
                <div aria-live="polite">
                  <strong>{sourceHeadline}</strong>
                  <p>{lifecycleSourceDetail}</p>
                </div>
              </div>
            </section>
            <section aria-label="System health details" className="diagnostics-view-details">
              <DiagnosticList lifecycleState={sourceLifecycleState} sources={sortedHealth} />
            </section>
          </>
        ) : null}
      </main>

      {state.expandedChart ? <div aria-hidden="true" className="inspect-backdrop" /> : null}

      {isMobile ? (
        <DashboardViewNavigation
          activeView={selectedView}
          mobile
          moreTriggerRef={moreTriggerRef}
          onNavigate={navigateToView}
          onOpenMore={() => setMobileDialog("more")}
        />
      ) : null}

      <MobileDialog
        description="Change the shared analytical time window, comparison, legend, and event settings."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "controls"}
        returnFocusRef={controlsTriggerRef}
        title="Analyze"
      >
        <div className="sheet-controls">
          <DashboardControls {...controls} surface="sheet" />
        </div>
      </MobileDialog>

      <MobileDialog
        description="Open weather, engineering, and data-collection views."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "more"}
        returnFocusRef={moreTriggerRef}
        title="More views"
      >
        <nav aria-label="More dashboard views" className="more-view-list">
          {dashboardViewDefinitions
            .filter((view) => moreDashboardViewIds.includes(view.id))
            .map((view) => (
              <button
                aria-current={selectedView === view.id ? "page" : undefined}
                key={view.id}
                onClick={() => navigateToView(view.id)}
                type="button"
              >
                <strong>{view.label}</strong>
                <span>{view.description}</span>
              </button>
            ))}
        </nav>
      </MobileDialog>

      <MobileDialog
        description="Collection health and observation freshness are shown separately for every source."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "sources"}
        returnFocusRef={sourcesTriggerRef}
        title="System health details"
      >
        <DiagnosticList lifecycleState={sourceLifecycleState} sources={sortedHealth} />
      </MobileDialog>

      <MobileDialog
        description="Active notices are prioritized; filterable selected-window history remains available here."
        onClose={() => setMobileDialog(null)}
        open={mobileDialog === "events"}
        returnFocusRef={eventsTriggerRef}
        title="Operations timeline"
      >
        <OperationsTimeline
          events={events}
          loading={eventsLoading}
          unavailable={eventsUnavailable}
        />
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
