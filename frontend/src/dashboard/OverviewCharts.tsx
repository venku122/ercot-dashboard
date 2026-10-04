import {
  intervalPriceSeries,
  intervalPriceTemporalPolicy,
  seriesIntervalLabel,
} from "./interval-price-series";
import { observationAt, temporalPolicy } from "./series-temporal-policy";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { chartDefinitions } from "./chart-config";
import { chartCoordinator } from "./chart-coordinator";
import {
  loadMarketGeographyManifest,
  loadIntervalPriceHistory,
  MARKET_PRICE_POINTS,
} from "./market-geography";
import {
  collectionPriceChart,
  engineeringChartIds,
  headroomChart,
  marketNames,
  marketTime,
} from "./homepage-model";
import { formatValue } from "./units";
import type { ChartDefinition, LoadedSeries, TimeState } from "./types";
import "./overview.css";

const definition = (id: string) => chartDefinitions.find((chart) => chart.id === id)!;
const pointFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("overviewPoint") ?? params.get("marketPoint")?.split("--")[0] ?? "HB_HOUSTON";
};
const fuelChart = {
  ...definition("fuel-mix"),
  title: "Generation composition · selected fuels",
  description:
    "Selected reported categories; not total system generation. Signed storage is shown separately. Missing observations remain gaps.",
  series: definition("fuel-mix").series.filter((series) => series.id !== "power-storage"),
};
const storageChart: ChartDefinition = { ...definition("storage"), zeroCentered: true };
delete storageChart.interpretation;

