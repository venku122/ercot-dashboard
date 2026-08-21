import { useEffect, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useExternalContextManifest, useExternalContextResource } from "./data-hooks";
import type {
  EgridResource,
  Eia930Resource,
  ExternalContextManifest,
  ExternalContextResource,
  ExternalContextSelected,
  ExternalContextStream,
  HenryHubResource,
} from "./external-context";

const SOURCE_PARAM = "context_source";
const STREAMS = new Set<ExternalContextStream>(["eia930_demand", "henry_hub_daily", "epa_egrid"]);

function streamFromUrl(): ExternalContextStream | null {
  const value = new URL(window.location.href).searchParams.get(
    SOURCE_PARAM,
  ) as ExternalContextStream;
  return STREAMS.has(value) ? value : null;
}

function setCanonicalStream(stream: ExternalContextStream | null): void {
  const url = new URL(window.location.href);
  if (stream) url.searchParams.set(SOURCE_PARAM, stream);
  else url.searchParams.delete(SOURCE_PARAM);
  window.history.pushState(null, "", url);
}

function utc(value: number): string {
  return new Date(value * 1_000).toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    timeZoneName: "short",
    year: "numeric",
  });
}

function selectedFor(
  manifest: ExternalContextManifest | undefined,
  stream: ExternalContextStream | null,
): ExternalContextSelected | null {
  if (!manifest || !stream) return null;
  if (stream === "eia930_demand") return manifest.eia_930.selected;
  if (stream === "henry_hub_daily") return manifest.natural_gas.selected;
  return manifest.epa_egrid.selected;
}

