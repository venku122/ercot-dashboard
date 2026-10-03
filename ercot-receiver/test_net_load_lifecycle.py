import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import net_load
import server


class NetLoadHandlerLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_key = server.API_KEY
        self.old_now = server.now_ts
        self.today = 1_800_057_600
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.API_KEY = "net-load-test-key"
        server.now_ts = lambda: self.today + 600
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "NetLoadTestServer",
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
        server.API_KEY = self.old_key
        server.now_ts = self.old_now
        self.tmp.cleanup()

    def invoke(self, method, path, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            "X-API-Key": "net-load-test-key",
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        thread_conn = getattr(server.DB_LOCAL, "conn", None)
        if thread_conn is not None:
            thread_conn.close()
            del server.DB_LOCAL.conn
        raw = handler.wfile.getvalue()
        return handler.response_status, None if not raw else json.loads(raw)

    def quartet(self, timestamp, demand=50_000.0):
        values = {
            "demand": demand,
            "wind": 10_000.0,
            "solar": 5_000.0,
            "published": demand - 15_050.0,
        }
        return [
            {
                "metric_name": name,
                "points": [
                    {
                        "timestamp": timestamp,
                        "value": values[key],
                        "dedupe_key": f"{key}:{timestamp}",
                    }
                ],
            }
            for key, name in net_load.REALTIME_METRICS.items()
        ]

    def test_current_day_replay_finalizes_previous_day_once_without_blob_growth(self):
        status, first = self.invoke("POST", "/api/ingest", self.quartet(self.today + 300))
        self.assertEqual(status, 200)
        self.assertEqual(first["net_load_materialization"], "updated")
        conn = sqlite3.connect(server.DB_PATH)
        first_counts = (
            conn.execute("SELECT COUNT(*) FROM net_load_resources").fetchone()[0],
            conn.execute("SELECT COUNT(*) FROM net_load_current").fetchone()[0],
        )
        conn.close()
        status, replay = self.invoke("POST", "/api/ingest", self.quartet(self.today + 300))
        self.assertEqual(status, 200)
        self.assertNotIn("net_load_materialization", replay)
        conn = sqlite3.connect(server.DB_PATH)
        self.assertEqual(
            first_counts,
            (
                conn.execute("SELECT COUNT(*) FROM net_load_resources").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM net_load_current").fetchone()[0],
            ),
        )
        conn.close()

    def test_cross_day_correction_recomputes_exact_ramp_dependencies(self):
        target = self.today - 86_400 - 1_800
        self.invoke("POST", "/api/ingest", self.quartet(target))
        _status, corrected = self.invoke("POST", "/api/ingest", self.quartet(target, 51_000.0))
        self.assertEqual(corrected["net_load_materialization"], "updated")
        conn = sqlite3.connect(server.DB_PATH)
        days = {
            row[0]
            for row in conn.execute(
                "SELECT day_start FROM net_load_current WHERE series_key='net-load.actual'"
            )
        }
        conn.close()
        self.assertEqual(days, {self.today - 172_800, self.today - 86_400})

    def test_materialization_failure_is_persistent_and_recovers(self):
        with patch.object(server, "recompute_bounded_actual_net_load", side_effect=RuntimeError("boom")):
            _status, failed = self.invoke("POST", "/api/ingest", self.quartet(self.today + 300))
        self.assertEqual(failed["net_load_materialization"], "failed")
        conn = sqlite3.connect(server.DB_PATH)
        self.assertEqual(
            conn.execute(
                "SELECT state,last_error_code FROM net_load_materialization_health WHERE pipeline='actual'"
            ).fetchone(),
            ("failed", "actual_materialization_failed"),
        )
        conn.close()

    def test_forecast_trio_converges_and_unchanged_replay_does_not_recompute(self):
        day = self.today + 86_400
        bounded_results = [[], [], [{"day_start": day}]]
        calls = []

        def bounded(_conn, days, _current):
            calls.append(tuple(days))
            return bounded_results[len(calls) - 1]

        load_results = [
            {"status": "inserted", "vintage_key": "load-v1"},
            {"status": "unchanged", "vintage_key": "load-v1"},
        ]
        renewable_results = [
            {"status": "inserted", "vintage_key": "wind-v1"},
            {"status": "inserted", "vintage_key": "solar-v1"},
        ]
        with (
            patch.object(server, "ingest_forecast_publication", side_effect=load_results),
            patch.object(server, "ingest_renewable_publication", side_effect=renewable_results),
            patch.object(server, "renewable_series_for_vintage", return_value="wind.stwpf"),
            patch.object(server, "affected_utc_days_for_forecast_vintage", return_value=[day]),
            patch.object(server, "affected_utc_days_for_renewable_vintage", return_value=[day]),
            patch.object(server, "recompute_forecast_quality", return_value=[]),
            patch.object(server, "recompute_bounded_forecast_net_load", side_effect=bounded),
        ):
            self.assertEqual(
                self.invoke("POST", "/api/forecast-publications/ingest", {})[1][
                    "net_load_materialization"
                ],
                "updated",
            )
            self.assertEqual(
                self.invoke("POST", "/api/renewable-publications/ingest", {})[1][
                    "net_load_materialization"
                ],
                "updated",
            )
            self.assertEqual(
                self.invoke("POST", "/api/renewable-publications/ingest", {})[1][
                    "net_load_materialization"
                ],
                "updated",
            )
            replay = self.invoke("POST", "/api/forecast-publications/ingest", {})[1]
        self.assertNotIn("net_load_materialization", replay)
        self.assertEqual(calls, [(day,), (day,), (day,)])
        self.assertEqual(bounded_results[-1], [{"day_start": day}])

    def test_manifest_inflight_invalidation_cannot_store_stale_pointer(self):
        started = threading.Event()
        release = threading.Event()
        result = []

        def blocked_manifest(_conn, now=None):
            started.set()
            self.assertTrue(release.wait(2))
            return {
                "kind": "net_load_manifest",
                "schema_version": 1,
                "methodology_version": "v1",
                "resources": [],
                "daily_resources": [],
            }

        with patch.object(server, "net_load_manifest", side_effect=blocked_manifest):
            thread = threading.Thread(
                target=lambda: result.append(self.invoke("GET", "/api/v1/net-load"))
            )
            thread.start()
            self.assertTrue(started.wait(2))
            self.app.cache.invalidate({"net-load-manifest"})
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result[0][0], 200)
        self.assertIsNone(self.app.cache.get("net-load-manifest:v1"))
        _status, recovered = self.invoke("POST", "/api/ingest", self.quartet(self.today + 600))
        self.assertEqual(recovered["net_load_materialization"], "updated")
        conn = sqlite3.connect(server.DB_PATH)
        self.assertEqual(
            conn.execute(
                "SELECT state,last_error_code FROM net_load_materialization_health WHERE pipeline='actual'"
            ).fetchone(),
            ("healthy", None),
        )
        conn.close()


if __name__ == "__main__":
    unittest.main()
