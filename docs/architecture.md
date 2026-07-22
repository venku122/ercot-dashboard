# Architecture

The dashboard remains a three-service SQLite/WAL system:

```text
ERCOT public JSON and HTML
  -> independent typed Deno source adapters
  -> authenticated receiver ingest, event, and source-health endpoints
  -> SQLite WAL metrics + tags + collector_sources + events
  -> bounded batch/read APIs
  -> React/TypeScript + Chart.js ESM dashboard
```

## Collector contract

Every new source returns a `SourceResult` containing normalized metric series, normalized events,
the source timestamp, a stable SHA-256 payload hash, and diagnostics. Each metric point carries a
stable dedupe key. Rolling results are reduced to new or changed identities. The collector recovers
a compact receiver-persisted checkpoint after restart, applies high-water plus overlap to immutable
actuals, and key/value-diffs mutable forecasts. Invalid or zero-core payloads submit no data and
report a failed attempt. Five-minute sources begin at staggered offsets, and one adapter failure
cannot terminate the other loops.

Receiver submissions are chunked below 400 KiB so they remain below the default 512 KiB body
limit, including the multi-day generation-outage history. Batch sizing uses a linear encoded-byte
accumulator instead of repeatedly spreading and serializing a growing candidate array.

## SQLite model and migration

`init_db` uses `PRAGMA table_info(metrics)` before adding nullable `metrics.dedupe_key`; historical
rows are not rewritten. A partial unique index applies only when a dedupe key exists. Dedupe-keyed
points use an explicit current-view upsert: revisions replace the prior value, identical replay is
unchanged, and responses distinguish inserted, updated, unchanged, and invalid points. Forecast
vintage history remains deferred; its future identity must include source, series, target interval,
and forecast issuance/vintage rather than reusing the current-view key. The additive
`collector_sources` and `events` tables follow the engineering handoff schema. Migrations are
idempotent on fresh and legacy databases and are covered by backup/restore tests.

WAL, `synchronous=NORMAL`, a five-second busy timeout, the existing covering indexes, and SQL
bucketing remain in place. `PRAGMA optimize` runs once at receiver startup rather than in every
ingest chunk. The system does not VACUUM automatically.

## API boundaries

- Request body: 512 KiB by default.
- Batch queries: 100.
- Tags per query: 20.
- `max_points`: 5,000 hard cap; the dashboard requests 1,200.
- Omitted `since`: the latest 31-day bounded window for GET and batch reads.
- Unbucketed raw span: 31 days.
- Events: 1,000 hard cap.
- Cache: 512 LRU entries by default with metric/source/event dependency invalidation.

Spike-critical queries can select `aggregation=minmax`; SQLite window functions preserve both
extrema in every bucket. Other series use SQL averages. Responses include the resolved bucket,
point limit, selected aggregation, raw-window statistics, and whether the current bucket is
partial. Exact overview KPIs use latest-point queries rather than decimated plot data. Statistics
never report a sample sum for gauges; MW series expose trapezoidal MWh integration.

## Frontend runtime

Chart.js, the date adapter, date-fns, Hammer, and the official zoom plugin are pinned ESM
dependencies. Global vendor scripts were removed. The React dashboard owns typed time, URL,
comparison, freshness, statistics, units, API, and chart-coordination modules.

Charts use `animation:false`, `parsing:false`, `normalized:true`, zero tension, explicit X bounds,
fixed tick sampling, server bucketing, and Chart.js decimation. A mounted chart owns one Chart.js
instance; data and options update through `chart.update("none")`. `IntersectionObserver` mounts only
near-visible charts and only visible, expanded groups are queried. Live mode requests and merges
timestamp-deduped tails. The shared cursor publishes at most once per animation frame and redraws
only subscribers currently within the observer margin, while mounted off-screen charts remain
idle. Click-to-pin state follows the user between visible charts.

Source status exposes collection/poll state independently from observation freshness. Event-driven
Operations Messages remains collection-healthy when a successful quiet poll has no newer event.
