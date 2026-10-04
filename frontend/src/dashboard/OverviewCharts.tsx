import { observationAt, temporalPolicy } from "./series-temporal-policy";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { chartDefinitions } from "./chart-config";
import { chartCoordinator } from "./chart-coordinator";
import { loadPriceRanking } from "./api";
import {
  engineeringChartIds,
  headroomChart,
  marketNames,
  marketSeries,
  marketTime,
  coherentPriceSnapshots,
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
  const priceSeries = marketSeries[selected];
  const readingTime = cursor.timestamp ?? time.end;
  const readings = [
    ["Demand", "supply-demand:demand", "MW"],
    ["Derived headroom", "overview-headroom:headroom", "MW"],
    ["Reported PRC", "overview-headroom:prc", "MW"],
    [marketNames[selected] ?? selected, `pricing:${priceSeries}`, "$/MWh"],
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
            series ? temporalPolicy(chartId!, series) : undefined,
          );
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {point
                  ? `${formatValue(point.value, unit)} · ${marketTime(point.ts)} · ${Math.round(readingTime - point.ts)}s old · ${point.resolution} · ${point.coverage} coverage · ${loaded?.meta.bucket_seconds ?? "unknown"}s bucket`
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
            series ? temporalPolicy(chartId!, series) : undefined,
          );
          return (
            <div
              key={key}
              tabIndex={0}
              title={
                point
                  ? `${point.resolution === "native" ? "Observation" : `${point.resolution} resolution · ${point.coverage} coverage`}: ${marketTime(point.ts)} · age ${Math.round(readingTime - point.ts)} seconds`
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
  renderChart: (chart: ChartDefinition, presentation: "overview") => ReactNode;
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
    window.history.replaceState(null, "", url);
  };
  const {
    data: ranking,
    error: rankingError,
    isLoading,
  } = useSWR("overview-price-ranking", () => loadPriceRanking(), {
    refreshInterval: time.mode === "live" ? 300_000 : 0,
    revalidateOnFocus: false,
  });
  const coherent = coherentPriceSnapshots(ranking ?? [], Date.now() / 1000);
  const newest = coherent[0]?.ts ?? 0;
  const headroomCoverage = seriesData.get("overview-headroom:headroom")?.meta.pairing;
  const priceSeries = marketSeries[selected];
  const pricingChart = useMemo(
    () => ({
      ...definition("pricing"),
      title: `${marketNames[selected] ?? selected} · settlement price`,
      series: definition("pricing").series.filter((series) => series.id === priceSeries),
    }),
    [selected, priceSeries],
  );
  return (
    <section className="homepage-workspace" aria-label="Grid charts">
      <TimeReadings seriesData={seriesData} time={time} selected={selected} />
      <div className="homepage-chart-grid">
        <div className="homepage-wide">{renderChart(definition("supply-demand"), "overview")}</div>
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
          <p>Latest collection · $/MWh. Source interval is not retained by this feed.</p>
          <label className="homepage-price-select">
            History point
            <select value={selected} onChange={(event) => selectPoint(event.target.value)}>
              {Object.entries(marketNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {!marketNames[selected] ? (
                <option value={selected}>{selected} · history unavailable</option>
              ) : null}
            </select>
          </label>
          {coherent.length && !coherent.some((row) => row.tag === `ercot_region:${selected}`) ? (
            <small>Selected point is outside this returned ranking subset.</small>
          ) : null}
          {coherent.length ? (
            <>
              <small>
                {marketTime(newest)}
                {Date.now() / 1000 - newest > 1800 ? " · stale" : ""}. {coherent.length} of{" "}
                {(ranking ?? []).length} returned points share this collection time.
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
                    const point = row.tag.replace(/^ercot_region:/, "");
                    return (
                      <tr key={point} aria-selected={selected === point}>
                        <td>
                          <button onClick={() => selectPoint(point)}>
                            {marketNames[point] ?? point}
                          </button>
                        </td>
                        <td>{row.value.toFixed(2)}</td>
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
                : rankingError
                  ? "Price ranking unavailable. Historical series remain independent."
                  : "No settlement prices reported."}
            </p>
          )}
        </section>
        <div className="homepage-wide">
          {priceSeries ? (
            renderChart(pricingChart, "overview")
          ) : (
            <section className="homepage-ranking">
              <h3>{selected} history</h3>
              <p>
                No configured historical series for this price point. Select Houston, North, or West
                to view their histories.
              </p>
            </section>
          )}
        </div>
        <div className="homepage-full homepage-frequency">
          {renderChart(definition("frequency"), "overview")}
        </div>
      </div>
      <TimeReadings seriesData={seriesData} time={time} selected={selected} evidence />
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
