import { useMemo, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useNetLoadDailyResource, useNetLoadManifest, useNetLoadResource } from "./data-hooks";
import {
  NET_LOAD_SERIES_KEYS,
  type NetLoadDailySeriesKey,
  type NetLoadResource,
  type NetLoadRow,
  type NetLoadSeriesKey,
} from "./net-load";
import { formatValue } from "./units";

const LABELS: Record<NetLoadSeriesKey, string> = {
  "net-load.actual": "Actual",
  "net-load.forecast.latest-capped-1h-before-utc-day": "Latest coherent, capped 1h before UTC day",
  "net-load.forecast.latest-capped-6h-before-utc-day": "Latest coherent, capped 6h before UTC day",
  "net-load.forecast.latest-capped-24h-before-utc-day":
    "Latest coherent, capped 24h before UTC day",
};
const DAILY_KEY: Record<NetLoadSeriesKey, NetLoadDailySeriesKey> = {
  "net-load.actual": "net-load.actual",
  "net-load.forecast.latest-capped-1h-before-utc-day":
    "net-load.forecast.latest-capped-1h-before-market-day",
  "net-load.forecast.latest-capped-6h-before-utc-day":
    "net-load.forecast.latest-capped-6h-before-market-day",
  "net-load.forecast.latest-capped-24h-before-utc-day":
    "net-load.forecast.latest-capped-24h-before-market-day",
};

function value(input: number | null | undefined) {
  return input === null || input === undefined ? "Unavailable" : formatValue(input, "MW");
}

function observedAt(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp * 1_000);
}

function chicagoDate(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp * 1_000);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

function latestValue(
  rows: NetLoadRow[],
  key:
    | "net_load_mw"
    | "ramp_1h_mw"
    | "ramp_3h_mw"
    | "published_average_net_load_mw"
    | "published_residual_mw",
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index]?.[key];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

