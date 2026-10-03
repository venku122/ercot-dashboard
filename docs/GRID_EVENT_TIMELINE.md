# Unified grid event timeline

PR19 adds a revision-aware, multi-source event timeline without treating temporal proximity as
causal attribution. The public policy identifier is
`multi_source_temporal_context_not_causal_attribution`.

## Evidence sources

The timeline preserves four evidence classes:

- `official_ercot`: direct ERCOT Operations Messages. The source publishes Central wall time
  without a repeated-hour flag, so a fall-back-hour message retains both possible UTC candidates.
- `official_weather`: NWS CAP alerts retained from the PR18 Texas active-alert stream. Coverage is
  Texas statewide, not the ERCOT footprint, and NWS severity is not an ERCOT grid-alert or EEA
  level.
- `source_observation`: the exact EEA state sampled from ERCOT's daily PRC dashboard. Its source
  epoch is an observation time, not an official EEA declaration time.
- `derived_annotation`: a versioned deterministic dashboard annotation with exact input
  identities. PR19 derives only `eea_transition_v1` when two consecutive collected EEA source
  observations have different levels.

TXANS defines Weather Watch, Voluntary Conservation Notice, and Conservation Appeal, and it does
not replace EEA. ERCOT does not expose a reviewed structured TXANS history feed with stable event
and revision identity, so the public contract reports `unavailable_unverified_source`. PR19 never
synthesizes TXANS events from weather, reserve values, news text, or Operations Messages.

## Collection and retention

The existing Operations Messages and EEA collectors also submit strict event evidence to the
receiver. Their legacy metric/event outputs remain available during migration. PR18 alert ingest
materializes NWS evidence inside the receiver, so it does not require a second NWS request.

Official/source evidence is retained for 400 days and dashboard-derived evidence for 90 days.
These are application retention bounds, not claims about upstream archive completeness. Coverage
begins when each collector starts. Operations Messages with an ambiguous repeated hour remain
queryable using either possible UTC candidate.

Each logical identity has an append-only revision history and a monotonic current pointer. Exact
replays are idempotent, older revisions cannot replace newer evidence, and changed bytes at the
same source clock fail closed as a collision. Corrections append a content-addressed revision; they
do not rewrite an older revision.

## API

Authenticated collection uses:

```text
POST /api/grid-events/ingest
```

The strict streams are `operations_messages`, `eea`, and `derived_annotations`. NWS evidence is
receiver-internal to the existing predictive-weather alert ingest. The legacy `/api/events/ingest`
and `/api/v1/events` routes remain unchanged.

Selected history uses:

```text
GET /api/v1/grid-events?from=<utc_epoch>&to=<utc_epoch>&limit=<1..500>&cursor=<opaque>
```

The window is half-open `[from,to)`, required, and limited to 31 days. Event intervals use overlap
semantics; point events must occur inside the window. Results are ordered by the later possible
start descending and identity ascending. A fall-back-hour event matches a window containing either
candidate. Pagination is explicit and cursors are bound to the exact requested window.

Responses expose coverage, known gaps, retention limits, and a nullable next cursor. They use
strong ETags, conditional `304`, bounded singleflight, short revalidation caching, and
generation-aware invalidation. Historical event windows are not described as immutable because
official updates and cancellations can arrive later.

## Frontend behavior

The unified endpoint is lazy and requested only in Reliability when event annotations are enabled.
Window changes, disabling, navigation, and unmount abort owned work; an old response cannot mix
with a new window. Existing current-status consumers continue to use the legacy current event path.

Permalinks retain the exact fixed UTC window and event identity. Storage-context replay links reuse
the same window only when it is 24 hours or less and the event has an unambiguous UTC start. The
link aligns display windows; it does not join observations, interpolate gaps, or claim that storage
responded to an event.

The timeline and its exact table display evidence class, source, native time basis, status,
severity, derivation method, and content version. Empty, failed, stale-last-good, paginated, and
known-gap states remain distinct.

## Deferred evidence gates

- complete TXANS ingest after an authoritative structured archive/feed is verified;
- NWS alert history before PR19 or an NCEI backfill contract;
- ERCOT-footprint weather filtering after reviewed boundary geometry exists;
- full historical Operations Messages backfill;
- additional derived threshold annotations after their source and methodology contracts are
  independently frozen.
