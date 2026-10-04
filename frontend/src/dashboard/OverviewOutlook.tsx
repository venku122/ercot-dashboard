import { useMemo } from "react";
import { Button } from "../components/ui/button";
import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import type { OutlookDataRequest } from "./data-hooks";
import { buildGridOutlook } from "./outlook";
import { OutlookProfile } from "./OutlookProfile";
import { marketTime } from "./homepage-model";
import { formatAge, formatValue } from "./units";

export function OverviewOutlook({
  request,
  now,
  historical,
  onOpen,
}: {
  request: OutlookDataRequest;
  now: number;
  historical: boolean;
  onOpen: () => void;
}) {
  const outlook = useMemo(
    () => (request.data ? buildGridOutlook(request.data, now) : null),
    [request.data, now],
  );
  const next = outlook?.next24;
  const health = outlook?.forecastSourceHealth;
  const validEmptyRetained =
    health?.availability_status === "empty" && (next?.observedCount ?? 0) > 0;
  const stale =
    health?.state === "stale" || health?.state === "failed" || health?.freshness_state === "stale";
  const state = request.error
    ? outlook
      ? "refresh-failed-retained"
      : "unavailable"
    : !outlook
      ? "loading"
      : !next?.observedCount
        ? health?.availability_status === "empty"
          ? "valid-empty"
          : request.data?.forecast.publication
            ? "incomplete"
            : "availability-unknown"
        : validEmptyRetained
          ? "valid-empty-retained"
          : stale
            ? "stale"
            : next.observedCount < next.expectedCount
              ? "partial"
              : "ready";
  return (
    <section
      className="overview-outlook"
      aria-label="Current next 24 hour Outlook"
      data-outlook-state={state}
    >
      <header>
        <div>
          <p className="eyebrow">Current published forecast</p>
          <h2>Next 24 hours</h2>
        </div>
        <Button
          variant="segmented"
          disabled={request.isValidating}
          onClick={() => void request.mutate()}
        >
          Refresh Outlook
        </Button>
        <Button variant="segmented" onClick={onOpen}>
          Open full Outlook
        </Button>
      </header>
      <p>
        {historical
          ? "Current outlook is independent of the selected historical period and cursor."
          : "Future forecast targets are independent of observed historical values."}
      </p>
      {!outlook ? (
        <DataLifecycleMessage
          state={request.error ? "unavailable" : "loading"}
          title={request.error ? "Current publication unavailable" : "Loading current publication"}
          detail={
            request.error
              ? "Publication and source eligibility are unknown. Core observed charts remain available."
              : "Loading the latest published outlook for the next 24 hours."
          }
        />
      ) : (
        <>
          {request.error ? (
            <p role="status">
              Refresh failed; showing the retained publication and its original issue time.
            </p>
          ) : null}
          {validEmptyRetained ? (
            <p role="status">
              Load forecast: latest collection was valid-empty; showing the retained publication and
              its original issue time.
            </p>
          ) : null}
          {outlook.adequacySourceHealth?.availability_status === "empty" ? (
            <p role="status">
              System adequacy: latest collection was valid-empty
              {next?.adequacyObservedCount
                ? "; showing retained adequacy hours and their original publication time."
                : "; no usable adequacy hours are available."}
            </p>
          ) : null}
          {stale ? (
            <p role="status">
              Retained forecast source is stale or failed; these values are not current
              observations.
            </p>
          ) : null}
          <p>
            Forecast publication{" "}
            {outlook.forecastIssuedAt === null
              ? "not available"
              : `${marketTime(outlook.forecastIssuedAt)} · ${formatAge(outlook.forecastAgeSeconds ?? 0)}`}{" "}
            ·{" "}
            {health
              ? `source ${health.state}, ${health.freshness_state}`
              : "source availability unknown"}
            .
          </p>
          {next && next.observedCount > 0 ? (
            <>
              <dl className="overview-outlook-summary">
                <div>
                  <dt>Forecast demand peak · NP3-565</dt>
                  <dd>{formatValue(next.peakDemandMw, "MW")}</dd>
                  <small>
                    {next.peakTargetTs === null ? "Unavailable" : marketTime(next.peakTargetTs)}
                  </small>
                </div>
                <div>
                  <dt>Tightest projected headroom · NP3-763</dt>
                  <dd>{formatValue(next.projectedHeadroomMw, "MW")}</dd>
                  <small>
                    {next.tightestTargetTs === null
                      ? "Adequacy forecast unavailable"
                      : marketTime(next.tightestTargetTs)}
                  </small>
                </div>
              </dl>
              <p>
                {next.observedCount} of {next.expectedCount} hourly values available. NP3-565 in-use
                load forecast; NP3-763 headroom uses its own forecast/capacity basis, separate from
                current observed capacity.
              </p>
              <p>
                {next.adequacyObservedCount} of {next.expectedCount} adequacy hours available.
                Publication{" "}
                {request.data?.adequacy.publication
                  ? marketTime(request.data.adequacy.publication.issued_at)
                  : "unavailable"}{" "}
                · source {outlook.adequacySourceHealth?.state ?? "unknown"},{" "}
                {outlook.adequacySourceHealth?.freshness_state ?? "unknown"}.
              </p>
              <OutlookProfile outlook={outlook} />
            </>
          ) : (
            <p role="status">
              {health?.availability_status === "empty"
                ? "Latest collection was valid-empty; no future forecast values are available."
                : request.data?.forecast.publication
                  ? "Collected publication has no usable forecast values in the next 24 hours."
                  : "No current collected forecast publication is available; source eligibility is unknown."}
            </p>
          )}
          <p className="overview-outlook-source-links">
            <a
              href="https://www.ercot.com/mp/data-products/data-product-details?id=NP3-565-CD"
              target="_blank"
              rel="noreferrer"
            >
              ERCOT load forecast product
            </a>
            <a
              href="https://www.ercot.com/mp/data-products/data-product-details?id=NP3-763-CD"
              target="_blank"
              rel="noreferrer"
            >
              ERCOT system adequacy product
            </a>
          </p>
        </>
      )}
    </section>
  );
}
