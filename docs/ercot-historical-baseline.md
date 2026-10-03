# ERCOT historical baseline

Measured on 2026-08-18 before changing the historical read architecture. This report is a synthetic, local baseline and a contract record. It is not a production benchmark, does not use live ERCOT rows, and makes no cache-improvement claim.

## Evidence boundary

- Baseline revision: `origin/main` at `4d77d4de7e7c06eee3a7a7a5b8e1c78a0540e71c`.
- Measurement checkout: stacked head `0f478d652a1ce03783389fed58168d14df811e08`, plus the uncommitted PR 03 contract instrumentation under review.
- `frontend/src/dashboard/api.ts` and `scripts/benchmark_receiver.py` were byte-for-byte unchanged from `origin/main` when measured.
- The receiver differed from `origin/main` only in source-health metadata handling and the new ingest-side correction counter. Its historical query, cache-key, and chunk handlers were unchanged.
- Host: MacBookPro18,1, Apple M1 Pro, macOS 26.6.1 arm64; Python 3.14.3; SQLite 3.51.3; Node 25.8.2.
- Fixture: 370 days of one hourly `ercot.baseline.load_mw` series, with two tags per point, generated into a temporary SQLite database and then reopened read-only. The fixture database was 3,133,440 bytes.
- Timing sample: 30 iterations per window in one warmed process. These are not cold-disk, network, browser-rendering, concurrency, or production-cardinality measurements.

The checked-in baseline harness is `scripts/baseline_historical_contract.py`. It emits exact request payloads, cache keys, SQLite execution counts, p50/p95 timings, compact JSON bytes, parse timings, and query plans. It invokes the real receiver `Handler.do_POST` and `Handler.do_GET` methods in-process with a read-only injected SQLite connection; its benchmark-only application disables the request limiter so limiter sleeps do not contaminate receiver timings. Temporary fixture paths vary by run.

## Before architecture and request shapes

The current frontend has two historical paths:

1. A fixed window with comparison disabled uses `GET /api/v1/series/chunk`. Data older than 24 hours is planned as canonical UTC-day chunks. Tags are deduplicated and sorted in the URL. Each cold chunk performs one SQLite series query; an in-process or edge hit performs none.
2. Comparison modes, live reads, and the compatibility fallback use `POST /api/series/batch`. One HTTP request contains one logical current query per physical series and, when comparison is enabled, one comparison query as well. Each logical query performs a point query and a separate statistics query.

The baseline fixture uses one physical series. For `S` requested physical series, multiply the fixed-window chunk counts by `S`; lazy chart activation means there is no single honest whole-dashboard multiplier.

### Fixed, no-comparison request contract

The deterministic frontend contract uses an old, day-aligned end time so every planned chunk is sealed. The unique URL count equals the request count for the first load of one physical series.

| Window | Resolution | HTTP requests | Unique chunk URLs | SQLite executions on all misses | SQLite executions on all hits |
| ------ | ---------: | ------------: | ----------------: | ------------------------------: | ----------------------------: |
| 6h     |        18s |             1 |                 1 |                               1 |                             0 |
| 24h    |        72s |             1 |                 1 |                               1 |                             0 |
| 7d     |       504s |             7 |                 7 |                               7 |                             0 |
| 30d    |     2,160s |            30 |                30 |                              30 |                             0 |
| 90d    |     6,480s |            90 |                90 |                              90 |                             0 |
| 1y     |    26,280s |           365 |               365 |                             365 |                             0 |

The UI has explicit presets through 30 days and 12 months. Ninety days is supported through the bounded custom-range control and the same chunk planner. Recent windows that cross the 24-hour seal boundary use hourly chunks for the recent portion, so their counts can exceed this deliberately sealed contract.

The canonical URL contract is:

```text
/api/v1/series/chunk?aggregation=<average|minmax>&chunk_seconds=<3600|86400>&end=<epoch>&metric=<name>&resolution=<seconds>&start=<epoch>[&rollup=sum][&tag=<sorted-tag>...]
```

The receiver converts the URL to a sorted-JSON identity containing schema version, metric, normalized tags, start, end, chunk size, resolution, aggregation, and rollup. The frontend contract test freezes rounding and tag normalization.

