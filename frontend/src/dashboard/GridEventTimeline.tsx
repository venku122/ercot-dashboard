import { useEffect, useMemo, useRef, useState } from "react";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import { useGridEventTimeline } from "./data-hooks";
import {
  GRID_EVENT_MAX_WINDOW_SECONDS,
  gridEventIdentityFromUrl,
  gridEventPermalink,
  gridEventReplayUrl,
  type GridEvent,
  type GridEventEvidenceClass,
} from "./grid-event-timeline";
import type { TimeState } from "./types";

const EVIDENCE_LABELS: Record<GridEventEvidenceClass, string> = {
  official_ercot: "Official ERCOT event",
  official_weather: "Official NWS weather alert",
  source_observation: "Source observation",
  derived_annotation: "Dashboard derived annotation",
};

const FILTERS: ReadonlyArray<{ value: "all" | GridEventEvidenceClass; label: string }> = [
  { value: "all", label: "All evidence" },
  { value: "official_ercot", label: "Official ERCOT" },
  { value: "official_weather", label: "Official NWS weather" },
  { value: "source_observation", label: "Source observations" },
  { value: "derived_annotation", label: "Dashboard derived" },
];

function timestamp(value: number): string {
  return new Date(value * 1_000).toLocaleString("en-US", { timeZone: "America/Chicago" });
}

function eventTime(event: GridEvent): string {
  if (event.starts_at !== null) return timestamp(event.starts_at);
  return `Ambiguous repeated hour · ${event.starts_at_candidates.map(timestamp).join(" or ")}`;
}

function eventInterval(event: GridEvent): string {
  const start = eventTime(event);
  return event.ends_at === null ? start : `${start}–${timestamp(event.ends_at)}`;
}

function timeBasisLabel(value: GridEvent["time_basis"]): string {
  if (value === "utc_exact") return "Exact UTC";
  if (value === "america_chicago_wall_ambiguous") return "Ambiguous repeated Chicago hour";
  if (value === "source_snapshot_epoch_not_official_declaration_time") {
    return "Source snapshot time, not official declaration time";
  }
  return "Derived from exact UTC inputs";
}

function gapLabel(gap: string): string {
  if (gap === "txans_unavailable_unverified_source") {
    return "TXANS event history is unavailable because no authoritative feed is verified.";
  }
  if (gap === "operations_messages_repeated_hour_ambiguous") {
    return "Operations messages in the repeated Chicago fall-back hour retain both possible UTC timestamps.";
  }
  return "History begins when each collector started; earlier absence is not a verified empty period.";
}

