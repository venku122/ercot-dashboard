import { useEffect, useMemo, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { Button } from "../components/ui/button";
import { usePredictiveWeather } from "./data-hooks";
import {
  intervalAt,
  type PredictiveWeatherLayerName,
  type PredictiveWeatherPoint,
  type PredictiveWeatherPointId,
} from "./predictive-weather";

const LAYER_LABELS: Record<PredictiveWeatherLayerName, string> = {
  temperature: "Temperature",
  apparentTemperature: "Apparent temperature",
  heatIndex: "Heat index",
  windChill: "Wind chill",
  windSpeed: "Wind speed",
  windGust: "Wind gust",
};

function timestamp(value: number | null): string {
  return value === null
    ? "Unavailable"
    : new Date(value * 1_000).toLocaleString("en-US", { timeZone: "America/Chicago" });
}

function measurement(value: number | null, unit: string): string {
  if (value === null) return "Missing";
  return unit === "wmoUnit:degC" ? `${value.toFixed(1)} °C` : `${value.toFixed(1)} km/h`;
}

function peakRows(point: PredictiveWeatherPoint, peakTargetTs: number | null) {
  if (peakTargetTs === null) return [];
  return point.layers.flatMap((layer) => {
    const row = intervalAt(point, layer.key, peakTargetTs);
    return row ? [{ layer, row }] : [];
  });
}

export function PredictiveWeatherPanel({
  enabled,
  peakTargetTs,
}: {
  enabled: boolean;
  peakTargetTs: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<PredictiveWeatherPointId>("KDFW");
  const query = usePredictiveWeather(enabled && expanded);
  const point = query.data?.forecast.points.find((item) => item.point_id === selectedPoint) ?? null;
  const linkedRows = useMemo(
    () => (point ? peakRows(point, peakTargetTs) : []),
    [peakTargetTs, point],
  );

  useEffect(() => {
    if (!enabled) setExpanded(false);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <section aria-labelledby="predictive-weather-title" className="predictive-weather-panel">
      <header>
        <div>
          <p className="eyebrow">Optional NWS context</p>
          <h3 id="predictive-weather-title">Predictive weather at representative points</h3>
          <p>
            Four airport-point forecasts share the Outlook time axis. Temporal overlap is context
            only and does not establish attribution to an ERCOT load forecast or grid condition.
          </p>
        </div>
        <Button
          aria-controls="predictive-weather-content"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide predictive weather" : "Show predictive weather"}
        </Button>
      </header>
      {expanded ? (
        <div id="predictive-weather-content">
          {query.isLoading && !query.data ? <DataLifecycleMessage state="loading" /> : null}
          {query.error && !query.data ? <DataLifecycleMessage state="unavailable" /> : null}
          {query.error && query.data ? (
            <p role="status">Refresh failed; showing the last successful weather snapshot.</p>
          ) : null}
          {query.data ? (
            <>
              <div className="predictive-weather-policy" role="note">
                <strong>NWS forecast at representative airport points</strong>
                <span>
                  Dallas/Fort Worth, Austin, Houston Hobby, and San Antonio are point samples—not
                  ERCOT weather zones, area averages, or statewide extrema.
                </span>
              </div>
              <div aria-label="Representative forecast point" className="predictive-weather-points">
                {query.data.forecast.points.map((item) => {
                  const temperature =
                    peakTargetTs === null ? null : intervalAt(item, "temperature", peakTargetTs);
                  return (
                    <button
                      aria-pressed={selectedPoint === item.point_id}
                      data-weather-point={item.point_id}
                      key={item.point_id}
                      onClick={() => setSelectedPoint(item.point_id)}
                      type="button"
                    >
                      <strong>{item.label}</strong>
                      <span>{item.state}</span>
                      <small>
                        {temperature
                          ? `${measurement(temperature.value, "wmoUnit:degC")} at Outlook peak`
                          : "No exact interval at Outlook peak"}
                      </small>
                    </button>
                  );
                })}
              </div>

              {point ? (
                <section aria-labelledby="predictive-weather-point-detail">
                  <h4 id="predictive-weather-point-detail">{point.label} exact forecast context</h4>
                  <p>
                    Official NWS grid update {timestamp(point.update_time)} · retrieved{" "}
                    {timestamp(point.retrieved_at)}
                  </p>
                  {linkedRows.length ? (
                    <div className="predictive-weather-context-grid">
                      {linkedRows.map(({ layer, row }) => (
                        <article key={layer.key}>
                          <span>{LAYER_LABELS[layer.key]}</span>
                          <strong>{measurement(row.value, layer.unit)}</strong>
                          <small>
                            Exact interval {timestamp(row.valid_start)}–{timestamp(row.valid_end)}
                          </small>
                          {layer.key === "temperature" && row.value !== null && row.value <= 0 ? (
                            <em>Dashboard derived: forecast at or below freezing</em>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p>No native NWS interval contains the selected Outlook peak timestamp.</p>
                  )}
                  <details>
                    <summary>Exact NWS forecast intervals</summary>
                    <div
                      aria-label={`${point.label} exact NWS forecast intervals`}
                      className="table-scroll"
                      role="region"
                      tabIndex={0}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>Official layer</th>
                            <th>Valid start</th>
                            <th>Valid end</th>
                            <th>Value</th>
                            <th>Provenance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {point.layers.flatMap((layer) =>
                            layer.rows.map((row) => (
                              <tr key={`${layer.key}-${row.valid_start}-${row.valid_end}`}>
                                <td>{LAYER_LABELS[layer.key]}</td>
                                <td>{timestamp(row.valid_start)}</td>
                                <td>{timestamp(row.valid_end)}</td>
                                <td>{measurement(row.value, layer.unit)}</td>
                                <td>Official NWS · {layer.unit}</td>
                              </tr>
                            )),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              ) : null}

              <section aria-labelledby="predictive-weather-alerts-title">
                <h4 id="predictive-weather-alerts-title">NWS weather alerts</h4>
                <p>
                  Texas statewide, not ERCOT footprint. NWS weather severity is not an ERCOT grid
                  alert, EEA, or conservation status.
                </p>
                {query.data.alerts.state === "valid_empty" ? (
                  <p>No active Texas NWS alerts in the latest valid collection.</p>
                ) : null}
                {query.data.alerts.state === "failed" ||
                query.data.alerts.state === "unavailable" ? (
                  <p>Texas NWS alert evidence is unavailable.</p>
                ) : null}
                {query.data.alerts.items.map((alert) => (
                  <article className="predictive-weather-alert" key={alert.id}>
                    <span>Official NWS · {alert.severity}</span>
                    <strong>{alert.headline ?? alert.event}</strong>
                    <small>
                      Effective {timestamp(alert.effective)} · expires {timestamp(alert.expires)}
                    </small>
                    <p>{alert.area_desc}</p>
                    <a href={alert.source_url} rel="noreferrer" target="_blank">
                      Open official NWS alert
                    </a>
                  </article>
                ))}
                {query.data.alerts.items.length ? (
                  <details>
                    <summary>Exact NWS alert evidence</summary>
                    <div
                      aria-label="Exact Texas NWS alert evidence"
                      className="table-scroll"
                      role="region"
                      tabIndex={0}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>Official identity</th>
                            <th>Event</th>
                            <th>Message</th>
                            <th>Effective</th>
                            <th>Expires</th>
                            <th>Severity / certainty / urgency</th>
                            <th>Area</th>
                          </tr>
                        </thead>
                        <tbody>
                          {query.data.alerts.items.map((alert) => (
                            <tr key={alert.id}>
                              <td>
                                <a href={alert.source_url} rel="noreferrer" target="_blank">
                                  {alert.id}
                                </a>
                              </td>
                              <td>{alert.event}</td>
                              <td>{alert.message_type}</td>
                              <td>{timestamp(alert.effective)}</td>
                              <td>{timestamp(alert.expires)}</td>
                              <td>
                                {alert.severity} / {alert.certainty} / {alert.urgency}
                              </td>
                              <td>{alert.area_desc}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}
              </section>

              <details>
                <summary>Source freshness</summary>
                <ul>
                  {query.data.source_health.map((health) => (
                    <li key={health.source_id}>
                      {health.source_id}: {health.state}; source updated{" "}
                      {timestamp(health.source_updated_at)}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