### Batch/compare cache identity

The batch endpoint cache key is `series_batch:` plus sorted JSON of the raw POST payload. Across the six measured windows, one single-series request per window produced six unique keys; loading each twice made 12 HTTP requests but still six identities. Reversing the two tag values produced two unique keys because the cache key is formed before per-query tag normalization. Current callers send stable tag order, but this is an observable fragmentation hazard for other clients.

## Batch query, bytes, and timing baseline

This table is the 30-iteration output of `python3 scripts/baseline_historical_contract.py --iterations 30`. Each row is one synthetic single-series batch request. “SQLite p50/p95” covers point retrieval, the separate raw statistics query, and Python row materialization. It excludes JSON encoding, HTTP, frontend work, and network time. Each iteration executed exactly two `SELECT` statements; the reported bytes are the compact UTF-8 JSON response body.

| Window |  Bucket | Points | SELECTs/request | Response bytes | SQLite p50 | SQLite p95 | Python JSON parse p50 | Python JSON parse p95 |
| ------ | ------: | -----: | --------------: | -------------: | ---------: | ---------: | --------------------: | --------------------: |
| 6h     |     22s |      7 |               2 |            425 |   7.783 ms |   8.056 ms |             0.0040 ms |             0.0089 ms |
| 24h    |     87s |     25 |               2 |            805 |   7.793 ms |   7.887 ms |             0.0069 ms |             0.0088 ms |
| 7d     |    605s |    169 |               2 |          3,832 |   8.216 ms |   8.866 ms |             0.0318 ms |             0.0370 ms |
| 30d    |  2,593s |    721 |               2 |         15,437 |   8.937 ms |   9.921 ms |             0.1246 ms |             0.1270 ms |
| 90d    |  7,777s |  1,001 |               2 |         21,318 |  10.229 ms |  11.361 ms |             0.1725 ms |             0.1753 ms |
| 1y     | 31,537s |  1,001 |               2 |         21,541 |  16.748 ms |  17.688 ms |             0.1775 ms |             0.1907 ms |

The endpoint accepts 90-day and one-year windows because `max_points=1000` requests server-side bucketing. A raw request with neither `max_points` nor `bucket_seconds` remains limited to 31 days. The 1,001-point result is the current inclusive-window/bucket behavior and must be preserved or deliberately changed with a parity explanation.

These response bytes must not be combined with the fixed-window request counts: they describe the batch/compare path, while the fixed path returns independently cacheable chunk bodies.

### Receiver handler cold/warm baseline

The same 30-sample run exercised the actual handler boundary, from request-body read and parsing through compact response serialization and write. Each cold batch request used a fresh receiver cache and executed two `SELECT` statements; every warmed request hit the receiver cache and executed zero. The byte count is the exact serialized handler body.

| Window | Batch bytes |       Cold p50/p95 |     Warm p50/p95 | Cold/warm SELECTs |
| ------ | ----------: | -----------------: | ---------------: | ----------------: |
| 6h     |         494 |   7.793 / 7.839 ms | 0.022 / 0.025 ms |             2 / 0 |
| 24h    |         874 |   7.834 / 8.032 ms | 0.029 / 0.032 ms |             2 / 0 |
| 7d     |       3,901 |   8.070 / 8.103 ms | 0.084 / 0.088 ms |             2 / 0 |
| 30d    |      15,506 |   9.044 / 9.995 ms | 0.293 / 0.300 ms |             2 / 0 |
| 90d    |      21,366 | 11.064 / 11.770 ms | 0.472 / 0.484 ms |             2 / 0 |
| 1y     |      21,589 | 17.487 / 18.647 ms | 0.438 / 0.447 ms |             2 / 0 |

The fixed-history handler run followed the exact sealed frontend planner contract. “Bytes” is the sum of every serialized chunk body in one complete single-series load. Every cold chunk returned `X-ERCOT-Cache: MISS` and executed one `SELECT`; every warmed chunk returned `HIT` and executed zero.

