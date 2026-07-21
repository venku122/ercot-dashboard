import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import { ChartCard } from "./dashboard/ChartCard";
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
  tickLive,
  navigateWindow,
  resetLive,
  setCustomRange,
  setRange,
  togglePause,
  zoomTo,
} from "./dashboard/time-state";
import type {
  DashboardState,
  EventRecord,
  LoadedSeries,
  SourceHealth,
  TimeState,
} from "./dashboard/types";
import { dashboardStateFromUrl, dashboardStateToUrl } from "./dashboard/url-state";
import { formatAge, formatValue } from "./dashboard/units";
import { formatChicagoDateTimeInput, parseChicagoDateTime } from "./dashboard/zoned-time";

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

export function App() {
  const [state, setState] = useState<DashboardState>(() =>
    dashboardStateFromUrl(new URL(window.location.href), nowSeconds()),
  );
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [activeChartIds, setActiveChartIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    seriesDataRef.current = seriesData;
  }, [seriesData]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setState((current) => ({
        ...current,
        time: tickLive(current.time, nowSeconds()),
      }));
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const next = dashboardStateToUrl(state, new URL(window.location.href));
    window.history.replaceState(null, "", next);
  }, [state]);

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
        if (controller.signal.aborted) return;
        setRequestError(error instanceof Error ? error.message : String(error));
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

  const healthById = useMemo(
    () => new Map(sourceHealth.map((source) => [source.source_id, source])),
    [sourceHealth],
  );
  const healthCounts = useMemo(() => {
    const counts = { healthy: 0, delayed: 0, stale: 0, failed: 0 };
    for (const source of sourceHealth) counts[source.state] += 1;
    return counts;
  }, [sourceHealth]);

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

  const overview = [
    {
      label: "Demand",
      value: latest.get("demand")?.value ?? null,
      unit: "MW",
    },
    {
      label: "Available capacity",
      value: latest.get("capacity")?.value ?? null,
      unit: "MW",
    },
    {
      label: "Frequency",
      value: latest.get("frequency")?.value ?? null,
      unit: "Hz",
    },
    {
      label: "Storage net output",
      value: latest.get("storage")?.value ?? null,
      unit: "MW",
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
    },
  ];

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Texas grid monitor</p>
          <h1>ERCOT analytical dashboard</h1>
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

      <section aria-label="Global dashboard controls" className="control-bar">
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
            <option value={3600}>1 hour</option>
            <option value={21600}>6 hours</option>
            <option value={43200}>12 hours</option>
            <option value={86400}>24 hours</option>
            <option value={259200}>3 days</option>
            <option value={604800}>7 days</option>
            <option value={2592000}>30 days</option>
            <option value={31536000}>12 months</option>
          </select>
        </label>
        <div className="button-cluster" aria-label="Window navigation">
          <Button
            aria-label="Previous time window"
            onClick={() =>
              setState((current) => ({
                ...current,
                time: navigateWindow(current.time, -1),
              }))
            }
          >
            ← Window
          </Button>
          <Button
            aria-label="Next time window"
            onClick={() =>
              setState((current) => ({
                ...current,
                time: navigateWindow(current.time, 1),
              }))
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
            zoomOriginRef.current = null;
            setState((current) => ({
              ...current,
              time: resetLive(current.time, nowSeconds()),
            }));
          }}
        >
          Reset to live
        </Button>
        <details className="custom-range">
          <summary>Custom range</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              try {
                const start = parseChicagoDateTime(String(form.get("start")));
                const end = parseChicagoDateTime(String(form.get("end")));
                setState((current) => ({ ...current, time: setCustomRange(start, end) }));
              } catch {
                setRequestError("invalid_time_range");
              }
            }}
          >
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
            <Button type="submit">Apply</Button>
          </form>
        </details>
        <label>
          <span>Compare</span>
          <select
            aria-label="Compare time"
            onChange={(event) =>
              setState((current) => ({
                ...current,
                compare: event.target.value as DashboardState["compare"],
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
            onChange={(event) =>
              setState((current) => ({
                ...current,
                legendMode: event.target.value as DashboardState["legendMode"],
              }))
            }
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
      </section>

      <main>
        {requestError ? (
          <div className="global-error" role="alert">
            Dashboard request failed. Existing data is preserved; this is not an empty-data state.{" "}
            {requestError}
          </div>
        ) : null}

        <section aria-label="Grid overview" className="overview-grid">
          {overview.map((item) => (
            <article className="overview-card" key={item.label}>
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
              <span className={`source-health-item status-${source.state}`} key={source.source_id}>
                {source.display_name}: collection {source.collection_state} · data{" "}
                {source.freshness_state} · {formatAge(source.data_age_seconds)}
                {source.source_timestamp_ts
                  ? ` · source ${new Date(source.source_timestamp_ts * 1000).toLocaleString()}`
                  : ""}
                {source.last_error ? ` · ${source.last_error}` : ""}
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
          ) : (
            <p>No settlement prices have been reported yet.</p>
          )}
        </section>

        {chartGroups.map((group) => {
          const collapsed = collapsedGroups.has(group);
          return (
            <section className="chart-group" key={group}>
              <button
                aria-expanded={!collapsed}
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
                <span>{group}</span>
                <span>{collapsed ? "Expand" : "Collapse"}</span>
              </button>
              {!collapsed ? (
                <div className="chart-grid">
                  {chartDefinitions
                    .filter((chart) => chart.group === group)
                    .map((chart) => (
                      <ChartCard
                        chart={chart}
                        compare={state.compare}
                        events={state.events ? events : []}
                        hiddenSeries={state.hiddenSeries}
                        inspect={state.expandedChart === chart.id}
                        key={chart.id}
                        legendMode={state.legendMode}
                        loading={loading}
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
                        onZoom={onZoom}
                        onVisibilityChange={setChartVisible}
                        seriesData={seriesData}
                        sourceHealth={
                          chart.sourceId ? (healthById.get(chart.sourceId) ?? null) : null
                        }
                        time={state.time}
                      />
                    ))}
                </div>
              ) : null}
            </section>
          );
        })}
      </main>

      {state.expandedChart ? <div aria-hidden="true" className="inspect-backdrop" /> : null}

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
