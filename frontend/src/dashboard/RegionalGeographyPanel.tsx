import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import {
  loadRegionalManifest,
  loadRegionalResource,
  REGIONAL_MODES,
  type RegionalMode,
  type RegionalPoint,
} from "./regional-geography";
import { formatValue } from "./units";

const MODE_LABEL: Record<RegionalMode, string> = {
  load: "Weather-zone load",
  wind: "Wind regions",
  solar: "Solar regions",
};

function display(value: number | null | undefined, unit = "MW") {
  return value === null || value === undefined ? "Unavailable" : formatValue(value, unit);
}

function generationSegments(rows: Array<{ current_mw: number | null }>) {
  const maximum = Math.max(
    1,
    ...rows.flatMap((row) => (row.current_mw === null ? [] : [row.current_mw])),
  );
  const segments: string[][] = [];
  let segment: string[] = [];
  rows.forEach((row, index) => {
    if (row.current_mw === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push(
      `${(index / Math.max(1, rows.length - 1)) * 100},${40 - (row.current_mw / maximum) * 36}`,
    );
  });
  if (segment.length) segments.push(segment);
  return segments;
}

function RegionButton({
  active,
  mode,
  onKeyDown,
  onSelect,
  point,
}: {
  active: boolean;
  mode: RegionalMode;
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
  onSelect(): void;
  point: RegionalPoint;
}) {
  const trend =
    point.change_1h_mw === null
      ? "No exact prior hour"
      : point.change_1h_mw >= 0
        ? `Up ${display(point.change_1h_mw)}`
        : `Down ${display(Math.abs(point.change_1h_mw))}`;
  return (
    <button
      aria-label={`${point.region}, ${MODE_LABEL[mode]}, ${display(point.current_mw)}, ${trend}`}
      aria-pressed={active}
      className="regional-schematic-button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <strong>{point.region}</strong>
      <span>{display(point.current_mw)}</span>
      <small>{trend}</small>
    </button>
  );
}

export function RegionalGeographyPanel({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<RegionalMode>(() => {
    if (typeof window === "undefined") return "load";
    const value = new URL(window.location.href).searchParams.get("regionalLayer");
    return REGIONAL_MODES.includes(value as RegionalMode) ? (value as RegionalMode) : "load";
  });
  const [urlRegion, setUrlRegion] = useState(() =>
    typeof window === "undefined"
      ? null
      : new URL(window.location.href).searchParams.get("regionalRegion"),
  );
  const [selected, setSelected] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const fetcher = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return loadRegionalManifest(next.signal).finally(() => {
      if (controller.current === next) controller.current = null;
    });
  }, []);
  useEffect(() => {
    if (!enabled || !expanded) controller.current?.abort();
    return () => {
      if (enabled && expanded) controller.current?.abort();
    };
  }, [enabled, expanded]);
  const query = useSWR(enabled && expanded ? ["regional-geography", "current"] : null, fetcher, {
    dedupingInterval: 0,
    keepPreviousData: false,
    revalidateOnFocus: true,
    refreshInterval: 300_000,
  });
  const points = query.data?.current[mode].regions ?? [];
  const requestedIndex = urlRegion ? points.findIndex((point) => point.region === urlRegion) : -1;
  const selectionResolved = urlRegion === null || requestedIndex >= 0;
  const activeIndex = requestedIndex >= 0 ? requestedIndex : Math.min(selected, points.length - 1);
  const activePoint = activeIndex >= 0 ? points[activeIndex] : undefined;
  const historyLink = useMemo(() => {
    if (!query.data || !selectionResolved || !activePoint) return null;
    const key =
      mode === "load"
        ? `regional.load.weather-zone.${activePoint.region}.actual`
        : `regional.${mode}.${activePoint.region}.hourly`;
    const matches = query.data.resources.filter((item) => item.series_key === key);
    const today = Math.floor(Date.now() / 86_400_000) * 86_400;
    const currentOrPast = matches
      .filter((item) => item.tile_start <= today)
      .sort((left, right) => right.tile_start - left.tile_start);
    return (
      currentOrPast[0] ??
      matches.sort((left, right) => left.tile_start - right.tile_start)[0] ??
      null
    );
  }, [activePoint, mode, query.data, selectionResolved]);
  const pairedForecastLink = useMemo(() => {
    if (!query.data || mode !== "load" || !activePoint || !historyLink) return null;
    const key = `regional.load.weather-zone.${activePoint.region}.forecast`;
    return (
      query.data.resources.find(
        (item) => item.series_key === key && item.tile_start === historyLink.tile_start,
      ) ?? null
    );
  }, [activePoint, historyLink, mode, query.data]);
  const historyController = useRef<AbortController | null>(null);
  const forecastHistoryController = useRef<AbortController | null>(null);
  const history = useSWR(
    enabled && expanded && historyLink ? ["regional-geography", historyLink.url] : null,
    () => {
      historyController.current?.abort();
      const next = new AbortController();
      historyController.current = next;
      return loadRegionalResource(historyLink!, next.signal).finally(() => {
        if (historyController.current === next) historyController.current = null;
      });
    },
    { keepPreviousData: false, revalidateOnFocus: false },
  );
  const forecastHistory = useSWR(
    enabled && expanded && pairedForecastLink
      ? ["regional-geography", pairedForecastLink.url]
      : null,
    () => {
      forecastHistoryController.current?.abort();
      const next = new AbortController();
      forecastHistoryController.current = next;
      return loadRegionalResource(pairedForecastLink!, next.signal).finally(() => {
        if (forecastHistoryController.current === next) forecastHistoryController.current = null;
      });
    },
    { keepPreviousData: false, revalidateOnFocus: false },
  );
  const historyObservedCount =
    history.data?.rows.filter((row) => row.current_mw !== null).length ?? 0;
  useEffect(() => {
    if (!points.length) return;
    if (requestedIndex >= 0) {
      setSelected(requestedIndex);
      return;
    }
    if (urlRegion !== null) {
      setSelected(0);
      setUrlRegion(null);
      const url = new URL(window.location.href);
      url.searchParams.delete("regionalRegion");
      window.history.replaceState(window.history.state, "", url);
    }
  }, [points.length, requestedIndex, urlRegion]);
  useEffect(() => {
    if (!enabled || !expanded) historyController.current?.abort();
    if (!enabled || !expanded) forecastHistoryController.current?.abort();
    return () => {
      historyController.current?.abort();
      forecastHistoryController.current?.abort();
    };
  }, [enabled, expanded]);
  useEffect(() => {
    const restore = () => {
      const url = new URL(window.location.href);
      const layer = url.searchParams.get("regionalLayer");
      if (REGIONAL_MODES.includes(layer as RegionalMode)) setMode(layer as RegionalMode);
      setUrlRegion(url.searchParams.get("regionalRegion"));
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const pushSelection = (nextMode: RegionalMode, region?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("regionalLayer", nextMode);
    if (region) url.searchParams.set("regionalRegion", region);
    else url.searchParams.delete("regionalRegion");
    setUrlRegion(region ?? null);
    window.history.pushState(window.history.state, "", url);
  };

  return (
    <section aria-labelledby="regional-geography-title" className="regional-geography-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Source-native regional context</p>
          <h2 id="regional-geography-title">Regional load and renewable outlook</h2>
        </div>
        <Button
          aria-controls="regional-geography-detail"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide regional details" : "Load regional details"}
        </Button>
      </div>
      <p>
        Load, wind, and solar use separate ERCOT source taxonomies. No history is requested until
        opened.
      </p>
      {expanded ? (
        <div id="regional-geography-detail">
          <fieldset>
            <legend>Regional source layer</legend>
            {REGIONAL_MODES.map((value) => (
              <Button
                aria-pressed={mode === value}
                key={value}
                onClick={() => {
                  setMode(value);
                  setSelected(0);
                  pushSelection(value);
                }}
              >
                {MODE_LABEL[value]}
              </Button>
            ))}
          </fieldset>
          {query.error && query.data ? (
            <p role="status">
              Refresh failed; showing the last successful regional snapshot and its source
              timestamps.
            </p>
          ) : null}
          {query.error && !query.data ? <DataLifecycleMessage state="unavailable" /> : null}
          {!query.data && !query.error ? <DataLifecycleMessage state="loading" /> : null}
          {query.data ? (
            <>
              <h3>{query.data.title}</h3>
              {query.data.source_health.some((source) => source.state !== "healthy") ? (
                <p role="status">
                  Some regional sources are stale, failed, or unavailable. Values remain
                  source-labeled.
                </p>
              ) : null}
              <ul aria-label="Regional source freshness">
                {query.data.source_health.map((source) => (
                  <li key={source.source_id}>
                    {source.source_id}: {source.state}; data age{" "}
                    {source.data_age_seconds ?? "unavailable"} seconds; last success{" "}
                    {source.last_success_ts === null
                      ? "unavailable"
                      : new Date(source.last_success_ts * 1000).toLocaleString()}
                  </li>
                ))}
              </ul>
              {query.data.materialization_health?.state === "failed" ? (
                <p role="status">
                  Regional load history materialization failed after source ingest. The last
                  successful immutable history remains available while replay repair is pending.
                  Consecutive failures: {query.data.materialization_health.consecutive_failures}.
                  Last success:{" "}
                  {query.data.materialization_health.last_success_ts === null
                    ? "unavailable"
                    : new Date(
                        query.data.materialization_health.last_success_ts * 1000,
                      ).toLocaleString()}
                  . Error: {query.data.materialization_health.last_error}.
                </p>
              ) : null}
              {query.data.current[mode].source ? (
                <p>
                  Source provenance:{" "}
                  {Object.entries(query.data.current[mode].source!)
                    .map(
                      ([key, value]) =>
                        `${key} ${typeof value === "number" && key.endsWith("_at") ? new Date(value * 1000).toLocaleString() : (value ?? "unavailable")}`,
                    )
                    .join(" · ")}
                </p>
              ) : null}
              {points.length ? (
                <>
                  <div
                    aria-label={`${MODE_LABEL[mode]} schematic`}
                    className="regional-schematic"
                    role="group"
                  >
                    {points.map((point, index) => (
                      <RegionButton
                        active={activeIndex === index}
                        key={point.region}
                        mode={mode}
                        onKeyDown={(event) => {
                          if (
                            ![
                              "ArrowLeft",
                              "ArrowRight",
                              "ArrowUp",
                              "ArrowDown",
                              "Home",
                              "End",
                            ].includes(event.key)
                          )
                            return;
                          event.preventDefault();
                          const delta =
                            event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? points.length - 1
                                : (activeIndex + delta + points.length) % points.length;
                          setSelected(next);
                          pushSelection(mode, points[next]?.region);
                          (
                            event.currentTarget.parentElement?.children[next] as
                              | HTMLElement
                              | undefined
                          )?.focus();
                        }}
                        onSelect={() => {
                          setSelected(index);
                          pushSelection(mode, point.region);
                        }}
                        point={point}
                      />
                    ))}
                  </div>
                  <div className="table-scroll" tabIndex={0}>
                    <table className="regional-current-table">
                      <caption>Exact {MODE_LABEL[mode].toLowerCase()} values</caption>
                      <thead>
                        <tr>
                          <th>Region</th>
                          <th>Observed</th>
                          <th>Current</th>
                          <th>Share</th>
                          <th>Exact 1h change</th>
                          <th>Forecast / status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {points.map((point) => (
                          <tr
                            data-selected={activePoint?.region === point.region || undefined}
                            key={point.region}
                          >
                            <th scope="row">{point.region}</th>
                            <td>
                              {point.current_target_ts === null ||
                              point.current_target_ts === undefined
                                ? "Unavailable"
                                : new Date(point.current_target_ts * 1000).toLocaleString()}
                            </td>
                            <td>{display(point.current_mw)}</td>
                            <td>{display(point.share_percent, "%")}</td>
                            <td>{display(point.change_1h_mw)}</td>
                            <td>
                              {mode === "load"
                                ? `${display(point.forecast_mw)}; error ${display(point.forecast_error_mw)}`
                                : point.next_24h_forecast_peak
                                  ? `HSL-potential forecast peak ${display(point.next_24h_forecast_peak.forecast_mw)}; forecast error unavailable — generation is curtailment-affected while forecast targets HSL potential`
                                  : "Renewable error unavailable — generation is curtailment-affected while forecast targets HSL potential"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {mode === "load" ? (
                    <>
                      <p>
                        Load forecast error is a diagnostic NP6-345 actual minus NP3-565 forecast;
                        positive means underforecast. The selected issue is constrained to a 1–2h
                        effective lead and is not an official ERCOT quality score.
                      </p>
                      {history.error && !history.data ? (
                        <p role="status">Selected actual-load history is unavailable.</p>
                      ) : history.data ? (
                        <>
                          {history.error ? (
                            <p role="status">
                              Actual-load refresh failed; showing the last successful selected
                              history.
                            </p>
                          ) : null}
                          {pairedForecastLink === null ? (
                            <p role="status">
                              Paired forecast history is unavailable; diagnostic error cannot be
                              calculated.
                            </p>
                          ) : forecastHistory.error ? (
                            <p role="status">
                              Forecast history refresh failed; actual history remains available and
                              diagnostic error is unavailable.
                            </p>
                          ) : !forecastHistory.data ? (
                            <DataLifecycleMessage state="loading" />
                          ) : null}
                          <figure>
                            {historyObservedCount <= 1 ? (
                              <p role="status">
                                {historyObservedCount === 0
                                  ? "No observed history points are available to draw; exact rows remain in the table."
                                  : "Only one observed history point is available; it cannot form a line, and its exact value remains in the table."}
                              </p>
                            ) : null}
                            <svg
                              aria-label={`${activePoint?.region} load actual${forecastHistory.data ? " and forecast" : ""}`}
                              className="regional-history-chart"
                              role="img"
                              viewBox="0 0 100 44"
                            >
                              {generationSegments(history.data.rows).map((segment, index) => (
                                <polyline
                                  fill="none"
                                  key={`actual-${index}`}
                                  points={segment.join(" ")}
                                  stroke="currentColor"
                                  vectorEffect="non-scaling-stroke"
                                />
                              ))}
                              {forecastHistory.data
                                ? generationSegments(
                                    forecastHistory.data.rows.map((row) => ({
                                      current_mw: row.forecast_mw,
                                    })),
                                  ).map((segment, index) => (
                                    <polyline
                                      className="profile-ramp-one"
                                      fill="none"
                                      key={`forecast-${index}`}
                                      points={segment.join(" ")}
                                      vectorEffect="non-scaling-stroke"
                                    />
                                  ))
                                : null}
                            </svg>
                            <figcaption>
                              Solid: NP6-345 actual.
                              {forecastHistory.data
                                ? " Dashed: coherent NP3-565 forecast."
                                : " Paired forecast unavailable."}
                            </figcaption>
                            <div
                              aria-label="Selected weather-zone history table"
                              className="table-scroll"
                              tabIndex={0}
                            >
                              <table className="regional-history-table">
                                <caption>Exact selected weather-zone hourly history</caption>
                                <thead>
                                  <tr>
                                    <th>Interval end</th>
                                    <th>Actual</th>
                                    <th>Forecast</th>
                                    <th>Diagnostic error actual − forecast</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {history.data.rows.map((actual) => {
                                    const forecast = forecastHistory.data?.rows.find(
                                      (row) => row.target_ts === actual.target_ts,
                                    );
                                    return (
                                      <tr key={actual.target_ts}>
                                        <td>
                                          {new Date(actual.target_ts * 1000).toLocaleString()}
                                        </td>
                                        <td>{display(actual.current_mw)}</td>
                                        <td>{display(forecast?.forecast_mw)}</td>
                                        <td>{display(forecast?.forecast_error_mw)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </figure>
                        </>
                      ) : historyLink ? (
                        <DataLifecycleMessage state="loading" />
                      ) : (
                        <p role="status">Selected actual-load history is unavailable.</p>
                      )}
                    </>
                  ) : (
                    <>
                      <p>
                        Forecast error unavailable: observed generation is curtailment-affected,
                        while the renewable forecast targets HSL potential.
                      </p>
                      {history.error ? (
                        <p role="status">Selected-region history is unavailable.</p>
                      ) : history.data ? (
                        <figure>
                          {historyObservedCount <= 1 ? (
                            <p role="status">
                              {historyObservedCount === 0
                                ? "No observed generation points are available to draw; exact rows remain in the table."
                                : "Only one observed generation point is available; it cannot form a line, and its exact value remains in the table."}
                            </p>
                          ) : null}
                          <svg
                            aria-label={`${activePoint?.region} hourly generation`}
                            className="regional-history-chart"
                            role="img"
                            viewBox="0 0 100 44"
                          >
                            {generationSegments(history.data.rows).map((segment, index) => (
                              <polyline
                                fill="none"
                                key={`${history.data!.series_key}-${index}`}
                                points={segment.join(" ")}
                                stroke="currentColor"
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                          </svg>
                          <figcaption>
                            Selected-region hourly generation. Forecast targets HSL potential.
                          </figcaption>
                          <div
                            aria-label="Selected-region history table"
                            className="table-scroll"
                            tabIndex={0}
                          >
                            <table className="regional-history-table">
                              <caption>Exact {activePoint?.region} hourly history</caption>
                              <thead>
                                <tr>
                                  <th>Observed interval end</th>
                                  <th>Generation</th>
                                  <th>HSL-potential forecast</th>
                                  <th>Exact 1h change</th>
                                </tr>
                              </thead>
                              <tbody>
                                {history.data.rows.map((row) => (
                                  <tr key={row.target_ts}>
                                    <td>{new Date(row.target_ts * 1000).toLocaleString()}</td>
                                    <td>{display(row.current_mw)}</td>
                                    <td>{display(row.forecast_mw)}</td>
                                    <td>{display(row.change_1h_mw)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </figure>
                      ) : historyLink ? (
                        <DataLifecycleMessage state="loading" />
                      ) : null}
                    </>
                  )}
                </>
              ) : (
                <p>
                  {query.data.current[mode].unavailable_reason === "source_parity"
                    ? "Regional snapshot withheld because source region totals did not match the system total within 0.1 MW."
                    : "No regional snapshot is available yet. The collector is wired but disabled by default pending reviewed activation."}
                </p>
              )}
              <p>Hourly NP4-742/745 only. Five-minute NP4-743/746 is deliberately deferred.</p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
