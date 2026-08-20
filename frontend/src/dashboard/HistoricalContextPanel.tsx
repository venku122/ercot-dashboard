import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useHistoricalContext } from "./data-hooks";
import type {
  HistoricalComparison,
  HistoricalContextResolver,
  HistoricalCoverage,
  HistoricalExtrema,
  HistoricalValue,
} from "./historical-context";
import { formatValue } from "./units";

function timestamp(value: number | null): string {
  if (value === null) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "America/Chicago",
    timeZoneName: "short",
    year: "numeric",
  }).format(new Date(value * 1_000));
}

function measured(value: HistoricalValue | null): string {
  return value
    ? `${formatValue(value.value, "MW")} at ${timestamp(value.timestamp)}`
    : "Unavailable";
}

function coverage(value: HistoricalCoverage | HistoricalExtrema["coverage"]): string {
  if (!value) return "Unavailable";
  return `${String(value.observed_count)} / ${String(value.expected_count)} observations (${String(Math.round(value.ratio * 100))}%)`;
}

function comparisonLabel(key: keyof HistoricalContextResolver["summary"]["comparisons"]): string {
  if (key === "previous_day") return "Previous local day, same hour";
  if (key === "previous_week") return "Previous local week, same hour";
  return "Previous local year, same hour";
}

function comparisonDetail(item: HistoricalComparison): string {
  if (item.reason === "unavailable_no_calendar_anniversary") return "No calendar anniversary";
  if (item.reason === "nonexistent_local_hour") return "Local hour did not exist";
  if (item.reason === "insufficient_coverage") return "Insufficient native observations";
  return item.state;
}

function summaryState(data: HistoricalContextResolver, stale: boolean, failed: boolean): string {
  if (failed) return "refresh-failed";
  if (stale) return "stale";
  return data.state;
}

