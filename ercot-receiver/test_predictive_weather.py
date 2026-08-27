"""Focused domain and HTTP acceptance for predictive weather current snapshots."""

from concurrent.futures import ThreadPoolExecutor
import copy
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


NOW = 1_787_232_000


def forecast_payload(offset=0):
    points = []
    mappings = {
        "KDFW": ("FWD", 81, 109),
        "KAUS": ("EWX", 158, 87),
        "KHOU": ("HGX", 66, 90),
        "KSAT": ("EWX", 127, 60),
    }
    for point_id, label, latitude, longitude in weather.POINTS:
        grid_id, grid_x, grid_y = mappings[point_id]
        layers = []
        for index, (key, unit) in enumerate(weather.LAYERS):
            layers.append(
                {
                    "key": key,
                    "unit": unit,
                    "rows": [
                        {
                            "valid_start": NOW + 3_600,
                            "valid_end": NOW + 7_200,
                            "value": float(index + offset),
                        }
                    ],
                }
            )
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
                "update_time": NOW - 600 + offset,
                "retrieved_at": NOW - 300 + offset,
                "cache_fresh_until": NOW + 3_600 + offset,
                "layers": layers,
            }
        )
    return {"schema": 1, "stream": "forecast", "points": points}


def alert_item(identifier="alert-1"):
    return {
        "id": identifier,
        "event": "Heat Advisory",
        "headline": "Fixture headline",
        "area_desc": "Fixture counties",
        "severity": "Moderate",
        "urgency": "Expected",
        "certainty": "Likely",
        "message_type": "Alert",
        "sent": NOW - 900,
        "effective": NOW - 600,
        "onset": NOW,
        "expires": NOW + 3_600,
        "ends": NOW + 3_600,
        "description": "Fixture description",
        "instruction": None,
        "response": "Prepare",
        "affected_zones": ["https://api.weather.gov/zones/forecast/TXZ119"],
        "references": [],
        "source_url": "https://api.weather.gov/alerts/urn:fixture:alert-1",
    }


def alerts_payload(items=None, *, truncated=False, offset=0):
    return {
        "schema": 1,
        "stream": "alerts",
        "collection_updated_at": NOW - 60 + offset,
        "retrieved_at": NOW + offset,
        "cache_fresh_until": NOW + 60 + offset,
        "truncated": truncated,
        "items": [] if items is None else items,
    }


class PredictiveWeatherDomainTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        weather.init_predictive_weather_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_unavailable_manifest_has_exact_bounded_registry(self):
        manifest = weather.predictive_weather_manifest(self.conn, NOW)
        self.assertEqual(
            {
                "schema",
                "kind",
                "registry_version",
                "policy",
                "generated_at",
                "forecast",
                "alerts",
                "source_health",
            },
            set(manifest),
        )
        self.assertEqual("unavailable", manifest["forecast"]["state"])
        self.assertEqual([point[0] for point in weather.POINTS], [p["point_id"] for p in manifest["forecast"]["points"]])
        self.assertTrue(all(len(point["layers"]) == 6 for point in manifest["forecast"]["points"]))
        self.assertEqual("texas_statewide_not_ercot_footprint", manifest["alerts"]["coverage"])

    def test_independent_stream_updates_and_stale_empty_states(self):
        forecast = weather.ingest_predictive_weather(self.conn, forecast_payload(), NOW)
        repeated = weather.ingest_predictive_weather(self.conn, forecast_payload(), NOW + 1)
        self.assertEqual("inserted", forecast["status"])
        self.assertEqual("unchanged", repeated["status"])
        before_alerts = weather.predictive_weather_manifest(self.conn, NOW)
        self.assertEqual("available", before_alerts["forecast"]["state"])
        self.assertEqual("unavailable", before_alerts["alerts"]["state"])

        alerts = weather.ingest_predictive_weather(self.conn, alerts_payload(), NOW + 1)
        manifest = weather.predictive_weather_manifest(self.conn, NOW + 2)
        self.assertEqual(forecast["content_version"], manifest["forecast"]["content_version"])
        self.assertEqual(alerts["content_version"], manifest["alerts"]["content_version"])
        self.assertEqual("valid_empty", manifest["alerts"]["state"])
        stale = weather.predictive_weather_manifest(self.conn, NOW + 4_000)
        self.assertEqual("stale", stale["forecast"]["state"])
        self.assertEqual("stale", stale["alerts"]["state"])

    def test_exact_registry_units_intervals_and_alert_identity_fail_closed(self):
        wrong = forecast_payload()
        wrong["points"][2]["label"] = "Houston"
        with self.assertRaisesRegex(ValueError, "invalid_predictive_weather_point"):
            weather.ingest_predictive_weather(self.conn, wrong, NOW)
        wrong = forecast_payload()
        wrong["points"][0]["layers"][0]["unit"] = "degF"
        with self.assertRaisesRegex(ValueError, "invalid_predictive_weather_layer"):
            weather.ingest_predictive_weather(self.conn, wrong, NOW)
        duplicate = alerts_payload([alert_item(), alert_item()])
        with self.assertRaisesRegex(ValueError, "duplicate_predictive_weather_alert"):
            weather.ingest_predictive_weather(self.conn, duplicate, NOW)

    def test_forecast_interval_application_safety_bound_preserves_over_eight_days(self):
        accepted = forecast_payload()
        row = accepted["points"][0]["layers"][3]["rows"][0]
        row["valid_end"] = row["valid_start"] + 9 * 86_400
        weather.ingest_predictive_weather(self.conn, accepted, NOW)
        current = weather.predictive_weather_manifest(self.conn, NOW)
        preserved = current["forecast"]["points"][0]["layers"][3]["rows"][0]
        self.assertEqual(row, preserved)

        rejected = forecast_payload(offset=1)
        row = rejected["points"][0]["layers"][3]["rows"][0]
        row["valid_end"] = row["valid_start"] + 10 * 86_400 + 1
        with self.assertRaisesRegex(ValueError, "invalid_predictive_weather_layer_row"):
            weather.ingest_predictive_weather(self.conn, rejected, NOW + 1)

    def test_retention_is_bounded_per_stream_and_failure_health_recovers(self):
        for offset in range(10):
            weather.ingest_predictive_weather(self.conn, forecast_payload(offset), NOW + offset)
        count = self.conn.execute(
            "SELECT COUNT(*) FROM predictive_weather_snapshots WHERE stream='forecast'"
        ).fetchone()[0]
        self.assertEqual(weather.MAX_SNAPSHOTS_PER_STREAM, count)
        weather.record_predictive_weather_failure(
            self.conn, "alerts", "invalid_predictive_weather_alert", NOW + 20
        )
        failed = weather.predictive_weather_manifest(self.conn, NOW + 20)
        alert_health = next(item for item in failed["source_health"] if item["source_id"] == "nws_alerts_tx")
        self.assertEqual("failed", alert_health["state"])
        weather.ingest_predictive_weather(self.conn, alerts_payload([alert_item()]), NOW + 21)
        recovered = weather.predictive_weather_manifest(self.conn, NOW + 21)
        alert_health = next(item for item in recovered["source_health"] if item["source_id"] == "nws_alerts_tx")
        self.assertEqual("healthy", alert_health["state"])
        self.assertEqual(0, alert_health["consecutive_failures"])

    def test_reverse_replay_cannot_regress_and_same_clock_collision_requires_correction(self):
        newer_payload = alerts_payload([alert_item()], offset=100)
        newer = weather.ingest_predictive_weather(self.conn, newer_payload, NOW + 100)
        older = weather.ingest_predictive_weather(
            self.conn, alerts_payload([alert_item("older")]), NOW + 101
        )
        self.assertEqual("ignored_older", older["status"])
        self.assertEqual(newer["content_version"], older["content_version"])
        current = weather.predictive_weather_manifest(self.conn, NOW + 101)
        self.assertEqual(newer["content_version"], current["alerts"]["content_version"])

        collision = copy.deepcopy(newer_payload)
        collision["items"][0]["headline"] = "Different bytes at the same source clock"
        with self.assertRaisesRegex(ValueError, "predictive_weather_publication_collision"):
            weather.ingest_predictive_weather(self.conn, collision, NOW + 102)

        correction = copy.deepcopy(collision)
        correction["retrieved_at"] += 1
        correction["cache_fresh_until"] += 1
        corrected = weather.ingest_predictive_weather(self.conn, correction, NOW + 103)
        self.assertEqual("corrected", corrected["status"])
        self.assertNotEqual(newer["content_version"], corrected["content_version"])


class PredictiveWeatherHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_api_key = server.API_KEY
        self.old_now = server.now_ts
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.API_KEY = "fixture-key"
        server.now_ts = lambda: NOW
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "WeatherServer",
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
        server.API_KEY = self.old_api_key
        server.now_ts = self.old_now
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        encoded = b"" if payload is None else json.dumps(payload).encode()
        handler.headers = {"Content-Length": str(len(encoded)), **(headers or {})}
        handler.rfile = io.BytesIO(encoded)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        try:
            getattr(handler, f"do_{method}")()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        body = handler.wfile.getvalue()
        return handler.response_status, handler.response_headers, body

    def test_authenticated_canonical_ingest_and_queryless_etag(self):
        unauthorized = self.request("POST", "/api/predictive-weather/ingest", forecast_payload())
        self.assertEqual(401, unauthorized[0])
        posted = self.request(
            "POST",
            "/api/predictive-weather/ingest",
            forecast_payload(),
            {"X-API-Key": "fixture-key"},
        )
        self.assertEqual(200, posted[0])
        cold = self.request("GET", "/api/v1/predictive-weather")
        hit = self.request("GET", "/api/v1/predictive-weather")
        conditional = self.request(
            "GET", "/api/v1/predictive-weather", headers={"If-None-Match": cold[1]["ETag"]}
        )
        self.assertEqual((200, 200, 304), (cold[0], hit[0], conditional[0]))
        self.assertEqual(cold[2], hit[2])
        self.assertEqual("MISS", cold[1]["X-ERCOT-Cache"])
        self.assertEqual("HIT", hit[1]["X-ERCOT-Cache"])
        self.assertEqual(b"", conditional[2])
        rejected = self.request("GET", "/api/v1/predictive-weather?point=KDFW")
        self.assertEqual(400, rejected[0])
        self.assertEqual("no-store", rejected[1]["Cache-Control"])

    def test_parallel_cold_get_singleflight_and_ingest_generation_guard(self):
        self.request(
            "POST",
            "/api/predictive-weather/ingest",
            forecast_payload(),
            {"X-API-Key": "fixture-key"},
        )
        calls = 0
        lock = threading.Lock()
        original = server.predictive_weather_manifest

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.predictive_weather_manifest = counted
        try:
            with ThreadPoolExecutor(max_workers=8) as executor:
                responses = list(executor.map(lambda _index: self.request("GET", "/api/v1/predictive-weather"), range(8)))
        finally:
            server.predictive_weather_manifest = original
        self.assertEqual(1, calls)
        self.assertEqual({response[0] for response in responses}, {200})
        self.assertEqual(1, len({response[2] for response in responses}))

        generation = self.app.cache.snapshot_generation()
        self.app.cache.invalidate({"predictive-weather-manifest"})
        stored = self.app.cache.set_if_generation(
            "predictive-weather-manifest:v1",
            {"stale": True},
            generation,
            {"predictive-weather-manifest"},
        )
        self.assertFalse(stored)
        self.assertIsNone(self.app.cache.get("predictive-weather-manifest:v1"))

    def test_nws_source_health_attempt_invalidates_predictive_weather_manifest(self):
        self.app.cache.set(
            "predictive-weather-manifest:v1",
            {"sentinel": True},
            {"predictive-weather-manifest"},
        )
        attempt = {
            "source_id": "nws_grid_forecast",
            "display_name": "NWS representative airport point forecasts",
            "expected_interval_seconds": 3_600,
            "attempted_at": NOW,
            "success": False,
            "error": "fixture_failure",
        }
        response = self.request(
            "POST",
            "/api/source-health",
            attempt,
            {"X-API-Key": "fixture-key"},
        )
        self.assertEqual(200, response[0])
        self.assertIsNone(self.app.cache.get("predictive-weather-manifest:v1"))


if __name__ == "__main__":
    unittest.main()
