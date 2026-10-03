"""Independent acceptance for atomic source-health batch updates."""

from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("source_health_atomic_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SERVER_PATH}")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class SourceHealthAtomicAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_api_key = server.API_KEY
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.API_KEY = "fixture-api-key"
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        for source_id, document_id in (
            ("ercot_mis_np4_732", "100"),
            ("ercot_mis_np4_737", "200"),
        ):
            server.update_source_health(
                conn,
                self.attempt(source_id, document_id, attempted_at=1_787_000_000),
                current_ts=1_787_000_000,
            )
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
        self.app.cache.set("source-health", {"sentinel": True}, {"source-health"})

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        server.DB_PATH = self.old_db_path
        server.DB_LOCAL = self.old_db_local
        server.API_KEY = self.old_api_key
        self.tmp.cleanup()

    @staticmethod
    def attempt(source_id, document_id, attempted_at):
        return {
            "source_id": source_id,
            "display_name": f"Synthetic {source_id}",
            "expected_interval_seconds": 3_600,
            "publication_mode": "event",
            "publication_interval_seconds": 3_600,
            "attempted_at": attempted_at,
            "success": True,
            "row_count": 216,
            "availability_status": "available",
            "source_timestamp_ts": attempted_at - 60,
            "data_timestamp_ts": attempted_at - 60,
            "checkpoint": {
                "version": 1,
                "highWater": {
                    "NP4-732-CD": {"issuedAt": attempted_at - 60, "docId": document_id}
                },
                "overlapDocIds": [document_id],
            },
        }

    def invoke(self, payload):
        body = json.dumps(payload).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = "/api/source-health"
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            "X-API-Key": "fixture-api-key",
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        try:
            handler.do_POST()
        finally:
            connection = getattr(server.DB_LOCAL, "conn", None)
            if connection is not None:
                connection.close()
                del server.DB_LOCAL.conn
        return handler.response_status, json.loads(handler.wfile.getvalue())

    def snapshot(self):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            return conn.execute(
                """
                SELECT source_id, last_attempt_ts, last_success_ts, checkpoint_json
                FROM collector_sources
                WHERE source_id IN ('ercot_mis_np4_732', 'ercot_mis_np4_737')
                ORDER BY source_id
                """
            ).fetchall()
        finally:
            conn.close()

    def test_invalid_second_attempt_rolls_back_first(self):
        before = self.snapshot()
        first = self.attempt("ercot_mis_np4_732", "101", 1_787_003_600)
        invalid_second = self.attempt("ercot_mis_np4_737", "201", 1_787_003_600)
        del invalid_second["display_name"]

        status, response = self.invoke([first, invalid_second])

        self.assertEqual(status, 400)
        self.assertEqual(response, {"error": "invalid_source_attempt"})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.app.cache.get("source-health"), {"sentinel": True})

    def test_second_write_failure_rolls_back_both(self):
        before = self.snapshot()
        attempts = [
            self.attempt("ercot_mis_np4_732", "101", 1_787_003_600),
            self.attempt("ercot_mis_np4_737", "201", 1_787_003_600),
        ]
        original = server.update_source_health
        calls = 0

        def fail_after_second_write(conn, attempt, current_ts=None, commit=True):
            nonlocal calls
            calls += 1
            original(conn, attempt, current_ts=current_ts, commit=commit)
            if calls == 2:
                raise sqlite3.OperationalError("synthetic second write failure")

        server.update_source_health = fail_after_second_write
        try:
            status, response = self.invoke(attempts)
        finally:
            server.update_source_health = original

        self.assertEqual(calls, 2)
        self.assertEqual(status, 500)
        self.assertEqual(response, {"error": "source_health_update_failed"})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.app.cache.get("source-health"), {"sentinel": True})


if __name__ == "__main__":
    unittest.main()
