import { useEffect, useMemo, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useTexasGridManifest, useTexasGridResource } from "./data-hooks";
import type {
  TexasGridGisResource,
  TexasGridLtlfResource,
  TexasGridResource,
  TexasGridStream,
  TexasGridTrendResource,
} from "./texas-grid-long-horizon";

const STREAM_PARAM = "grid_resource";
const STREAMS = new Set<TexasGridStream>([
  "gis",
  "resource_capacity_trend",
  "long_term_load_forecast",
]);

function streamFromUrl(): TexasGridStream | null {
  const value = new URL(window.location.href).searchParams.get(STREAM_PARAM) as TexasGridStream;
  return STREAMS.has(value) ? value : null;
}

function timestamp(value: number): string {
  return new Date(value * 1_000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  });
}

function mw(value: number | null): string {
  return value === null ? "Source column absent" : `${value.toLocaleString("en-US")} MW`;
}

function setCanonicalStream(stream: TexasGridStream | null): void {
  const url = new URL(window.location.href);
  if (stream) url.searchParams.set(STREAM_PARAM, stream);
  else url.searchParams.delete(STREAM_PARAM);
  window.history.pushState(null, "", url);
}

function GisEvidence({ resource }: { resource: TexasGridGisResource }) {
  const phaseLabels = useMemo(
    () => new Map(resource.phases.map((phase) => [phase.id, phase.label])),
    [resource.phases],
  );
  const fuelLabels = useMemo(
    () =>
      new Map(
        resource.fuels.map((fuel) => [
          {
            BIO: "biomass",
            COA: "coal",
            GAS: "gas",
            GEO: "geothermal",
            HYD: "hydrogen",
            NUC: "nuclear",
            OIL: "fuel_oil",
            OTH: "other",
            PET: "petcoke",
            SOL: "solar",
            WAT: "water",
            WIN: "wind",
          }[fuel.code]!,
          fuel.label,
        ]),
      ),
    [resource.fuels],
  );
  return (
    <section aria-labelledby="texas-grid-gis-title" className="texas-grid-resource">
      <header>
        <div>
          <p className="eyebrow">Official ERCOT monthly planning snapshot</p>
          <h3 id="texas-grid-gis-title">Generator interconnection study aggregates</h3>
          <p>
            Project-row counts and signed source capacity sums by official study phase and fuel.
            Negative MW can reflect repowering net-change adjustments. These values are not
            installed or committed capacity and do not establish additions or retirements.
          </p>
        </div>
        <a href={resource.publication.source_page_url} rel="noreferrer" target="_blank">
          Open official GIS source
        </a>
      </header>
      <p>
        Source period {resource.publication.source_period} · published{" "}
        {timestamp(resource.publication.published_at)}
      </p>
      <div
        aria-label="Exact generator interconnection aggregate evidence"
        className="table-scroll texas-grid-table"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Official study phase</th>
              <th>Fuel</th>
              <th>Project-row count</th>
              <th>Signed source capacity sum</th>
            </tr>
          </thead>
          <tbody>
            {resource.aggregates.map((row) => (
              <tr key={`${row.phase}:${row.fuel}`}>
                <td>{phaseLabels.get(row.phase)}</td>
                <td>{fuelLabels.get(row.fuel)}</td>
                <td>{row.count.toLocaleString("en-US")}</td>
                <td>{mw(row.capacity_mw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrendEvidence({ resource }: { resource: TexasGridTrendResource }) {
  const [seriesId, setSeriesId] =
    useState<TexasGridTrendResource["series"][number]["series_id"]>("wind");
  const series = resource.series.find((item) => item.series_id === seriesId)!;
  return (
    <section aria-labelledby="texas-grid-trend-title" className="texas-grid-resource">
      <header>
        <div>
          <p className="eyebrow">Official ERCOT capacity trend</p>
          <h3 id="texas-grid-trend-title">Resource capacity trend</h3>
          <p>
            Operational capacity and source-defined planned/studied categories remain separate. The
            official total is displayed as a source total and is never added to or stacked with its
            component categories. Planning values are not commitments or realization forecasts.
          </p>
        </div>
        <a href={resource.publication.source_page_url} rel="noreferrer" target="_blank">
          Open official capacity source
        </a>
      </header>
      <p>
        Source period {resource.publication.source_period} · published{" "}
        {timestamp(resource.publication.published_at)}
      </p>
      <div aria-label="Capacity trend series" className="texas-grid-series-picker">
        {resource.series.map((item) => (
          <button
            aria-pressed={seriesId === item.series_id}
            key={item.series_id}
            onClick={() => setSeriesId(item.series_id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        aria-label={`${series.label} exact resource capacity trend evidence`}
        className="table-scroll texas-grid-table"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Cadence</th>
              <th>Period</th>
              <th>Official total</th>
              <th>Operational</th>
              <th>IA + financial security</th>
              <th>IA + no financial security</th>
              <th>Other planned</th>
              <th>Small generator</th>
            </tr>
          </thead>
          <tbody>
            {series.annual.map((row) => (
              <tr key={`annual:${String(row.year)}`}>
                <td>Annual</td>
                <td>{row.year}</td>
                <td>{mw(row.official_total_mw)}</td>
                <td>{mw(row.operational_mw)}</td>
                <td>{mw(row.ia_financial_security_posted_mw)}</td>
                <td>{mw(row.ia_no_financial_security_mw)}</td>
                <td>{mw(row.other_planned_mw)}</td>
                <td>{mw(row.small_generator_mw)}</td>
              </tr>
            ))}
            {series.planned_monthly.map((row) => (
              <tr key={`monthly:${row.month}`}>
                <td>Planned monthly</td>
                <td>{row.month}</td>
                <td>{mw(row.official_total_mw)}</td>
                <td>{mw(row.operational_mw)}</td>
                <td>{mw(row.ia_financial_security_posted_mw)}</td>
                <td>{mw(row.ia_no_financial_security_mw)}</td>
                <td>{mw(row.other_planned_mw)}</td>
                <td>{mw(row.small_generator_mw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LtlfEvidence({ resource }: { resource: TexasGridLtlfResource }) {
  const [scenarioId, setScenarioId] =
    useState<TexasGridLtlfResource["scenarios"][number]["scenario_id"]>("ercot_adjusted");
  const scenario = resource.scenarios.find((item) => item.scenario_id === scenarioId)!;
  return (
    <section aria-labelledby="texas-grid-ltlf-title" className="texas-grid-resource">
      <header>
        <div>
          <p className="eyebrow">Official ERCOT long-term forecast</p>
          <h3 id="texas-grid-ltlf-title">Monthly peak demand and energy forecast</h3>
          <p>
            Calendar-month peak values are MW and energy values are MWh. The units are bound to
            Appendix A of the official methodology report. These scenarios include documented
            large-load assumptions; they are forecasts, not public project status records or
            realization guarantees.
          </p>
        </div>
        <a href={resource.publication.source_page_url} rel="noreferrer" target="_blank">
          Open official forecast source
        </a>
      </header>
      <p>
        Source period {resource.publication.source_period} · published{" "}
        {timestamp(resource.publication.published_at)}
      </p>
      <div aria-label="Long-term load forecast scenario" className="texas-grid-series-picker">
        {resource.scenarios.map((item) => (
          <button
            aria-pressed={scenarioId === item.scenario_id}
            key={item.scenario_id}
            onClick={() => setScenarioId(item.scenario_id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        aria-label={`${scenario.label} exact long-term load forecast evidence`}
        className="table-scroll texas-grid-table"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th>Monthly peak</th>
              <th>Monthly energy</th>
            </tr>
          </thead>
          <tbody>
            {scenario.rows.map((row) => (
              <tr key={row.month}>
                <td>{row.month}</td>
                <td>{mw(row.monthly_peak_mw)}</td>
                <td>{row.monthly_energy_mwh.toLocaleString("en-US")} MWh</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ResourceEvidence({ resource }: { resource: TexasGridResource }) {
  if (resource.stream === "gis") return <GisEvidence resource={resource} />;
  if (resource.stream === "long_term_load_forecast") return <LtlfEvidence resource={resource} />;
  return <TrendEvidence resource={resource} />;
}

export function TexasGridView({ enabled }: { enabled: boolean }) {
  const [selectedStream, setSelectedStream] = useState<TexasGridStream | null>(streamFromUrl);
  const manifest = useTexasGridManifest(enabled);
  const selectedResource =
    selectedStream === "gis"
      ? (manifest.data?.generator_interconnection.selected ?? null)
      : selectedStream === "resource_capacity_trend"
        ? (manifest.data?.resource_capacity_trend.selected ?? null)
        : selectedStream === "long_term_load_forecast"
          ? (manifest.data?.long_term_load_forecast.selected ?? null)
          : null;
  const resource = useTexasGridResource(enabled && selectedStream !== null, selectedResource);

  useEffect(() => {
    if (!enabled) return;
    const initial = new URL(window.location.href);
    if (initial.searchParams.has(STREAM_PARAM) && streamFromUrl() === null) {
      initial.searchParams.delete(STREAM_PARAM);
      window.history.replaceState(null, "", initial);
    }
    const restore = () => setSelectedStream(streamFromUrl());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [enabled]);

  const choose = (stream: TexasGridStream | null) => {
    setCanonicalStream(stream);
    setSelectedStream(stream);
  };

  if (!enabled) return null;
  return (
    <section aria-label="Texas Grid long-horizon evidence" className="texas-grid-view">
      <div className="texas-grid-policy" role="note">
        <strong>Planning snapshots, not operating capacity or realization forecasts</strong>
        <span>
          Official monthly reports preserve operational, planned, and studied distinctions. The
          dashboard does not infer commitments, construction, additions, retirements, or future
          load.
        </span>
      </div>

      {manifest.isLoading && !manifest.data ? <DataLifecycleMessage state="loading" /> : null}
      {manifest.error && !manifest.data ? <DataLifecycleMessage state="unavailable" /> : null}
      {manifest.error && manifest.data ? (
        <p role="status">Refresh failed; showing the last successful Texas Grid manifest.</p>
      ) : null}

      {manifest.data ? (
        <>
          <div aria-label="Long-horizon evidence families" className="texas-grid-family-grid">
            <article>
              <span>{manifest.data.generator_interconnection.state}</span>
              <h3>Generator interconnection status</h3>
              <p>Official study-phase and fuel aggregates. No project rows or identities.</p>
              <Button
                aria-pressed={selectedStream === "gis"}
                disabled={!manifest.data.generator_interconnection.selected}
                onClick={() => choose(selectedStream === "gis" ? null : "gis")}
              >
                {selectedStream === "gis"
                  ? "Close interconnection history"
                  : "Open interconnection history"}
              </Button>
            </article>
            <article>
              <span>{manifest.data.resource_capacity_trend.state}</span>
              <h3>Resource capacity trend</h3>
              <p>Official total, operational, planned, studied, and small-generator values.</p>
              <Button
                aria-pressed={selectedStream === "resource_capacity_trend"}
                disabled={!manifest.data.resource_capacity_trend.selected}
                onClick={() =>
                  choose(
                    selectedStream === "resource_capacity_trend" ? null : "resource_capacity_trend",
                  )
                }
              >
                {selectedStream === "resource_capacity_trend"
                  ? "Close capacity history"
                  : "Open capacity history"}
              </Button>
            </article>
            <article>
              <span>{manifest.data.long_term_load_forecast.state}</span>
              <h3>Long-term load forecast</h3>
              <p>Official monthly peak MW and energy MWh for two documented forecast scenarios.</p>
              <Button
                aria-pressed={selectedStream === "long_term_load_forecast"}
                disabled={!manifest.data.long_term_load_forecast.selected}
                onClick={() =>
                  choose(
                    selectedStream === "long_term_load_forecast" ? null : "long_term_load_forecast",
                  )
                }
              >
                {selectedStream === "long_term_load_forecast"
                  ? "Close load forecast"
                  : "Open load forecast"}
              </Button>
            </article>
          </div>

          <section aria-labelledby="texas-grid-unavailable-title">
            <h3 id="texas-grid-unavailable-title">Evidence not yet supported</h3>
            <div className="texas-grid-unavailable-grid">
              <article>
                <strong>Large-load project status</strong>
                <span>
                  Forecast methodology context is available in the LTLF evidence. Individual project
                  categories and status remain unavailable because no stable public machine-readable
                  status dataset is verified.
                </span>
              </article>
              <article>
                <strong>Gross retirements</strong>
                <span>Unavailable: no verified gross-retirement source is available.</span>
              </article>
            </div>
          </section>

          {selectedStream && !selectedResource ? (
            <p role="status">
              The selected evidence family is unavailable; no history request was made.
            </p>
          ) : null}
          {resource.isLoading && !resource.data ? <DataLifecycleMessage state="loading" /> : null}
          {resource.error && !resource.data ? <DataLifecycleMessage state="unavailable" /> : null}
          {resource.error && resource.data ? (
            <p role="status">Refresh failed; showing the selected immutable history resource.</p>
          ) : null}
          {resource.data ? <ResourceEvidence resource={resource.data} /> : null}

          <details>
            <summary>Source collection and materialization health</summary>
            <div
              aria-label="Exact Texas Grid source health"
              className="table-scroll texas-grid-table"
              role="region"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Collection</th>
                    <th>Availability</th>
                    <th>Materialization</th>
                    <th>Source updated</th>
                    <th>Retrieved</th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.data.source_health.map((row) => (
                    <tr key={row.source_id}>
                      <td>{row.source_id}</td>
                      <td>{row.state}</td>
                      <td>{row.availability_status ?? "not reported"}</td>
                      <td>{row.materialization.state}</td>
                      <td>
                        {row.source_updated_at === null
                          ? "Unavailable"
                          : timestamp(row.source_updated_at)}
                      </td>
                      <td>
                        {row.retrieved_at === null ? "Unavailable" : timestamp(row.retrieved_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}
