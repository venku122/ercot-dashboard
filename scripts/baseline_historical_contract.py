#!/usr/bin/env python3
"""Reproducible, read-only baseline for the current historical receiver contract."""

from __future__ import annotations

import argparse
from collections import defaultdict
import importlib.util
import io
import json
import math
from pathlib import Path
import sqlite3
import statistics
import tempfile
import time
from typing import Any, Callable
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[1]
WINDOWS = (
    ("6h", 6 * 3600),
    ("24h", 24 * 3600),
    ("7d", 7 * 86400),
    ("30d", 30 * 86400),
    ("90d", 90 * 86400),
    ("1y", 365 * 86400),
)
CORRECTION_BUCKETS = (
    "future",
    "under_5m",
    "5m_to_1h",
    "1h_to_24h",
    "1d_to_7d",
    "7d_to_30d",
    "over_30d",
)


def load_server(server_path: Path):
    spec = importlib.util.spec_from_file_location("ercot_receiver_baseline_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load receiver module: {server_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def percentile(samples: list[float], percentile_value: float) -> float:
    if not samples:
        return 0.0
    ordered = sorted(samples)
    rank = max(1, math.ceil(percentile_value * len(ordered)))
    return ordered[min(len(ordered), rank) - 1]


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def open_read_only(path: Path) -> sqlite3.Connection:
    resolved = path.resolve()
    return sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)


