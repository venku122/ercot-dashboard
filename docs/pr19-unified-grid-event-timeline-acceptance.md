# PR19 unified grid event timeline acceptance

PR19 presents multiple event sources on one UTC window without merging their identities or implying
that one source caused another. Direct ERCOT messages, official NWS weather alerts, exact source
observations, and deterministic dashboard annotations remain visibly and structurally distinct.

## Source and provenance boundary

- `official_ercot` means a direct ERCOT operations or TXANS publication. TXANS remains
  `unavailable_unverified_source` until an authoritative event feed with stable identity and issued,
  effective, ending, update, and cancellation semantics is reviewed. Static explanatory or active
  web pages are never synthesized into historical TXANS events.
- `official_weather` means a direct NWS alert collected from the PR18 Texas active-alert stream. Its
  coverage is **Texas statewide, not ERCOT footprint**, and its NWS severity is never displayed as
  an ERCOT grid-alert, EEA, or conservation level.
- `source_observation` preserves an exact source observation and its native timestamp basis. An EEA
  source snapshot is not silently promoted to an official declaration timestamp.
- `derived_annotation` is deterministic dashboard methodology with exact referenced inputs. It is
  never labeled official and does not interpolate across missing evidence.
- Coincident events from different sources remain separate. Similar titles, overlapping intervals,
  references, or nearby timestamps do not authorize cross-source deduplication, joining, or causal
  attribution.

The timeline policy is `multi_source_temporal_context_not_causal_attribution`. Copy never says an
NWS alert, EEA observation, operations message, TXANS notice, or dashboard annotation caused,
triggered, drove, explained, or resulted in another event or grid behavior.

## Window and receiver contract

- `GET /api/v1/grid-events?from=<epoch>&to=<epoch>` uses exact integer UTC seconds and half-open
  `[from,to)` semantics. The exact query allowlist adds only optional bounded `limit` and opaque
  `cursor`; duplicate, extra, noncanonical, reversed, or over-31-day requests fail closed.
- Events overlapping the window are included, including an event that starts before `from` and ends
  after it. An event beginning exactly at `to` is excluded.
- Ordering is `starts_at` descending then canonical `identity` ascending. A canonical identity is
  stable across refreshes; a content revision changes its `content_version`, response bytes, and
  ETag without replacing the source identity.
- Strong ETag bytes are stable, matching `If-None-Match` returns `304`, cold concurrent requests
  singleflight, and invalidation during generation cannot repopulate stale bytes.
- Operations, EEA, NWS, and derived-annotation changes invalidate matching current-window
  responses. Historical responses remain revalidated rather than immutable because cancellations
  and corrections can arrive later.
- Pagination is explicit through `next_cursor`; no page or UI calls a capped result complete. The
  response exposes exact retention bounds, coverage states, and known gaps, including repeated-hour
  ambiguity and history beginning at collection.

## Lazy lifecycle and existing status consumers

1. The unified selected-window endpoint is requested only in Reliability while event annotations
   are enabled. It makes zero requests outside Reliability or while events are disabled.
2. Existing current-status event consumers remain independent. PR19 does not duplicate or remove
   the current status request used by operating summaries, public alerts, chart annotations, or the
   mobile current-notice drawer.
3. Entering Reliability issues one canonical selected-window request. A matching SWR key deduplicates
   unchanged rerenders and reopening.
4. Window switch, view exit, disable, and unmount abort timeline-owned work. A late old-window result
   cannot overwrite or mix with the current window.
5. Partial, stale last-good, refresh-failed, unavailable-source, explicit-gap, empty-window, and
   paginated states remain visibly distinct. Failure is never presented as a valid empty window.

## Share and synchronized replay

- A canonical event permalink preserves the exact fixed `from`, `to`, `range`, `events=1`,
  Reliability view, and event `identity`. Reload and browser back/forward focus the same event when it
  remains present; a missing focused identity gets an explicit recovery message.
- The synchronized storage-context replay link carries the same fixed UTC window to Generation and
  opens the existing storage chart workspace. It does not join timeline rows to storage evidence,
  auto-open an unsupported causal narrative, or claim battery response.
- Replay refuses windows longer than the PR17 24-hour bound instead of clipping them. An ambiguous
  repeated-hour event has no replay link until a user explicitly chooses one of its two UTC
  candidates; the Reliability permalink may still preserve the event and both candidates.
- Common UTC windows mean synchronized display only. Every event and replay observation retains its
  own exact timestamp, cadence, source, gaps, and provenance.

## Accessible and visual contract

- The ordered timeline exposes event time, interval, source, evidence class, type, status, severity,
  title, and source or derivation method using text in addition to color.
- The exact-data table is the complete accessible fallback, with canonical identity and content
  version. It is keyboard focusable and owns horizontal scrolling.
- Controls and links have visible focus and a minimum 44 by 44 CSS-pixel target. Focused events can
  be reached without pointer input, and reduced-motion preferences disable nonessential scrolling.
- At 440 by 956 CSS pixels there is no body-level horizontal overflow. Long titles, alert text,
  coverage policy, URLs, and gap copy wrap within the timeline.
- Desktop Chromium and iPhone Pro Max WebKit visual evidence covers all provenance classes, NWS
  statewide wording, unavailable TXANS, known gaps, pagination, focused replay links, and the exact
  table. Darwin and pinned Playwright Noble baselines are followed immediately by no-update
  comparisons.

## Independent gates

Receiver black-box acceptance covers canonical window/query rejection, overlap boundaries, strict
event and source enums, revisions and cancellation, no cross-source merging, exact ordering,
coverage/gaps/retention, pagination, bytes/ETag/304, ingest and health invalidation, cold singleflight,
and inflight invalidation.

Frontend acceptance covers strict key allowlists, bounds and enums; all evidence labels; NWS versus
grid-alert semantics; known gaps; exact ordering/table; zero off-view/disabled fanout; one selected
request; abort and stale-generation rejection; URL reload/back/forward focus; fixed-window replay
links; 44-pixel controls; mobile containment; and partial, stale, refresh-failed, empty, unavailable,
and paginated states.

## Deferred

- TXANS event ingestion remains blocked on a reviewed authoritative feed.
- Pre-PR19 NWS alert history and observations before collector retention began cannot be recreated.
- Full ERCOT public-notice archive backfill, footprint-filtered NWS alerts, immutable daily event
  resources, and additional frequency/price/reserve annotations require separate reviewed source and
  methodology contracts.
