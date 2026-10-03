# Offline normalized-series migration

Production normalization is an explicit offline operation. Receiver startup keeps a bounded,
restartable compatibility pass, but operators must not use repeated application restarts as the
production migration plan.

The tool always requires an explicit database path. It never discovers the configured receiver
database and therefore cannot silently target production.

## Read-only readiness

Run against a coherent database or migration working copy:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/series_migration.py status \
  --database ./ercot-working-copy.db \
  --batch-size 50000
```

The command opens SQLite with `mode=ro` and reports schema version, total/assigned/unassigned
metric rows, unassigned rows by metric, tile-catalog-backed metrics still blocked, canonical
series and tag counts, required indexes, page/freelist allocation, main/WAL/SHM bytes, estimated
remaining batches, and the final `normalized_series.ready` decision. It exposes no internal
series IDs.

## Resumable working-copy migration

Use only a coherent backup copy. Never copy only the main file of an active WAL-mode database;
the corresponding WAL may contain committed data absent from that file.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/series_migration.py migrate \
  --database ./ercot-working-copy.db \
  --batch-size 50000 \
  --complete \
  --verify
```

Each ID-ordered batch commits independently. Interruption leaves completed rows assigned and a
subsequent invocation resumes remaining `series_id IS NULL` rows. Progress is JSON on stderr and
includes batch rows, elapsed time, throughput, and main/WAL/SHM sizes. The final JSON report
includes before/after sizes and verification evidence.

Verification requires:

- `PRAGMA integrity_check` equals `ok`;
- `PRAGMA foreign_key_check` is empty;
- zero unassigned metric rows;
- metric row count and a deterministic digest of all legacy/value columns are unchanged;
- every stored canonical identity hash and metric-to-series mapping is valid;
- all pre-migration tables and columns remain present;
- the normalized timestamp-range query selects the covering index; and
- later tile-catalog metrics, when present in the cumulative server, have no unassigned rows.

The tool retains legacy `metric_name`, `tags`, `metric_tags`, and dedupe columns. Old v1 reads
therefore remain available during rollback and compatibility review.

## Rehearsal and disk headroom

Before an authorized cutover, run the tool on a throwaway production-shaped database and record:

- source and copied database checksums;
- input rows and unassigned rows;
- batch count, elapsed time, and rows/second;
- main database and peak WAL bytes;
- free filesystem bytes before and after;
- interruption/resume evidence;
- representative concurrent-ingest rehearsal if required;
- v1 representative parity and v2 readiness; and
- integrity, foreign-key, identity, mapping, and query-plan results.

Keep the coherent rollback backup, source copy, and migrated candidate distinct. Budget space for
all three plus WAL growth; do not infer headroom from only the final database size.

## Future authorized production cutover — not executed by this campaign

1. Record the deployed receiver/collector revisions and complete Portainer environment.
2. Stop or disable every writer during an approved maintenance window.
3. Obtain a coherent SQLite state using the SQLite backup API or a stopped database, including all
   committed WAL content.
4. Preserve a checksum-verified rollback copy.
5. Create a separate migration working copy.
6. Run `series_migration.py migrate --complete --verify` on that working copy.
7. Require zero unassigned rows, integrity/parity success, v2 readiness, and reviewed size/runtime.
8. Checksum the migrated database and stage it beside—not over—the current file.
9. With the receiver stopped and collectors still disabled, atomically replace the database.
10. Start the receiver only; verify v1 representative reads, `/api/status` readiness, v2 catalog,
    canonical tile bytes/ETags, database health, and logs.
11. Restore collectors individually only after receiver validation.
12. On any failure, stop the receiver, restore the preserved coherent database atomically, start
    the prior matching receiver/collector images, and repeat v1 health checks.

This campaign does not perform the production backup, replacement, deployment, or collector
activation.

## Local production-shaped evidence

On 2026-08-20, the deterministic benchmark migrated a throwaway WAL-mode database containing
250,000 metric rows across 32 physical series. The input main file was 56,524,800 bytes. A forced
interruption after the first 10,000-row batch left exactly 240,000 rows pending; the next invocation
resumed those rows and verified zero unassigned rows. Resume time was 5.108 seconds (46,985
rows/second), the final main file was 107,483,136 bytes, and the largest observed WAL during the
first batch was 13,002,752 bytes. The legacy day-range count took 0.589 ms; the single normalized
series count took 0.023 ms and the covering normalized index was selected. Integrity, value digest,
row count, identity, mapping, legacy-schema, foreign-key, and query-plan checks all passed.

This is local synthetic evidence, not a production-runtime forecast. Reproduce or scale it with:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/benchmark_series_migration.py \
  --rows 250000 --batch-size 10000 --physical-series 32
```
