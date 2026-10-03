"""Independent HTTP acceptance for versioned forecast-quality resources."""

from __future__ import annotations

import importlib.util
import io
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("forecast_quality_api_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SERVER_PATH}")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


DAY_START = 1_800_057_600
CONTENT_VERSION = "q1-" + "a" * 64
RESOURCE_PATH = (
    "/api/v2/forecast-quality/load.system/v1/"
    f"{CONTENT_VERSION}/1h/1d/{DAY_START}"
)


class ForecastQualityApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        server.now_ts = lambda: DAY_START + 86_400
        self.old_now = server.now_ts
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: DAY_START + 86_400
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        payload = {
            "schema": 1,
            "kind": "forecast_quality_daily",
            "series_key": "load.system",
            "horizon": "1h",
            "horizon_seconds": 3_600,
            "tile_span": "1d",
            "day_start": DAY_START,
            "day_end": DAY_START + 86_400,
            "unit": "MW",
            "methodology_version": "v1",
            "methodology": {"diagnostic_pairing": "acceptance fixture"},
            "model_counts": {},
            "missing_reasons": {},
            "summary": {"sample_count": 0},
            "rows": [],
            "content_version": CONTENT_VERSION,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        conn.execute(
            """
            INSERT INTO forecast_quality_resources (
                series_key, methodology_version, content_version, horizon,
                day_start, payload_json, created_at
            ) VALUES ('load.system', 'v1', ?, '1h', ?, ?, ?)
            """,
            (CONTENT_VERSION, DAY_START, encoded, DAY_START + 100),
        )
        conn.execute(
            """
            INSERT INTO forecast_quality_current (
                series_key, methodology_version, horizon, day_start,
                content_version, dataset_cutoff, updated_at
            ) VALUES ('load.system', 'v1', '1h', ?, ?, ?, ?)
            """,
            (DAY_START, CONTENT_VERSION, DAY_START + 100, DAY_START + 100),
        )
        conn.commit()
        conn.close()
        self.app = type(
            "AcceptanceServer",
            (),
            {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "cache_metrics_lock": threading.Lock(),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        server.DB_PATH = self.old_db_path
        server.DB_LOCAL = self.old_db_local
        server.now_ts = self.old_now_ts
        server.now_ts = self.old_now
        self.tmp.cleanup()

    def get(self, path, headers=None):
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        handler.headers = headers or {}
        handler.rfile = io.BytesIO()
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(
            name, value
        )
        handler.end_headers = lambda: None
        try:
            handler.do_GET()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def post(self, path, payload, headers=None):
        body = json.dumps(payload).encode("utf-8")
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            **(headers or {}),
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(
            name, value
        )
        handler.end_headers = lambda: None
        try:
            handler.do_POST()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def test_immutable_resource_bytes_etag_hit_and_304_are_identical(self):
        status, first_headers, first_body = self.get(RESOURCE_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(first_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(first_headers["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertNotIn(b"publication_id", first_body)

        status, hit_headers, hit_body = self.get(RESOURCE_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(hit_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(hit_body, first_body)
        self.assertEqual(hit_headers["ETag"], first_headers["ETag"])

        status, not_modified_headers, not_modified_body = self.get(
            RESOURCE_PATH, {"If-None-Match": first_headers["ETag"]}
        )
        self.assertEqual(status, 304)
        self.assertEqual(not_modified_body, b"")
        self.assertEqual(not_modified_headers["ETag"], first_headers["ETag"])

    def test_manifest_url_is_canonical_and_resource_validation_is_strict(self):
        status, headers, body = self.get("/api/v1/forecast-quality")
        self.assertEqual(status, 200)
        manifest = json.loads(body)
        self.assertEqual(manifest["resources"][0]["url"], RESOURCE_PATH)
        self.assertEqual(headers["X-ERCOT-Cache"], "MISS")

        status, headers, body_again = self.get("/api/v1/forecast-quality")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(body_again, body)

        status, headers, _body = self.get(RESOURCE_PATH + "?unexpected=1")
        self.assertEqual(status, 400)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_ten_simultaneous_resource_misses_share_one_storage_read(self):
        original = server.forecast_quality_resource
        calls = 0
        calls_lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with calls_lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.forecast_quality_resource = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _index: self.get(RESOURCE_PATH), range(10)))
        finally:
            server.forecast_quality_resource = original

        self.assertEqual(calls, 1)
        self.assertTrue(all(status == 200 for status, _headers, _body in responses))
        self.assertEqual(len({body for _status, _headers, body in responses}), 1)
        self.assertEqual(
            len({headers["ETag"] for _status, headers, _body in responses}),
            1,
        )

    def test_runner_source_health_is_visible_for_both_renewable_series(self):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            for source_id, product_id in (
                ("ercot_mis_np4_732", "NP4-732-CD"),
                ("ercot_mis_np4_737", "NP4-737-CD"),
            ):
                server.update_source_health(
                    conn,
                    {
                        "source_id": source_id,
                        "display_name": f"ERCOT MIS {product_id} hourly publication",
                        "expected_interval_seconds": 3_600,
                        "publication_mode": "event",
                        "publication_interval_seconds": 3_600,
                        "attempted_at": DAY_START + 200,
                        "success": True,
                        "row_count": 24,
                        "availability_status": "available",
                        "source_timestamp_ts": DAY_START + 100,
                        "data_timestamp_ts": DAY_START + 100,
                    },
                    current_ts=DAY_START + 200,
                )
        finally:
            conn.close()

        status, _headers, body = self.get("/api/v1/forecast-quality")
        self.assertEqual(status, 200)
        contracts = {item["series_key"]: item for item in json.loads(body)["source_contracts"]}
        for series_key in ("wind.stwpf", "solar.stppf"):
            self.assertTrue(
                any(
                    health["availability_status"] == "available"
                    for health in contracts[series_key]["health"]
                ),
                series_key,
            )

        conn = sqlite3.connect(server.DB_PATH)
        try:
            stopped = server.forecast_quality_manifest(conn, now=DAY_START + 10_000)
        finally:
            conn.close()
        stopped_contracts = {
            item["series_key"]: item for item in stopped["source_contracts"]
        }
        for series_key in ("wind.stwpf", "solar.stppf"):
            self.assertEqual(stopped_contracts[series_key]["health"][0]["state"], "delayed")

    def test_source_health_batch_rolls_back_every_product_on_validation_failure(self):
        common = {
            "display_name": "ERCOT MIS renewable publication",
            "expected_interval_seconds": 3_600,
            "publication_mode": "event",
            "publication_interval_seconds": 3_600,
            "attempted_at": DAY_START + 200,
            "success": True,
            "row_count": 24,
            "availability_status": "available",
        }
        attempts = [
            {**common, "source_id": "ercot_mis_np4_732"},
            {
                **common,
                "source_id": "ercot_mis_np4_737",
                "availability_status": "not-an-allowed-state",
            },
        ]
        old_key = server.API_KEY
        server.API_KEY = "acceptance-key"
        try:
            status, _headers, _body = self.post(
                "/api/source-health",
                attempts,
                {"X-API-Key": "acceptance-key"},
            )
        finally:
            server.API_KEY = old_key
        self.assertEqual(status, 400)
        conn = sqlite3.connect(server.DB_PATH)
        try:
            count = conn.execute(
                "SELECT COUNT(*) FROM collector_sources "
                "WHERE source_id IN ('ercot_mis_np4_732', 'ercot_mis_np4_737')"
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(count, 0)

    def test_recompute_route_rejects_future_cutoff_without_moving_pointer(self):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            before = conn.execute(
                "SELECT content_version, dataset_cutoff FROM forecast_quality_current"
            ).fetchone()
        finally:
            conn.close()
        old_key = server.API_KEY
        server.API_KEY = "acceptance-key"
        try:
            status, _headers, _body = self.post(
                "/api/forecast-quality/recompute",
                {
                    "series_key": "load.system",
                    "day_start": DAY_START,
                    "horizons": ["1h"],
                    "dataset_cutoff": DAY_START + 86_701,
                },
                {"X-API-Key": "acceptance-key"},
            )
        finally:
            server.API_KEY = old_key
        self.assertEqual(status, 400)
        conn = sqlite3.connect(server.DB_PATH)
        try:
            after = conn.execute(
                "SELECT content_version, dataset_cutoff FROM forecast_quality_current"
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
