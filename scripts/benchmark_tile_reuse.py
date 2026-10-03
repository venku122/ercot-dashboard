#!/usr/bin/env python3
"""Deterministic overlapping-window benchmark for the production v2 tile planner."""

from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
import http.client
import importlib.util
import json
import math
from pathlib import Path
import platform
import random
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "ercot-receiver" / "server.py"
BASE_BENCHMARK_PATH = ROOT / "scripts" / "benchmark_v2_tiles.py"
PLANNER_HELPER = ROOT / "scripts" / "plan_v2_tiles.mjs"
DAY = 86_400
HOUR = 3_600
SEED = 20260827
WINDOW_COUNT = 50
RANGES = (
    ("6h", 6 * HOUR),
    ("24h", DAY),
    ("7d", 7 * DAY),
    ("30d", 30 * DAY),
    ("90d", 90 * DAY),
    ("1y", 365 * DAY),
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[max(0, math.ceil(len(ordered) * quantile) - 1)]


def timing(values: list[float]) -> dict[str, float]:
    return {
        "p50_seconds": statistics.median(values) if values else 0.0,
        "p95_seconds": percentile(values, 0.95),
        "p99_seconds": percentile(values, 0.99),
    }


def deterministic_windows(fixture_end: int) -> dict[str, list[dict[str, int | str]]]:
    rng = random.Random(SEED)
    output: dict[str, list[dict[str, int | str]]] = {}
    for range_label, span in RANGES:
        windows = []
        for index in range(WINDOW_COUNT):
            pattern = index % 10
            if pattern == 0:
                shift = 0
            elif pattern in (1, 2):
                shift = pattern * 3 * HOUR
            elif pattern in (3, 4):
                shift = -((pattern - 2) * 3 * HOUR)
            elif pattern in (5, 6):
                shift = (index // 10 + 1) * DAY
            elif pattern == 7:
                shift = -(index // 10 + 1) * DAY
            else:
                shift = rng.randint(-36, 36) * HOUR + rng.randint(1, 59) * 60
            end = fixture_end - 2 * DAY + shift
            start = end - span
            windows.append(
                {
                    "label": f"{range_label}-{index:02d}",
                    "start": start,
                    "end": end,
                }
            )
        output[range_label] = windows
    return output


def navigation_traces(fixture_end: int) -> dict[str, list[dict[str, int | str]]]:
    end = fixture_end - 2 * DAY
    spans = {
        "24h": DAY,
        "7d": 7 * DAY,
        "30d": 30 * DAY,
        "90d": 90 * DAY,
        "1y": 365 * DAY,
    }
    trace_specs = {
        "A": [("24h", 0), ("24h", 3 * HOUR), ("24h", 6 * HOUR), ("7d", 0), ("30d", 0), ("7d", 0)],
        "B": [("7d-selected", 0), ("7d-previous", -7 * DAY), ("7d-selected", DAY), ("7d-previous", -6 * DAY)],
        "C": [("30d", 0), ("90d", 0), ("1y", 0), ("30d", 0)],
        "D": [("24h", 0), ("24h", 0), ("24h", 0), ("7d", 0)],
    }
    output = {}
    for trace, specs in trace_specs.items():
        rows = []
        for index, (raw_label, shift) in enumerate(specs):
            range_label = raw_label.split("-")[0]
            span = spans[range_label]
            window_end = end + shift
            rows.append({"label": f"{trace}-{index}-{raw_label}", "start": window_end - span, "end": window_end})
        output[trace] = rows
    return output


def production_plans(server, windows: list[dict[str, Any]], now: int) -> dict[str, list[str]]:
    payload = {
        "catalog": server.tile_catalog_payload(),
        "correctionHorizonSeconds": DAY,
        "end": now,
        "now": now,
        "seriesKey": "supply-demand.demand",
        "windows": windows,
    }
    completed = subprocess.run(
        ["node", "--experimental-strip-types", str(PLANNER_HELPER)],
        cwd=ROOT,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip())
    parsed = json.loads(completed.stdout)
    if parsed["planner_module"] != "frontend/src/dashboard/tile-planner.ts":
        raise RuntimeError("production planner was not used")
    if not parsed["default_matches_explicit_horizon"]:
        raise RuntimeError("planner correction horizon drift")
    return parsed["windows"]


def planner_summary(base, windows: list[dict[str, Any]], plans: dict[str, list[str]]) -> dict[str, Any]:
    v2_references = [url for window in windows for url in plans[window["label"]]]
    v1_by_window = {
        window["label"]: base.v1_urls(window["end"], window["end"] - window["start"])
        for window in windows
    }
    v1_references = [url for window in windows for url in v1_by_window[window["label"]]]
    seen: set[str] = set()
    windows_with_reuse = 0
    for window in windows:
        urls = plans[window["label"]]
        if seen.intersection(urls):
            windows_with_reuse += 1
        seen.update(urls)
    unique_v1 = len(set(v1_references))
    unique_v2 = len(set(v2_references))
    return {
        "window_count": len(windows),
        "v1_total_references": len(v1_references),
        "v1_unique_urls": unique_v1,
        "v2_total_references": len(v2_references),
        "v2_unique_urls": unique_v2,
        "url_cardinality_reduction": unique_v1 - unique_v2,
        "url_cardinality_reduction_percent": round(
            100 * (unique_v1 - unique_v2) / unique_v1, 3
        ) if unique_v1 else 0.0,
        "reuse_factor": round(len(v2_references) / unique_v2, 4),
        "average_references_per_unique_tile": round(len(v2_references) / unique_v2, 4),
        "windows_reusing_existing_tile_percent": round(
            100 * windows_with_reuse / len(windows), 3
        ),
        "application_cache_hits": len(v2_references) - unique_v2,
        "application_cache_misses": unique_v2,
        "application_cache_hit_ratio": round(
            (len(v2_references) - unique_v2) / len(v2_references), 6
        ),
        "unique_urls": sorted(set(v2_references)),
    }


def response_processing(responses: list[dict[str, Any]]) -> dict[str, Any]:
    parse_samples = []
    merge_samples = []
    for response in responses:
        started = time.perf_counter()
        payload = json.loads(response["body"])
        parse_samples.append(time.perf_counter() - started)
        started = time.perf_counter()
        sorted(payload["buckets"], key=lambda row: row["start"])
        merge_samples.append(time.perf_counter() - started)
    return {"json_parse": timing(parse_samples), "tile_merge": timing(merge_samples)}


def post_json(port: int, path: str, payload: Any, api_key: str) -> dict[str, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    body = json.dumps(payload).encode("utf-8")
    try:
        connection.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                "X-API-Key": api_key,
            },
        )
        response = connection.getresponse()
        parsed = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(f"POST {path} failed: {response.status} {parsed}")
        return parsed
    finally:
        connection.close()


def add_capacity_fixture(db_path: Path, server, *, days: int = 430) -> int:
    metric = "ercot.supply_demand.available_capacity_mw"
    tags = ["source:supply_demand"]
    rows = days * DAY // 300
    conn = sqlite3.connect(db_path)
    try:
        series_id = server.resolve_series_id(conn, metric, tags)
        conn.executemany(
            """
            INSERT INTO metrics
                (metric_name, ts, value, interval, metric_type, tags, series_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    metric,
                    1_735_689_600 + index * 300,
                    72_000.0 + float(index % 144),
                    300,
                    "power",
                    '["source:supply_demand"]',
                    series_id,
                )
                for index in range(rows)
            ),
        )
        conn.commit()
        return rows
    finally:
        conn.close()


def runtime_summary(base, server, app, port: int, urls: list[str]) -> dict[str, Any]:
    app.cache = server.Cache(10, max_entries=max(512, len(urls) + 16))
    app.cache_metrics = defaultdict(float)
    before = dict(app.cache_metrics)
    cold = [base.request(port, url) for url in urls]
    middle = dict(app.cache_metrics)
    warm = [base.request(port, url) for url in urls]
    after = dict(app.cache_metrics)
    if any(item["status"] != 200 for item in cold + warm):
        raise RuntimeError("runtime tile request failed")
    if [item["body"] for item in cold] != [item["body"] for item in warm]:
        raise RuntimeError("cold and warm bytes differ")
    return {
        "requests": len(urls),
        "response_bytes": sum(len(item["body"]) for item in cold),
        "cold": {
            "cache_headers": sorted({item["cache"] for item in cold}),
            "ttfb": timing([item["ttfb_seconds"] for item in cold]),
            "latency": timing([item["total_seconds"] for item in cold]),
            "sqlite_generations": base.delta(middle, before, "tile_sqlite_generations_total"),
            "sqlite_statements": base.delta(middle, before, "benchmark_sqlite_execute_fetch_count"),
            "sqlite_query_seconds": base.delta(middle, before, "benchmark_sqlite_execute_fetch_seconds"),
            "receiver_hits": base.delta(middle, before, "tile_receiver_lru_hits_total"),
            "receiver_misses": base.delta(middle, before, "tile_receiver_lru_misses_total"),
            **response_processing(cold),
        },
        "warm": {
            "cache_headers": sorted({item["cache"] for item in warm}),
            "ttfb": timing([item["ttfb_seconds"] for item in warm]),
            "latency": timing([item["total_seconds"] for item in warm]),
            "sqlite_generations": base.delta(after, middle, "tile_sqlite_generations_total"),
            "sqlite_statements": base.delta(after, middle, "benchmark_sqlite_execute_fetch_count"),
            "sqlite_query_seconds": base.delta(after, middle, "benchmark_sqlite_execute_fetch_seconds"),
            "receiver_hits": base.delta(after, middle, "tile_receiver_lru_hits_total"),
            "receiver_misses": base.delta(after, middle, "tile_receiver_lru_misses_total"),
            **response_processing(warm),
        },
    }


def run() -> dict[str, Any]:
    base = load_module("benchmark_v2_base", BASE_BENCHMARK_PATH)
    server = base.load_server(SERVER_PATH)
    with tempfile.TemporaryDirectory() as temporary_name:
        temporary = Path(temporary_name)
        db_path = temporary / "reuse.db"
        fixture = base.build_fixture(db_path, server, days=430)
        capacity_rows = add_capacity_fixture(db_path, server)
        fixture_end = fixture["end"] // DAY * DAY
        windows_by_range = deterministic_windows(fixture_end)
        plans_by_range = {
            label: production_plans(server, windows, fixture_end + DAY)
            for label, windows in windows_by_range.items()
        }
        planner = {
            label: planner_summary(base, windows_by_range[label], plans_by_range[label])
            for label, _span in RANGES
        }
        trace_windows = navigation_traces(fixture_end)
        traces = {}
        for label, windows in trace_windows.items():
            plans = production_plans(server, windows, fixture_end + DAY)
            references = [url for window in windows for url in plans[window["label"]]]
            traces[label] = {
                "steps": len(windows),
                "total_references": len(references),
                "unique_urls": len(set(references)),
                "reused_references": len(references) - len(set(references)),
                "reuse_factor": round(len(references) / len(set(references)), 4),
            }

        all_v2_urls = {
            url
            for plans in plans_by_range.values()
            for urls in plans.values()
            for url in urls
        }
        all_v2_references = sum(
            len(urls) for plans in plans_by_range.values() for urls in plans.values()
        )
        all_v1_urls = []
        for windows in windows_by_range.values():
            for window in windows:
                all_v1_urls.extend(base.v1_urls(window["end"], window["end"] - window["start"]))
        aggregate_reuse = {
            "window_count": WINDOW_COUNT * len(RANGES),
            "v1_total_references": len(all_v1_urls),
            "v1_unique_urls": len(set(all_v1_urls)),
            "v2_total_references": all_v2_references,
            "v2_unique_urls": len(all_v2_urls),
            "url_cardinality_reduction": len(set(all_v1_urls)) - len(all_v2_urls),
            "url_cardinality_reduction_percent": round(
                100 * (len(set(all_v1_urls)) - len(all_v2_urls)) / len(set(all_v1_urls)), 3
            ),
            "v2_reuse_factor": round(all_v2_references / len(all_v2_urls), 4),
        }

        server.DB_PATH = str(db_path)
        server.DB_LOCAL = threading.local()
        server.RATE_LIMIT_SERIES_RPM = 1_000_000
        server.RATE_LIMIT_INGEST_RPM = 1_000_000
        server.API_KEY = "benchmark-local-key"
        original_log = server.Handler.log_message
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

        def timed_storage(handler, conn, *args):
            recorder = base.SqliteExecuteFetchRecorder(handler._app_server())
            proxy = base.TimedConnectionProxy(conn, recorder)
            return original_storage(handler, proxy, *args)

        server.Handler.log_message = lambda *_args: None
        server.Handler.finish = closing_finish
        server.Handler._tile_storage_points = timed_storage
        app = server.Server(("127.0.0.1", 0))
        app.limiter = base.UnlimitedLimiter()
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        try:
            port = int(app.server_address[1])
            runtime = {
                label: runtime_summary(base, server, app, port, planner[label]["unique_urls"])
                for label, _span in RANGES
            }
            representative = planner["24h"]["unique_urls"][0]
            same_key = base.singleflight_probe(server, app, port, representative)
            app.cache = server.Cache(10, max_entries=512)
            app.cache_metrics = defaultdict(float)
            mixed_urls = [
                representative,
                representative.replace(
                    "supply-demand.demand", "supply-demand.available-capacity"
                ),
            ]
            with ThreadPoolExecutor(max_workers=2) as pool:
                mixed_responses = list(pool.map(lambda url: base.request(port, url), mixed_urls))
            mixed_metrics = dict(app.cache_metrics)
            mixed_key = {
                "statuses": sorted({response["status"] for response in mixed_responses}),
                "leaders": sum(response["singleflight"] == "LEADER" for response in mixed_responses),
                "sqlite_generations": mixed_metrics.get(
                    "tile_sqlite_generations_total", 0.0
                ),
                "singleflight_waiters": mixed_metrics.get(
                    "tile_singleflight_waits_total", 0.0
                ),
            }
            pre_restart = base.request(port, representative)
        finally:
            app.shutdown()
            app.server_close()
            thread.join(timeout=5)

        app2 = server.Server(("127.0.0.1", 0))
        app2.limiter = base.UnlimitedLimiter()
        app2.cache_metrics = defaultdict(float)
        thread2 = threading.Thread(target=app2.serve_forever, daemon=True)
        thread2.start()
        try:
            restart_port = int(app2.server_address[1])
            restarted = base.request(restart_port, representative)
            restart_metrics = dict(app2.cache_metrics)
            tile_start = int(representative.split("/")[-2])
            unrelated = representative.replace(f"/{tile_start}/", f"/{tile_start + DAY}/")
            affected_before = base.request(restart_port, representative)
            unrelated_before = base.request(restart_port, unrelated)
            correction_ts = tile_start + 900
            post_json(
                restart_port,
                "/api/ingest",
                [
                    {
                        "metric_name": "ercot.supply_demand.demand_mw",
                        "tags": ["source:supply_demand"],
                        "points": [
                            {
                                "timestamp": correction_ts,
                                "value": 55_555.0,
                                "dedupe_key": "tile-reuse-correction",
                            }
                        ],
                    }
                ],
                "benchmark-local-key",
            )
            affected_after = base.request(restart_port, representative)
            unrelated_after = base.request(restart_port, unrelated)
            correction = {
                "affected_cache_after": affected_after["cache"],
                "affected_bytes_changed": affected_after["body"] != affected_before["body"],
                "affected_etag_changed": affected_after["etag"] != affected_before["etag"],
                "unrelated_cache_after": unrelated_after["cache"],
                "unrelated_bytes_identical": unrelated_after["body"] == unrelated_before["body"],
                "unrelated_etag_identical": unrelated_after["etag"] == unrelated_before["etag"],
            }
        finally:
            app2.shutdown()
            app2.server_close()
            thread2.join(timeout=5)
            server.Handler.log_message = original_log
            server.Handler.finish = original_finish
            server.Handler._tile_storage_points = original_storage

        conn = sqlite3.connect(db_path)
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        conn.close()
        if "tile_resources" in tables:
            raise RuntimeError("generated tile persistence table exists")
        if restarted["cache"] != "MISS" or restart_metrics["tile_sqlite_generations_total"] != 1:
            raise RuntimeError("receiver restart did not regenerate from SQLite")
        if restarted["body"] != pre_restart["body"] or restarted["etag"] != pre_restart["etag"]:
            raise RuntimeError("restart regeneration was not deterministic")
        if correction != {
            "affected_cache_after": "MISS",
            "affected_bytes_changed": True,
            "affected_etag_changed": True,
            "unrelated_cache_after": "HIT",
            "unrelated_bytes_identical": True,
            "unrelated_etag_identical": True,
        }:
            raise RuntimeError(f"bounded correction proof failed: {correction}")

        for item in planner.values():
            item.pop("unique_urls")
        return {
            "schema": 1,
            "generated_at": 1787821200,
            "benchmark": {
                "name": "canonical_tile_overlapping_window_reuse",
                "seed": SEED,
                "windows_per_range": WINDOW_COUNT,
                "total_windows": WINDOW_COUNT * len(RANGES),
                "production_planner": "frontend/src/dashboard/tile-planner.ts",
                "correction_horizon_seconds": DAY,
                "target_point_count": 1200,
                "cold_definition": "fresh explicitly empty receiver LRU; OS page cache uncontrolled",
                "warm_definition": "same receiver process with requested canonical tiles retained in bounded LRU",
                "application_cache_definition": "same navigation process deduplicating exact canonical URLs",
            },
            "runtime": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            },
            "fixture": {
                **fixture,
                "rows": fixture["rows"] + capacity_rows,
                "database_bytes": db_path.stat().st_size,
                "physical_series_count": 2,
                "cadence_seconds": 300,
                "synthetic": True,
            },
            "ranges": {
                label: {"planner": planner[label], "receiver": runtime[label]}
                for label, _span in RANGES
            },
            "aggregate_reuse": aggregate_reuse,
            "navigation_traces": traces,
            "same_key_concurrency": same_key,
            "mixed_key_concurrency": mixed_key,
            "restart": {
                "cache_header": restarted["cache"],
                "sqlite_generations": restart_metrics["tile_sqlite_generations_total"],
                "bytes_identical": restarted["body"] == pre_restart["body"],
                "etag_identical": restarted["etag"] == pre_restart["etag"],
                "persistent_tile_table_absent": "tile_resources" not in tables,
            },
            "correction": correction,
            "production_mutation": False,
        }


def write_csv(path: Path, evidence: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "range", "window_count", "v1_total_references", "v1_unique_urls",
        "v2_total_references", "v2_unique_urls", "url_cardinality_reduction_percent",
        "reuse_factor", "application_cache_hit_ratio", "mode", "requests",
        "response_bytes", "sqlite_generations", "sqlite_statements",
        "sqlite_query_seconds", "receiver_hits", "receiver_misses",
        "ttfb_p50_seconds", "ttfb_p95_seconds", "latency_p50_seconds",
        "latency_p95_seconds", "parse_p50_seconds", "parse_p95_seconds",
        "merge_p50_seconds", "merge_p95_seconds",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for label, row in evidence["ranges"].items():
            planner = row["planner"]
            for mode in ("cold", "warm"):
                receiver = row["receiver"][mode]
                writer.writerow({
                    "range": label,
                    **{key: planner[key] for key in fields if key in planner},
                    "mode": mode,
                    "requests": row["receiver"]["requests"],
                    "response_bytes": row["receiver"]["response_bytes"],
                    "sqlite_generations": receiver["sqlite_generations"],
                    "sqlite_statements": receiver["sqlite_statements"],
                    "sqlite_query_seconds": receiver["sqlite_query_seconds"],
                    "receiver_hits": receiver["receiver_hits"],
                    "receiver_misses": receiver["receiver_misses"],
                    "ttfb_p50_seconds": receiver["ttfb"]["p50_seconds"],
                    "ttfb_p95_seconds": receiver["ttfb"]["p95_seconds"],
                    "latency_p50_seconds": receiver["latency"]["p50_seconds"],
                    "latency_p95_seconds": receiver["latency"]["p95_seconds"],
                    "parse_p50_seconds": receiver["json_parse"]["p50_seconds"],
                    "parse_p95_seconds": receiver["json_parse"]["p95_seconds"],
                    "merge_p50_seconds": receiver["tile_merge"]["p50_seconds"],
                    "merge_p95_seconds": receiver["tile_merge"]["p95_seconds"],
                })


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--csv", type=Path)
    args = parser.parse_args()
    evidence = run()
    serialized = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")
    if args.csv:
        write_csv(args.csv, evidence)


if __name__ == "__main__":
    main()
