#!/usr/bin/env python3
"""Independent HTTP/cache acceptance for PR18 predictive weather."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest

import predictive_weather as weather
import server


NOW = 1_777_000_300
START = NOW - 300
POINT_MAPPING = {
    "KDFW": ("FWD", 74, 103),
    "KAUS": ("EWX", 156, 90),
    "KHOU": ("HGX", 65, 92),
    "KSAT": ("EWX", 133, 80),
}


def forecast(value=-1.0, revision=0):
    points = []
    for point_id, label, latitude, longitude in weather.POINTS:
        grid_id, grid_x, grid_y = POINT_MAPPING[point_id]
        points.append(
            {
                "point_id": point_id,
                "label": label,
                "latitude": latitude,
                "longitude": longitude,
                "mapping": {
                    "grid_id": grid_id,
                    "grid_x": grid_x,
                    "grid_y": grid_y,
                    "time_zone": "America/Chicago",
                    "forecast_grid_data_url": (
                        f"https://api.weather.gov/gridpoints/{grid_id}/{grid_x},{grid_y}"
                    ),
                },
                "update_time": START + revision,
                "retrieved_at": START + 30 + revision,
                "cache_fresh_until": NOW + 3_600 + revision,
                "layers": [
                    {
                        "key": key,
                        "unit": unit,
                        "rows": [
                            {
                                "valid_start": START,
                                "valid_end": START + 3_600,
                                "value": None if key == "heatIndex" else value,
                            }
                        ],
                    }
                    for key, unit in weather.LAYERS
                ],
            }
        )
    return {"schema": 1, "stream": "forecast", "points": points}


def alerts(*, empty=False, marker="first", revision=0):
    items = []
    if not empty:
        items.append(
            {
                "id": f"urn:oid:{marker}",
                "event": "High Wind Warning",
                "headline": f"High Wind Warning {marker}",
                "area_desc": "North Texas",
                "severity": "Severe",
                "urgency": "Expected",
                "certainty": "Likely",
                "message_type": "Alert",
                "sent": START,
                "effective": START,
                "onset": START,
                "expires": START + 3_600,
                "ends": START + 3_600,
                "description": "Official fixture description",
                "instruction": None,
                "response": "Prepare",
                "affected_zones": [
                    "https://api.weather.gov/zones/forecast/TXZ119"
                ],
                "references": [],
                "source_url": f"https://api.weather.gov/alerts/urn:oid:{marker}",
            }
        )
    return {
        "schema": 1,
        "stream": "alerts",
        "collection_updated_at": START + revision,
        "retrieved_at": START + 30 + revision,
        "cache_fresh_until": NOW + 600 + revision,
        "truncated": False,
        "items": items,
    }


class PredictiveWeatherApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        self.old_api_key = server.API_KEY
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: NOW
        server.API_KEY = "predictive-weather-acceptance-key"
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "PredictiveWeatherAcceptanceServer",
            (),
            {
                "cache": server.Cache(128),
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
        server.API_KEY = self.old_api_key
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = b"" if payload is None else json.dumps(payload).encode()
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
        handler.send_response = lambda status: setattr(
            handler, "response_status", status
        )
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(
            name, value
        )
        handler.end_headers = lambda: None
        try:
            getattr(handler, f"do_{method}")()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def post(self, payload, authenticated=True):
        headers = {"X-API-Key": server.API_KEY} if authenticated else {}
        return self.request(
            "POST", "/api/predictive-weather/ingest", payload, headers
        )

    def get(self, headers=None, path="/api/v1/predictive-weather"):
        return self.request("GET", path, headers=headers)

    def test_auth_queryless_etag_304_and_independent_stream_invalidation(self):
        self.assertEqual(401, self.post(forecast(), authenticated=False)[0])
        self.assertEqual(200, self.post(forecast())[0])
        self.assertEqual(200, self.post(alerts(empty=True))[0])

        status, headers, body = self.get()
        self.assertEqual(200, status, body)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertIn("must-revalidate", headers["Cache-Control"])
        manifest = json.loads(body)
        self.assertEqual("available", manifest["forecast"]["state"])
        self.assertEqual("valid_empty", manifest["alerts"]["state"])
        self.assertEqual(
            [point[0] for point in weather.POINTS],
            [point["point_id"] for point in manifest["forecast"]["points"]],
        )

        etag = headers["ETag"]
        status, repeat_headers, repeat_body = self.get({"If-None-Match": etag})
        self.assertEqual(304, status)
        self.assertEqual(etag, repeat_headers["ETag"])
        self.assertEqual(b"", repeat_body)
        status, query_headers, _body = self.get(path="/api/v1/predictive-weather?point=KDFW")
        self.assertEqual(400, status)
        self.assertEqual("no-store", query_headers["Cache-Control"])

        self.assertEqual(200, self.post(alerts(marker="changed", revision=1))[0])
        status, changed_headers, changed_body = self.get()
        self.assertEqual(200, status, changed_body)
        self.assertEqual("MISS", changed_headers["X-ERCOT-Cache"])
        self.assertNotEqual(etag, changed_headers["ETag"])
        changed = json.loads(changed_body)
        self.assertEqual("urn:oid:changed", changed["alerts"]["items"][0]["id"])
        self.assertEqual(-1.0, changed["forecast"]["points"][0]["layers"][0]["rows"][0]["value"])

    def test_cold_concurrency_singleflights_identical_bytes(self):
        self.assertEqual(200, self.post(forecast())[0])
        self.assertEqual(200, self.post(alerts())[0])
        self.app.cache = server.Cache(128)
        original = server.predictive_weather_manifest
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.predictive_weather_manifest = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _index: self.get(), range(10)))
        finally:
            server.predictive_weather_manifest = original
        self.assertEqual(1, calls)
        self.assertEqual({status for status, _headers, _body in responses}, {200})
        self.assertEqual(1, len({body for _status, _headers, body in responses}))
        self.assertEqual(1, len({headers["ETag"] for _status, headers, _body in responses}))
        self.assertEqual(0, self.app.singleflight.pending())

    def test_inflight_ingest_invalidation_cannot_repopulate_stale_bytes(self):
        self.assertEqual(200, self.post(forecast(-1.0))[0])
        self.app.cache = server.Cache(128)
        original = server.predictive_weather_manifest
        generated = threading.Event()
        release = threading.Event()

        def blocked(*args, **kwargs):
            result = original(*args, **kwargs)
            generated.set()
            self.assertTrue(release.wait(2))
            return result

        server.predictive_weather_manifest = blocked
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale = pool.submit(self.get)
                self.assertTrue(generated.wait(2))
                self.assertEqual(200, self.post(forecast(42.0, revision=1))[0])
                release.set()
                self.assertEqual(200, stale.result()[0])
        finally:
            release.set()
            server.predictive_weather_manifest = original

        status, headers, body = self.get()
        self.assertEqual(200, status, body)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertEqual(
            42.0,
            json.loads(body)["forecast"]["points"][0]["layers"][0]["rows"][0]["value"],
        )

    def test_malformed_ingest_records_stream_failure_without_erasing_last_good(self):
        self.assertEqual(200, self.post(forecast())[0])
        server.now_ts = lambda: NOW + 1
        malformed = forecast()
        malformed["points"][0]["unexpected"] = True
        status, headers, body = self.post(malformed)
        self.assertEqual(400, status, body)
        self.assertEqual("no-store", headers["Cache-Control"])

        manifest = json.loads(self.get()[2])
        self.assertEqual("available", manifest["forecast"]["state"])
        health = next(
            item
            for item in manifest["source_health"]
            if item["source_id"] == "nws_grid_forecast"
        )
        self.assertEqual("failed", health["state"])
        self.assertEqual(1, health["consecutive_failures"])
        self.assertIsNotNone(manifest["forecast"]["content_version"])

    def test_same_clock_collision_fails_closed_and_reverse_order_replay_is_ignored(self):
        self.assertEqual(200, self.post(forecast(-1.0, revision=2))[0])

        collision_status, _headers, collision_body = self.post(
            forecast(99.0, revision=2)
        )
        self.assertEqual(400, collision_status, collision_body)
        self.assertEqual(
            "predictive_weather_publication_collision",
            json.loads(collision_body)["error"],
        )

        status, _headers, replay_body = self.post(forecast(50.0, revision=1))
        self.assertEqual(200, status, replay_body)
        self.assertEqual("ignored_older", json.loads(replay_body)["status"])
        current = json.loads(self.get()[2])
        self.assertEqual(
            -1.0,
            current["forecast"]["points"][0]["layers"][0]["rows"][0]["value"],
        )

    def test_retention_is_bounded_per_stream(self):
        for index in range(weather.MAX_SNAPSHOTS_PER_STREAM + 4):
            self.assertEqual(200, self.post(forecast(float(index), revision=index))[0])
        conn = sqlite3.connect(server.DB_PATH)
        count = conn.execute(
            "SELECT COUNT(*) FROM predictive_weather_snapshots WHERE stream='forecast'"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(weather.MAX_SNAPSHOTS_PER_STREAM, count)


if __name__ == "__main__":
    unittest.main()
