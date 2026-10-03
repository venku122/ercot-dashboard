"""Independent HTTP/cache acceptance for PR12 net-load resources."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("net_load_api_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SERVER_PATH}")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)
import net_load as net_load_module


DAY_START = 1_800_057_600
CONTENT_VERSION = "v1-" + "a" * 64
RESOURCE_PATH = (
    "/api/v2/net-load/net-load.actual/v1/"
    f"{CONTENT_VERSION}/1d/{DAY_START}/native"
)


class NetLoadApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: DAY_START + 172_800

        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        self.payload = {
            "complete": True,
            "content_version": CONTENT_VERSION,
            "contributors": {
                "same_timestamp_required": True,
                "source_id": "ercot_realtime",
            },
            "day_end": DAY_START + 86_400,
            "day_start": DAY_START,
            "description": "acceptance fixture",
            "evening_policy": {
                "dashboard_defined": True,
                "key": "dashboard_evening_v1",
                "tie_policy": "earliest",
                "timezone": "America/Chicago",
                "window": "[16:00,22:00)",
            },
            "exclusions": {},
            "expected_point_count": 1,
            "finalized": True,
            "horizon": "actual",
            "kind": "net_load_tile",
            "lod": "native",
            "methodology_version": "v1",
            "observed_point_count": 1,
            "official_ercot_net_load": False,
            "ramp_policy": "exact_elapsed_no_interpolation_or_bridging",
            "rows": [
                {
                    "demand_mw": 50_000.0,
                    "missing_reason": None,
                    "net_load_mw": 35_000.0,
                    "published_average_net_load_mw": 34_950.0,
                    "published_residual_mw": 50.0,
                    "ramp_1h_mw": 1_000.0,
                    "ramp_3h_mw": 2_500.0,
                    "sample_count": 5,
                    "solar_mw": 5_000.0,
                    "storage_net_output_mw": -700.0,
                    "target_ts": DAY_START,
                    "wind_mw": 10_000.0,
                }
            ],
            "schema_version": 1,
            "policy_cutoff": None,
            "series_key": "net-load.actual",
            "storage_policy": "context_only_not_in_formula",
            "tile_span": "1d",
            "timezone": "UTC",
            "unit": "MW",
        }
        encoded = json.dumps(self.payload, sort_keys=True, separators=(",", ":"))
        conn.execute(
            """
            INSERT INTO net_load_resources(
              series_key,methodology_version,content_version,horizon,
              day_start,lod,payload_json,created_at
            ) VALUES('net-load.actual','v1',?,'actual',?,'native',?,?)
            """,
            (CONTENT_VERSION, DAY_START, encoded, DAY_START + 1),
        )
        conn.execute(
            """
            INSERT INTO net_load_current(
              series_key,methodology_version,horizon,day_start,
              content_version,dataset_cutoff,updated_at
            ) VALUES('net-load.actual','v1','actual',?,?,?,?)
            """,
            (DAY_START, CONTENT_VERSION, DAY_START + 1, DAY_START + 1),
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

    def test_immutable_bytes_etag_hit_and_304_are_identical(self):
        cold_status, cold_headers, cold_body = self.get(RESOURCE_PATH)
        hit_status, hit_headers, hit_body = self.get(RESOURCE_PATH)
        not_modified_status, not_modified_headers, not_modified_body = self.get(
            RESOURCE_PATH, {"If-None-Match": cold_headers["ETag"]}
        )

        self.assertEqual((cold_status, hit_status, not_modified_status), (200, 200, 304))
        self.assertEqual(cold_body, hit_body)
        self.assertEqual(cold_headers["ETag"], hit_headers["ETag"])
        self.assertEqual(cold_headers["ETag"], not_modified_headers["ETag"])
        self.assertEqual(not_modified_body, b"")
        self.assertEqual(cold_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(hit_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(json.loads(cold_body), self.payload)

    def test_ten_simultaneous_cold_requests_share_one_loader(self):
        original = server.net_load_resource
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.net_load_resource = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as executor:
                responses = list(executor.map(lambda _index: self.get(RESOURCE_PATH), range(10)))
        finally:
            server.net_load_resource = original

        self.assertEqual(calls, 1)
        self.assertEqual({status for status, _headers, _body in responses}, {200})
        self.assertEqual(len({body for _status, _headers, body in responses}), 1)
        self.assertEqual(len({headers["ETag"] for _status, headers, _body in responses}), 1)
        self.assertEqual(self.app.singleflight.pending(), 0)

    def test_canonical_context_and_query_are_rejected(self):
        cases = (
            RESOURCE_PATH + "?until=1",
            RESOURCE_PATH.replace(f"/{DAY_START}/", f"/{DAY_START + 1}/"),
            RESOURCE_PATH.replace("/native", "/1h"),
            RESOURCE_PATH.replace("net-load.actual", "net-load.forecast-1h"),
        )
        for path in cases:
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertIn(status, (400, 404))
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn(b"series_id", body)

    def test_unchanged_newer_cutoff_still_blocks_older_pointer_replacement(self):
        conn = sqlite3.connect(server.DB_PATH)
        conn.execute("DELETE FROM net_load_current")
        conn.execute("DELETE FROM net_load_resources")
        observed_at = DAY_START
        for name, value in (
            (server.NET_LOAD_REALTIME_METRICS["demand"], 50_000),
            (server.NET_LOAD_REALTIME_METRICS["wind"], 10_000),
            (server.NET_LOAD_REALTIME_METRICS["solar"], 5_000),
            (server.NET_LOAD_REALTIME_METRICS["published"], 34_950),
        ):
            conn.execute(
                """
                INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags)
                VALUES(?,?,?,60,'gauge','[]')
                """,
                (name, observed_at, value),
            )
        conn.commit()

        end = DAY_START + 86_400
        first = server.recompute_net_load(
            conn, "net-load.actual", DAY_START,
            current_ts=end + 500, dataset_cutoff=end + 100,
            horizons=["actual"],
        )[0]
        repeated = server.recompute_net_load(
            conn, "net-load.actual", DAY_START,
            current_ts=end + 500, dataset_cutoff=end + 300,
            horizons=["actual"],
        )[0]
        self.assertEqual(first["content_version"], repeated["content_version"])

        # A correction visible under an older dataset boundary may create an
        # immutable blob, but must not replace the pointer whose cutoff is newer.
        for name, value in (
            (server.NET_LOAD_REALTIME_METRICS["demand"], 51_000),
            (server.NET_LOAD_REALTIME_METRICS["wind"], 10_000),
            (server.NET_LOAD_REALTIME_METRICS["solar"], 5_000),
            (server.NET_LOAD_REALTIME_METRICS["published"], 35_950),
        ):
            conn.execute(
                """
                INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags)
                VALUES(?,?,?,60,'gauge','[]')
                """,
                (name, DAY_START + 300, value),
            )
        conn.commit()
        older = server.recompute_net_load(
            conn, "net-load.actual", DAY_START,
            current_ts=end + 500, dataset_cutoff=end + 200,
            horizons=["actual"],
        )[0]
        self.assertNotEqual(older["content_version"], first["content_version"])
        pointer = conn.execute(
            """
            SELECT content_version,dataset_cutoff FROM net_load_current
            WHERE series_key='net-load.actual' AND horizon='actual' AND day_start=?
            """,
            (DAY_START,),
        ).fetchone()
        conn.close()
        self.assertEqual(pointer, (first["content_version"], end + 300))

    def test_future_forecast_never_claims_a_future_cutoff_or_publishes_incomplete(self):
        conn = sqlite3.connect(server.DB_PATH)
        future_day = DAY_START + 5 * 86_400
        dataset_cutoff = DAY_START + 2 * 86_400
        resource = net_load_module._resource_payload(
            conn, "net-load.forecast", "1h", future_day, dataset_cutoff
        )
        results = server.recompute_net_load(
            conn, "net-load.forecast", future_day,
            current_ts=dataset_cutoff, dataset_cutoff=dataset_cutoff,
            horizons=["1h"],
        )
        self.assertGreater(resource["policy_cutoff"], dataset_cutoff)
        self.assertFalse(resource["finalized"])
        self.assertNotIn("selection_cutoff", resource)
        self.assertNotIn("effective_as_of", resource)
        self.assertFalse(resource["complete"])
        self.assertEqual(results, [])
        current_pointer = conn.execute(
            """
            SELECT content_version FROM net_load_current
            WHERE series_key='net-load.forecast' AND horizon='1h' AND day_start=?
            """,
            (future_day,),
        ).fetchone()
        conn.close()
        self.assertIsNone(current_pointer)


if __name__ == "__main__":
    unittest.main()