function TimeReadings({
  seriesData,
  time,
  selected,
  evidence = false,
}: {
  seriesData: Map<string, LoadedSeries>;
  time: TimeState;
  selected: string;
  evidence?: boolean;
}) {
  const [cursor, setCursor] = useState(chartCoordinator.snapshot());
  useEffect(() => {
    const unsubscribe = chartCoordinator.subscribe((timestamp, pinned) =>
      setCursor({ timestamp, pinned }),
    );
    return () => {
      unsubscribe();
    };
  }, []);
  const readingTime = cursor.timestamp ?? time.end;
  const readings = [
    ["Demand", "supply-demand:demand", "MW"],
    ["Derived headroom", "overview-headroom:headroom", "MW"],
    ["Reported PRC", "overview-headroom:prc", "MW"],
    [marketNames[selected] ?? selected, "pricing:interval", "$/MWh"],
    ["Frequency", "frequency:frequency", "Hz"],
  ] as const;
  return evidence ? (
    <details className="homepage-engineering">
      <summary>Cursor evidence · observation times, ages &amp; resolution</summary>
      <p className="homepage-chart-note">
        {marketTime(readingTime)} · * marks aggregate or unknown resolution. Bucket width does not
        prove native coverage. No request is made when moving the cursor. Arrow keys move the
        cursor; Enter pins the range; Escape clears without resuming live.
      </p>
      <dl>
        {readings.map(([label, key, unit]) => {
          const loaded = seriesData.get(key);
          const [chartId, seriesId] = key.split(":");
          const series =
            chartDefinitions
              .find((item) => item.id === chartId)
              ?.series.find((item) => item.id === seriesId) ??
            headroomChart.series.find((item) => item.id === seriesId);
          const point = observationAt(
            loaded,
            readingTime,
            key === "pricing:interval"
              ? intervalPriceTemporalPolicy
              : series
                ? temporalPolicy(chartId!, series)
                : undefined,
          );
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {point
                  ? `${formatValue(point.value, unit)} · ${marketTime(point.ts)} · ${key === "pricing:interval" ? seriesIntervalLabel(loaded, point.ts) : `${Math.round(readingTime - point.ts)}s old`} · ${point.resolution} · ${point.coverage} coverage · ${loaded?.meta.bucket_seconds ?? "unknown"}s bucket`
                  : "No recent compatible observation"}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  ) : (
    <>
      <div className="homepage-readings" aria-label="Time-aligned grid readings">
        {readings.map(([label, key, unit]) => {
          const loaded = seriesData.get(key);
          const [chartId, seriesId] = key.split(":");
          const series =
            chartDefinitions
              .find((item) => item.id === chartId)
              ?.series.find((item) => item.id === seriesId) ??
            headroomChart.series.find((item) => item.id === seriesId);
          const point = observationAt(
            loaded,
            readingTime,
            key === "pricing:interval"
              ? intervalPriceTemporalPolicy
              : series
                ? temporalPolicy(chartId!, series)
                : undefined,
          );
          return (
            <div
              key={key}
              tabIndex={0}
              title={
                point
                  ? key === "pricing:interval"
                    ? seriesIntervalLabel(loaded, point.ts)
                    : `${point.resolution === "native" ? "Observation" : `${point.resolution} resolution · ${point.coverage} coverage`}: ${marketTime(point.ts)} · age ${Math.round(readingTime - point.ts)} seconds`
                  : "No recent compatible observation"
              }
            >
              <span>
                {label}
                {unit === "$/MWh" ? (
                  <span className="homepage-mobile-price-unit"> · $/MWh</span>
                ) : null}
              </span>
              <strong>
                {point ? (
                  <>
                    {unit === "$/MWh" ? (
                      <>
                        {formatValue(point.value, unit).split("/")[0]}
                        <span className="homepage-desktop-price-unit">/MWh</span>
                      </>
                    ) : (
                      formatValue(point.value, unit)
                    )}
                    {point.resolution !== "native" ? "*" : ""}
                  </>
                ) : (
                  "—"
                )}
              </strong>
              <small>
                {point
                  ? `${point.aggregate ? "Bucket · " : ""}${marketTime(point.ts)}`
                  : "No recent observation"}
              </small>
            </div>
          );
        })}
      </div>
      {cursor.pinned ? (
        <button className="homepage-clear-pin" onClick={() => chartCoordinator.clearPin()}>
          Clear pin
        </button>
      ) : null}
    </>
  );
}

export function OverviewCharts({
  renderChart,
  seriesData,
  time,
}: {
  renderChart: (
    chart: ChartDefinition,
    presentation: "overview",
    override?: Map<string, LoadedSeries>,
  ) => ReactNode;
  seriesData: Map<string, LoadedSeries>;
  time: TimeState;
}) {
  const [engineering, setEngineering] = useState(false);
  const [selected, setSelected] = useState(pointFromUrl);
  useEffect(() => {
    const restore = () => setSelected(pointFromUrl());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const selectPoint = (point: string) => {
    setSelected(point);
    const url = new URL(window.location.href);
    url.searchParams.set("overviewPoint", point);
    window.history.pushState(null, "", url);
  };
  const {
    data: ranking,
    error: rankingError,
    isLoading,
  } = useSWR("overview-interval-price-ranking", () => loadMarketGeographyManifest(), {
    refreshInterval: time.mode === "live" ? 300_000 : 0,
    revalidateOnFocus: false,
  });
  const coherent = [...(ranking?.settlement_interval.rows ?? [])].sort(
    (a, b) => b.value - a.value || a.settlement_point.localeCompare(b.settlement_point),
  );
  const newest = ranking?.settlement_interval.target_ts ?? 0;
  const pointType = MARKET_PRICE_POINTS.find(([point]) => point === selected)?.[1];
  const history = useSWR(
    pointType ? ["overview-interval-history", selected, pointType, time.start, time.end] : null,
    () => loadIntervalPriceHistory(`${selected}--${pointType}`, time.start, time.end),
    {
      keepPreviousData: false,
      revalidateOnFocus: false,
      refreshInterval: time.mode === "live" ? 300000 : 0,
    },
  );
  const headroomCoverage = seriesData.get("overview-headroom:headroom")?.meta.pairing;
  const pricingChart = useMemo(
    () => ({
      ...definition("pricing"),
      title: `${marketNames[selected] ?? selected} · NP6-905 settlement price`,
      sourceId: "ercot_mis_np6_905",
      sourceUrl: "https://www.ercot.com/mp/data-products/data-product-details?id=NP6-905-CD",
      description:
        "Exact selected point and type, 15-minute delivery interval ending; latest published corrections, not an as-known replay. Legacy collection snapshots remain independent.",
      series: [
        {
          id: "interval",
          label: marketNames[selected] ?? selected,
          color: "#60a5fa",
          temporal: intervalPriceTemporalPolicy,
        },
      ],
    }),
    [selected],
  );
  const collectionSeries = new Map(seriesData);
  for (const series of collectionPriceChart.series) {
    const loaded = seriesData.get(`pricing:${series.id}`);
    if (loaded) collectionSeries.set(`pricing-collection:${series.id}`, loaded);
  }
  const displaySeries = new Map(seriesData);
  displaySeries.set(
    "pricing:interval",
    intervalPriceSeries(history.data ?? [], time.start, time.end, Boolean(history.error)),
  );
  return (
    <section className="homepage-workspace" aria-label="Grid charts">
      <TimeReadings seriesData={displaySeries} time={time} selected={selected} />
      <div className="homepage-chart-grid">
        <div className="homepage-wide">
          {renderChart(definition("supply-demand"), "overview")}
          <p className="homepage-chart-note">
            Historical forecast: latest archived MW publication issued before each delivery hour.
            Official issue time does not prove this system knew it then. Future outlook is separate.
            {seriesData.get("supply-demand:forecast-demand")?.error
              ? ` ${seriesData.get("supply-demand:forecast-demand")?.error}.`
              : ""}
          </p>
        </div>
        <div className="homepage-narrow">
          {renderChart(headroomChart, "overview")}
          {headroomCoverage ? (
            <p className="homepage-chart-note">
              {headroomCoverage.paired_count} paired observations of{" "}
              {headroomCoverage.expected_count} nominal sample slots at five-minute cadence. Missing
              contributors remain gaps; first collection time is unavailable. Coverage describes
              retained observations, not complete ERCOT history.
            </p>
          ) : null}
        </div>
        <div className="homepage-wide">{renderChart(fuelChart, "overview")}</div>
        <div className="homepage-narrow">{renderChart(storageChart, "overview")}</div>
        <section className="homepage-narrow homepage-ranking" aria-label="Settlement price ranking">
          <h3>Settlement price snapshots</h3>
          <p>
            NP6-905-CD · latest completed delivery interval · $/MWh. Ranking is independent of the
            historical chart window; latest published corrections are not an as-known replay.
          </p>
          <label className="homepage-price-select">
            History point
            <select value={selected} onChange={(event) => selectPoint(event.target.value)}>
              {MARKET_PRICE_POINTS.map(([id]) => (
                <option key={id} value={id}>
                  {marketNames[id] ?? id}
                </option>
              ))}
              {!MARKET_PRICE_POINTS.some(([point]) => point === selected) ? (
                <option value={selected}>{selected} · history unavailable</option>
              ) : null}
            </select>
          </label>
          {coherent.length && !coherent.some((row) => row.settlement_point === selected) ? (
            <small>Selected point is outside this returned ranking subset.</small>
          ) : null}
          {coherent.length ? (
            <>
              <small>
                {marketTime(newest)}
                {Date.now() / 1000 - newest > 1800 ? " · stale" : ""}. {coherent.length} of{" "}
                {MARKET_PRICE_POINTS.length} configured hub/load-zone points share this delivery
                interval.
              </small>
              <table>
                <thead>
                  <tr>
                    <th>Price point</th>
                    <th>$/MWh</th>
                  </tr>
                </thead>
                <tbody>
                  {coherent.map((row) => {
                    const point = row.settlement_point;
                    return (
                      <tr key={point} aria-selected={selected === point}>
                        <td>
                          <button onClick={() => selectPoint(point)}>
                            {marketNames[point] ?? point}
                          </button>
                        </td>
                        <td
                          title={`${marketTime(row.target_ts - 900)} – ${marketTime(row.target_ts)} · issue ${row.publication ? marketTime(row.publication.issued_at) : "unknown"} · retrieved ${row.publication ? marketTime(row.publication.retrieved_at) : "unknown"}`}
                        >
                          {row.value.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <p role="status">
              {isLoading
                ? "Loading price points…"
                : rankingError || ranking?.settlement_interval.state === "unavailable"
                  ? "Settlement source unavailable. Core collection history remains independent."
                  : "No settlement prices reported."}
            </p>
          )}
        </section>
        <div className="homepage-wide">
          {pointType ? (
            renderChart(pricingChart, "overview", displaySeries)
          ) : (
            <section className="homepage-ranking">
              <h3>{selected} history</h3>
              <p>
                Interval history is unsupported for this price point. No other point is substituted.
              </p>
            </section>
          )}
        </div>
        <div className="homepage-full">
          {renderChart(collectionPriceChart, "overview", collectionSeries)}
        </div>
        <div className="homepage-full homepage-frequency">
          {renderChart(definition("frequency"), "overview")}
        </div>
      </div>
      <TimeReadings seriesData={displaySeries} time={time} selected={selected} evidence />
      <details
        className="homepage-engineering"
        onToggle={(event) => setEngineering(event.currentTarget.open)}
      >
        <summary>Engineering details · reserves, DC ties, time error &amp; inertia</summary>
        {engineering ? (
          <div className="homepage-chart-grid">
            {chartDefinitions
              .filter((chart) => engineeringChartIds.has(chart.id))
              .map((chart) => (
                <div className="homepage-half" key={chart.id}>
                  {renderChart(chart, "overview")}
                </div>
              ))}
          </div>
        ) : null}
      </details>
    </section>
  );
}
