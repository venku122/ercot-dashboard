import { useMemo, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useForecastQuality, useForecastQualityResource } from "./data-hooks";
import {
  FORECAST_QUALITY_HORIZONS,
  FORECAST_QUALITY_SERIES,
  type ForecastQualityHorizon,
  type ForecastQualitySeriesKey,
} from "./forecast-quality";
import { formatValue } from "./units";

const SERIES_LABELS: Record<ForecastQualitySeriesKey, string> = {
  "load.system": "System load",
  "wind.stwpf": "Wind STWPF",
  "solar.stppf": "Solar STPPF",
};

const HORIZON_LABELS: Record<ForecastQualityHorizon, string> = {
  "1h": "1-hour ahead",
  "6h": "6-hour ahead",
  "24h": "24-hour ahead",
};

function number(value: number | null, unit = "MW") {
  return value === null ? "Unavailable" : formatValue(value, unit);
}

function timestamp(value: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value * 1_000);
}

export function ForecastQualityPanel({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [seriesKey, setSeriesKey] = useState<ForecastQualitySeriesKey>("load.system");
  const [horizon, setHorizon] = useState<ForecastQualityHorizon>("1h");
  const manifest = useForecastQuality(enabled && expanded);
  const summary = manifest.data?.summaries.find(
    (item) => item.series_key === seriesKey && item.horizon === horizon,
  );
  const latestResource = useMemo(() => {
    const matches =
      manifest.data?.resources.filter(
        (item) =>
          item.series_key === seriesKey &&
          item.horizon === horizon &&
          item.day_start + 86_400 <= Math.floor(Date.now() / 1_000),
      ) ?? [];
    return matches.length ? matches[matches.length - 1]! : null;
  }, [horizon, manifest.data, seriesKey]);
  const resource = useForecastQualityResource(
    enabled && expanded && latestResource !== null,
    latestResource,
  );
  const source = manifest.data?.source_contracts.find((item) => item.series_key === seriesKey);
  const unhealthy = source?.health.some(
    (item) =>
      item.availability_status !== "available" ||
      item.consecutive_failures === null ||
      item.consecutive_failures > 0 ||
      item.state !== "healthy",
  );

  return (
    <section aria-labelledby="forecast-quality-title" className="outlook-days-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Historical diagnostics</p>
          <h3 id="forecast-quality-title">Forecast quality</h3>
        </div>
        <Button
          aria-controls="forecast-quality-detail"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide quality details" : "Load quality details"}
        </Button>
      </div>
      <p>
        No history is requested until this panel is opened. Results are diagnostic pairings, not an
        ERCOT performance declaration.
      </p>
      {expanded ? (
        <div id="forecast-quality-detail">
          <fieldset>
            <legend>Forecast series</legend>
            {FORECAST_QUALITY_SERIES.map((key) => (
              <Button aria-pressed={seriesKey === key} key={key} onClick={() => setSeriesKey(key)}>
                {SERIES_LABELS[key]}
              </Button>
            ))}
          </fieldset>
          <fieldset>
            <legend>Evaluation horizon</legend>
            {FORECAST_QUALITY_HORIZONS.map((key) => (
              <Button aria-pressed={horizon === key} key={key} onClick={() => setHorizon(key)}>
                {HORIZON_LABELS[key]}
              </Button>
            ))}
          </fieldset>
          {manifest.error ? (
            <DataLifecycleMessage
              detail="The bounded forecast-quality manifest could not be loaded."
              state="unavailable"
            />
          ) : manifest.data === undefined ? (
            <DataLifecycleMessage state="loading" />
          ) : (
            <>
              {unhealthy ? (
                <p role="status">
                  Source health is stale, failed, empty, or unavailable. Interpret the historical
                  sample cautiously.
                </p>
              ) : null}
              {summary?.availability !== "available" ? (
                <DataLifecycleMessage
                  detail="No materialized quality history is available for this series and horizon."
                  state="unavailable"
                />
              ) : (
                <>
                  {summary.summary.sample_count === 0 ? (
                    <p data-forecast-quality-state="no-pairs" role="status">
                      {(summary.missing_reasons["missing_actual"] ?? 0) > 0
                        ? "No matched actual outcomes are available for this materialized history."
                        : "No eligible forecast vintages are available for this materialized history."}
                    </p>
                  ) : null}
                  <dl className="outlook-summary-grid" aria-label="Forecast quality summary">
                    <div>
                      <dt>Mean absolute error</dt>
                      <dd>{number(summary.summary.mae_mw)}</dd>
                    </div>
                    <div>
                      <dt>Bias</dt>
                      <dd>{number(summary.summary.bias_mw)}</dd>
                    </div>
                    <div>
                      <dt>MAPE</dt>
                      <dd>{number(summary.summary.mape_percent, "%")}</dd>
                    </div>
                    <div>
                      <dt>Joint sample</dt>
                      <dd>
                        {summary.summary.sample_count}/{summary.summary.expected_count} (
                        {(summary.summary.joint_coverage * 100).toFixed(1)}%)
                      </dd>
                    </div>
                  </dl>
                  <p>
                    Signed error = actual − forecast; positive means underforecast. MAE and bias use{" "}
                    {summary.summary.sample_count} valid pairs. MAPE uses its own positive-actual
                    sample of {summary.summary.mape_sample_count}.
                  </p>
                  <p>
                    Coverage spans {summary.summary.chicago_delivery_date_count} Chicago delivery
                    dates and {(summary.summary.sample_span_seconds / 86_400).toFixed(1)} days.
                    Exclusions:{" "}
                    {Object.entries(summary.missing_reasons)
                      .filter(([, count]) => count > 0)
                      .map(([reason, count]) => `${reason.replaceAll("_", " ")} ${count}`)
                      .join(", ") || "none"}
                    .
                  </p>
                  {summary.summary.qualification.qualified ? (
                    <p>
                      Historical empirical 80% error band:{" "}
                      {number(summary.summary.empirical_interval?.lower_mw ?? null)} to{" "}
                      {number(summary.summary.empirical_interval?.upper_mw ?? null)}. This is not
                      probabilistic confidence.
                    </p>
                  ) : summary.summary.sample_count > 0 ? (
                    <p role="status">
                      Insufficient history for an empirical interval:{" "}
                      {summary.summary.qualification.reasons.join(", ") || "qualification pending"}.
                      Requires at least 100 pairs, 30 Chicago delivery dates, 28 days, and 80% joint
                      coverage.
                    </p>
                  ) : null}
                </>
              )}
              {resource.error ? (
                <DataLifecycleMessage
                  detail="The latest immutable daily resource could not be loaded."
                  state="unavailable"
                />
              ) : latestResource && resource.data === undefined ? (
                <DataLifecycleMessage state="loading" />
              ) : resource.data ? (
                <div className="outlook-hourly-detail">
                  <h4>Latest materialized UTC day</h4>
                  <div className="outlook-table-wrap">
                    <table
                      aria-label={`${SERIES_LABELS[seriesKey]} ${HORIZON_LABELS[horizon]} exact forecast quality`}
                    >
                      <thead>
                        <tr>
                          <th scope="col">Target</th>
                          <th scope="col">Forecast</th>
                          <th scope="col">Actual</th>
                          <th scope="col">Signed error</th>
                          <th scope="col">Absolute error</th>
                          <th scope="col">Revision</th>
                          <th scope="col">Method/model</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resource.data.rows.map((row) => (
                          <tr key={row.target_ts}>
                            <th scope="row">{timestamp(row.target_ts)}</th>
                            <td>{number(row.forecast_mw)}</td>
                            <td>{number(row.actual_mw)}</td>
                            <td>{number(row.error_mw)}</td>
                            <td>{number(row.absolute_error_mw)}</td>
                            <td>{number(row.revision_mw)}</td>
                            <td>{row.model ?? row.missing_reason ?? "Unavailable"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
              <footer className="outlook-provenance">
                <strong>Method v1 · Type 7 quantiles</strong>
                <span>{source?.interpretation.replaceAll("_", " ")}</span>
                <span>{source?.source_ids.join(" + ")}</span>
              </footer>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