function Eia930Evidence({ resource }: { resource: Eia930Resource }) {
  return (
    <section aria-labelledby="external-eia930-title" className="external-context-resource">
      <header>
        <div>
          <p className="eyebrow">Delayed preliminary EIA cross-check</p>
          <h3 id="external-eia930-title">EIA-930 ERCO demand and total interchange</h3>
          <p>
            One-hour energy observations in MWh, labeled by hour ending UTC. They are not
            instantaneous ERCOT MW and do not replace or validate ERCOT operational feeds. Positive
            total interchange means EIA net export/outflow; negative means net import/inflow.
          </p>
        </div>
        <a href={resource.publication.source_url} rel="noreferrer" target="_blank">
          Open keyless EIA route
        </a>
      </header>
      <p>Retrieved {utc(resource.publication.retrieved_at)}</p>
      <div
        aria-label="Exact EIA-930 hourly context evidence"
        className="external-context-table table-scroll"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Source period</th>
              <th>UTC interval</th>
              <th>Observation</th>
              <th>Source value</th>
              <th>Interpretation</th>
            </tr>
          </thead>
          <tbody>
            {resource.rows.map((row) => (
              <tr key={`${row.period}:${row.type}`}>
                <td>{row.period}</td>
                <td>
                  {utc(row.interval_start)} – {utc(row.interval_end)}
                </td>
                <td>{row.type_name}</td>
                <td>{row.value_decimal} MWh</td>
                <td>
                  {row.type === "TI"
                    ? row.value_mwh > 0
                      ? "Net export / outflow"
                      : row.value_mwh < 0
                        ? "Net import / inflow"
                        : "Zero reported net interchange"
                    : "Reported hourly energy demand"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HenryHubEvidence({ resource }: { resource: HenryHubResource }) {
  return (
    <section aria-labelledby="external-henry-title" className="external-context-resource">
      <header>
        <div>
          <p className="eyebrow">Daily natural-gas market context</p>
          <h3 id="external-henry-title">Henry Hub natural gas spot price</h3>
          <p>
            Source market dates have no time of day or timezone. Missing weekends and holidays are
            gaps, not zero or forward-filled values. Display-window overlap with ERCOT observations
            does not establish same-hour causality.
          </p>
        </div>
        <a href={resource.publication.source_page_url} rel="noreferrer" target="_blank">
          Open official EIA history
        </a>
      </header>
      <p>Retrieved {utc(resource.publication.retrieved_at)}</p>
      <div
        aria-label="Exact Henry Hub daily spot-price evidence"
        className="external-context-table table-scroll"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Source market date</th>
              <th>Source value</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {resource.rows.map((row) => (
              <tr key={row.market_date}>
                <td>{row.market_date}</td>
                <td>{row.value_decimal}</td>
                <td>USD per MMBtu</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EgridEvidence({ resource }: { resource: EgridResource }) {
  return (
    <section aria-labelledby="external-egrid-title" className="external-context-resource">
      <header>
        <div>
          <p className="eyebrow">Retrospective annual EPA methodology context</p>
          <h3 id="external-egrid-title">eGRID ERCT total-output emission rates</h3>
          <p>
            Source-published annual average rates for ERCOT All. They are not current or marginal
            emissions, generator-specific rates, or ERCOT-wide mass emissions. The dashboard does
            not multiply these rates by live demand or generation.
          </p>
        </div>
        <a href={resource.publication.source_page_url} rel="noreferrer" target="_blank">
          Open EPA eGRID source
        </a>
      </header>
      <p>
        Data year {resource.publication.data_year} · revision {resource.publication.revision} ·
        released {resource.publication.released_on} · {resource.subregion} /{" "}
        {resource.subregion_name}
      </p>
      <div
        aria-label="Exact eGRID ERCT annual rate evidence"
        className="external-context-table table-scroll"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Metric ID</th>
              <th>Exact source header</th>
              <th>Annual average rate</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {resource.rates.map((rate) => (
              <tr key={rate.metric_id}>
                <td>{rate.metric_id}</td>
                <td>{rate.source_header}</td>
                <td>{rate.value.toLocaleString("en-US")}</td>
                <td>lb/MWh</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Exact eGRID publication identity</summary>
        <dl className="external-context-provenance">
          <div>
            <dt>Workbook SHA-256</dt>
            <dd>{resource.publication.workbook_sha256}</dd>
          </div>
          <div>
            <dt>Table</dt>
            <dd>{resource.publication.table_title}</dd>
          </div>
          <div>
            <dt>Production model</dt>
            <dd>{resource.publication.production_model ?? "Not present in workbook"}</dd>
          </div>
          <div>
            <dt>Production version</dt>
            <dd>{resource.publication.production_version ?? "Not present in workbook"}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function ResourceEvidence({ resource }: { resource: ExternalContextResource }) {
  if (resource.stream === "eia930_demand") return <Eia930Evidence resource={resource} />;
  if (resource.stream === "henry_hub_daily") return <HenryHubEvidence resource={resource} />;
  return <EgridEvidence resource={resource} />;
}

function stateCopy(state: string, reason: string | null, freshness: string | null): string {
  if (state === "available") {
    return freshness === "stale" ? "Available · source is stale" : "Available";
  }
  if (state === "disabled" && reason === "eia_api_key_not_configured") {
    return "Disabled · individual EIA API key not configured";
  }
  if (state === "failed") return `Failed · ${reason ?? "latest enabled source attempt failed"}`;
  return `Unavailable · ${reason ?? "source contract is not available"}`;
}

export function ExternalContextView({ enabled }: { enabled: boolean }) {
  const [selectedStream, setSelectedStream] = useState<ExternalContextStream | null>(streamFromUrl);
  const manifest = useExternalContextManifest(enabled);
  const selected = selectedFor(manifest.data, selectedStream);
  const resource = useExternalContextResource(enabled, selectedStream, selected);

  useEffect(() => {
    if (!enabled) return;
    const initial = new URL(window.location.href);
    if (initial.searchParams.has(SOURCE_PARAM) && streamFromUrl() === null) {
      initial.searchParams.delete(SOURCE_PARAM);
      window.history.replaceState(null, "", initial);
    }
    const restore = () => setSelectedStream(streamFromUrl());
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [enabled]);

  const choose = (stream: ExternalContextStream) => {
    const next = selectedStream === stream ? null : stream;
    setCanonicalStream(next);
    setSelectedStream(next);
  };

  if (!enabled) return null;
  return (
    <section aria-label="External energy and emissions context" className="external-context-view">
      <div className="external-context-policy" role="note">
        <strong>External context, not ERCOT operational authority or live emissions</strong>
        <span>
          EIA and EPA evidence retains its native cadence, geography, units, and methodology. It
          never replaces an ERCOT operational feed, and temporal overlap does not establish
          causality.
        </span>
      </div>

      {manifest.isLoading && !manifest.data ? <DataLifecycleMessage state="loading" /> : null}
      {manifest.error && !manifest.data ? <DataLifecycleMessage state="unavailable" /> : null}
      {manifest.error && manifest.data ? (
        <p role="status">Refresh failed; showing the last successful external-context manifest.</p>
      ) : null}

      {manifest.data ? (
        <>
          <div aria-label="External context sources" className="external-context-family-grid">
            <article>
              <span>
                {stateCopy(
                  manifest.data.eia_930.state,
                  manifest.data.eia_930.reason,
                  manifest.data.eia_930.freshness,
                )}
              </span>
              <h3>EIA-930 ERCO hourly context</h3>
              <p>Delayed preliminary hourly energy demand and signed total net interchange.</p>
              <Button
                aria-pressed={selectedStream === "eia930_demand"}
                disabled={!manifest.data.eia_930.selected}
                onClick={() => choose("eia930_demand")}
              >
                {selectedStream === "eia930_demand"
                  ? "Close EIA-930 evidence"
                  : "Open EIA-930 evidence"}
              </Button>
            </article>
            <article>
              <span>
                {stateCopy(
                  manifest.data.natural_gas.state,
                  manifest.data.natural_gas.reason,
                  manifest.data.natural_gas.freshness,
                )}
              </span>
              <h3>Henry Hub daily spot price</h3>
              <p>
                Daily source-market-date context without fill, interpolation, or same-hour joins.
              </p>
              <Button
                aria-pressed={selectedStream === "henry_hub_daily"}
                disabled={!manifest.data.natural_gas.selected}
                onClick={() => choose("henry_hub_daily")}
              >
                {selectedStream === "henry_hub_daily"
                  ? "Close natural-gas evidence"
                  : "Open natural-gas evidence"}
              </Button>
            </article>
            <article>
              <span>
                {stateCopy(
                  manifest.data.epa_egrid.state,
                  manifest.data.epa_egrid.reason,
                  manifest.data.epa_egrid.freshness,
                )}
              </span>
              <h3>EPA eGRID annual ERCT rates</h3>
              <p>
                {manifest.data.epa_egrid.selected
                  ? `Data year ${String(manifest.data.epa_egrid.selected.data_year)}, revision ${String(manifest.data.epa_egrid.selected.revision)}.`
                  : "Retrospective annual average output emission-rate methodology."}
              </p>
              <Button
                aria-pressed={selectedStream === "epa_egrid"}
                disabled={!manifest.data.epa_egrid.selected}
                onClick={() => choose("epa_egrid")}
              >
                {selectedStream === "epa_egrid" ? "Close eGRID evidence" : "Open eGRID evidence"}
              </Button>
            </article>
            <article>
              <span>Unavailable</span>
              <h3>EPA CAMD hourly emissions</h3>
              <p>
                ERCOT-footprint and reporting-coverage methodology is not frozen. This is not a
                zero-emissions series, and a credential alone cannot enable it.
              </p>
            </article>
          </div>

          {selectedStream && !selected ? (
            <p role="status">
              The selected source is disabled or unavailable; no resource request was made.
            </p>
          ) : null}
          {resource.isLoading && !resource.data ? <DataLifecycleMessage state="loading" /> : null}
          {resource.error && !resource.data ? <DataLifecycleMessage state="unavailable" /> : null}
          {resource.error && resource.data ? (
            <p role="status">
              Refresh failed; showing the selected immutable external-context resource.
            </p>
          ) : null}
          {resource.data ? <ResourceEvidence resource={resource.data} /> : null}

          <details>
            <summary>Source collection and materialization health</summary>
            <div
              aria-label="Exact external-context source health"
              className="external-context-table table-scroll"
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
                      <td>{row.availability_status}</td>
                      <td>{row.materialization.state}</td>
                      <td>
                        {row.source_updated_at === null
                          ? "Unavailable"
                          : utc(row.source_updated_at)}
                      </td>
                      <td>{row.retrieved_at === null ? "Unavailable" : utc(row.retrieved_at)}</td>
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
