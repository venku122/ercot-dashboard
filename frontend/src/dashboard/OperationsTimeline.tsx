import { useMemo, useState } from "react";

import {
  buildOperationsTimeline,
  filterOperationsTimeline,
  operationsSeverityOptions,
  type OperationsSeverity,
} from "./operations-timeline";
import type { EventRecord } from "./types";

export function OperationsTimeline({ events }: { events: readonly EventRecord[] }) {
  const [severity, setSeverity] = useState<"all" | OperationsSeverity>("all");
  const timeline = useMemo(() => buildOperationsTimeline(events), [events]);
  const visibleEvents = useMemo(
    () => filterOperationsTimeline(timeline, severity),
    [severity, timeline],
  );
  const selectedLabel =
    operationsSeverityOptions.find((option) => option.value === severity)?.label ??
    "All severities";

  if (!timeline.length) {
    return (
      <div className="operations-timeline-empty" role="status">
        <strong>No recorded operations events in this window</strong>
        <p>Choose a longer time range to review earlier ERCOT notices.</p>
      </div>
    );
  }

  return (
    <div className="operations-timeline-view">
      <div className="operations-timeline-controls">
        <p aria-live="polite">
          Showing {visibleEvents.length} of {timeline.length} event
          {timeline.length === 1 ? "" : "s"}, newest first
        </p>
        <label>
          <span>Severity</span>
          <select
            aria-label="Filter operations timeline by severity"
            onChange={(event) => setSeverity(event.target.value as "all" | OperationsSeverity)}
            value={severity}
          >
            {operationsSeverityOptions.map((option) => {
              const count =
                option.value === "all"
                  ? timeline.length
                  : timeline.filter((event) => event.timelineSeverity === option.value).length;
              return (
                <option key={option.value} value={option.value}>
                  {option.label} ({count})
                </option>
              );
            })}
          </select>
        </label>
      </div>
      {visibleEvents.length ? (
        <ol aria-label="Historical operations timeline" className="operations-timeline">
          {visibleEvents.map((event) => (
            <li data-event-severity={event.timelineSeverity} key={event.dedupe_key}>
              <span aria-hidden="true" className="operations-timeline-marker" />
              <article>
                <header>
                  <time dateTime={new Date(event.starts_at * 1000).toISOString()}>
                    {new Date(event.starts_at * 1000).toLocaleString()}
                  </time>
                  <span className="event-category">{event.categoryLabel}</span>
                  <span className="event-severity">{event.severityLabel}</span>
                  <span className="event-status">{event.status ?? "Status not reported"}</span>
                </header>
                <strong>{event.title}</strong>
                {event.body && event.body !== event.title ? <p>{event.body}</p> : null}
              </article>
            </li>
          ))}
        </ol>
      ) : (
        <div className="operations-timeline-empty" role="status">
          <strong>No {selectedLabel.toLowerCase()} events in this window</strong>
          <p>Choose another severity or a longer time range.</p>
        </div>
      )}
    </div>
  );
}
