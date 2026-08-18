import { useEffect, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { useOutlookData } from "./data-hooks";
import { buildGridOutlook, type GridOutlook, type OutlookDayCard } from "./outlook";
import { formatAge, formatValue } from "./units";

export type OutlookViewProps = {
  enabled: boolean;
  now?: number;
};

function timeLabel(timestamp: number | null) {
  if (timestamp === null) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp * 1_000);
}

function dayLabel(deliveryDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${deliveryDate}T12:00:00Z`));
}

function value(value: number | null, unit: string) {
  return value === null ? "Not available" : formatValue(value, unit);
}

function revision(valueMw: number | null) {
  if (valueMw === null) return "No day-prior comparison";
  const sign = valueMw > 0 ? "+" : "";
  return `${sign}${formatValue(valueMw, "MW")} since the day-prior vintage`;
}

function OutlookProfile({ outlook }: { outlook: GridOutlook }) {
  const points = outlook.next24Hours;
  if (points.length < 2) {
    return <p className="outlook-empty">Next-24-hour profile is not available.</p>;
  }
  const values = points.map((point) => point[1]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(1, maximum - minimum);
  const polyline = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 38 - ((point[1] - minimum) / spread) * 34;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <figure className="outlook-profile">
      <svg
        aria-label={`Next 24 hour demand forecast from ${formatValue(minimum, "MW")} to ${formatValue(maximum, "MW")}`}
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 42"
      >
        <polyline fill="none" points={polyline} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>
        <span>Now</span>
        <span>Next 24 hours</span>
      </figcaption>
      <details>
        <summary>Hourly forecast values</summary>
        <div className="table-scroll">
          <table aria-label="Next 24 hour forecast values">
            <thead>
              <tr>
                <th>Interval ending</th>
                <th>Forecast demand</th>
              </tr>
            </thead>
            <tbody>
              {points.map(([timestamp, demand]) => (
                <tr key={timestamp}>
                  <td>{timeLabel(timestamp)}</td>
                  <td>{formatValue(demand, "MW")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function DayCard({
  card,
  onSelect,
  selected,
}: {
  card: OutlookDayCard;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <article className="outlook-day-card" data-outlook-day={card.deliveryDate}>
      <header>
        <p className="eyebrow">{dayLabel(card.deliveryDate)}</p>
        <strong>Dashboard outlook</strong>
      </header>
      <dl>
        <div>
          <dt>Peak demand</dt>
          <dd>{value(card.peakDemandMw, "MW")}</dd>
          <small>{timeLabel(card.peakTargetTs)}</small>
        </div>
        <div>
          <dt>Projected headroom</dt>
          <dd>{value(card.projectedHeadroomMw, "MW")}</dd>
          <small>
            {card.tightestTargetTs === null
              ? "NP3-763 interval unavailable"
              : `Tightest at ${timeLabel(card.tightestTargetTs)}`}
          </small>
        </div>
        <div>
          <dt>Peak-hour forecast revision</dt>
          <dd>{revision(card.peakRevisionMw)}</dd>
        </div>
      </dl>
      <Button
        aria-controls={`outlook-day-detail-${card.deliveryDate}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {selected
          ? `${dayLabel(card.deliveryDate)} hourly detail shown`
          : `View ${dayLabel(card.deliveryDate)} hourly detail`}
      </Button>
    </article>
  );
}

