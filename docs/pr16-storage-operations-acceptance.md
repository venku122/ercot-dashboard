# PR16 storage operations acceptance

## Scope and truth boundary

PR16 may summarize only the three system-wide, five-minute values published by ERCOT's Energy
Storage Resources dashboard:

- charging MW, published as negative load;
- discharging MW, published as positive generation; and
- net-output MW, retained exactly as published.

The summary is an interpretation of the existing chart data, not a new source, receiver resource,
or causal model. It must say that nearby price, demand, and ramp changes are context rather than
attributed causes. It must not claim state of charge, stored energy, remaining duration, capacity
utilization, individual-resource behavior, dispatch intent, efficiency, cycle count, response
attribution, arbitrage, or market revenue.

## Coherence and operating mode

The current snapshot uses the newest timestamp present in all three series. Independently newer
values are never borrowed. If one series is absent, or nonempty series have no shared timestamp,
the UI reports a partial coherent snapshot and names the missing series or shared timestamp.

The source-published net-output value determines the label:

| Net output            | Label       |
| --------------------- | ----------- |
| less than -50 MW      | Charging    |
| -50 MW through +50 MW | Near idle   |
| greater than +50 MW   | Discharging |

Exactly -50 MW and +50 MW are therefore Near idle. Charging plus discharging must match net output
within 0.01 MW. A larger source-balance mismatch makes the coherent snapshot partial; within the
tolerance the diagnostic is displayed but must not replace the published net-output value.

The summary is current-state language only in Live mode. A fixed window retains the chart and its
exact history table but does not label the fleet's current operating mode.

## Lifecycle and provenance

- The summary consumes the already-loaded storage chart series and makes no requests of its own.
- No storage request occurs outside Generation or before the existing chart enters its visibility
  lifecycle.
- One visible chart request contains charging, discharging, and net output exactly once. Opening the
  summary's exact observation must not trigger another request.
- Healthy current data renders normally. Partial data names the coherence gap. With stale or failed
  source health and usable data, the last coherent snapshot remains visible with an explicit stale
  status. With no usable data, the existing chart lifecycle owns waiting or unavailable copy.
- Collector freshness is the newest observation epoch, not the later envelope `lastUpdated` time.
  Epoch is authoritative through the repeated Chicago fall-back hour.

## Exact values, accessibility, and mobile

The live summary exposes one focusable horizontal-scroll region containing exactly one coherent
row: ISO observation timestamp, signed charging, discharging and net output, and the source-balance
diagnostic. Existing ChartCard history, CSV, comparison, hidden-series, inspect, and URL behavior
remain unchanged.

All disclosure controls are at least 44 CSS pixels high. At 440 CSS pixels the summary and its
two-column value grid remain within the viewport, the page has no horizontal overflow, and only the
exact table scrolls horizontally. Darwin and pinned Ubuntu 24.04 baselines cover the summary and
open exact table in Chromium and iPhone Pro Max WebKit.

## Cache and storage

PR16 adds no receiver route, SQLite table, retention policy, or cache namespace. It reuses the
reviewed tile catalog entries `storage.charging`, `storage.discharging`, and `storage.net-output`,
their canonical v2 tile URLs, mergeable power aggregates, ETags, singleflight, and metric/range
invalidation. The existing live, recent, and sealed TTL classes remain unchanged. No longer edge
TTL is justified without a measured correction horizon or content-versioned URLs.

## ESR remains deferred

The subscription ESR endpoint is not a PR16 data source. The reviewed live calls returned HTTP 200
with five field definitions but zero rows across bounded windows. The checked-in empty fixture now
pins those exact five field names, and validation rejects the former resource-level shape. Zero rows
still provide no row contract, so no ESR row parser, resource identity, cadence, natural key,
pagination contract, retention, tile, source-health row, or frontend claim is accepted.

Before ESR work can begin, a nonempty bounded response must establish row form, exact field names,
UTC/local/DST semantics, units and signs, stable ordering and pagination, duplicates and
corrections, actual cadence and gaps, distinct-identity cardinality, and encoded database/index
bytes for normal, DST, and correction-heavy windows. Response rows and credentials must not be
retained in documentation or logs. State of charge remains unavailable unless an authoritative
field explicitly publishes it.

## Acceptance gates

P0 requires collector fixture acceptance, pure coherence/deadband acceptance, jsdom summary
acceptance, desktop Chromium lifecycle checks, mobile containment checks, reviewed VRI baselines,
typecheck, formatting, and existing tile/cache tests. P1 begins only after the nonempty ESR evidence
gate above; zero-row access and schema definitions alone do not authorize ingestion or retention.
