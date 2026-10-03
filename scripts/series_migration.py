#!/usr/bin/env python3
"""Offline normalized-series migration and readiness evidence.

This tool is intentionally pointed at an operator-provided SQLite file. It never
discovers or opens the receiver's configured production path implicitly.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import sys
import time
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SERVER = ROOT / "ercot-receiver" / "server.py"
REQUIRED_INDEXES = (
    "idx_metrics_series_ts_id_value",
    "idx_metrics_unbackfilled_name",
    "idx_series_tags_tag_series",
)


def _load_server(path: Path):
    spec = importlib.util.spec_from_file_location("ercot_series_migration_server", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load receiver module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _connect(path: Path, *, read_only: bool) -> sqlite3.Connection:
    if read_only:
        return sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    return sqlite3.connect(path)


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    if not _has_table(conn, table):
        return ()
    return tuple(str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})"))


def _catalog_metrics(server: Any) -> tuple[str, ...]:
    payload_builder = getattr(server, "tile_catalog_payload", None)
    if not callable(payload_builder):
        return ()
    payload = payload_builder()
    metrics: set[str] = set()
    for entry in payload.get("series", []):
        selector = entry.get("selector") if isinstance(entry, dict) else None
        metric = selector.get("metric") if isinstance(selector, dict) else None
        if isinstance(metric, str) and metric:
            metrics.add(metric)
    return tuple(sorted(metrics))


def _file_bytes(path: Path) -> dict[str, int]:
    def size(candidate: Path) -> int:
        try:
            return candidate.stat().st_size
        except FileNotFoundError:
            return 0

    return {
        "main": size(path),
        "wal": size(Path(f"{path}-wal")),
        "shm": size(Path(f"{path}-shm")),
    }


def _index_details(conn: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    rows = conn.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name"
    ).fetchall()
    by_name = {str(name): sql for name, sql in rows}
    return {
        name: {"present": name in by_name, "sql": by_name.get(name)}
        for name in REQUIRED_INDEXES
    }


def _readiness(
    conn: sqlite3.Connection, server: Any, *, batch_size: int
) -> dict[str, Any]:
    metric_columns = set(_columns(conn, "metrics"))
    total = (
        int(conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0])
        if _has_table(conn, "metrics")
        else 0
    )
    if "series_id" not in metric_columns:
        assigned = 0
        unassigned = total
        grouped = (
            [
                {"metric": str(metric), "rows": int(count)}
                for metric, count in conn.execute(
                    "SELECT metric_name,COUNT(*) FROM metrics GROUP BY metric_name "
                    "ORDER BY COUNT(*) DESC,metric_name"
                )
            ]
            if total
            else []
        )
    else:
        assigned = int(
            conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id IS NOT NULL"
            ).fetchone()[0]
        )
        unassigned = total - assigned
        grouped = [
            {"metric": str(metric), "rows": int(count)}
            for metric, count in conn.execute(
                "SELECT metric_name,COUNT(*) FROM metrics WHERE series_id IS NULL "
                "GROUP BY metric_name ORDER BY COUNT(*) DESC,metric_name"
            )
        ]
    required = _catalog_metrics(server)
    grouped_map = {row["metric"]: row["rows"] for row in grouped}
    blocked = [
        {"metric": metric, "unassigned_rows": grouped_map[metric]}
        for metric in required
        if grouped_map.get(metric, 0) > 0
    ]
    return {
        "ready": unassigned == 0 and not blocked,
        "metric_rows": total,
        "assigned_series_id_rows": assigned,
        "unassigned_series_id_rows": unassigned,
        "unassigned_by_metric": grouped,
        "tile_catalog_metric_count": len(required),
        "blocked_tile_metrics": blocked,
        "estimated_remaining_batches": math.ceil(unassigned / batch_size),
    }


def status_report(
    path: Path, server: Any, *, batch_size: int, read_only: bool = True
) -> dict[str, Any]:
    conn = _connect(path, read_only=read_only)
    try:
        page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
        page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
        freelist = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        schema_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        readiness = _readiness(conn, server, batch_size=batch_size)
        return {
            "schema": 1,
            "database": str(path.resolve()),
            "read_only": read_only,
            "schema_version": schema_version,
            "tables": {
                "metrics": list(_columns(conn, "metrics")),
                "series": list(_columns(conn, "series")),
                "series_tags": list(_columns(conn, "series_tags")),
            },
            "canonical_series_count": int(
                conn.execute("SELECT COUNT(*) FROM series").fetchone()[0]
            )
            if _has_table(conn, "series")
            else 0,
            "series_tags_count": int(
                conn.execute("SELECT COUNT(*) FROM series_tags").fetchone()[0]
            )
            if _has_table(conn, "series_tags")
            else 0,
            "indexes": _index_details(conn),
            "pages": {
                "page_size": page_size,
                "page_count": page_count,
                "freelist_count": freelist,
                "allocated_bytes": page_size * page_count,
            },
            "files": _file_bytes(path),
            "normalized_series": readiness,
        }
    finally:
        conn.close()


def _legacy_digest(conn: sqlite3.Connection) -> str:
    columns = set(_columns(conn, "metrics"))
    selected = [
        name
        for name in (
            "id",
            "metric_name",
            "ts",
            "value",
            "interval",
            "metric_type",
            "tags",
            "dedupe_key",
        )
        if name in columns
    ]
    digest = hashlib.sha256()
    for row in conn.execute(
        f"SELECT {','.join(selected)} FROM metrics ORDER BY id"
    ):
        digest.update(
            json.dumps(
                row, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        )
        digest.update(b"\n")
    return digest.hexdigest()


def _schema_snapshot(conn: sqlite3.Connection) -> dict[str, tuple[str, ...]]:
    return {
        str(table): _columns(conn, str(table))
        for (table,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
    }


def _identity_errors(conn: sqlite3.Connection, server: Any) -> list[str]:
    errors: list[str] = []
    if not _has_table(conn, "series"):
        return ["series_table_missing"]
    for series_id, metric_name, tags_json, identity_hash in conn.execute(
        "SELECT id,metric_name,tags_json,identity_hash FROM series ORDER BY id"
    ):
        try:
            decoded = json.loads(tags_json)
            expected_tags, expected_hash = server.canonical_series_identity(
                metric_name, decoded
            )
        except Exception as exc:  # fail closed on corrupt stored identity
            errors.append(f"series:{series_id}:invalid:{type(exc).__name__}")
            continue
        if expected_tags != tags_json or expected_hash != identity_hash:
            errors.append(f"series:{series_id}:hash_mismatch")
    duplicates = conn.execute(
        "SELECT identity_hash,COUNT(*) FROM series GROUP BY identity_hash HAVING COUNT(*)>1"
    ).fetchall()
    errors.extend(f"duplicate_identity_hash:{row[0]}" for row in duplicates)
    return errors


def _mapping_errors(
    conn: sqlite3.Connection, server: Any, limit: int = 100, batch_size: int = 50_000
) -> list[str]:
    errors: list[str] = []
    last_id = 0
    while len(errors) < limit:
        rows = conn.execute(
            "SELECT m.id,m.metric_name,m.tags,s.metric_name,s.tags_json "
            "FROM metrics m JOIN series s ON s.id=m.series_id "
            "WHERE m.id>? ORDER BY m.id LIMIT ?",
            (last_id, batch_size),
        ).fetchall()
        if not rows:
            break
        ids = [int(row[0]) for row in rows]
        placeholders = ",".join("?" for _ in ids)
        relation_tags: dict[int, list[str]] = {}
        for metric_id, tag in conn.execute(
            f"SELECT metric_id,tag FROM metric_tags WHERE metric_id IN ({placeholders}) "
            "ORDER BY metric_id,tag",
            ids,
        ):
            relation_tags.setdefault(int(metric_id), []).append(str(tag))
        for metric_id, metric_name, raw_tags, series_metric, series_tags in rows:
            tags = relation_tags.get(int(metric_id), [])
            if tags:
                expected_tags = server.canonical_series_tags(tags)
            else:
                try:
                    decoded = json.loads(raw_tags or "[]")
                except (json.JSONDecodeError, TypeError):
                    decoded = []
                expected_tags = server.canonical_series_tags(
                    decoded if isinstance(decoded, list) else []
                )
            if metric_name.strip()[:240] != series_metric or expected_tags != series_tags:
                errors.append(f"metric:{metric_id}:series_mapping_mismatch")
                if len(errors) >= limit:
                    break
        last_id = ids[-1]
    return errors


def verify_database(
    conn: sqlite3.Connection,
    server: Any,
    *,
    expected_rows: int | None = None,
    expected_digest: str | None = None,
    original_schema: dict[str, tuple[str, ...]] | None = None,
) -> dict[str, Any]:
    integrity = [str(row[0]) for row in conn.execute("PRAGMA integrity_check")]
    foreign_keys = [list(row) for row in conn.execute("PRAGMA foreign_key_check")]
    row_count = int(conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0])
    unassigned = int(
        conn.execute("SELECT COUNT(*) FROM metrics WHERE series_id IS NULL").fetchone()[0]
    )
    digest = _legacy_digest(conn)
    identity_errors = _identity_errors(conn, server)
    mapping_errors = _mapping_errors(conn, server)
    plan_rows = conn.execute(
        "EXPLAIN QUERY PLAN SELECT ts,value FROM metrics "
        "WHERE series_id=? AND ts>=? AND ts<=? ORDER BY ts,id",
        (0, 0, 1),
    ).fetchall()
    plan = [str(row[3]) for row in plan_rows]
    indexed = any("idx_metrics_series_ts_id_value" in detail for detail in plan)
    missing_schema: list[str] = []
    if original_schema is not None:
        current = _schema_snapshot(conn)
        for table, columns in original_schema.items():
            if table not in current:
                missing_schema.append(f"table:{table}")
                continue
            for column in columns:
                if column not in current[table]:
                    missing_schema.append(f"column:{table}.{column}")
    checks = {
        "integrity_check": integrity == ["ok"],
        "foreign_key_check": not foreign_keys,
        "zero_unassigned_series_ids": unassigned == 0,
        "row_count_preserved": expected_rows is None or row_count == expected_rows,
        "legacy_values_preserved": expected_digest is None or digest == expected_digest,
        "identity_hashes_valid": not identity_errors,
        "metric_series_mappings_valid": not mapping_errors,
        "legacy_schema_preserved": not missing_schema,
        "normalized_range_index_selected": indexed,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "row_count": row_count,
        "unassigned_series_id_rows": unassigned,
        "legacy_digest": digest,
        "integrity_result": integrity,
        "foreign_key_errors": foreign_keys,
        "identity_errors": identity_errors,
        "mapping_errors": mapping_errors,
        "missing_legacy_schema": missing_schema,
        "query_plan": plan,
    }


def migrate(
    path: Path,
    server: Any,
    *,
    batch_size: int,
    complete: bool,
    verify: bool,
    max_batches: int | None,
) -> dict[str, Any]:
    conn = _connect(path, read_only=False)
    started = time.monotonic()
    before_files = _file_bytes(path)
    peak_files = dict(before_files)
    original_schema = _schema_snapshot(conn)
    original_rows = int(conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0])
    original_digest = _legacy_digest(conn)
    server.SERIES_BACKFILL_MAX_BATCHES = 0
    server.init_db(conn)
    migrated = 0
    batches = 0
    while complete or batches == 0:
        if max_batches is not None and batches >= max_batches:
            break
        batch_started = time.monotonic()
        changed = int(
            server.backfill_metric_series(
                conn,
                batch_size=batch_size,
                commit_each_batch=True,
                max_batches=1,
            )
        )
        if changed == 0:
            break
        batches += 1
        migrated += changed
        elapsed = max(time.monotonic() - batch_started, 1e-9)
        progress = {
            "event": "batch",
            "batch": batches,
            "rows": changed,
            "total_rows": migrated,
            "rows_per_second": changed / elapsed,
            "elapsed_seconds": time.monotonic() - started,
            "files": _file_bytes(path),
        }
        for name, size in progress["files"].items():
            peak_files[name] = max(peak_files[name], size)
        print(json.dumps(progress, sort_keys=True), file=sys.stderr, flush=True)
        if changed < batch_size:
            break
    server.backfill_series_tags(conn)
    conn.commit()
    elapsed = time.monotonic() - started
    verification = (
        verify_database(
            conn,
            server,
            expected_rows=original_rows,
            expected_digest=original_digest,
            original_schema=original_schema,
        )
        if verify
        else None
    )
    conn.close()
    report = {
        "schema": 1,
        "database": str(path.resolve()),
        "migrated_rows": migrated,
        "batches": batches,
        "batch_size": batch_size,
        "elapsed_seconds": elapsed,
        "rows_per_second": migrated / elapsed if elapsed else 0.0,
        "files_before": before_files,
        "files_after": _file_bytes(path),
        "peak_files": peak_files,
        "verification": verification,
    }
    if verification is not None and not verification["passed"]:
        raise RuntimeError(json.dumps(report, sort_keys=True))
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect or migrate a specific offline ERCOT SQLite database"
    )
    parser.add_argument(
        "--server", type=Path, default=DEFAULT_SERVER, help="receiver server.py path"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    status = subparsers.add_parser("status", help="read-only migration readiness")
    status.add_argument("--database", type=Path, required=True)
    status.add_argument("--batch-size", type=int, default=50_000)
    migrate_parser = subparsers.add_parser("migrate", help="resumable offline migration")
    migrate_parser.add_argument("--database", type=Path, required=True)
    migrate_parser.add_argument("--batch-size", type=int, default=50_000)
    migrate_parser.add_argument("--complete", action="store_true")
    migrate_parser.add_argument("--verify", action="store_true")
    migrate_parser.add_argument("--max-batches", type=int)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.batch_size < 1:
        raise SystemExit("batch size must be positive")
    if not args.database.is_file():
        raise SystemExit(f"database does not exist: {args.database}")
    server = _load_server(args.server)
    if args.command == "status":
        report = status_report(args.database, server, batch_size=args.batch_size)
    else:
        if args.max_batches is not None and args.max_batches < 1:
            raise SystemExit("max batches must be positive")
        report = migrate(
            args.database,
            server,
            batch_size=args.batch_size,
            complete=args.complete,
            verify=args.verify,
            max_batches=args.max_batches,
        )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
