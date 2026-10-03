# Forecast vintage receiver contract

PR09 stores three live-verified ERCOT Public API products without expanding each
zone or measure into generic metric rows:

- `NP3-565-CD`: one wide row per publication, target hour, and model. The
  `inUseFlag` value is an attribute, not part of identity.
- `NP3-763-CD`: one wide system-adequacy row per publication and target hour.
- `NP6-345-CD`: one wide actual weather-zone-load row per content snapshot and
  target hour.

The parent `forecast_publications` row carries source, product, immutable
content hash, retrieval provenance, schema fingerprint, and unit provenance.
Only the receiver allowlisted source ID, exact artifact endpoint, parser schema
version, ordered field-and-type fingerprint, and `MW` or an unknown unit are
accepted. The exact live field order is frozen in `forecast_vintages.py`.
The `MW` adapter declaration is grounded in ERCOT's System-Wide Demand display
for the NP3-565/NP6-345 load sources and ERCOT STAR Help definitions for the
NP3-763 capacity and forecast-demand measures. The receiver does not infer any
other unit.

For Grid Outlook, the current ERCOT
[`STAR_help_description_20251205.docx`](https://www.ercot.com/files/docs/2021/06/10/STAR_help_description_20251205.docx)
defines API field `availCapRes` (help field `AvailCapReserve`) as `AvailCapGen`
minus forecasted demand for each hour. The bounded Outlook contract therefore
uses only `availCapRes` as projected headroom and exposes `availCapGen` as
projected available generation capacity. It does not use `capGenRes` as
headroom; that field is available online generation capacity from COP HSL.
Query provenance accepts only each product adapter's exact ERCOT filter
allowlist. Values must be bounded scalars; unknown, nested, or sensitive-looking
keys never reach storage or public responses. Keys are normalized and sorted
before first-seen diagnostic persistence, but are not part of immutable identity.
The optional NP3-565 query filter accepts the live-verified model vocabulary;
publication rows themselves retain every bounded model string and `inUseFlag`
without filtering.

## Time and identity

`target_ts` is the UTC end instant of the ERCOT America/Chicago market hour. The
receiver independently reconstructs it from the raw operating/delivery date,
hour-ending label, and repeat flag. A normal day has HE1..HE24, spring transition
days omit HE2, and fall transition days contain HE2 false followed by HE2 true.
HE24 ends at the next local midnight. Caller timestamps that disagree are
rejected.

Forecast `postedDatetime` values are retained as raw local text and must map to
one unambiguous America/Chicago instant equal to `issued_at`. Ambiguous fall or
nonexistent spring posting times are rejected until an authoritative offset or
fold is available. Forecast publication identity is the official posted text.
NP6-345 exposes no verified posting time, so its identity kind is an immutable
content snapshot; it retains `retrieved_at` and does not invent issue or publish
times. Caller retrieval time may be at most five minutes ahead of receiver time,
preventing a future timestamp from permanently dominating actual selection.

Callers never choose the public `vintage_key`. The receiver derives it from the
canonical source, schema, immutable unit and publication provenance, official
identity, and complete normalized rows.
Retrieval time and query window are observational provenance: shifted overlap
windows replay unchanged and preserve the first-seen provenance. Changed rows
under the same official forecast posting key remain a collision; an official
correction must have a distinct publication key. Actual content changes form a
new content snapshot. Internal SQLite IDs are never returned.

## APIs and cache scope

- Authenticated `POST /api/forecast-publications/ingest` accepts one nonempty,
  bounded wide publication with a reviewed route-specific 1 MiB body cap. Other
  receiver routes retain the existing 512 KiB cap.
- `GET /api/v1/forecast-publications` and
  `GET /api/v1/forecast-comparison` are bounded diagnostic APIs with
  `Cache-Control: no-store`. Comparison requires explicit forecast and actual
  source/product identities, selects a forecast known at or before `as_of`, and
  chooses the newest retrieved actual snapshot independently for each target.
  Rows whose target precedes the selected forecast issue are omitted. Remaining
  errors are explicitly known-at diagnostics with a nonnegative horizon, not a
  general forecast-quality analytics contract.
- `GET /api/v1/outlook` is the fixed, no-query current-view contract used only
  when the Outlook view is opened. It selects the latest NP3-565 publication,
  requires at most one `inUseFlag=true` model per target, joins the latest
  publication issued at least 24 hours earlier for target-matched revisions,
  and aligns the latest NP3-763 `availCapRes` values. Results are ordered and
  bounded to 193 target hours, use a short mutable cache with a strong ETag,
  and are invalidated when a new forecast publication is inserted. It also
  carries bounded NP3-565/NP3-763 collector health so valid-empty, stale, and
  failed collection states remain distinct from target-hour coverage, plus
  optional latest KDFW/KAUS/KHOU/KSAT METAR temperatures in a clearly
  labeled `current_observations_only` block with METAR availability,
  collection, and freshness state. The UI changes that label when the source is
  stale or failed. These observations are not a weather forecast and no causal
  weather driver or ERCOT status is inferred.
  Predictive weather-driver integration is explicitly deferred to PR18.
  Current outage and reserve context is not part of this PR10 contract and is
  not claimed by its cards.
- `GET /api/v2/forecast-publications/{source}/{product}/{vintage}/1d/{start}` is
  a canonical UTC-aligned, content-addressed target-axis resource with a strong
  ETag and immutable cache policy. It omits observational retrieval/query
  provenance so the same vintage has identical bytes across replicas and
  rebuilds; that provenance remains available from the no-store diagnostic API.

These publication resources preserve the finalized historical bytes. They are
not yet dashboard chart tiles. PR11 must add catalog identities, LOD aggregation,
frontend selection, and any per-target forecast-horizon policy. Existing generic
forecast metrics are not migrated because their issue time and publication
identity cannot be reconstructed safely.