| Window | Requests | Chunk bytes |     Cold fan-out p50/p95 | Warm fan-out p50/p95 | Cold/warm SELECTs |
| ------ | -------: | ----------: | -----------------------: | -------------------: | ----------------: |
| 6h     |        1 |         714 |         3.941 / 4.118 ms |     0.037 / 0.048 ms |             1 / 0 |
| 24h    |        1 |         714 |         3.955 / 4.145 ms |     0.037 / 0.042 ms |             1 / 0 |
| 7d     |        7 |       5,005 |       27.613 / 27.984 ms |     0.257 / 0.269 ms |             7 / 0 |
| 30d    |       30 |      21,480 |     118.334 / 119.905 ms |     1.188 / 1.466 ms |            30 / 0 |
| 90d    |       90 |      44,910 |     355.864 / 368.709 ms |     3.201 / 3.362 ms |            90 / 0 |
| 1y     |      365 |     109,560 | 1,443.607 / 1,463.955 ms |   10.987 / 12.362 ms |           365 / 0 |

These handler timings include receiver parsing, query/cache work, serialization, and in-memory response writes. They do not include a socket, network transfer, proxy/CDN, TTFB, or cold filesystem cache.

## Checked Chromium parse and merge baseline

The checked-in `scripts/benchmark_frontend_history.mjs` launches repository Playwright Chromium, loads the actual frontend module through Vite, and calls the production `mergePoints` implementation. This run used Chromium 149.0.7827.55, 100 warm-ups, 500 measured samples, and 50 operations per sample against deterministic point-array payloads with the same point counts as the batch baseline. It measures browser JavaScript JSON parsing and point merging only, not fetch, React, Chart.js, derived-series work, comparison alignment, or paint.

| Window | Browser payload bytes | JSON.parse p50/p95 | `mergePoints` p50/p95 |
| ------ | --------------------: | -----------------: | --------------------: |
| 6h     |                   131 |   0.000 / 0.002 ms |      0.000 / 0.002 ms |
| 24h    |                   437 |   0.002 / 0.004 ms |      0.002 / 0.004 ms |
| 7d     |                 2,777 |   0.008 / 0.010 ms |      0.012 / 0.014 ms |
| 30d    |                11,912 |   0.034 / 0.036 ms |      0.052 / 0.054 ms |
| 90d    |                16,553 |   0.044 / 0.046 ms |      0.070 / 0.072 ms |
| 1y     |                16,553 |   0.044 / 0.046 ms |      0.070 / 0.074 ms |

The browser payload contains only `{points: [...]}`, so its byte count is not an HTTP response byte count. These timings establish a checked-browser algorithmic baseline, not whole-dashboard rendering performance.

## Existing receiver benchmark

The pre-existing `scripts/benchmark_receiver.py` builds 105,120 five-minute rows for one tagged series. The 2026-08-18 run produced a 27,439,104-byte temporary database and the following sanity evidence:

- Six-hour processed-cache helper: 73 points, first lookup/query 0.181 ms, cached median 0.0007 ms.
- Seven-day processed-cache helper: 673 points, first lookup/query 1.212 ms, cached median 0.0004 ms.
- Cache exercise: 11 hits, 2 misses, 0.8462 hit ratio, two sealed entries; an unrelated live ingest did not invalidate the sealed seven-day entry.
- Twelve-month tagged raw query: 105,120 points, best 78.079 ms, median 80.694 ms.
- Twelve-month hourly average: 8,760 points, best 59.545 ms, median 59.603 ms.
- Twelve-month two-hour min/max: 8,760 points, best 163.221 ms, median 167.147 ms.
- A dedupe retry inserted nothing, reported one unchanged point, and grew the database by zero pages.

The helper's “cold” value is its first receiver-cache lookup in an already-open process, not a cold filesystem read. It reports a median but not p95; the contract harness supplies the 30-sample p50/p95 series above.

## Query-plan snapshot

All six batch windows produced the same plan shape for the two-tag bucket query:

```text
SEARCH m USING COVERING INDEX idx_metrics_name_ts_value_id (metric_name=? AND ts>? AND ts<?)
LIST SUBQUERY 1
SEARCH metric_tags USING COVERING INDEX idx_metric_tags_tag_metric (tag=?)
USE TEMP B-TREE FOR GROUP BY
CREATE BLOOM FILTER
USE TEMP B-TREE FOR GROUP BY
```