export function GridEventTimeline({ enabled, time }: { enabled: boolean; time: TimeState }) {
  const from = Math.round(time.start);
  const to = Math.round(time.end);
  const validWindow = to > from && to - from <= GRID_EVENT_MAX_WINDOW_SECONDS;
  const query = useGridEventTimeline(enabled && validWindow, from, to);
  const [filter, setFilter] = useState<"all" | GridEventEvidenceClass>("all");
  const eventRefs = useRef(new Map<string, HTMLElement>());
  const focusedIdentity =
    typeof window === "undefined" ? null : gridEventIdentityFromUrl(new URL(window.location.href));
  const events = query.data?.events ?? [];
  const visibleEvents = useMemo(
    () => (filter === "all" ? events : events.filter((event) => event.evidence_class === filter)),
    [events, filter],
  );
  const focusMissing =
    focusedIdentity !== null && !events.some((event) => event.identity === focusedIdentity);

  useEffect(() => {
    if (!focusedIdentity || focusMissing) return;
    const element = eventRefs.current.get(focusedIdentity);
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [focusMissing, focusedIdentity, query.data?.content_version]);

  if (!enabled) return null;
  return (
    <section aria-label="Unified grid event timeline" className="events-panel grid-event-panel">
      <header className="grid-event-heading">
        <div>
          <p className="eyebrow">Shared UTC history</p>
          <h2>Unified grid event timeline</h2>
          <p>
            ERCOT, NWS, source-observation, and dashboard-derived evidence share a display window.
            Temporal overlap does not establish attribution or operational intent.
          </p>
        </div>
      </header>

      {!validWindow ? (
        <div className="grid-event-window-limit" role="status">
          <strong>Selected event window exceeds 31 days.</strong>
          <p>Choose a range of 31 days or less; no event request was made.</p>
        </div>
      ) : null}
      {validWindow && query.isLoading && !query.data ? (
        <DataLifecycleMessage state="loading" />
      ) : null}
      {validWindow && query.error && !query.data ? (
        <DataLifecycleMessage
          detail="The selected multi-source event window could not be loaded. Existing current-status notices remain independent."
          state="unavailable"
        />
      ) : null}
      {query.error && query.data ? (
        <p role="status">Refresh failed; showing the last successful event-window response.</p>
      ) : null}

      {query.data ? (
        <>
          <div className="grid-event-coverage" role="note">
            <article data-coverage="operations">
              <strong>ERCOT operations messages</strong>
              <span>Collector-accumulated official messages</span>
            </article>
            <article data-coverage="eea">
              <strong>EEA source observations</strong>
              <span>Snapshot time is not an official declaration time</span>
            </article>
            <article data-coverage="nws">
              <strong>NWS weather alerts</strong>
              <span>Texas statewide, not ERCOT footprint; collected after PR19</span>
            </article>
            <article data-coverage="txans">
              <strong>TXANS unavailable</strong>
              <span>No verified authoritative event feed; no events are synthesized</span>
            </article>
          </div>

          <details className="grid-event-gaps">
            <summary>Coverage limits and known gaps</summary>
            <ul>
              {query.data.gaps.map((gap) => (
                <li key={gap}>{gapLabel(gap)}</li>
              ))}
            </ul>
          </details>

          {focusMissing ? (
            <p className="grid-event-focus-missing" role="status">
              The focused event is not present in this page or retained window. Review the known
              coverage limits or return to the complete evidence filter.
            </p>
          ) : null}

          <div className="grid-event-controls">
            <p aria-live="polite">
              Showing {visibleEvents.length} of {events.length} events, newest first
            </p>
            <label>
              <span>Evidence</span>
              <select
                aria-label="Filter unified timeline by evidence class"
                onChange={(event) =>
                  setFilter(event.target.value as "all" | GridEventEvidenceClass)
                }
                value={filter}
              >
                {FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} (
                    {option.value === "all"
                      ? events.length
                      : events.filter((event) => event.evidence_class === option.value).length}
                    )
                  </option>
                ))}
              </select>
            </label>
          </div>

          {visibleEvents.length ? (
            <ol
              aria-label="Multi-source historical grid event timeline"
              className="grid-event-list"
            >
              {visibleEvents.map((event) => {
                const focused = event.identity === focusedIdentity;
                const replayUrl = gridEventReplayUrl(event, time, new URL(window.location.href));
                return (
                  <li
                    data-event-evidence={event.evidence_class}
                    data-event-focused={focused}
                    key={event.identity}
                  >
                    <article
                      ref={(element) => {
                        if (element) eventRefs.current.set(event.identity, element);
                        else eventRefs.current.delete(event.identity);
                      }}
                      tabIndex={-1}
                    >
                      <header>
                        <time>{eventTime(event)}</time>
                        <span>{EVIDENCE_LABELS[event.evidence_class]}</span>
                        <span>{event.event_type}</span>
                        {event.severity ? <span>{event.severity}</span> : null}
                      </header>
                      <strong>{event.title}</strong>
                      {event.body && event.body !== event.title ? <p>{event.body}</p> : null}
                      <dl>
                        <div>
                          <dt>Source</dt>
                          <dd>{event.source_id}</dd>
                        </div>
                        <div>
                          <dt>Exact interval</dt>
                          <dd>{eventInterval(event)}</dd>
                        </div>
                        <div>
                          <dt>Status</dt>
                          <dd>{event.status ?? "Not reported"}</dd>
                        </div>
                        <div>
                          <dt>Time basis</dt>
                          <dd>{timeBasisLabel(event.time_basis)}</dd>
                        </div>
                      </dl>
                      {event.derivation ? (
                        <p className="grid-event-derivation">
                          Dashboard derived · {event.derivation.method} · {event.derivation.version}{" "}
                          · exact inputs {event.derivation.input_identities.join(", ")}
                        </p>
                      ) : null}
                      {event.evidence_class === "official_weather" ? (
                        <p className="grid-event-weather-policy">
                          Official NWS weather severity; not an ERCOT grid alert, EEA, or
                          conservation level.
                        </p>
                      ) : null}
                      <nav aria-label={`Links for ${event.title}`} className="grid-event-links">
                        {event.source_url ? (
                          <a href={event.source_url} rel="noreferrer" target="_blank">
                            Open official source
                          </a>
                        ) : null}
                        <a
                          href={gridEventPermalink(
                            event.identity,
                            time,
                            new URL(window.location.href),
                          ).toString()}
                        >
                          Permalink to fixed event window
                        </a>
                        {replayUrl ? (
                          <a href={replayUrl.toString()}>
                            Open synchronized storage-context window
                          </a>
                        ) : (
                          <span className="grid-event-replay-unavailable">
                            Replay needs one unambiguous UTC timestamp and a selected window of 24
                            hours or less
                          </span>
                        )}
                      </nav>
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="grid-event-empty" role="status">
              <strong>
                {events.length
                  ? "No events match this evidence filter."
                  : "No collected events overlap this window."}
              </strong>
              <p>
                Known coverage gaps remain listed above; empty does not mean every source was
                observed.
              </p>
            </div>
          )}

          {query.data.next_cursor ? (
            <p className="grid-event-pagination" role="status">
              More events are available after this page. Narrow the fixed window to review all exact
              rows; this page is not presented as complete.
            </p>
          ) : null}

          <details className="grid-event-exact">
            <summary>Exact event evidence</summary>
            <div
              aria-label="Unified grid event exact evidence"
              className="table-scroll"
              role="region"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Identity</th>
                    <th>Evidence class</th>
                    <th>Source</th>
                    <th>Exact time</th>
                    <th>Observed at</th>
                    <th>Source updated at</th>
                    <th>Time basis</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Severity</th>
                    <th>Title</th>
                    <th>Source or derivation</th>
                    <th>Content version</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.identity}>
                      <td>{event.identity}</td>
                      <td>{EVIDENCE_LABELS[event.evidence_class]}</td>
                      <td>{event.source_id}</td>
                      <td>{eventInterval(event)}</td>
                      <td>{timestamp(event.observed_at)}</td>
                      <td>{timestamp(event.source_updated_at)}</td>
                      <td>{event.time_basis}</td>
                      <td>{event.event_type}</td>
                      <td>{event.status ?? "Not reported"}</td>
                      <td>{event.severity ?? "Not reported"}</td>
                      <td>{event.title}</td>
                      <td>
                        {event.derivation
                          ? `${event.derivation.method} ${event.derivation.version}: ${event.derivation.input_identities.join(", ")}`
                          : (event.source_url ?? "Source URL not supplied")}
                      </td>
                      <td>{event.content_version}</td>
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
