# ERCOT Dashboard Query Performance Plan

Date: 2026-05-25

## Current State

- Live Portainer stack: `ercot`, stack ID `65`, endpoint ID `5`.
- Containers:
  - `ercot-receiver`: running, host port `30124` -> container port `8080`.
  - `ercot-collector`: running.
- Live data path: `/mnt/nvme_pool/docker/appdata/ercot/ercot-receiver/data/metrics.db`.
- Local analysis DB: `analysis/db/ercot-metrics-20260525-094929.db`.
- Snapshot status: ZFS snapshot creation was blocked for `truenas_admin` because `zfs snapshot` requires elevated privileges and `sudo -n` requires a password.
- Backup method used: SQLite online backup API on TrueNAS, then `scp` to local disk.

## Data Profile

- `metrics`: 5,175,415 rows in the copied database.
- `metric_tags`: 3,953,875 rows.
- Distinct metric names: 77.
- Distinct tags: 66.
- Largest series:
  - `ercot.DC_Tie_Flows`: 843,690 rows.
  - `ercot.app.duty_cycle`: 243,357 rows.
  - `ercot.pricing`: 170,940 rows.
  - Main real-time ERCOT metrics: about 168,738 rows each.
- The main real-time ERCOT metrics stop at `2026-05-23 06:05:33 UTC` in the copied DB, while pricing, ancillary, weather, and app metrics continue through `2026-05-25`.

## Query Findings

The current receiver schema has:

```sql
CREATE INDEX idx_metrics_name_ts ON metrics(metric_name, ts);
CREATE INDEX idx_metric_tags_tag ON metric_tags(tag);
CREATE INDEX idx_metric_tags_metric ON metric_tags(metric_id);
```

The current API flow fetches raw points first and then transforms them in Python:

- `tags_filter_clause()` builds an `IN (SELECT ... GROUP BY ... HAVING COUNT(DISTINCT tag) = N)` filter.
- `_series_query()` fetches every matching raw point ordered by timestamp.
- `bucket_average()`, `seasonal_average()`, and `downsample_minmax()` run in Python after the raw fetch.

Representative local timings:

- Untagged 12-month count on `ercot.Real_Time_Data.Actual_System_Demand`: about `0.19s`.
- Tagged 12-month count on `ercot.DC_Tie_Flows` / `ercot_dc_tie:DC_E` before added local indexes: about `3.10s`.
- SQL hourly aggregation over 12 months before added local covering index: about `2.90s`.

Local-only index experiment:

```sql
CREATE INDEX idx_metric_tags_tag_metric ON metric_tags(tag, metric_id);
CREATE INDEX idx_metrics_name_ts_value_id ON metrics(metric_name, ts, value, id);
ANALYZE;
```

After those indexes:

- Tagged 12-month count using the current subquery shape: about `0.44s`.
- Tagged 12-month count using an explicit join: about `0.34s`.
- SQL hourly aggregation over 12 months: about `0.04s`.

## Recommended Implementation Plan

1. Add low-risk indexes in `init_db()`.
   - Add `idx_metric_tags_tag_metric ON metric_tags(tag, metric_id)`.
   - Add a covering read index for time-series reads, likely `idx_metrics_name_ts_value_id ON metrics(metric_name, ts, value, id)`.
   - Keep the existing indexes initially to avoid a risky migration. Revisit after production query plans are verified.

2. Replace tag filtering for single-tag series with an explicit join.
   - Most dashboard tag filters are single tag filters.
   - Use:
     ```sql
     SELECT m.ts, m.value
     FROM metrics m
     JOIN metric_tags mt ON mt.metric_id = m.id
     WHERE m.metric_name = ?
       AND mt.tag = ?
       AND m.ts >= ?
       AND m.ts <= ?
     ORDER BY m.ts
     ```
   - Keep the current grouped `HAVING COUNT(DISTINCT tag)` path for multi-tag "must contain all tags" filters, or replace it with repeated `EXISTS` clauses after benchmarking.

3. Push bucketed long-range reads into SQLite.
   - When `bucket_seconds` is set and `seasonal_period` is not set, use SQL aggregation:
     ```sql
     SELECT (m.ts / ?) * ? AS bucket_ts, AVG(m.value)
     FROM metrics m
     WHERE ...
     GROUP BY bucket_ts
     ORDER BY bucket_ts
     ```
   - This avoids loading 100k+ raw points per series into Python for long range charts.

4. Add a first-class downsample query path.
   - Today `max_points` still requires all raw rows to be fetched before Python downsampling.
   - Add a SQL-backed bucket path for `max_points`, computing the bucket width from `[since, until] / max_points`.
   - Start with bucket average for speed and predictable cardinality; only add min/max envelope SQL if visual fidelity requires it.

