# PR18 predictive weather acceptance

PR18 adds bounded predictive National Weather Service context to Outlook. It relates official NWS
forecast intervals to already-loaded ERCOT load-forecast timestamps without claiming that weather
caused load, storage, price, or grid conditions. NWS alerts remain weather-source evidence and are
never presented as ERCOT grid alerts.

## Frozen representative points

The P0 forecast contract contains exactly four WGS84 representative airport points in this order.
The identity includes the station code and `representative-airport-points-v1` methodology, so changing a
coordinate or methodology creates a new canonical identity rather than silently changing history.

| Identity | Label             | Latitude | Longitude |
| -------- | ----------------- | -------: | --------: |
| `KDFW`   | Dallas/Fort Worth |  32.8974 |  -97.0220 |
| `KAUS`   | Austin            |  30.1831 |  -97.6806 |
| `KHOU`   | Houston Hobby     |  29.6458 |  -95.2821 |
| `KSAT`   | San Antonio       |  29.5443 |  -98.4839 |

These are representative points, not ERCOT weather-zone boundaries or an assertion of statewide
coverage. Forecast UI copy says “NWS forecast at representative airport points.”

## Receiver and cache contract

- `GET /api/v1/predictive-weather` is the single fixed current resource. It rejects every query
  parameter rather than allowing alternate cache identities.
- The response has exactly four point states plus a distinct Texas-alert state. A point or alert
  stream is explicitly `available`, `stale`, `unavailable`, or partial as defined by the stable
  parser contract; missing evidence is never replaced with zero or an empty successful snapshot.
- A successful NWS active-alert response containing no alerts is a valid empty state. Network,
  parse, or refresh failure is not.
- Strong ETag bytes are stable: a matching `If-None-Match` returns `304`, cold concurrent requests
  singleflight, and invalidation during generation cannot repopulate stale bytes.
- Forecast ingest, alert ingest, and relevant source-health changes invalidate the current resource.
  Forecast and alert streams update independently, so one healthy stream is not discarded when the
  other fails.
- Point-to-grid mappings are keyed by the frozen point identity and methodology. Concurrent mapping
  misses singleflight; conditional `304` preserves the reviewed mapping; a changed canonical grid
  URL invalidates the old grid response before fetch. Failures are never cached as empty mappings.
- Forecast responses preserve official update/retrieval time, validity intervals, units, nullable
  values, and conditional-response metadata. Alert responses preserve their official identity,
  event/headline, severity/urgency/certainty, validity times, area description, instructions, and
  source link within reviewed bounds.
- Texas alerts are labeled “Texas statewide, not ERCOT footprint.” P0 does not infer ERCOT-footprint
  intersection because reviewed ERCOT boundary geometry is unavailable.

## Outlook linkage and truthfulness

- A forecast observation is linked to an Outlook load target only when
  `valid_start <= target_timestamp < valid_end`. Boundary-end, nearest, interpolated, previous, or
  next values are not borrowed.
- The peak load timestamp and NWS interval retain their exact native UTC timestamps. Local display
  is additional presentation, not a replacement for exact UTC evidence.
- Heat, freeze, and wind context is labeled **Dashboard derived**, with a visible method and source
  units. NWS values and alerts remain labeled **Official NWS**.
- Copy may say observations overlap in time. It never says weather “caused,” “drove,” “explains,”
  “resulted in,” or “triggered” an ERCOT forecast, price, storage action, or grid alert.
- NWS alerts do not enter the existing ERCOT operations event stream, top-level grid-alert policy,
  or Operations Timeline. Weather and grid-alert semantics remain structurally and visually
  distinct.
- Existing current METAR observations remain observation context. PR18 does not refetch them or
  relabel them as forecasts.

## Lazy lifecycle and request ownership

1. Outside Outlook and while the predictive-weather disclosure is collapsed, there are zero
   predictive-weather requests.
2. Opening the disclosure issues exactly one current predictive-weather request. It reuses the
   already-loaded Outlook/load and METAR context and issues no duplicate Outlook, load, forecast,
   adequacy, or METAR request.
3. Collapse, Outlook exit, disable, and unmount abort panel-owned work. A late response from an old
   request generation cannot overwrite a newer view or mix point and alert generations.
4. Reopening an unchanged current identity respects canonical request deduplication. Refresh failure
   preserves visibly stale last-good evidence and cannot be presented as current.
5. Forecast partial, alert partial, valid-empty alert, stale, refresh-failed, and unavailable states
   remain visibly distinct. One stream remains usable when the other is degraded.

## Visual and accessible contract

- The exact-data table is the complete accessible fallback. It includes representative point,
  provenance, validity start/end, value, unit, source update time, and linked load target where
  present. The alert table preserves official alert identity and validity.
- Controls have visible focus and at least a 44 by 44 CSS-pixel target. Status is not communicated by
  color alone, tables have accessible names, and reduced motion disables nonessential animation.
- At 440 by 956 CSS pixels there is no body-level horizontal overflow. Wide plots and tables own
  their internal scrolling; long alert, policy, and freshness text wraps within the panel.
- Desktop Chromium and iPhone Pro Max WebKit visual evidence covers heat/freeze/wind context, a
  valid-empty Texas alert state, mixed partial/stale state, noncausal copy, and exact tables.
  Checked-in baselines include local Darwin and pinned Playwright Noble variants followed
  immediately by no-update comparisons. The mobile WebKit workflow explicitly includes PR18.

## Independent P0 gates

- Receiver black-box tests cover fixed query rejection, exact cardinality/order, state invariants,
  stable bytes/ETag/304, stream and health invalidation, cold singleflight, inflight invalidation,
  partial updates, valid-empty alerts, last-good staleness, and retention bounds.
- Pure frontend tests cover strict key allowlists and cardinality, ordering, finite numbers, units,
  validity intervals, exact peak containment including both boundaries, nullable/negative values,
  source-versus-derived provenance, Texas coverage wording, and prohibited causal/grid-alert claims.
- jsdom/browser tests cover zero off-view/collapsed fanout; exactly one request on expand; no duplicate
  Outlook/load/METAR request; abort on collapse/view exit/unmount; stale-generation rejection;
  deduplicated reopen; mixed stream states; exact tables; keyboard/focus semantics; and mobile
  containment.

## Deferred

- ERCOT-footprint alert filtering and maps remain blocked until reviewed boundary geometry exists.
- Eight-zone coverage, alternate representative points, immutable forecast-history resources,
  forecast skill scoring, push notifications, and a unified weather/grid event timeline are not P0.
- Causal attribution remains out of scope regardless of temporal overlap.
