#!/usr/bin/env python3

import importlib.util
import io
import json
from datetime import date, timedelta
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("historical_context_api_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)
hc = sys.modules[server.resolve_historical_context.__module__]


class HistoricalContextApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "TestServer", (), {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "cache_metrics_lock": threading.Lock(),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()
        self.old_key = server.API_KEY
        self.old_now = server.now_ts
        server.API_KEY = "history-key"
        self.day = date(2026, 1, 15)
        self.as_of = hc._hour_bounds(self.day, 10)[1]
        server.now_ts = lambda: self.as_of + 60

    def tearDown(self):
        server.API_KEY = self.old_key
        server.now_ts = self.old_now
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        self.tmp.cleanup()

    def invoke(self, method, path, payload=None, headers=None, status=200):
        body = b"" if payload is None else json.dumps(payload).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            **(headers or {}),
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda value: setattr(handler, "response_status", value)
        handler.response_headers = {}
        handler.send_header = lambda key, value: handler.response_headers.__setitem__(key, value)
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        self.assertEqual(status, handler.response_status)
        raw = handler.wfile.getvalue()
        return (None if not raw else json.loads(raw), handler.response_headers, raw)

    def demand_payload(self, first_value=10.0):
        starts = hc._hour_starts(self.day, 10)
        return [{
            "metric": hc.METRIC,
            "tags": ["source:supply_demand"],
            "interval": 300,
            "points": [
                {
                    "timestamp": start + offset,
                    "value": first_value if offset == 0 else 20.0 + offset,
                    "dedupe_key": f"api:{start + offset}",
                }
                for start in starts for offset in range(0, 3600, 300)
            ],
        }]

    def ingest(self, payload=None):
        return self.invoke(
            "POST", "/api/ingest", payload or self.demand_payload(),
            headers={"X-API-Key": "history-key"},
        )[0]

    def resolver_path(self):
        return f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of={self.as_of}"

    def test_resolver_resource_etag_and_time_advance_stability(self):
        self.ingest()
        resolver, headers, _raw = self.invoke("GET", self.resolver_path())
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertEqual(
            "public, max-age=0, s-maxage=15, must-revalidate",
            headers["Cache-Control"],
        )
        resource, resource_headers, resource_raw = self.invoke("GET", resolver["resource"]["url"])
        self.assertEqual(resolver["summary"], resource)
        self.assertIn("immutable", resource_headers["Cache-Control"])
        etag = resource_headers["ETag"]
        empty, not_modified_headers, not_modified_raw = self.invoke(
            "GET", resolver["resource"]["url"], headers={"If-None-Match": etag}, status=304
        )
        self.assertIsNone(empty)
        self.assertEqual(b"", not_modified_raw)
        self.assertEqual(etag, not_modified_headers["ETag"])
        server.now_ts = lambda: self.as_of + 401 * 86400
        later, later_headers, later_raw = self.invoke("GET", resolver["resource"]["url"])
        self.assertEqual(resource, later)
        self.assertEqual(resource_raw, later_raw)
        self.assertEqual(etag, later_headers["ETag"])

    def test_correction_invalidates_resolver_and_generation_guard(self):
        self.ingest()
        first, _headers, _raw = self.invoke("GET", self.resolver_path())
        old_generation = self.app.cache.snapshot_generation()
        corrected = self.demand_payload(first_value=999999.0)
        result = self.ingest(corrected)
        self.assertEqual(1, result["updated"])
        self.assertIsNone(self.app.cache.get(f"historical-context:v1:{self.as_of}"))
        self.assertFalse(
            self.app.cache.set_if_generation(
                "historical-context:obsolete", {"bad": True}, old_generation,
                {"historical-context"},
            )
        )
        second, headers, _raw = self.invoke("GET", self.resolver_path())
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertNotEqual(first["resource"]["content_version"], second["resource"]["content_version"])
        old_resource, _headers, _raw = self.invoke("GET", first["resource"]["url"])
        self.assertEqual(first["summary"], old_resource)

    def test_strict_resolver_and_resource_shapes(self):
        self.ingest()
        good, _headers, _raw = self.invoke("GET", self.resolver_path())
        for path in (
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}",
            f"/api/v1/historical-context?series_key=other&as_of={self.as_of}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of={self.as_of + 1}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of={self.as_of + 3600}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of=0",
            f"/api/v1/historical-context?as_of={self.as_of}&series_key={hc.SERIES_KEY}",
            f"/api/v1/historical-context?series_key=supply-demand%2Edemand&as_of={self.as_of}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of=0{self.as_of}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of=%2B{self.as_of}",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of={self.as_of}&as_of={self.as_of}",
        ):
            self.invoke("GET", path, status=400)
        self.invoke("GET", good["resource"]["url"] + "?x=1", status=400)
        self.invoke(
            "GET",
            f"/api/v2/historical-context/{hc.SERIES_KEY}/v1/hc1-{'0' * 64}/{self.as_of}",
            status=404,
        )

    def test_prior_only_same_season_hour_type7_and_competition_rank(self):
        selected_day = date(2026, 2, 15)
        points = []
        for offset in range(30, -1, -1):
            market_day = selected_day - timedelta(days=offset)
            value = 20.0 if offset == 0 else float(30 - offset)
            start, end = hc._date_bounds(market_day)
            points.extend(
                {
                    "timestamp": timestamp,
                    "value": value,
                    "dedupe_key": f"type7:{timestamp}",
                }
                for timestamp in range(start, end, 300)
            )

        for index in range(0, len(points), 2_000):
            self.ingest([{
                "metric": hc.METRIC,
                "tags": ["source:supply_demand"],
                "interval": 300,
                "points": points[index:index + 2_000],
            }])

        as_of = hc._date_bounds(selected_day)[1]
        server.now_ts = lambda: as_of + 60
        summary, _headers, _raw = self.invoke(
            "GET",
            f"/api/v1/historical-context?series_key={hc.SERIES_KEY}&as_of={as_of}",
        )
        cohort = summary["summary"]["seasonal_local_hour_percentiles"]
        self.assertEqual(30, cohort["sample_count"])
        self.assertAlmostEqual(2.9, cohort["p10"])
        self.assertAlmostEqual(14.5, cohort["p50"])
        self.assertAlmostEqual(26.1, cohort["p90"])

        rank = summary["summary"]["completed_day_peak_rank"]
        self.assertEqual("partial", rank["state"])
        self.assertEqual(10, rank["rank"])
        self.assertEqual(31, rank["denominator"])
        self.assertEqual("competition", rank["ties"])


if __name__ == "__main__":
    unittest.main()
