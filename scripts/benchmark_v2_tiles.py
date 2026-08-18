#!/usr/bin/env python3
"""Reproducible direct-receiver benchmark for canonical v2 historical tiles.

The default run creates an isolated synthetic SQLite database, starts the real
receiver Handler on loopback, and never reads or mutates production state.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import http.client
import importlib.util
import json
import math
from pathlib import Path
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
DAY = 86_400
HOUR = 3_600
INTERVAL = 300
START = 1_735_689_600  # 2025-01-01T00:00:00Z
WINDOWS = (
    ("6h", 6 * HOUR),
    ("24h", DAY),
    ("7d", 7 * DAY),
    ("30d", 30 * DAY),
    ("90d", 90 * DAY),
    ("1y", 365 * DAY),
)
SERIES_KEY = "supply-demand.demand"
METRIC = "ercot.supply_demand.demand_mw"
TAGS = ["source:supply_demand"]
PLANNER_HELPER = ROOT / "scripts" / "plan_v2_tiles.mjs"


def load_server(path: Path):
    spec = importlib.util.spec_from_file_location("ercot_receiver_v2_benchmark", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load receiver module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_fixture(path: Path, server, *, days: int = 367) -> dict[str, int]:
    conn = sqlite3.connect(path)
    try:
        server.init_db(conn)
        series_id = server.resolve_series_id(conn, METRIC, TAGS)
        rows = days * DAY // INTERVAL
        conn.executemany(
            """
            INSERT INTO metrics
                (metric_name, ts, value, interval, metric_type, tags, series_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    METRIC,
                    START + index * INTERVAL,
                    45_000.0 + float((index % 288) - 144),
                    INTERVAL,
                    "power",
                    '["source:supply_demand"]',
                    series_id,
                )
                for index in range(rows)
            ),
        )
        conn.commit()
        return {"end": START + rows * INTERVAL, "rows": rows}
    finally:
        conn.close()