function NetLoadProfile({ rows }: { rows: NetLoadRow[] }) {
  const plot = (
    series: readonly (readonly [string, "net_load_mw" | "ramp_1h_mw" | "ramp_3h_mw", string])[],
    label: string,
  ) => {
    const values = rows.flatMap((row) =>
      series.flatMap(([, key]) => (typeof row[key] === "number" ? [row[key]] : [])),
    );
    if (values.length < 2) return null;
    const minimum = Math.min(...values);
    const spread = Math.max(1, Math.max(...values) - minimum);
    const points = (key: (typeof series)[number][1]) =>
      rows
        .flatMap((row, index) =>
          typeof row[key] === "number"
            ? [
                `${((index / Math.max(1, rows.length - 1)) * 100).toFixed(2)},${(40 - ((row[key] - minimum) / spread) * 36).toFixed(2)}`,
              ]
            : [],
        )
        .join(" ");
    return (
      <svg aria-label={label} role="img" viewBox="0 0 100 44">
        {series.map(([seriesLabel, key, className]) => (
          <polyline
            aria-label={seriesLabel}
            className={className}
            fill="none"
            key={key}
            points={points(key)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
  };
  return (
    <figure className="outlook-profile net-load-profile">
      {plot([["Net load", "net_load_mw", "profile-net"]], "Net-load profile")}
      {plot(
        [
          ["1h ramp", "ramp_1h_mw", "profile-ramp-one"],
          ["3h ramp", "ramp_3h_mw", "profile-ramp-three"],
        ],
        "Exact one-hour and three-hour ramp profiles on a separate scale",
      )}
      <figcaption>
        <span>Solid: net load</span>
        <span>Dashed: 1h ramp</span>
        <span>Dotted: 3h ramp</span>
      </figcaption>
      <p>Evening-ramp summary uses the separately versioned 4–10 PM Central market-day resource.</p>
    </figure>
  );
}

function ForecastContributorList({
  contributors,
}: {
  contributors: NetLoadResource["contributors"];
}) {
  if (!("load" in contributors)) return null;
  return (
    <ul aria-label="Forecast contributor provenance">
      {(["load", "wind", "solar"] as const).map((name) => (
        <li key={name}>
          {name}: issued {observedAt(contributors[name].issued_at)} ·{" "}
          {contributors[name].vintage_key}
        </li>
      ))}
    </ul>
  );
}

export function NetLoadPanel({ enabled }: { enabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [seriesKey, setSeriesKey] = useState<NetLoadSeriesKey>("net-load.actual");
  const manifest = useNetLoadManifest(enabled && expanded);
  const tileLink = useMemo(() => {
    const matches = (manifest.data?.resources.filter((item) => item.series_key === seriesKey) ?? [])
      .slice()
      .sort((left, right) => left.day_start - right.day_start);
    if (!matches.length) return null;
    const today = Math.floor(Date.now() / 86_400_000) * 86_400;
    if (seriesKey === "net-load.actual") {
      const completed = matches.filter((item) => item.day_start < today);
      return completed.length ? completed[completed.length - 1]! : null;
    }
    return matches.find((item) => item.day_start >= today) ?? matches[matches.length - 1]!;
  }, [manifest.data, seriesKey]);
  const dailyLink = useMemo(() => {
    if (tileLink === null) return null;
    const targetDate = chicagoDate(tileLink.day_start + 43_200);
    const matches =
      manifest.data?.daily_resources.filter(
        (item) =>
          item.series_key === DAILY_KEY[seriesKey] &&
          item.delivery_date === targetDate &&
          item.complete,
      ) ?? [];
    return matches[0] ?? null;
  }, [manifest.data, seriesKey, tileLink]);
  const tile = useNetLoadResource(enabled && expanded && tileLink !== null, tileLink);
  const daily = useNetLoadDailyResource(enabled && expanded && dailyLink !== null, dailyLink);

  return (
    <section aria-labelledby="net-load-title" className="outlook-days-panel net-load-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Derived grid shape</p>
          <h2 id="net-load-title">Net load and ramp</h2>
        </div>
        <Button
          aria-controls="net-load-detail"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide net-load details" : "Load net-load details"}
        </Button>
      </div>
      <p>
        Demand minus wind and solar. This dashboard-derived diagnostic is not ERCOT&apos;s official
        net-load product. No history is requested until opened.
      </p>
      {expanded ? (
        <div id="net-load-detail">
          <fieldset>
            <legend>Series and snapshot policy</legend>
            {NET_LOAD_SERIES_KEYS.map((key) => (
              <Button aria-pressed={seriesKey === key} key={key} onClick={() => setSeriesKey(key)}>
                {LABELS[key]}
              </Button>
            ))}
          </fieldset>
          {manifest.error ? (
            <DataLifecycleMessage
              detail="The bounded net-load catalog is unavailable."
              state="unavailable"
            />
          ) : manifest.data === undefined ? (
            <DataLifecycleMessage state="loading" />
          ) : tileLink === null ? (
            <DataLifecycleMessage
              detail="No completed materialized day is available yet."
              state="unavailable"
            />
          ) : tile.error ? (
            <DataLifecycleMessage
              detail="The immutable net-load tile is unavailable."
              state="unavailable"
            />
          ) : tile.data === undefined ? (
            <DataLifecycleMessage state="loading" />
          ) : (
            <>
              {manifest.data.materialization_health?.some((item) => item.state === "failed") ? (
                <DataLifecycleMessage
                  detail="Net-load materialization is degraded; the versioned data below may be stale."
                  state="unavailable"
                />
              ) : null}
              {dailyLink !== null && daily.error ? (
                <DataLifecycleMessage
                  detail="The Central-time daily ramp summary is unavailable."
                  state="unavailable"
                />
              ) : null}
              {!tile.data.complete ? (
                <DataLifecycleMessage
                  detail={`Partial coverage: ${tileLink.valid_point_count} of ${tileLink.point_count} expected points are complete. Missing intervals remain explicit in the table.`}
                  state="unavailable"
                />
              ) : null}
              <dl aria-label="Net-load summary" className="outlook-summary-grid">
                <div>
                  <dt>Latest net load</dt>
                  <dd>{value(latestValue(tile.data.rows, "net_load_mw"))}</dd>
                </div>
                <div>
                  <dt>1-hour ramp</dt>
                  <dd>{value(latestValue(tile.data.rows, "ramp_1h_mw"))}</dd>
                </div>
                <div>
                  <dt>3-hour ramp</dt>
                  <dd>{value(latestValue(tile.data.rows, "ramp_3h_mw"))}</dd>
                </div>
                <div>
                  <dt>Daily minimum → evening peak</dt>
                  <dd>{value(daily.data?.daily_ramp?.ramp_mw)}</dd>
                </div>
                {seriesKey === "net-load.actual" ? (
                  <>
                    <div>
                      <dt>Published Average Net Load</dt>
                      <dd>{value(latestValue(tile.data.rows, "published_average_net_load_mw"))}</dd>
                    </div>
                    <div>
                      <dt>Derived − published residual</dt>
                      <dd>{value(latestValue(tile.data.rows, "published_residual_mw"))}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              <p>
                Ramps are exact elapsed changes with no interpolation or bridging. The evening
                method is dashboard-defined: America/Chicago 4–10 PM, earliest ties, with the
                preceding/on-peak daily minimum. Incomplete days are excluded.
              </p>
              <NetLoadProfile rows={tile.data.rows} />
              {seriesKey === "net-load.actual" ? (
                <p>
                  Actual rows use same-timestamp Real-Time System Conditions demand, wind, solar,
                  and published Average Net Load. ERCOT&apos;s published load basis excludes ESR
                  charging. Storage net output is shown separately and never changes this formula.
                </p>
              ) : (
                <div>
                  <p>
                    One coherent NP3-565 + NP4-732 STWPF + NP4-737 STPPF curve is selected no later
                    than the policy cutoff. Renewable values describe forecast HSL potential, not
                    actual generation and not a per-target lead-time claim.
                  </p>
                  <p>
                    {tile.data.finalized
                      ? "Finalized policy snapshot"
                      : "Provisional latest coherent curve"}
                    {tile.data.effective_as_of === null
                      ? ""
                      : ` as of ${observedAt(tile.data.effective_as_of)}`}
                    .
                  </p>
                  <ForecastContributorList contributors={tile.data.contributors} />
                </div>
              )}
              <div className="outlook-table-wrap">
                <table aria-label={`${LABELS[seriesKey]} exact net-load values`}>
                  <thead>
                    <tr>
                      <th scope="col">Target</th>
                      <th scope="col">Demand</th>
                      <th scope="col">Wind</th>
                      <th scope="col">Solar</th>
                      <th scope="col">Net load</th>
                      {seriesKey === "net-load.actual" ? (
                        <th scope="col">Published net load</th>
                      ) : null}
                      {seriesKey === "net-load.actual" ? (
                        <th scope="col">Derived − published</th>
                      ) : null}
                      <th scope="col">1h ramp</th>
                      <th scope="col">3h ramp</th>
                      <th scope="col">Storage context</th>
                      <th scope="col">Missing reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tile.data.rows.map((row) => (
                      <tr key={row.target_ts}>
                        <th scope="row">{observedAt(row.target_ts)}</th>
                        <td>{value(row.demand_mw)}</td>
                        <td>{value(row.wind_mw)}</td>
                        <td>{value(row.solar_mw)}</td>
                        <td>{value(row.net_load_mw)}</td>
                        {seriesKey === "net-load.actual" ? (
                          <td>{value(row.published_average_net_load_mw)}</td>
                        ) : null}
                        {seriesKey === "net-load.actual" ? (
                          <td>{value(row.published_residual_mw)}</td>
                        ) : null}
                        <td>{value(row.ramp_1h_mw)}</td>
                        <td>{value(row.ramp_3h_mw)}</td>
                        <td>{value(row.storage_net_output_mw)}</td>
                        <td>{row.missing_reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <footer className="outlook-provenance">
                <strong>{LABELS[seriesKey]} · method v1</strong>
                <span>Formula: demand − wind − solar</span>
                <span>Canonical UTC daily native tile; Central-time daily-ramp summary</span>
              </footer>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