5. Treat computed charts separately.
   - Frontend computed charts intentionally disable downsampling for alignment, which means long ranges still pull raw series for `minus`, `sum`, and `diff`.
   - Add a shared `bucket_seconds` for computed chart source series on long ranges so source series align by bucket before frontend math.
   - For `diff`, either fetch one pre-window point or compute deltas server-side to avoid losing the first visible delta.

6. Add longer range options behind server-side aggregation.
   - Add frontend ranges like 2 years / all data only after the server returns bounded point counts.
   - For long actual charts, auto-select bucket sizes such as:
     - 30 days: 15 minutes or 1 hour.
     - 6-12 months: 1 hour.
     - 2 years / all data: 6 hours or 1 day.
   - Keep seasonal trend modes, but move their first aggregation step into SQL.

7. Add receiver tests around query behavior.
   - Index creation is easy to test through `init_db()`.
   - Add fixture data for:
     - untagged range reads,
     - single-tag reads,
     - multi-tag reads,
     - SQL bucketed reads,
     - `max_points` bounded responses,
     - computed chart alignment expectations from the frontend if practical.

8. Operational rollout.
   - Build the receiver image.
   - Before deploy, create a ZFS snapshot using an account with ZFS snapshot privileges or through the TrueNAS UI/API.
   - Deploy without dropping old indexes.
   - Verify:
     - `/api/status`,
     - 30-day, 12-month, and longer-range dashboard loads,
     - tagged DC tie charts,
     - container logs for slow requests/errors,
     - DB file growth after new indexes.

## Local Implementation Results

Implemented locally on 2026-05-25:

- Fixed the real-time ERCOT grid collector by replacing the brittle `an="2">` / exact table-whitespace parser with class-based parsing of `headerValueClass`, `tdLeft`, and `labelClassCenter` table cells.
- Validated the parser against the live ERCOT page in a Deno container. It returned 14 metrics, including `ercot.Frequency.Current_Frequency` and tagged `ercot.DC_Tie_Flows`.
- Added receiver indexes:
  - `idx_metric_tags_tag_metric ON metric_tags(tag, metric_id)`
  - `idx_metrics_name_ts_value_id ON metrics(metric_name, ts, value, id)`
- Reworked single-tag reads to use a direct join against `metric_tags`.
- Added SQL bucket aggregation for explicit `bucket_seconds`.
- Added SQL bucket aggregation for `max_points` long-range reads.
- Updated frontend long-range computed series to request shared bucketed source series so computed charts remain aligned without pulling full raw series.
- Added receiver tests for new indexes, single-tag filtering, SQL bucketing, and max-point bucket sizing.

Local stack:

- Receiver image: `ercot-receiver:local`
- Collector image: `ercot-collector:local`
- Receiver URL: `http://localhost:18080`
- Receiver data volume: `analysis/local-data/metrics.db`, copied from the production DB backup.
- Local ingestion uses `METRICS_API_KEY=local-dev-key`.

Local validation:

- `pnpm run check`: passed.
- `python3 -m unittest discover -s ercot-receiver -p 'test*.py'`: passed, 8 tests.
- Built `ercot-receiver:local`: passed.
- Built `ercot-collector:local`: passed.
- Full-page browser screenshot: `/tmp/ercot-dashboard-local-full.png`; dashboard rendered populated charts.
- Local collector submitted fresh grid data after restart:
  - latest `ercot.Frequency.Current_Frequency`: `2026-05-25 15:07:33 UTC`, value `59.983`.

Representative optimized local API timings against the copied production-sized DB:

- `GET /api/series` for tagged `ercot.DC_Tie_Flows` / `ercot_dc_tie:DC_E`, 12-month range, `max_points=1200`: about `520-570ms`, 389 bucketed points.
- `GET /api/series` for `ercot.Real_Time_Data.Actual_System_Demand`, 12-month range, `bucket_seconds=3600`: about `90-100ms`, 2,820 points.
- `GET /api/latest` for tagged `ercot.DC_Tie_Flows` / `ercot_dc_tie:DC_E`: about `5ms`.

Before/after reference from the local DB experiment:

- Tagged 12-month count improved from about `3.10s` to about `0.34-0.44s`.
- SQL hourly aggregation improved from about `2.90s` to about `0.04s`.

## Separate Operational Finding

The production stack was healthy at the container/API level, but main real-time ERCOT grid metrics appeared stale as of `2026-05-23 06:05:33 UTC`. Recent collector logs showed pricing, ancillary, EEA, and weather ingestion continuing, but no recent real-time grid condition log lines in the sampled tail.

The local collector fix validates the likely root cause: ERCOT changed the real-time conditions HTML enough to break the old brittle parser while still serving the underlying data. Production should resume grid metrics after the fixed collector image is deployed.