This proves that the metric/time scan and tag lookup use the intended covering indexes on this SQLite version. It also records two temporary grouping structures; the plan is not evidence that grouping is free. The plan was obtained against the synthetic two-tag query. Single-tag queries use the direct `metrics JOIN metric_tags` branch, and min/max window-function queries require separate plans before they can be compared.

## Correction-age baseline and contract

`origin/main` has no correction audit log, persisted correction timestamp, or historical correction-age series. Therefore no retrospective live correction distribution can be reconstructed for this baseline.

PR 03 adds deterministic counters to each `ingest_metrics` result and durably aggregates them by bounded source, metric, normalized tag set, and age bucket in `metric_correction_age`. `GET /api/v1/correction-age` exposes those cumulative counts and last-observed timestamps. A counter increments only when a row with an existing `dedupe_key` is materially updated; new inserts, unchanged retries, invalid rows, and rows without a matched dedupe key do not count. Age is `ingest current_ts - point timestamp` and is assigned to exactly one bucket:

| Bucket      | Contract                  |
| ----------- | ------------------------- |
| `future`    | age < 0                   |
| `under_5m`  | 0 <= age < 5 minutes      |
| `5m_to_1h`  | 5 minutes <= age < 1 hour |
| `1h_to_24h` | 1 hour <= age < 24 hours  |
| `1d_to_7d`  | 1 day <= age < 7 days     |
| `7d_to_30d` | 7 days <= age < 30 days   |
| `over_30d`  | age >= 30 days            |

The finalized baseline harness seeded one material correction in each bucket. It reported all seven expected names, one count per bucket, and seven total synthetic corrections. The focused receiver unit test separately exercised `under_5m` and `future`. This is deterministic contract evidence, not a live observation.

The counters cannot answer how often old ERCOT corrections occurred before PR 03. The durable table starts empty at migration and grows only across source/metric/tag combinations that already reach the protected ingest endpoint; no raw revision payloads are retained. The public diagnostic endpoint uses the receiver cache and is invalidated only by material corrections.

## Reproduction commands

```bash
git rev-parse origin/main
git diff --quiet origin/main -- frontend/src/dashboard/api.ts scripts/benchmark_receiver.py
python3 scripts/benchmark_receiver.py
python3 scripts/baseline_historical_contract.py --iterations 30
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/test_baseline_historical_contract.py
pnpm exec vitest run frontend/src/dashboard/v1-historical-contract.test.ts
python3 -m unittest ercot-receiver/test_server.py
node scripts/benchmark_frontend_history.mjs --iterations 500 --warmups 100 --operations-per-sample 50
```

## Gaps before an optimization claim

- No live or production SQLite database was copied or queried. The fixture has one series and does not represent production series/tag cardinality, WAL state, filesystem latency, or concurrent load.
- No end-to-end browser network/render trace was captured. Whole-view request counts depend on the selected view, lazy chart activation, physical-series count, comparison mode, and whether chunks are already cached.
- The checked Chromium parse/merge benchmark excludes fetch scheduling, garbage collection under dashboard load, derived series, Chart.js processing, layout, and paint.
- The handler timing includes receiver parsing and serialization but no real socket, proxy/CDN, network transfer, or TTFB. The repository's first-lookup benchmark is not a cold-disk benchmark.
- EXPLAIN evidence covers the representative average/two-tag query only. Single-tag, untagged, `rollup=sum`, min/max, statistics, and concurrent-write plans remain to be captured.
- Correction-age data starts with the new PR 03 table. There is no pre-PR03 history; source/metric/tag bucket counts are durable only after this migration.
- Receiver LRU hit/miss evidence exists only for the synthetic helper. CDN behavior, ETag/304, singleflight, and Cloudflare MISS-to-HIT are later rollout gates and were not exercised here.

Any later performance statement must compare the same revision-independent fixture, windows, query semantics, host conditions, iteration count, and evidence boundaries against the new architecture.