export function OutlookContent({ outlook }: { outlook: GridOutlook }) {
  const [selectedDate, setSelectedDate] = useState(outlook.cards[0]?.deliveryDate ?? null);
  useEffect(() => {
    if (!outlook.cards.some((card) => card.deliveryDate === selectedDate)) {
      setSelectedDate(outlook.cards[0]?.deliveryDate ?? null);
    }
  }, [outlook.cards, selectedDate]);
  const weatherValues = outlook.weather.observations.filter(
    (observation) => observation.temperature_c !== null,
  );
  const weatherHealth = outlook.weather.source;
  const weatherIsCurrent =
    weatherHealth?.state === "healthy" &&
    weatherHealth.freshness_state === "fresh" &&
    weatherValues.length > 0;
  const sourceWarnings = [
    ["Load forecast", outlook.forecastSourceHealth],
    ["System adequacy", outlook.adequacySourceHealth],
    ["Weather observations", weatherHealth],
  ].flatMap(([label, health]) => {
    if (!health || typeof health === "string") return [`${label}: source health unavailable`];
    if (health.availability_status === "empty")
      return [`${label}: latest collection was valid-empty`];
    if (health.state !== "healthy" || health.freshness_state !== "fresh") {
      return [`${label}: ${health.state}, data ${health.freshness_state}`];
    }
    return [];
  });
  return (
    <div className="outlook-view-content" data-outlook-state="ready">
      {sourceWarnings.length ? (
        <aside
          aria-label="Outlook source freshness"
          className="outlook-source-warning"
          data-outlook-source-state="partial"
        >
          <strong>Some Outlook inputs are partial or stale</strong>
          <ul>
            {sourceWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </aside>
      ) : null}
      <section aria-label="Grid Outlook summary" className="outlook-summary-grid">
        <article>
          <span>Seven-day projected peak</span>
          <strong>{value(outlook.projectedPeakMw, "MW")}</strong>
          <small>{timeLabel(outlook.projectedPeakTargetTs)}</small>
        </article>
        <article>
          <span>Tightest projected headroom</span>
          <strong>{value(outlook.tightestHeadroomMw, "MW")}</strong>
          <small>{timeLabel(outlook.tightestTargetTs)}</small>
        </article>
        <article>
          <span>Forecast issuance</span>
          <strong>
            {outlook.forecastAgeSeconds === null
              ? "Not available"
              : formatAge(outlook.forecastAgeSeconds)}
          </strong>
          <small>
            {outlook.forecastModel ? `Active model ${outlook.forecastModel}` : "Model varies"}
          </small>
        </article>
      </section>

      <section aria-labelledby="outlook-profile-title" className="outlook-profile-panel">
        <div>
          <p className="eyebrow">Load forecast</p>
          <h3 id="outlook-profile-title">Next 24 hours</h3>
        </div>
        <OutlookProfile outlook={outlook} />
      </section>

      <section aria-labelledby="seven-day-outlook-title" className="outlook-days-panel">
        <div>
          <p className="eyebrow">Daily detail</p>
          <h3 id="seven-day-outlook-title">Seven-day outlook</h3>
          <p>
            Projected headroom is ERCOT NP3-763 <code>availCapRes</code>: projected available
            generation capacity minus forecast demand for each hour.
          </p>
        </div>
        {outlook.cards.length ? (
          <div className="outlook-day-strip">
            {outlook.cards.map((card) => (
              <DayCard
                card={card}
                key={card.deliveryDate}
                onSelect={() => setSelectedDate(card.deliveryDate)}
                selected={selectedDate === card.deliveryDate}
              />
            ))}
          </div>
        ) : (
          <p className="outlook-empty">No future in-use forecast rows are available.</p>
        )}
        {outlook.days.map((day) => (
          <div
            aria-live="polite"
            className="outlook-hourly-detail"
            hidden={day.card.deliveryDate !== selectedDate}
            id={`outlook-day-detail-${day.card.deliveryDate}`}
            key={day.card.deliveryDate}
          >
            <h4>{dayLabel(day.card.deliveryDate)} hourly detail</h4>
            <div className="table-scroll">
              <table aria-label={`${dayLabel(day.card.deliveryDate)} hourly outlook`}>
                <thead>
                  <tr>
                    <th>Interval ending</th>
                    <th>Demand</th>
                    <th>Projected headroom</th>
                    <th>Day-prior revision</th>
                  </tr>
                </thead>
                <tbody>
                  {day.hours.map((hour) => (
                    <tr key={hour.targetTs}>
                      <td>{timeLabel(hour.targetTs)}</td>
                      <td>{value(hour.demandMw, "MW")}</td>
                      <td>{value(hour.projectedHeadroomMw, "MW")}</td>
                      <td>{value(hour.revisionMw, "MW")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section
        aria-labelledby="outlook-weather-title"
        className="outlook-weather-panel"
        data-weather-state={weatherIsCurrent ? "current" : "stale-or-unavailable"}
      >
        <div>
          <p className="eyebrow">
            {weatherIsCurrent ? "Current observations only" : "Latest observations only"}
          </p>
          <h3 id="outlook-weather-title">Weather context</h3>
          <p>
            Forecast weather driver unavailable. No weather cause is inferred.
            {!weatherIsCurrent ? " Observations may be stale or unavailable." : ""}
          </p>
        </div>
        <div className="outlook-weather-grid">
          {outlook.weather.observations.map((observation) => (
            <article key={observation.station_code}>
              <span>{observation.label}</span>
              <strong>{value(observation.temperature_c, "°C")}</strong>
              <small>{timeLabel(observation.observed_at)}</small>
            </article>
          ))}
        </div>
        {!weatherValues.length ? (
          <p className="outlook-empty">METAR observations unavailable.</p>
        ) : null}
      </section>

      <footer className="outlook-provenance">
        <strong>Dashboard outlook — not an ERCOT declaration</strong>
        <span>{outlook.sourceLabel}</span>
        <span>
          Forecast source {outlook.forecastSourceHealth?.freshness_state ?? "unknown"} · Adequacy
          source {outlook.adequacySourceHealth?.freshness_state ?? "unknown"}
        </span>
      </footer>
    </div>
  );
}

export function OutlookView({ enabled, now = Math.floor(Date.now() / 1_000) }: OutlookViewProps) {
  const outlook = useOutlookData(enabled);
  if (!enabled) return null;
  if (outlook.error) {
    return (
      <section aria-label="Grid Outlook unavailable">
        <DataLifecycleMessage state="unavailable" />
        <Button onClick={() => void outlook.mutate()}>Retry Outlook</Button>
      </section>
    );
  }
  if (!outlook.data) {
    return <DataLifecycleMessage state="loading" />;
  }
  return <OutlookContent outlook={buildGridOutlook(outlook.data, now)} />;
}
