import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("ercot_receiver_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SERVER_PATH}")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)

bucket_average = server.bucket_average
seasonal_average = server.seasonal_average
transform_series = server.transform_series


class SeriesTransformTests(unittest.TestCase):
    def test_bucket_average_groups_points_by_bucket(self):
        points = [[0, 10.0], [59, 14.0], [60, 20.0], [119, 28.0]]

        self.assertEqual(bucket_average(points, 60), [[0, 12.0], [60, 24.0]])

    def test_seasonal_average_repeats_average_profile(self):
        points = [
            [0, 10.0],
            [60, 20.0],
            [120, 30.0],
            [180, 40.0],
        ]

        self.assertEqual(
            seasonal_average(points, 120, 60),
            [[0, 20.0], [60, 30.0], [120, 20.0], [180, 30.0]],
        )

    def test_transform_series_prefers_seasonal_bucketing_when_requested(self):
        points = [
            [0, 10.0],
            [60, 20.0],
            [120, 30.0],
            [180, 40.0],
        ]

        self.assertEqual(
            transform_series(points, seasonal_period=120),
            [[0, 20.0], [60, 30.0], [120, 20.0], [180, 30.0]],
        )

    def test_seasonal_average_rejects_invalid_bucket_size(self):
        with self.assertRaises(ValueError):
            seasonal_average([[0, 1.0]], 60, 120)


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "metrics.db"
        self.conn = sqlite3.connect(self.db_path)
        server.init_db(self.conn)
        self.handler = server.Handler.__new__(server.Handler)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def insert_metric(self, metric_name, ts, value, tags=None):
        tags = tags or []
        cur = self.conn.execute(
            """
            INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (metric_name, ts, value, 60, "gauge", server.json.dumps(tags)),
        )
        if tags:
            self.conn.executemany(
                "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
                [(cur.lastrowid, tag) for tag in tags],
            )
        self.conn.commit()

    def test_init_db_creates_covering_indexes(self):
        rows = self.conn.execute(
            """
            SELECT name FROM sqlite_master
            WHERE type = 'index'
            ORDER BY name
            """
        ).fetchall()

        self.assertIn(("idx_metric_tags_tag_metric",), rows)
        self.assertIn(("idx_metrics_name_ts_value_id",), rows)

    def test_series_query_filters_single_tag(self):
        self.insert_metric("ercot.DC_Tie_Flows", 100, 1.0, ["ercot_dc_tie:DC_E"])
        self.insert_metric("ercot.DC_Tie_Flows", 100, 2.0, ["ercot_dc_tie:DC_N"])
        self.insert_metric("ercot.DC_Tie_Flows", 160, 3.0, ["ercot_dc_tie:DC_E"])

        points = self.handler._series_query(
            self.conn,
            "ercot.DC_Tie_Flows",
            90,
            170,
            ["ercot_dc_tie:DC_E"],
        )

        self.assertEqual(points, [[100, 1.0], [160, 3.0]])

    def test_series_query_buckets_in_sql(self):
        self.insert_metric("ercot.load", 0, 10.0)
        self.insert_metric("ercot.load", 30, 20.0)
        self.insert_metric("ercot.load", 60, 40.0)

        points = self.handler._series_query(
            self.conn, "ercot.load", 0, 120, [], bucket_seconds=60
        )

        self.assertEqual(points, [[0, 15.0], [60, 40.0]])

    def test_series_query_minmax_preserves_bucket_extrema(self):
        self.insert_metric("ercot.pricing", 0, 10.0)
        self.insert_metric("ercot.pricing", 20, -500.0)
        self.insert_metric("ercot.pricing", 40, 5000.0)
        self.insert_metric("ercot.pricing", 60, 20.0)

        points = self.handler._series_query(
            self.conn,
            "ercot.pricing",
            0,
            120,
            [],
            bucket_seconds=60,
            aggregation="minmax",
        )

        self.assertEqual(points, [[20, -500.0], [40, 5000.0], [60, 20.0]])

    def test_query_bucket_seconds_uses_max_points_window(self):
        self.assertEqual(self.handler._query_bucket_seconds(0, 100, 10, None), 11)
        self.assertEqual(self.handler._query_bucket_seconds(0, 100, 10, 60), 60)
        self.assertIsNone(self.handler._query_bucket_seconds(None, 100, 10, None))

    def test_minmax_fallback_never_exceeds_requested_point_bound(self):
        points = [[index, -index if index % 2 else index] for index in range(100)]

        self.assertLessEqual(len(server.downsample_minmax(points, 9)), 9)
        self.assertEqual(server.downsample_minmax(points, 1), [points[-1]])


class MigrationAndIngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "metrics.db"
        self.conn = sqlite3.connect(self.db_path)
        server.init_db(self.conn)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_fresh_schema_has_sources_events_and_partial_dedupe_index(self):
        tables = {
            row[0]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        columns = {
            row[1] for row in self.conn.execute("PRAGMA table_info(metrics)")
        }
        indexes = {
            row[1] for row in self.conn.execute("PRAGMA index_list(metrics)")
        }

        self.assertIn("collector_sources", tables)
        self.assertIn("events", tables)
        self.assertIn("dedupe_key", columns)
        self.assertIn("idx_metrics_dedupe_key", indexes)

    def test_existing_database_migrates_without_rewriting_rows(self):
        legacy_path = Path(self.tmp.name) / "legacy.db"
        legacy = sqlite3.connect(legacy_path)
        legacy.execute(
            """
            CREATE TABLE metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                metric_name TEXT NOT NULL,
                ts INTEGER NOT NULL,
                value REAL NOT NULL,
                interval INTEGER,
                metric_type TEXT,
                tags TEXT
            )
            """
        )
        legacy.execute(
            "INSERT INTO metrics (metric_name, ts, value) VALUES ('legacy.metric', 1, 2)"
        )
        legacy.commit()

        server.init_db(legacy)

        self.assertEqual(legacy.execute("SELECT COUNT(*) FROM metrics").fetchone()[0], 1)
        self.assertIn(
            "dedupe_key", {row[1] for row in legacy.execute("PRAGMA table_info(metrics)")}
        )
        legacy.close()

    def test_metric_dedupe_upserts_revisions_and_identical_replay_is_unchanged(self):
        payload = [
            {
                "metric_name": "ercot.supply_demand.demand_mw",
                "tags": ["source:supply_demand"],
                "points": [
                    {
                        "timestamp": 100,
                        "value": 50_000,
                        "dedupe_key": "supply:actual:100",
                    }
                ],
            },
            {
                "metric_name": "ercot.supply_demand.forecast_demand_mw",
                "tags": ["source:supply_demand"],
                "points": [
                    {
                        "timestamp": 200,
                        "value": 55_000,
                        "dedupe_key": "supply:forecast:200",
                    }
                ],
            },
            {"metric_name": "bad", "points": [{"value": "not-a-number"}]},
        ]

        first = server.ingest_metrics(self.conn, payload, current_ts=100)
        unchanged = server.ingest_metrics(self.conn, payload[:2], current_ts=100)
        payload[0]["points"][0]["value"] = 50_250
        payload[1]["points"][0]["value"] = 54_750
        revised = server.ingest_metrics(self.conn, payload[:2], current_ts=101)

        self.assertEqual((first["inserted"], first["invalid"]), (2, 1))
        self.assertEqual(
            {key: unchanged[key] for key in ("inserted", "updated", "unchanged", "invalid")},
            {"inserted": 0, "updated": 0, "unchanged": 2, "invalid": 0},
        )
        self.assertEqual(
            {key: revised[key] for key in ("inserted", "updated", "unchanged", "invalid")},
            {"inserted": 0, "updated": 2, "unchanged": 0, "invalid": 0},
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0], 2)
        self.assertEqual(
            self.conn.execute(
                "SELECT value FROM metrics WHERE dedupe_key = 'supply:actual:100'"
            ).fetchone()[0],
            50_250,
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT value FROM metrics WHERE dedupe_key = 'supply:forecast:200'"
            ).fetchone()[0],
            54_750,
        )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM metric_tags").fetchone()[0], 2
        )

    def test_event_retry_upserts_without_duplicate(self):
        event = {
            "dedupe_key": "operations:2026-07-21:notice",
            "source_id": "operations_messages",
            "starts_at": 100,
            "observed_at": 101,
            "event_type": "Operational Information",
            "status": "Active",
            "title": "Initial title",
            "metadata": {"fixture": True},
        }

        first = server.ingest_events(self.conn, [event], current_ts=102)
        event["title"] = "Updated title"
        second = server.ingest_events(self.conn, [event], current_ts=103)

        self.assertEqual(first, {"inserted": 1, "updated": 0, "invalid": 0})
        self.assertEqual(second, {"inserted": 0, "updated": 1, "invalid": 0})
        self.assertEqual(
            self.conn.execute("SELECT title FROM events").fetchone()[0], "Updated title"
        )

    def test_database_backup_restores_migrated_data(self):
        server.ingest_metrics(
            self.conn,
            [
                {
                    "metric_name": "ercot.test",
                    "points": [
                        {"timestamp": 100, "value": 1, "dedupe_key": "test:100"}
                    ],
                }
            ],
        )
        backup_path = Path(self.tmp.name) / "backup.db"
        backup = sqlite3.connect(backup_path)
        self.conn.backup(backup)
        backup.close()

        restored = sqlite3.connect(backup_path)
        server.init_db(restored)
        self.assertEqual(restored.execute("SELECT COUNT(*) FROM metrics").fetchone()[0], 1)
        restored.close()


class SourceHealthAndBoundsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(Path(self.tmp.name) / "metrics.db")
        server.init_db(self.conn)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def attempt(self, timestamp, success=True):
        server.update_source_health(
            self.conn,
            {
                "source_id": "fuel_mix",
                "display_name": "ERCOT Fuel Mix",
                "expected_interval_seconds": 300,
                "attempted_at": timestamp,
                "success": success,
                "source_timestamp_ts": timestamp if success else None,
                "payload_hash": "abc" if success else None,
                "row_count": 8 if success else 0,
                "error": None if success else "fixture_failure",
            },
            current_ts=timestamp,
        )

    def test_source_health_derives_healthy_delayed_stale_and_failed(self):
        self.attempt(1000)
        self.assertEqual(server.list_source_health(self.conn, 1100)[0]["state"], "healthy")
        self.assertEqual(server.list_source_health(self.conn, 1700)[0]["state"], "delayed")
        self.assertEqual(server.list_source_health(self.conn, 2300)[0]["state"], "stale")
        self.attempt(2400, success=False)
        self.attempt(2500, success=False)
        self.attempt(2600, success=False)
        health = server.list_source_health(self.conn, 2600)[0]
        self.assertEqual(health["state"], "failed")
        self.assertEqual(health["consecutive_failures"], 3)

    def test_event_driven_source_can_be_collection_healthy_with_old_observation(self):
        server.update_source_health(
            self.conn,
            {
                "source_id": "operations_messages",
                "display_name": "ERCOT Operations Messages",
                "expected_interval_seconds": 180,
                "publication_mode": "event",
                "attempted_at": 10_000,
                "success": True,
                "source_timestamp_ts": 1_000,
                "row_count": 0,
            },
            current_ts=10_000,
        )

        health = server.list_source_health(self.conn, 10_060)[0]

        self.assertEqual(health["collection_state"], "healthy")
        self.assertEqual(health["freshness_state"], "event_driven")
        self.assertEqual(health["collection_age_seconds"], 60)
        self.assertEqual(health["data_age_seconds"], 9_060)

    def test_query_limits_reject_unbounded_or_oversized_requests(self):
        with self.assertRaisesRegex(ValueError, "max_points_exceeds_limit"):
            server.validate_max_points(server.MAX_POINTS_HARD + 1)
        with self.assertRaisesRegex(ValueError, "raw_span_exceeds_limit"):
            server.validate_query_window(
                0, server.MAX_RAW_SPAN_SECONDS + 1, None, None
            )
        server.validate_query_window(
            0, server.MAX_RAW_SPAN_SECONDS + 1, server.MAX_POINTS_HARD, None
        )

    def test_raw_statistics_are_independent_of_plot_decimation(self):
        points = [[0, 10.0], [1800, 20.0], [3600, 30.0]]

        stats = server.series_statistics(points)

        self.assertEqual(stats["count"], 3)
        self.assertEqual(stats["latest"], 30.0)
        self.assertEqual(stats["minimum"], 10.0)
        self.assertEqual(stats["maximum"], 30.0)
        self.assertEqual(stats["average"], 20.0)
        self.assertEqual(stats["energy_mwh"], 20.0)

    def test_cache_is_bounded_and_invalidates_only_dependencies(self):
        cache = server.Cache(60, max_entries=2)
        cache.set("a", 1, {"metric.a"})
        cache.set("b", 2, {"metric.b"})
        cache.invalidate({"metric.a"})
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("b"), 2)
        self.assertEqual(cache.stats()["hit_ratio"], 0.5)
        cache.set("c", 3, {"metric.c"})
        cache.set("d", 4, {"metric.d"})
        self.assertLessEqual(cache.stats()["entries"], 2)


class HttpQueryBoundsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "TestServer",
            (),
            {"cache": server.Cache(60), "limiter": server.RateLimiter()},
        )()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        self.tmp.cleanup()

    def invoke(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.send_header = lambda _name, _value: None
        handler.end_headers = lambda: None
        if method == "GET":
            handler.do_GET()
        else:
            handler.do_POST()
        self.assertEqual(handler.response_status, 200)
        return json.loads(handler.wfile.getvalue())

    def test_get_without_since_defaults_to_bounded_window(self):
        payload = self.invoke("GET", "/api/series?metric=fixture.raw")

        self.assertIsNotNone(payload["meta"]["since"])
        self.assertLessEqual(
            payload["meta"]["until"] - payload["meta"]["since"],
            server.MAX_RAW_SPAN_SECONDS,
        )

    def test_batch_without_since_uses_the_same_bounded_window(self):
        payload = self.invoke(
            "POST",
            "/api/series/batch",
            {"queries": [{"id": "raw", "metric": "fixture.raw"}]},
        )

        meta = payload["series"][0]["meta"]
        self.assertIsNotNone(meta["since"])
        self.assertLessEqual(meta["until"] - meta["since"], server.MAX_RAW_SPAN_SECONDS)

    def test_batch_statistics_use_raw_window_not_max_points_plot(self):
        conn = sqlite3.connect(server.DB_PATH)
        for ts, value in ((100, 10), (200, 20), (300, 30)):
            conn.execute(
                """
                INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
                VALUES ('fixture.stats', ?, ?, 60, 'gauge', '[]')
                """,
                (ts, value),
            )
        conn.commit()
        conn.close()

        payload = self.invoke(
            "POST",
            "/api/series/batch",
            {
                "queries": [
                    {
                        "id": "stats",
                        "metric": "fixture.stats",
                        "since": 100,
                        "until": 300,
                        "max_points": 1,
                    }
                ]
            },
        )

        result = payload["series"][0]
        self.assertEqual(len(result["points"]), 1)
        self.assertEqual(result["meta"]["stats"]["count"], 3)
        self.assertEqual(result["meta"]["stats"]["latest"], 30)


if __name__ == "__main__":
    _ = unittest.main()