export function HistoricalContextPanel({
  asOf,
  enabled,
  expanded,
  onExpandedChange,
}: {
  asOf: number;
  enabled: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const request = useHistoricalContext(enabled && expanded, asOf);
  const data = request.data;
  const stale = Boolean(data && data.summary.as_of === asOf && request.error);
  const refreshFailed = Boolean(data && request.error);
  const lifecycle = data
    ? summaryState(data, stale, refreshFailed)
    : request.error
      ? "unavailable"
      : request.isLoading
        ? "pending"
        : "unavailable";

  return (
    <section
      aria-labelledby="historical-context-title"
      className="historical-context-panel"
      data-historical-context-state={lifecycle}
    >
      <header>
        <div>
          <p className="eyebrow">Dashboard observations</p>
          <h2 id="historical-context-title">Historical context and records</h2>
          <p>
            Demand context from observations collected by this dashboard, conditioned on season and
            America/Chicago civil hour. This is not a forecast or an all-time ERCOT record.
          </p>
        </div>
        <Button
          aria-controls="historical-context-content"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded
            ? "Close historical context and records"
            : "Open historical context and records"}
        </Button>
      </header>

      {expanded ? (
        <div id="historical-context-content">
          {!data && request.isLoading ? (
            <DataLifecycleMessage
              detail="Resolving the latest completed demand hour and its available collection history."
              state="loading"
              title="Historical context pending…"
            />
          ) : null}
          {!data && request.error ? (
            <DataLifecycleMessage
              detail="No historical-context summary is available from the latest request."
              state="unavailable"
            />
          ) : null}
          {data ? (
            <HistoricalContextContent data={data} refreshFailed={refreshFailed} stale={stale} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HistoricalContextContent({
  data,
  refreshFailed,
  stale,
}: {
  data: HistoricalContextResolver;
  refreshFailed: boolean;
  stale: boolean;
}) {
  const summary = data.summary;
  const selected = summary.selected_hour;
  const comparisons = Object.entries(summary.comparisons) as Array<
    [keyof typeof summary.comparisons, HistoricalComparison]
  >;
  const extrema = Object.values(summary.observed_extrema);
  const percentile = summary.seasonal_local_hour_percentiles;
  const rank = summary.completed_day_peak_rank;
  const statusMessage = refreshFailed
    ? "Refresh failed. Showing the last successfully loaded summary; verify its as-of time."
    : stale
      ? "Showing the last successfully loaded summary while the selected as-of hour is pending."
      : data.state === "partial"
        ? "The selected hour has partial coverage and is excluded from qualified comparisons."
        : data.state === "unavailable"
          ? "No qualifying demand observation exists for the selected completed hour."
          : "The selected completed hour meets the native-observation coverage threshold.";

  return (
    <div className="historical-context-content">
      <p aria-live="polite" className="historical-context-status">
        <strong>{refreshFailed ? "Refresh failed" : stale ? "Stale last-good" : data.state}</strong>
        {" · "}
        {statusMessage}
      </p>
      <div className="historical-context-highlights">
        <article>
          <span>Selected local hour</span>
          <strong>{measured(selected.value)}</strong>
          <small>
            {selected.market_date} HE {String(selected.local_hour).padStart(2, "0")} ·{" "}
            {coverage(selected.coverage)}
          </small>
        </article>
        <article>
          <span>Seasonal same-hour range</span>
          <strong>
            {percentile.state === "available"
              ? `${formatValue(percentile.p10, "MW")} – ${formatValue(percentile.p90, "MW")}`
              : "Unavailable"}
          </strong>
          <small>
            Type 7 p10–p90 · {percentile.season} · {String(percentile.sample_count)} qualified prior
            hours
          </small>
        </article>
        <article>
          <span>Completed-day peak rank</span>
          <strong>
            {rank.rank === null
              ? "Unavailable"
              : `${String(rank.rank)} of ${String(rank.denominator)}`}
          </strong>
          <small>
            {rank.market_date} · competition rank · {String(rank.excluded_prior_count)} prior days
            excluded
          </small>
        </article>
      </div>

      <div
        aria-label="Exact historical demand evidence"
        className="table-scroll historical-context-exact"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption>Exact historical demand evidence and coverage</caption>
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">State</th>
              <th scope="col">Value</th>
              <th scope="col">Coverage / method</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Selected completed civil hour</th>
              <td>{selected.coverage.state}</td>
              <td>{measured(selected.value)}</td>
              <td>
                {coverage(selected.coverage)} · {String(selected.occurrence_count)} UTC
                occurrence(s)
              </td>
            </tr>
            {comparisons.map(([key, item]) => (
              <tr key={key}>
                <th scope="row">{comparisonLabel(key)}</th>
                <td>{item.state}</td>
                <td>{measured(item.value)}</td>
                <td>{item.coverage ? coverage(item.coverage) : comparisonDetail(item)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Seasonal same-local-hour percentiles</th>
              <td>{percentile.state}</td>
              <td>
                {percentile.state === "available"
                  ? `p10 ${formatValue(percentile.p10, "MW")}; p50 ${formatValue(percentile.p50, "MW")}; p90 ${formatValue(percentile.p90, "MW")}`
                  : "Unavailable"}
              </td>
              <td>
                Type 7 · prior {percentile.season} hours only · n={String(percentile.sample_count)}
              </td>
            </tr>
            <tr>
              <th scope="row">Completed-day peak rank</th>
              <td>{rank.state}</td>
              <td>{measured(rank.peak)}</td>
              <td>
                {rank.rank === null
                  ? "Selected day did not qualify"
                  : `Rank ${String(rank.rank)} of ${String(rank.denominator)}; ${String(rank.qualified_prior_count)} qualified and ${String(rank.excluded_prior_count)} excluded prior days`}
              </td>
            </tr>
            {extrema.map((item) => (
              <tr key={item.window}>
                <th scope="row">Observed extrema · {item.window.replace("_", " ")}</th>
                <td>{item.state}</td>
                <td>
                  Low {measured(item.minimum)}; high {measured(item.maximum)}
                </td>
                <td>{coverage(item.coverage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="historical-context-method">
        <summary>Method and provenance</summary>
        <dl>
          <div>
            <dt>Series</dt>
            <dd>{summary.series_key}</dd>
          </div>
          <div>
            <dt>Statistic</dt>
            <dd>{summary.statistic}</dd>
          </div>
          <div>
            <dt>Time basis</dt>
            <dd>{summary.time_basis}</dd>
          </div>
          <div>
            <dt>As of</dt>
            <dd>{timestamp(summary.as_of)}</dd>
          </div>
          <div>
            <dt>Observed start</dt>
            <dd>{timestamp(summary.retention.observed_start)}</dd>
          </div>
          <div>
            <dt>Observed end</dt>
            <dd>{timestamp(summary.retention.observed_end)}</dd>
          </div>
          <div>
            <dt>Content version</dt>
            <dd>{data.resource.content_version}</dd>
          </div>
        </dl>
        <p>
          Previous day, week, and year preserve the same local civil hour. Missing observations are
          not filled or borrowed. The immutable resource identity is shown for evidence; this panel
          uses the resolver's embedded summary and makes no second resource request.
        </p>
      </details>
    </div>
  );
}
