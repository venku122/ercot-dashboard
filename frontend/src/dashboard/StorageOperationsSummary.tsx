import { useMemo } from "react";

import { seriesKey } from "./chart-config";
import { deriveStorageOperationsSnapshot } from "./storage-operations";
import type { LoadedSeries, SourceHealth, TimeState } from "./types";
import { formatValue } from "./units";

export function StorageOperationsSummary({
  seriesData,
  sourceHealth,
  time,
}: {
  seriesData: Map<string, LoadedSeries>;
  sourceHealth: SourceHealth | null;
  time: TimeState;
}) {
  const snapshot = useMemo(
    () =>
      deriveStorageOperationsSnapshot({
        charging: seriesData.get(seriesKey("storage", "charging"))?.points ?? [],
        discharging: seriesData.get(seriesKey("storage", "discharging"))?.points ?? [],
        netOutput: seriesData.get(seriesKey("storage", "net-output"))?.points ?? [],
      }),
    [seriesData],
  );
  const fourSecondNotice = (
    <p>
      ERCOT&apos;s separate four-second charging feed is historical-only and ended with RTC+B on
      December 5, 2025; it is not used as live or zero data here.
    </p>
  );

  if (time.mode !== "live") {
    return (
      <section aria-label="Storage fleet operating summary" className="storage-operations-summary">
        <p>
          Fleet operating mode is shown only in Live mode. The chart and exact table remain the
          reviewed history for this fixed window.
        </p>
        {fourSecondNotice}
      </section>
    );
  }

  if (snapshot.availability !== "available") {
    return (
      <section aria-label="Storage fleet operating summary" className="storage-operations-summary">
        <strong>Coherent fleet snapshot unavailable</strong>
        <p>
          {snapshot.availability === "partial"
            ? `The three source values do not share one observation time (${snapshot.missing.join(", ")}). Older values are not borrowed.`
            : "No aggregate storage observations are available in this window."}
        </p>
        {fourSecondNotice}
      </section>
    );
  }

  const stale = sourceHealth?.state === "stale" || sourceHealth?.state === "failed";
  const modeLabel =
    snapshot.mode === "near-idle"
      ? "Near idle"
      : snapshot.mode === "charging"
        ? "Charging"
        : "Discharging";
  return (
    <section aria-label="Storage fleet operating summary" className="storage-operations-summary">
      {stale ? (
        <p role="status">Showing the last coherent storage snapshot; source is stale.</p>
      ) : null}
      <div className="storage-operations-grid">
        <article>
          <span>Fleet mode</span>
          <strong>{modeLabel}</strong>
          <small>App display deadband from source net output</small>
        </article>
        <article>
          <span>Charging</span>
          <strong>{formatValue(snapshot.charging_mw, "MW")}</strong>
          <small>Negative load</small>
        </article>
        <article>
          <span>Discharging</span>
          <strong>{formatValue(snapshot.discharging_mw, "MW")}</strong>
          <small>Positive generation</small>
        </article>
        <article>
          <span>Net output</span>
          <strong>{formatValue(snapshot.net_output_mw, "MW")}</strong>
          <small>{new Date(snapshot.observed_at * 1000).toLocaleString()}</small>
        </article>
      </div>
      <p>
        System-wide dashboard aggregate only. It does not report state of charge, stored energy,
        remaining duration, capacity utilization, individual resources, dispatch intent, or market
        revenue. Nearby price, demand, or ramp changes are context—not attributed causes.
      </p>
      {fourSecondNotice}
      <details>
        <summary>Exact coherent observation</summary>
        <div
          aria-label="Exact coherent storage observation"
          className="table-scroll"
          role="region"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Observed</th>
                <th>Charging</th>
                <th>Discharging</th>
                <th>Net output</th>
                <th>Source balance diagnostic</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{new Date(snapshot.observed_at * 1000).toISOString()}</td>
                <td>{formatValue(snapshot.charging_mw, "MW")}</td>
                <td>{formatValue(snapshot.discharging_mw, "MW")}</td>
                <td>{formatValue(snapshot.net_output_mw, "MW")}</td>
                <td>{formatValue(snapshot.source_balance_delta_mw, "MW")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