def v1_urls(end: int, span: int) -> list[str]:
    start = end - span
    resolution = max(1, math.ceil(span / 1_200))
    cursor = (start // DAY) * DAY
    output = []
    while cursor < end:
        output.append(
            "/api/v1/series/chunk?"
            + urlencode(
                {
                    "aggregation": "average",
                    "chunk_seconds": DAY,
                    "end": cursor + DAY,
                    "metric": METRIC,
                    "resolution": resolution,
                    "start": cursor,
                    "tag": TAGS,
                },
                doseq=True,
            )
        )
        cursor += DAY
    return output


def frontend_v2_plans(server, end: int, windows=WINDOWS) -> dict[str, Any]:
    """Run the production TypeScript planner against the receiver catalog."""
    input_payload = {
        "catalog": server.tile_catalog_payload(),
        "correctionHorizonSeconds": DAY,
        "end": end,
        "now": end + DAY,
        "seriesKey": SERIES_KEY,
        "windows": [[label, span] for label, span in windows],
    }
    completed = subprocess.run(
        ["node", "--experimental-strip-types", str(PLANNER_HELPER)],
        input=json.dumps(input_payload),
        capture_output=True,
        check=False,
        cwd=ROOT,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"frontend planner failed: {completed.stderr.strip()}")
    result = json.loads(completed.stdout)
    if result.get("correction_horizon_seconds") != DAY:
        raise RuntimeError("frontend planner correction horizon drift")
    if result.get("default_matches_explicit_horizon") is not True:
        raise RuntimeError("frontend planner default correction horizon drift")
    if result.get("series_key") != SERIES_KEY:
        raise RuntimeError("frontend planner series identity drift")
    expected_lods = server.TILE_CATALOG_BY_KEY[SERIES_KEY]["supported_lods"]
    if result.get("supported_lods") != expected_lods:
        raise RuntimeError("frontend planner catalog LOD drift")
    if set(result.get("windows", {})) != {label for label, _span in windows}:
        raise RuntimeError("frontend planner window drift")
    return result


class SqliteExecuteFetchRecorder:
    """Benchmark-only wall time for completed SQLite execute/fetch pairs."""

    def __init__(self, app):
        self.app = app

    def record(self, elapsed: float) -> None:
        with self.app.cache_metrics_lock:
            self.app.cache_metrics["benchmark_sqlite_execute_fetch_count"] += 1
            self.app.cache_metrics["benchmark_sqlite_execute_fetch_seconds"] += elapsed


class TimedCursorProxy:
    def __init__(self, cursor, started: float, recorder: SqliteExecuteFetchRecorder):
        self._cursor = cursor
        self._started = started
        self._recorder = recorder
        self._recorded = False

    def _finish(self) -> None:
        if not self._recorded:
            self._recorded = True
            self._recorder.record(time.perf_counter() - self._started)

    def fetchone(self):
        try:
            return self._cursor.fetchone()
        finally:
            self._finish()

    def fetchall(self):
        try:
            return self._cursor.fetchall()
        finally:
            self._finish()

    def fetchmany(self, *args):
        try:
            return self._cursor.fetchmany(*args)
        finally:
            self._finish()

    def __getattr__(self, name):
        return getattr(self._cursor, name)


class TimedConnectionProxy:
    def __init__(self, connection, recorder: SqliteExecuteFetchRecorder):
        self._connection = connection
        self._recorder = recorder

    def execute(self, *args, **kwargs):
        started = time.perf_counter()
        try:
            cursor = self._connection.execute(*args, **kwargs)
        except Exception:
            self._recorder.record(time.perf_counter() - started)
            raise
        return TimedCursorProxy(cursor, started, self._recorder)

    def __getattr__(self, name):
        return getattr(self._connection, name)


class UnlimitedLimiter:
    def allow(self, _key: str, _rpm: int) -> bool:
        return True


def request(port: int, path: str) -> dict[str, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    started = time.perf_counter()
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        ttfb = time.perf_counter() - started
        body = response.read()
        total = time.perf_counter() - started
        return {
            "body": body,
            "cache": response.getheader("X-ERCOT-Cache"),
            "singleflight": response.getheader("X-ERCOT-Singleflight"),
            "status": response.status,
            "total_seconds": total,
            "ttfb_seconds": ttfb,
        }
    finally:
        connection.close()


def delta(after: dict[str, float], before: dict[str, float], key: str) -> float:
    return float(after.get(key, 0.0) - before.get(key, 0.0))


def timing_summary(responses: list[dict[str, Any]], field: str) -> dict[str, float]:
    samples = sorted(float(item[field]) for item in responses)
    return {
        "p50_seconds": statistics.median(samples),
        "p95_seconds": samples[max(0, math.ceil(len(samples) * 0.95) - 1)],
        "sum_seconds": sum(samples),
    }


def decode_proxy(responses: list[dict[str, Any]]) -> dict[str, Any]:
    parse_started = time.perf_counter()
    payloads = [json.loads(item["body"]) for item in responses]
    parse_seconds = time.perf_counter() - parse_started
    merge_started = time.perf_counter()
    buckets = sorted(
        (bucket for payload in payloads for bucket in payload["buckets"]),
        key=lambda bucket: (bucket["start"], bucket["state"]["first_ordinal"] or 0),
    )
    checksum = sum(float(bucket["state"]["value_sum"]) for bucket in buckets)
    merge_seconds = time.perf_counter() - merge_started
    return {
        "bucket_count": len(buckets),
        "checksum": checksum,
        "json_parse_seconds": parse_seconds,
        "merge_proxy_seconds": merge_seconds,
        "proxy": "Python json.loads plus deterministic bucket sort/value_sum walk; not browser timing",
    }


def measure_fanout(app, port: int, urls: list[str]) -> dict[str, Any]:
    app.cache = app.cache.__class__(10, max_entries=max(512, len(urls) + 8))
    app.cache_metrics = defaultdict(float)
    before = dict(app.cache_metrics)
    cold = [request(port, url) for url in urls]
    middle = dict(app.cache_metrics)
    warm = [request(port, url) for url in urls]
    after = dict(app.cache_metrics)
    if any(item["status"] != 200 for item in [*cold, *warm]):
        raise RuntimeError("receiver benchmark request failed")
    raw_bodies_equal = [item["body"] for item in cold] == [
        item["body"] for item in warm
    ]
    if not raw_bodies_equal:
        raise RuntimeError("cold and warm raw response bodies differ")
    return {
        "requests": len(urls),
        "raw_bodies_equal": raw_bodies_equal,
        "response_bytes": {
            "cold": sum(len(item["body"]) for item in cold),
            "warm": sum(len(item["body"]) for item in warm),
        },
        "cold": {
            "cache_headers": sorted({item["cache"] for item in cold}),
            "total": timing_summary(cold, "total_seconds"),
            "ttfb": timing_summary(cold, "ttfb_seconds"),
            "tile_origin_requests_total": delta(
                middle, before, "tile_origin_requests_total"
            ),
            "tile_receiver_lru_hits_total": delta(
                middle, before, "tile_receiver_lru_hits_total"
            ),
            "tile_receiver_lru_misses_total": delta(
                middle, before, "tile_receiver_lru_misses_total"
            ),
            "tile_singleflight_waits_total": delta(
                middle, before, "tile_singleflight_waits_total"
            ),
            "tile_sqlite_generation_attempts_total": delta(
                middle, before, "tile_sqlite_generation_attempts_total"
            ),
            "tile_sqlite_generations_total": delta(
                middle, before, "tile_sqlite_generations_total"
            ),
            "tile_generation_latency_seconds_count": delta(
                middle, before, "tile_generation_latency_seconds_count"
            ),
            "tile_generation_latency_seconds_sum": delta(
                middle, before, "tile_generation_latency_seconds_sum"
            ),
            "tile_generation_latency_seconds_max": float(
                middle.get("tile_generation_latency_seconds_max", 0.0)
            ),
            "sqlite_execute_fetch_count": delta(
                middle, before, "benchmark_sqlite_execute_fetch_count"
            ),
            "sqlite_execute_fetch_seconds": delta(
                middle, before, "benchmark_sqlite_execute_fetch_seconds"
            ),
        },
        "warm": {
            "cache_headers": sorted({item["cache"] for item in warm}),
            "total": timing_summary(warm, "total_seconds"),
            "ttfb": timing_summary(warm, "ttfb_seconds"),
            "tile_origin_requests_total": delta(after, middle, "tile_origin_requests_total"),
            "tile_receiver_lru_hits_total": delta(
                after, middle, "tile_receiver_lru_hits_total"
            ),
            "tile_receiver_lru_misses_total": delta(
                after, middle, "tile_receiver_lru_misses_total"
            ),
            "tile_singleflight_waits_total": delta(
                after, middle, "tile_singleflight_waits_total"
            ),
            "tile_sqlite_generation_attempts_total": delta(
                after, middle, "tile_sqlite_generation_attempts_total"
            ),
            "tile_sqlite_generations_total": delta(
                after, middle, "tile_sqlite_generations_total"
            ),
            "tile_generation_latency_seconds_count": delta(
                after, middle, "tile_generation_latency_seconds_count"
            ),
            "tile_generation_latency_seconds_sum": delta(
                after, middle, "tile_generation_latency_seconds_sum"
            ),
            "tile_generation_latency_seconds_max": (
                0.0
                if delta(after, middle, "tile_generation_latency_seconds_count") == 0
                else float(after.get("tile_generation_latency_seconds_max", 0.0))
            ),
            "sqlite_execute_fetch_count": delta(
                after, middle, "benchmark_sqlite_execute_fetch_count"
            ),
            "sqlite_execute_fetch_seconds": delta(
                after, middle, "benchmark_sqlite_execute_fetch_seconds"
            ),
        },
        "frontend_proxies": {"cold": decode_proxy(cold), "warm": decode_proxy(warm)},
        "urls": urls,
    }


def singleflight_probe(server, app, port: int, url: str, clients: int = 10) -> dict[str, Any]:
    app.cache = server.Cache(10, max_entries=512)
    app.cache_metrics = defaultdict(float)
    original = server.Handler._generate_tile
    entered = threading.Event()

    def delayed(handler, *args):
        entered.set()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with app.cache_metrics_lock:
                waits = app.cache_metrics["tile_singleflight_waits_total"]
            if waits >= clients - 1:
                break
            time.sleep(0.001)
        return original(handler, *args)

    server.Handler._generate_tile = delayed
    before = dict(app.cache_metrics)
    client_barrier = threading.Barrier(clients)

    def racing_request():
        client_barrier.wait(timeout=2)
        return request(port, url)

    try:
        with ThreadPoolExecutor(max_workers=clients) as pool:
            futures = [pool.submit(racing_request) for _ in range(clients)]
            entered.wait(timeout=2)
            responses = [future.result() for future in futures]
    finally:
        server.Handler._generate_tile = original
    after = dict(app.cache_metrics)
    return {
        "clients": clients,
        "leader_responses": sum(item["singleflight"] == "LEADER" for item in responses),
        "shared_responses": sum(item["singleflight"] == "SHARED" for item in responses),
        "statuses": sorted({item["status"] for item in responses}),
        "tile_origin_requests_total": delta(after, before, "tile_origin_requests_total"),
        "tile_sqlite_generation_attempts_total": delta(
            after, before, "tile_sqlite_generation_attempts_total"
        ),
        "tile_sqlite_generations_total": delta(
            after, before, "tile_sqlite_generations_total"
        ),
        "tile_singleflight_waits_total": delta(
            after, before, "tile_singleflight_waits_total"
        ),
    }


def run(server_path: Path, *, days: int = 367) -> dict[str, Any]:
    server = load_server(server_path)
    temporary = tempfile.TemporaryDirectory()
    try:
        db_path = Path(temporary.name) / "v2-benchmark.db"
        fixture = build_fixture(db_path, server, days=days)
        end = (fixture["end"] // DAY) * DAY
        server.DB_PATH = str(db_path)
        server.DB_LOCAL = threading.local()
        server.RATE_LIMIT_SERIES_RPM = 1_000_000
        original_log_message = server.Handler.log_message
        server.Handler.log_message = lambda *_args: None
        original_storage = server.Handler._tile_storage_points
        original_finish = server.Handler.finish

        def closing_finish(handler):
            try:
                original_finish(handler)
            finally:
                conn = getattr(server.DB_LOCAL, "conn", None)
                if conn is not None:
                    conn.close()
                    del server.DB_LOCAL.conn

        server.Handler.finish = closing_finish

        def timed_storage(handler, conn, *args):
            recorder = SqliteExecuteFetchRecorder(handler._app_server())
            return original_storage(handler, TimedConnectionProxy(conn, recorder), *args)

        server.Handler._tile_storage_points = timed_storage
        app = server.Server(("127.0.0.1", 0))
        app.limiter = UnlimitedLimiter()
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(app.server_address[1])
            eligible_windows = tuple(
                (label, span) for label, span in WINDOWS if span <= days * DAY
            )
            planner = frontend_v2_plans(server, end, eligible_windows)
            windows = {
                label: measure_fanout(app, port, planner["windows"][label])
                for label, _span in eligible_windows
            }
            all_v1 = [
                url
                for _label, span in eligible_windows
                for url in v1_urls(end, span)
            ]
            all_v2 = [
                url
                for label, _span in eligible_windows
                for url in planner["windows"][label]
            ]
            probe = singleflight_probe(server, app, port, all_v2[0])
            return {
                "cardinality": {
                    "v1_contract": "faithful independently frozen v1 baseline",
                    "v1_total_requests": len(all_v1),
                    "v1_unique_urls": len(set(all_v1)),
                    "v2_total_requests": len(all_v2),
                    "v2_unique_urls": len(set(all_v2)),
                    "unique_url_reduction": len(set(all_v1)) - len(set(all_v2)),
                    "unique_url_reduction_percent": round(
                        100.0 * (len(set(all_v1)) - len(set(all_v2))) / len(set(all_v1)),
                        3,
                    ),
                },
                "contract": {
                    "endpoint": "GET /api/v2/tiles/{series_key}/{tile_span}/{tile_start}/{lod}",
                    "measurement": "real loopback ThreadingHTTPServer and Handler.do_GET",
                    "frontend_planner": planner["planner_module"],
                    "frontend_planner_correction_horizon_seconds": planner[
                        "correction_horizon_seconds"
                    ],
                    "frontend_planner_default_matches_explicit_horizon": planner[
                        "default_matches_explicit_horizon"
                    ],
                    "frontend_planner_supported_lods": planner["supported_lods"],
                    "production_mutation": False,
                    "series_key": SERIES_KEY,
                    "synthetic": True,
                },
                "database": {"bytes": db_path.stat().st_size, **fixture},
                "receiver_cache": app.cache.stats(),
                "singleflight": probe,
                "windows": windows,
            }
        finally:
            app.shutdown()
            app.server_close()
            thread.join(timeout=5)
            server.Handler._tile_storage_points = original_storage
            server.Handler.finish = original_finish
            server.Handler.log_message = original_log_message
    finally:
        temporary.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--server-path",
        type=Path,
        default=ROOT / "ercot-receiver" / "server.py",
    )
    args = parser.parse_args()
    print(json.dumps(run(args.server_path.resolve()), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