def build_fixture(path: Path, server, *, days: int = 370) -> None:
    conn = sqlite3.connect(path)
    server.init_db(conn)
    start = 1_735_689_600
    interval = 3600
    rows = days * 24
    conn.executemany(
        """
        INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [
            (
                "ercot.baseline.load_mw",
                start + index * interval,
                45_000.0 + float(index % 240),
                interval,
                "gauge",
                '["region:texas","source:fixture"]',
            )
            for index in range(rows)
        ],
    )
    metric_ids = [row[0] for row in conn.execute("SELECT id FROM metrics ORDER BY id")]
    conn.executemany(
        "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
        [(metric_id, tag) for metric_id in metric_ids for tag in ("region:texas", "source:fixture")],
    )
    conn.commit()
    conn.close()


def explain_plan(
    conn: sqlite3.Connection,
    metric: str,
    tags: list[str],
    since: int,
    until: int,
    bucket_seconds: int,
) -> list[dict[str, Any]]:
    placeholders = ",".join("?" for _ in tags)
    sql = f"""
        EXPLAIN QUERY PLAN
        SELECT (m.ts / ?) * ? AS bucket_ts, AVG(m.value)
        FROM metrics m
        WHERE m.metric_name = ? AND m.ts >= ? AND m.ts <= ?
        AND m.id IN (
            SELECT metric_id FROM metric_tags
            WHERE tag IN ({placeholders})
            GROUP BY metric_id HAVING COUNT(DISTINCT tag) = {len(tags)}
        )
        GROUP BY bucket_ts ORDER BY bucket_ts
    """
    rows = conn.execute(
        sql,
        [bucket_seconds, bucket_seconds, metric, since, until, *tags],
    ).fetchall()
    return [
        {"id": row[0], "parent": row[1], "not_used": row[2], "detail": row[3]}
        for row in rows
    ]


def correction_age_buckets(conn: sqlite3.Connection) -> dict[str, Any]:
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
    ]
    timestamp_names = ("observation_ts", "metric_ts", "ts")
    for table in tables:
        columns = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
        observation_column = next((name for name in timestamp_names if name in columns), None)
        if observation_column is None or "corrected_at" not in columns:
            continue
        ages = [
            int(row[0]) - int(row[1])
            for row in conn.execute(
                f'SELECT corrected_at, "{observation_column}" FROM "{table}" '
                f'WHERE corrected_at IS NOT NULL AND "{observation_column}" IS NOT NULL'
            )
        ]
        counts = {label: 0 for label in CORRECTION_BUCKETS}
        for age in ages:
            if age < 0:
                label = "future"
            elif age < 300:
                label = "under_5m"
            elif age < 3600:
                label = "5m_to_1h"
            elif age < 86400:
                label = "1h_to_24h"
            elif age < 7 * 86400:
                label = "1d_to_7d"
            elif age < 30 * 86400:
                label = "7d_to_30d"
            else:
                label = "over_30d"
            counts[label] += 1
        return {
            "available": True,
            "buckets": counts,
            "observation_column": observation_column,
            "rows": len(ages),
            "table": table,
        }
    return {
        "available": False,
        "reason": "historical correction ages unavailable: no correction audit table with corrected_at and observation timestamp",
    }


def synthetic_correction_contract(server) -> dict[str, Any]:
    if not hasattr(server, "CORRECTION_AGE_BUCKETS") or not hasattr(server, "ingest_metrics"):
        return {"available": False, "reason": "receiver correction telemetry unavailable"}
    now = 2_000_000_000
    ages = (-60, 60, 600, 7200, 2 * 86400, 10 * 86400, 40 * 86400)
    initial = [
        {
            "metric_name": "ercot.baseline.correction",
            "points": [
                {
                    "dedupe_key": f"baseline-correction-{index}",
                    "timestamp": now - age,
                    "value": 1,
                }
            ],
        }
        for index, age in enumerate(ages)
    ]
    revised = json.loads(json.dumps(initial))
    for item in revised:
        item["points"][0]["value"] = 2
    conn = sqlite3.connect(":memory:")
    try:
        server.init_db(conn)
        server.ingest_metrics(conn, initial, current_ts=now)
        result = server.ingest_metrics(conn, revised, current_ts=now)
    finally:
        conn.close()
    expected_names = list(CORRECTION_BUCKETS)
    return {
        "available": True,
        "bucket_names": list(result["correction_age_buckets"]),
        "bucket_names_match_contract": list(result["correction_age_buckets"]) == expected_names,
        "buckets": result["correction_age_buckets"],
        "synthetic_corrections": result["updated"],
    }


def measure_parse(payload: bytes, iterations: int, clock: Callable[[], float]) -> dict[str, Any]:
    samples = []
    for _ in range(iterations):
        started = clock()
        json.loads(payload)
        samples.append(clock() - started)
    return {
        "iterations": iterations,
        "p50_seconds": statistics.median(samples),
        "p95_seconds": percentile(samples, 0.95),
        "runtime": "python json.loads (receiver-side reproducibility proxy)",
    }


def measure_window(
    conn: sqlite3.Connection,
    server,
    handler,
    *,
    end: int,
    iterations: int,
    max_points: int,
    metric: str,
    span: int,
    tags: list[str],
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, Any]:
    requested_since = end - span
    try:
        since, until = server.normalize_query_window(
            requested_since,
            end,
            max_points=max_points,
        )
    except ValueError as error:
        return {"supported": False, "reason": str(error)}
    bucket_seconds = handler._query_bucket_seconds(since, until, max_points, None)
    request = {
        "queries": [
            {
                "id": f"history-{span}",
                "max_points": max_points,
                "metric": metric,
                "since": since,
                "tags": tags,
                "until": until,
            }
        ]
    }
    cache_key = handler._cache_key("series_batch", request)
    elapsed_samples: list[float] = []
    select_counts: list[int] = []
    response = None
    for _ in range(iterations):
        traced: list[str] = []
        conn.set_trace_callback(
            lambda statement: traced.append(statement)
            if statement.lstrip().upper().startswith(("SELECT", "WITH"))
            else None
        )
        started = clock()
        points = handler._series_query(
            conn,
            metric,
            since,
            until,
            tags,
            bucket_seconds=bucket_seconds,
        )
        stats = handler._series_statistics(conn, metric, since, until, tags)
        elapsed_samples.append(clock() - started)
        conn.set_trace_callback(None)
        select_counts.append(len(traced))
        response = {
            "series": [
                {
                    "id": f"history-{span}",
                    "meta": {
                        "bucket_seconds": bucket_seconds,
                        "max_points": max_points,
                        "since": since,
                        "stats": stats,
                        "until": until,
                    },
                    "metric": metric,
                    "points": points,
                }
            ]
        }
    encoded = json_bytes(response)
    return {
        "bucket_seconds": bucket_seconds,
        "cache_key": cache_key,
        "explain_query_plan": explain_plan(
            conn,
            metric,
            tags,
            since,
            until,
            bucket_seconds,
        ),
        "parse": measure_parse(encoded, iterations, clock),
        "points": len(response["series"][0]["points"]),
        "request": request,
        "response_bytes": len(encoded),
        "sqlite": {
            "executions_per_iteration": select_counts,
            "p50_seconds": statistics.median(elapsed_samples),
            "p95_seconds": percentile(elapsed_samples, 0.95),
            "total_executions": sum(select_counts),
        },
        "supported": True,
    }


class BenchmarkLimiter:
    """Explicit benchmark-only rate-limit bypass; never installed on the real server."""

    def allow(self, _key: str, _rpm: int) -> bool:
        return True


def benchmark_app(server, *, cache_entries: int = 512):
    return type(
        "HistoricalBaselineApp",
        (),
        {
            "cache": server.Cache(3600, max_entries=cache_entries),
            "cache_metrics": defaultdict(float),
            "limiter": BenchmarkLimiter(),
        },
    )()


def invoke_handler(
    server,
    app,
    method: str,
    path: str,
    *,
    payload: Any = None,
    request_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    body = json_bytes(payload) if payload is not None else b""
    handler = server.Handler.__new__(server.Handler)
    handler.path = path
    handler.client_address = ("127.0.0.1", 12345)
    handler.server = app
    handler.headers = {
        "Content-Length": str(len(body)),
        "Content-Type": "application/json",
        **(request_headers or {}),
    }
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler.response_headers = {}
    handler.send_response = lambda status: setattr(handler, "response_status", status)
    handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
    handler.end_headers = lambda: None
    if method == "POST":
        handler.do_POST()
    elif method == "GET":
        handler.do_GET()
    else:
        raise ValueError(f"unsupported benchmark method: {method}")
    response_body = handler.wfile.getvalue()
    parsed = json.loads(response_body) if response_body else None
    return {
        "body": response_body,
        "headers": handler.response_headers,
        "json": parsed,
        "status": handler.response_status,
    }


def traced_handler_call(
    conn: sqlite3.Connection,
    callback: Callable[[], dict[str, Any]],
    clock: Callable[[], float] = time.perf_counter,
) -> tuple[dict[str, Any], float, int]:
    statements: list[str] = []
    conn.set_trace_callback(
        lambda statement: statements.append(statement)
        if statement.lstrip().upper().startswith(("SELECT", "WITH"))
        else None
    )
    started = clock()
    try:
        response = callback()
        elapsed = clock() - started
    finally:
        conn.set_trace_callback(None)
    return response, elapsed, len(statements)


def sample_summary(samples: list[float]) -> dict[str, float]:
    return {
        "p50_seconds": statistics.median(samples),
        "p95_seconds": percentile(samples, 0.95),
    }


def measure_batch_handler_window(
    conn: sqlite3.Connection,
    server,
    request: dict[str, Any],
    *,
    iterations: int,
) -> dict[str, Any]:
    request_body = json_bytes(request)
    cache_key = server.Handler.__new__(server.Handler)._cache_key(
        "series_batch", request
    )
    cold_elapsed: list[float] = []
    cold_selects: list[int] = []
    cold_response = None
    for _ in range(iterations):
        app = benchmark_app(server)
        cold_response, elapsed, selects = traced_handler_call(
            conn,
            lambda: invoke_handler(
                server,
                app,
                "POST",
                "/api/series/batch",
                payload=request,
            ),
        )
        cold_elapsed.append(elapsed)
        cold_selects.append(selects)

    warm_app = benchmark_app(server)
    invoke_handler(
        server,
        warm_app,
        "POST",
        "/api/series/batch",
        payload=request,
    )
    warm_elapsed: list[float] = []
    warm_selects: list[int] = []
    warm_response = None
    for _ in range(iterations):
        warm_response, elapsed, selects = traced_handler_call(
            conn,
            lambda: invoke_handler(
                server,
                warm_app,
                "POST",
                "/api/series/batch",
                payload=request,
            ),
        )
        warm_elapsed.append(elapsed)
        warm_selects.append(selects)

    assert cold_response is not None and warm_response is not None
    return {
        "cold": {
            **sample_summary(cold_elapsed),
            "cache_headers": [cold_response["headers"].get("X-ERCOT-Cache")],
            "response_bytes": len(cold_response["body"]),
            "select_executions": cold_selects,
            "status": cold_response["status"],
            "total_requests": iterations,
        },
        "request_bytes": len(request_body),
        "request_parse": measure_parse(request_body, iterations, time.perf_counter),
        "receiver_cache": {
            "cache_key": cache_key,
            "cold": "fresh receiver Cache for every measured request",
            "warm": "same receiver Cache primed before measured requests",
            "warm_zero_sql": all(count == 0 for count in warm_selects),
        },
        "response_meta": cold_response["json"]["series"][0]["meta"],
        "response_schema_keys": sorted(cold_response["json"].keys()),
        "series_schema_keys": sorted(cold_response["json"]["series"][0].keys()),
        "warm": {
            **sample_summary(warm_elapsed),
            "cache_headers": [warm_response["headers"].get("X-ERCOT-Cache")],
            "response_bytes": len(warm_response["body"]),
            "select_executions": warm_selects,
            "status": warm_response["status"],
            "total_requests": iterations,
        },
        "warmup_requests": 1,
        "timing_scope": "Handler.do_POST request read/parse through response serialization/write",
    }


def canonical_chunk_urls(
    *,
    end: int,
    metric: str,
    span: int,
    tags: list[str],
) -> list[str]:
    chunk_seconds = 86400
    requested_start = end - span
    aligned_start = (requested_start // chunk_seconds) * chunk_seconds
    resolution = max(1, math.ceil(span / 1200))
    return [
        "/api/v1/series/chunk?"
        + urlencode(
            {
                "aggregation": "average",
                "chunk_seconds": chunk_seconds,
                "end": start + chunk_seconds,
                "metric": metric,
                "resolution": resolution,
                "start": start,
                "tag": tags,
            },
            doseq=True,
        )
        for start in range(aligned_start, end, chunk_seconds)
    ]


def invoke_chunk_fanout(server, app, urls: list[str]) -> list[dict[str, Any]]:
    return [invoke_handler(server, app, "GET", url) for url in urls]


def measure_chunk_handler_window(
    conn: sqlite3.Connection,
    server,
    urls: list[str],
    *,
    iterations: int,
) -> dict[str, Any]:
    cold_elapsed: list[float] = []
    cold_selects: list[int] = []
    cold_responses = None
    for _ in range(iterations):
        app = benchmark_app(server, cache_entries=len(urls) + 8)
        cold_responses, elapsed, selects = traced_handler_call(
            conn,
            lambda: invoke_chunk_fanout(server, app, urls),
        )
        cold_elapsed.append(elapsed)
        cold_selects.append(selects)

    warm_app = benchmark_app(server, cache_entries=len(urls) + 8)
    invoke_chunk_fanout(server, warm_app, urls)
    warm_elapsed: list[float] = []
    warm_selects: list[int] = []
    warm_responses = None
    for _ in range(iterations):
        warm_responses, elapsed, selects = traced_handler_call(
            conn,
            lambda: invoke_chunk_fanout(server, warm_app, urls),
        )
        warm_elapsed.append(elapsed)
        warm_selects.append(selects)

    assert cold_responses is not None and warm_responses is not None
    return {
        "cold": {
            **sample_summary(cold_elapsed),
            "response_bytes": sum(len(response["body"]) for response in cold_responses),
            "select_executions": cold_selects,
            "statuses": [response["status"] for response in cold_responses],
            "total_requests": len(urls) * iterations,
        },
        "cold_cache_headers": sorted(
            set(response["headers"].get("X-ERCOT-Cache") for response in cold_responses)
        ),
        "requests_per_iteration": len(urls),
        "response_schema_keys": sorted(cold_responses[0]["json"].keys()),
        "unique_urls": len(set(urls)),
        "urls": urls,
        "warm": {
            **sample_summary(warm_elapsed),
            "response_bytes": sum(len(response["body"]) for response in warm_responses),
            "select_executions": warm_selects,
            "statuses": [response["status"] for response in warm_responses],
            "total_requests": len(urls) * iterations,
        },
        "warm_cache_headers": sorted(
            set(response["headers"].get("X-ERCOT-Cache") for response in warm_responses)
        ),
        "warmup_requests": len(urls),
        "timing_scope": "full Handler.do_GET canonical chunk fanout through response writes",
    }


def run_baseline(
    db_path: Path,
    server_path: Path,
    *,
    iterations: int = 5,
    max_points: int = 1_000,
    metric: str = "ercot.baseline.load_mw",
    tags: list[str] | None = None,
) -> dict[str, Any]:
    if iterations < 1 or iterations > 100:
        raise ValueError("iterations must be between 1 and 100")
    if max_points < 1 or max_points > 5_000:
        raise ValueError("max_points must be between 1 and 5000")
    tags = sorted(set(tags or ["region:texas", "source:fixture"]))
    server = load_server(server_path)
    handler = server.Handler.__new__(server.Handler)
    conn = open_read_only(db_path)
    try:
        row = conn.execute(
            "SELECT MAX(ts) FROM metrics WHERE metric_name = ?",
            (metric,),
        ).fetchone()
        if row is None or row[0] is None:
            raise ValueError(f"metric has no rows: {metric}")
        end = int(row[0])
        direct_sql_windows = {
            label: measure_window(
                conn,
                server,
                handler,
                end=end,
                iterations=iterations,
                max_points=max_points,
                metric=metric,
                span=span,
                tags=tags,
            )
            for label, span in WINDOWS
        }
        keys = [
            entry["cache_key"]
            for entry in direct_sql_windows.values()
            if entry["supported"]
        ]
        first_supported = next(
            entry for entry in direct_sql_windows.values() if entry["supported"]
        )
        reversed_request = json.loads(json.dumps(first_supported["request"]))
        reversed_request["queries"][0]["tags"] = list(reversed(tags))
        tag_order_keys = {
            handler._cache_key("series_batch", first_supported["request"]),
            handler._cache_key("series_batch", reversed_request),
        }
        original_get_db = server.get_db
        original_now_ts = server.now_ts
        server.get_db = lambda: conn
        server.now_ts = lambda: end + 2 * 86400
        try:
            handler_batch_windows = {
                label: measure_batch_handler_window(
                    conn,
                    server,
                    direct_sql_windows[label]["request"],
                    iterations=iterations,
                )
                for label, _span in WINDOWS
                if direct_sql_windows[label]["supported"]
            }
            fixed_end = (end // 86400) * 86400
            handler_chunk_windows = {
                label: measure_chunk_handler_window(
                    conn,
                    server,
                    canonical_chunk_urls(
                        end=fixed_end,
                        metric=metric,
                        span=span,
                        tags=tags,
                    ),
                    iterations=iterations,
                )
                for label, span in WINDOWS
                if direct_sql_windows[label]["supported"]
            }
        finally:
            server.get_db = original_get_db
            server.now_ts = original_now_ts
        return {
            "contract": {
                "cache_identity": "series_batch + sorted JSON of raw request payload",
                "endpoints": [
                    "POST /api/series/batch",
                    "GET /api/v1/series/chunk",
                ],
                "max_points": max_points,
                "metric": metric,
                "tags": tags,
            },
            "correction_age": {
                "current_ingest_contract": synthetic_correction_contract(server),
                "historical_observations": correction_age_buckets(conn),
            },
            "database": {
                "bytes": db_path.stat().st_size,
                "path": str(db_path.resolve()),
                "read_only": True,
            },
            "frontend_parse_merge": {
                "available": False,
                "reason": "requires a separate instrumented browser run; Python JSON parse proxy is recorded per window",
            },
            "measurement_scopes": {
                "direct_sql_windows": "direct receiver query helpers, EXPLAIN QUERY PLAN, and JSON parse proxy",
                "handler_batch_windows": "actual Handler.do_POST cold and warm receiver-cache requests",
                "handler_chunk_windows": "actual Handler.do_GET cold and warm canonical full fanout",
            },
            "handler_batch_windows": handler_batch_windows,
            "handler_chunk_windows": handler_chunk_windows,
            "request_cardinality": {
                "requests_if_each_window_loaded_twice": len(keys) * 2,
                "tag_order_variant_unique_keys": len(tag_order_keys),
                "unique_cache_keys": len(set(keys)),
                "windows": len(keys),
            },
            "server_path": str(server_path.resolve()),
            "direct_sql_windows": direct_sql_windows,
        }
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, help="Existing SQLite database opened read-only")
    parser.add_argument(
        "--server-path",
        type=Path,
        default=ROOT / "ercot-receiver" / "server.py",
    )
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--max-points", type=int, default=1_000)
    parser.add_argument("--metric", default="ercot.baseline.load_mw")
    parser.add_argument("--tag", action="append", dest="tags")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    temporary: tempfile.TemporaryDirectory[str] | None = None
    if args.db is None:
        temporary = tempfile.TemporaryDirectory()
        db_path = Path(temporary.name) / "baseline.db"
        server = load_server(args.server_path.resolve())
        build_fixture(db_path, server)
    else:
        db_path = args.db
    try:
        evidence = run_baseline(
            db_path.resolve(),
            args.server_path.resolve(),
            iterations=args.iterations,
            max_points=args.max_points,
            metric=args.metric,
            tags=args.tags,
        )
        rendered = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            print(rendered, end="")
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    main()
