#!/usr/bin/env python3
"""Black-box HTTP/cache acceptance for immutable PR12 resources."""

import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

import net_load
import server


class NetLoadHttpAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        net_load.init_net_load_schema(conn)
        self.day_start = 1_768_435_200
        self.content_version = "v1-" + "a" * 64
        self.semantic_key = net_load.FORECAST_SEMANTIC_KEYS["1h"]
        self.payload = {
            "kind": "net_load_tile",
            "schema_version": 1,
            "methodology_version": "v1",
            "series_key": self.semantic_key,
            "horizon": "1h",
            "selection_policy": "coherent_whole_curve_latest_capped_before_utc_day",
            "snapshot_lead_seconds": 3_600,
            "day_start": self.day_start,
            "day_end": self.day_start + 86_400,
            "timezone": "UTC",
            "tile_span": "1d",
            "lod": "native",
            "unit": "MW",
            "official_ercot_net_load": False,
            "storage_policy": "context_only_not_in_formula",
            "rows": [],
            "content_version": self.content_version,
        }
        conn.execute(
            """
            INSERT INTO net_load_resources(
              series_key,methodology_version,content_version,horizon,
              day_start,lod,payload_json,created_at
            ) VALUES(?,?,?,?,?,'native',?,?)
            """,
            (
                net_load.FORECAST_SERIES_KEY,
                "v1",
                self.content_version,
                "1h",
                self.day_start,
                net_load.canonical_json(self.payload),
                self.day_start + 86_400,
            ),
        )
        conn.commit()
        conn.close()
        self.app = type(
            "TestServer",
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
        self.tmp.cleanup()

    def invoke(self, request_headers=None):
        handler = server.Handler.__new__(server.Handler)
        handler.path = (
            f"/api/v2/net-load/{self.semantic_key}/v1/{self.content_version}/"
            f"1d/{self.day_start}/native"
        )
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": "0",
            "Content-Type": "application/json",
            **(request_headers or {}),
        }
        handler.rfile = io.BytesIO()
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        try:
            handler.do_GET()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def test_immutable_tile_bytes_etag_hit_and_304_are_identical(self):
        first_status, first_headers, first_body = self.invoke()
        warm_status, warm_headers, warm_body = self.invoke()
        conditional_status, conditional_headers, conditional_body = self.invoke(
            {"If-None-Match": first_headers["ETag"]}
        )

        self.assertEqual(first_status, 200)
        self.assertEqual(warm_status, 200)
        self.assertEqual(conditional_status, 304)
        self.assertEqual(first_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(warm_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(conditional_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(first_headers["ETag"], warm_headers["ETag"])
        self.assertEqual(first_headers["ETag"], conditional_headers["ETag"])
        self.assertEqual(first_body, warm_body)
        self.assertEqual(json.loads(first_body), self.payload)
        self.assertEqual(conditional_body, b"")
        self.assertEqual(first_headers["Cache-Control"], "public, max-age=31536000, immutable")


if __name__ == "__main__":
    unittest.main()
