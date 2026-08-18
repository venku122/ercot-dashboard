# ERCOT series identity parity evidence

Verified on 2026-08-18 against the PR04 working tree based on
`3923bb7b11ba8997ad302d9b8bd6c3b93d3e28db`. The receiver changes were
uncommitted during this run. This is deterministic synthetic-fixture evidence;
it does not describe production data or claim a performance improvement.

## Contract under test

A physical series is identified by the normalized metric name and normalized
tag set. Tags are truncated to the receiver limits, deduplicated, sorted, and
encoded as compact JSON. The `series` table stores that canonical pair and its
SHA-256 identity hash; `metrics.series_id` is the internal foreign-key-like
reference. `series_tags` provides indexed subset-tag lookup. Existing
`metrics.metric_name`, `metrics.tags`, and `metric_tags` remain available for
compatibility and migration auditing.

The v1 selector semantics must not change:

- no tag filter selects all physical series for the metric;
- one or more tags select every physical series whose tag set is a superset of
  the requested normalized tag set;
- `rollup=sum` sums those selected samples by timestamp.

The acceptance harness builds a pre-migration SQLite database, computes an
independent answer from the legacy columns, runs `init_db`, and compares that
answer byte-for-value with the production `_series_query`. It does not call the
production legacy selector to construct expected output.

## Reproduction

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/baseline_series_identity.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/test_baseline_series_identity.py
```

The first command creates a temporary legacy database, migrates and corrects
it, closes the writable connection, then repeats the parity checks through a
SQLite `mode=ro` connection. The temporary directory is removed afterward. It
does not open or modify the repository database.

Observed result:

```text
fixture metric rows: 9
canonical series rows: 6
NULL series_id rows after migration: 0
second init_db schema, identity, mapping, and series_tags snapshot: exact match
no tags: exact match
one tag: exact match
unsorted duplicate multi-tag filter: exact match
missing tag: exact empty match
rollup=sum inputs and output: exact match
same-identity correction: 0 inserted, 1 updated, 0 unchanged
same-identity row count unchanged and series_id stable: true
tag-changing correction: 0 inserted, 1 updated, 0 unchanged
tag-changing row count unchanged and series_id changed: true
post-correction north and south query parity: exact match
read-only recheck parity: exact match
read-only database snapshot unchanged: true
unit tests: 3 passed
```

The rollup fixture deliberately contains two physical series at each timestamp.
The independent and production results were exactly `[[600, 10.0], [700,
24.0]]`. The first correction changed one value from `10.0` to `12.5` while
retaining the canonical identity. A second correction changed that sample's
tags from north to south and moved it to the corresponding normalized series
without inserting another metric row.

## Query-plan evidence

The harness resolves the canonical north-series ID and runs:

```sql
EXPLAIN QUERY PLAN
SELECT ts, value
FROM metrics
WHERE series_id = ? AND ts >= ? AND ts <= ?
ORDER BY ts;
```

SQLite returned:

```text
SEARCH metrics USING COVERING INDEX idx_metrics_series_ts_id_value
  (series_id=? AND ts>? AND ts<?)
```

The harness hard-fails unless the covering `series_id` plus timestamp-range
plan is present. The index orders equal timestamps by metric row ID as well.
This proves the exact sample scan, not every surrounding selector step.

During the compatibility period, each v1 data query first checks whether the
requested metric still has an unassigned row. That gate uses the partial
`idx_metrics_unbackfilled_name` index; its EXPLAIN regression forbids a full
metrics scan. A cold batch request currently performs four indexed SELECTs
(completion gate plus data query for points and again for statistics), while a
cold canonical chunk performs two. Receiver-cache hits still execute zero SQL.
The normalized v2 tile path in the next PR can address exact storage identities
directly after backfill completion.

## Migration and rollback boundary

`init_db` creates the normalized tables and index, then backfills legacy samples
in bounded ID-ordered batches. Startup defaults are 1,000 rows per batch and at
most 10 batches, configured by `SERIES_BACKFILL_BATCH_SIZE` and
`SERIES_BACKFILL_MAX_BATCHES`. Until every row for a requested metric has a
non-NULL `series_id`, that metric deliberately uses the legacy selector so a
partial backfill cannot omit rows. The explicit backfill helper can resume the
remaining rows.

The harness snapshots canonical series rows, `series_tags`, metric-to-series
mappings, and indexes after the first and second calls; the snapshots are
identical. Compatibility columns are retained, so a rollback to the legacy read
path does not require reconstructing tags from the normalized tables.

Raw query results now use `ORDER BY ts, id`; latest selection uses `ORDER BY ts
DESC, id DESC`. This deliberately makes equal-timestamp behavior deterministic.
The fixture preserves insertion order and passes exact parity, but this is not a
claim that the earlier `ORDER BY ts` query guaranteed a tie order: it was
planner-dependent.

Creating the two new partial metrics indexes is a one-time additive migration.
SQLite must inspect the metrics table and briefly hold a schema/write lock for
each build. Both are created after the bounded startup batch:

- `idx_metrics_series_ts_id_value` contains only assigned rows and supports the
  covering normalized range scan;
- `idx_metrics_unbackfilled_name` contains only unassigned rows and supports the
  compatibility completion gate.

The first grows and the second shrinks as explicit backfill continues.
`IF NOT EXISTS` prevents repeat index builds or table scans on later starts.
Series-tag mappings are populated atomically by identity resolution; startup
does not rescan the full `series` table. The explicit `backfill_series_tags`
helper remains available as an idempotent repair for an interrupted or
development-only intermediate schema.

## Limits and remaining production evidence

- The fixture is synthetic and single-process. It does not exercise a live
  production database, concurrent ingestion during backfill, interruption
  between committed batches, or rollback under load.
- It covers both a same-identity value correction and a tag-changing correction.
  Receiver unit tests remain the authority for broader drift-audit behavior.
- The plan assertion covers the final single-series timestamp scan.
  Multi-series tag resolution and `IN (...)` cardinality are not benchmarked
  here.
- Hash-collision handling is not induced; the receiver rejects a stored hash
  mismatch.
- No latency, storage, or throughput improvement is inferred from this
  acceptance fixture.
