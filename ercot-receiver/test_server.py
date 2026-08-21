import importlib.util
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
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
        self.assertIn(("idx_metrics_series_ts_id_value",), rows)
        self.assertIn(("idx_metrics_unbackfilled_name",), rows)

    def test_init_db_has_no_generated_tile_body_table(self):
        tables = {
            row[0]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            ).fetchall()
        }

        self.assertNotIn("tile_resources", tables)
        self.assertFalse(any("tile" in name and "resource" in name for name in tables))

    def test_normalized_series_readiness_is_explicit_and_public_safe(self):
        self.insert_metric("ercot.readiness", 100, 1.0, ["source:fixture"])
        pending = server.normalized_series_readiness(self.conn)
        self.assertEqual(
            {
                "ready": False,
                "unassigned_rows": 1,
                "blocked_tile_series": [],
            },
            pending,
        )
        self.assertNotIn("series_id", json.dumps(pending))
        self.assertEqual(1, server.backfill_metric_series(self.conn))
        self.assertEqual(
            {
                "ready": True,
                "unassigned_rows": 0,
                "blocked_tile_series": [],
            },
            server.normalized_series_readiness(self.conn),
        )
        hot_index_sql = self.conn.execute(
            """
            SELECT sql FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_metrics_series_ts_id_value'
            """
        ).fetchone()[0]
        self.assertIn("WHERE series_id IS NOT NULL", hot_index_sql)

    def test_incomplete_backfill_gate_uses_partial_metric_index(self):
        plan = self.conn.execute(
            """
            EXPLAIN QUERY PLAN
            SELECT 1 FROM metrics
            WHERE metric_name = ? AND series_id IS NULL
            LIMIT 1
            """,
            ("ercot.fixture",),
        ).fetchall()
        details = [row[3] for row in plan]

        self.assertTrue(
            any("USING INDEX idx_metrics_unbackfilled_name" in detail for detail in details),
            details,
        )
        self.assertFalse(any("SCAN metrics" in detail for detail in details), details)

    def test_normalized_query_path_matches_legacy_for_no_one_and_multiple_tags(self):
        self.insert_metric("ercot.parity", 100, 1.0, [])
        self.insert_metric("ercot.parity", 200, 30.0, ["zone:a"])
        self.insert_metric("ercot.parity", 200, 10.0, ["kind:x", "zone:a"])
        self.insert_metric(
            "ercot.parity", 200, 20.0, ["detail:y", "kind:x", "zone:a"]
        )
        self.insert_metric("ercot.parity", 400, 4.0, ["kind:x", "zone:b"])
        filters = ([], ["zone:a"], ["zone:a", "kind:x"])
        legacy = {
            tuple(tags): self.handler._series_query(
                self.conn, "ercot.parity", 0, 500, tags
            )
            for tags in filters
        }

        self.assertEqual(server.backfill_metric_series(self.conn, batch_size=2), 5)
        normalized = {
            tuple(tags): self.handler._series_query(
                self.conn, "ercot.parity", 0, 500, tags
            )
            for tags in filters
        }

        self.assertEqual(normalized, legacy)
        self.assertEqual(
            normalized[()],
            [[100, 1.0], [200, 30.0], [200, 10.0], [200, 20.0], [400, 4.0]],
        )
        self.assertEqual(
            normalized[("zone:a",)],
            [[200, 30.0], [200, 10.0], [200, 20.0]],
        )
        self.assertEqual(
            normalized[("zone:a", "kind:x")],
            [[200, 10.0], [200, 20.0]],
        )
        self.assertEqual(
            self.handler._series_query(
                self.conn,
                "ercot.parity",
                0,
                500,
                ["zone:a"],
                rollup="sum",
            ),
            [[200, 60.0]],
        )

    def test_normalized_range_scan_uses_series_timestamp_covering_index(self):
        result = server.ingest_metrics(
            self.conn,
            [
                {
                    "metric_name": "ercot.indexed",
                    "tags": ["zone:a"],
                    "points": [{"timestamp": 100, "value": 1}],
                }
            ],
        )
        self.assertEqual(result["inserted"], 1)
        series_id = self.conn.execute(
            "SELECT series_id FROM metrics WHERE metric_name = 'ercot.indexed'"
        ).fetchone()[0]

        plan = self.conn.execute(
            """
            EXPLAIN QUERY PLAN
            SELECT ts, value FROM metrics
            WHERE series_id = ? AND ts >= ? AND ts <= ?
            ORDER BY ts, id
            """,
            (series_id, 0, 200),
        ).fetchall()

        self.assertTrue(
            any(
                "USING COVERING INDEX idx_metrics_series_ts_id_value" in row[3]
                for row in plan
            ),
            plan,
        )

        source, clauses, params, needs_legacy_tags = server.series_filter_sql(
            self.conn, "ercot.indexed", ["zone:a"]
        )
        self.assertFalse(needs_legacy_tags)
        handler_plan = self.conn.execute(
            "EXPLAIN QUERY PLAN SELECT m.ts, m.value FROM "
            + source
            + " WHERE "
            + " AND ".join([*clauses, "m.ts >= ?", "m.ts <= ?"])
            + " ORDER BY m.ts, m.id",
            [*params, 0, 200],
        ).fetchall()
        self.assertTrue(
            any(
                "USING COVERING INDEX idx_metrics_series_ts_id_value" in row[3]
                for row in handler_plan
            ),
            handler_plan,
        )

        selector_plan = self.conn.execute(
            """
            EXPLAIN QUERY PLAN
            SELECT s.id FROM series s
            JOIN series_tags st ON st.series_id = s.id
            WHERE s.metric_name = ? AND st.tag IN (?)
            GROUP BY s.id
            HAVING COUNT(DISTINCT st.tag) = 1
            """,
            ("ercot.indexed", "zone:a"),
        ).fetchall()
        details = [row[3] for row in selector_plan]
        self.assertFalse(any("SCAN metrics" in detail for detail in details), details)
        self.assertTrue(
            any(
                "USING COVERING INDEX idx_series_tags_tag_series" in detail
                for detail in details
            ),
            details,
        )

    def test_normalized_query_parity_covers_aggregates_latest_and_empty(self):
        self.insert_metric("ercot.aggregate_parity", 0, 5.0, ["zone:a"])
        self.insert_metric(
            "ercot.aggregate_parity", 30, 1.0, ["kind:x", "zone:a"]
        )
        self.insert_metric(
            "ercot.aggregate_parity", 60, 9.0, ["kind:x", "zone:a"]
        )
        self.insert_metric(
            "ercot.aggregate_parity",
            90,
            3.0,
            ["detail:y", "kind:x", "zone:a"],
        )

        def snapshot():
            return {
                "average": self.handler._series_query(
                    self.conn,
                    "ercot.aggregate_parity",
                    0,
                    120,
                    ["kind:x", "zone:a"],
                    bucket_seconds=60,
                ),
                "empty": self.handler._series_query(
                    self.conn,
                    "ercot.aggregate_parity",
                    0,
                    120,
                    ["zone:missing"],
                ),
                "latest": self.handler._latest_query(
                    self.conn,
                    "ercot.aggregate_parity",
                    ["zone:a", "kind:x"],
                ),
                "minmax": self.handler._series_query(
                    self.conn,
                    "ercot.aggregate_parity",
                    0,
                    120,
                    ["zone:a", "kind:x"],
                    bucket_seconds=60,
                    aggregation="minmax",
                ),
                "statistics": self.handler._series_statistics(
                    self.conn,
                    "ercot.aggregate_parity",
                    0,
                    120,
                    ["kind:x", "zone:a"],
                ),
            }

        legacy = snapshot()
        self.assertEqual(server.backfill_metric_series(self.conn), 4)
        normalized = snapshot()

        self.assertEqual(normalized, legacy)
        self.assertEqual(normalized["average"], [[0, 1.0], [60, 6.0]])
        self.assertEqual(normalized["empty"], [])
        self.assertEqual(normalized["latest"]["value"], 3.0)
        self.assertEqual(normalized["statistics"]["count"], 3)

    def test_incomplete_backfill_falls_back_without_dropping_null_series_rows(self):
        server.ingest_metrics(
            self.conn,
            [
                {
                    "metric_name": "ercot.mixed",
                    "tags": ["zone:a"],
                    "points": [{"timestamp": 100, "value": 1}],
                }
            ],
        )
        self.insert_metric("ercot.mixed", 200, 2.0, ["zone:a"])

        self.assertEqual(
            self.handler._series_query(
                self.conn, "ercot.mixed", 0, 300, ["zone:a"]
            ),
            [[100, 1.0], [200, 2.0]],
        )

    def test_no_tag_selector_does_not_expand_unbounded_series_id_parameters(self):
        for index in range(1_100):
            server.resolve_series_id(
                self.conn, "ercot.high_cardinality", [f"node:{index}"]
            )

        source, clauses, params, needs_legacy_tags = server.series_filter_sql(
            self.conn, "ercot.high_cardinality", []
        )

        self.assertEqual(source, "metrics m")
        self.assertFalse(needs_legacy_tags)
        self.assertEqual(params, ["ercot.high_cardinality"])
        self.assertEqual(len(clauses), 1)
        self.assertIn("SELECT id FROM series", clauses[0])
        self.assertEqual(
            self.handler._series_query(
                self.conn, "ercot.high_cardinality", 0, 100, []
            ),
            [],
        )

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
        source_columns = {
            row[1]
            for row in self.conn.execute("PRAGMA table_info(collector_sources)")
        }
        indexes = {
            row[1] for row in self.conn.execute("PRAGMA index_list(metrics)")
        }

        self.assertIn("collector_sources", tables)
        self.assertIn("events", tables)
        self.assertIn("metric_correction_age", tables)
        self.assertIn("series", tables)
        self.assertIn("series_tags", tables)
        self.assertIn("dedupe_key", columns)
        self.assertIn("series_id", columns)
        self.assertIn("data_timestamp_ts", source_columns)
        self.assertIn("diagnostics_json", source_columns)
        self.assertIn("provenance_json", source_columns)
        self.assertIn("availability_status", source_columns)
        self.assertIn("idx_metrics_dedupe_key", indexes)
        self.assertIn("idx_metrics_series_ts_id_value", indexes)
        self.assertIn("idx_metrics_unbackfilled_name", indexes)
        self.assertIn(
            "idx_series_tags_tag_series",
            {
                row[1]
                for row in self.conn.execute("PRAGMA index_list(series_tags)")
            },
        )

    def test_series_identity_normalizes_tag_order_and_duplicates(self):
        first_id = server.resolve_series_id(
            self.conn,
            "ercot.fuel_mix.generation_mw",
            ["fuel:wind", "source:ercot", "fuel:wind"],
        )
        second_id = server.resolve_series_id(
            self.conn,
            "ercot.fuel_mix.generation_mw",
            ["source:ercot", "fuel:wind"],
        )

        self.assertEqual(first_id, second_id)
        self.assertEqual(
            self.conn.execute(
                "SELECT tags_json FROM series WHERE id = ?", (first_id,)
            ).fetchone()[0],
            '["fuel:wind","source:ercot"]',
        )
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM series").fetchone()[0], 1)

    def test_init_does_not_rescan_series_tags_and_explicit_repair_remains_available(self):
        series_id = server.resolve_series_id(
            self.conn, "ercot.interrupted", ["source:fixture"]
        )
        self.conn.execute("DELETE FROM series_tags WHERE series_id = ?", (series_id,))
        self.conn.commit()

        server.init_db(self.conn)

        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM series_tags WHERE series_id = ?", (series_id,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(server.backfill_series_tags(self.conn), 1)
        self.assertEqual(server.backfill_series_tags(self.conn), 0)

    def test_incremental_backfill_is_resumable_and_idempotent(self):
        for tags in ('["zone:a"]', '["zone:a"]', '["zone:b"]'):
            self.conn.execute(
                """
                INSERT INTO metrics (metric_name, ts, value, tags)
                VALUES ('ercot.backfill', 1, 2, ?)
                """,
                (tags,),
            )

        self.assertEqual(
            server.backfill_metric_series(
                self.conn, batch_size=1, max_batches=1
            ),
            1,
        )
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id IS NULL"
            ).fetchone()[0],
            2,
        )
        self.assertEqual(server.backfill_metric_series(self.conn, batch_size=1), 2)
        self.assertEqual(server.backfill_metric_series(self.conn), 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM series").fetchone()[0], 2)

        server.init_db(self.conn)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM series").fetchone()[0], 2)
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id IS NULL"
            ).fetchone()[0],
            0,
        )

    def test_init_backfill_is_bounded_and_explicit_helper_completes_it(self):
        self.conn.executemany(
            """
            INSERT INTO metrics (metric_name, ts, value, tags)
            VALUES ('ercot.bounded', ?, ?, '[]')
            """,
            [(1, 1), (2, 2), (3, 3)],
        )
        original_size = server.SERIES_BACKFILL_BATCH_SIZE
        original_batches = server.SERIES_BACKFILL_MAX_BATCHES
        server.SERIES_BACKFILL_BATCH_SIZE = 1
        server.SERIES_BACKFILL_MAX_BATCHES = 1
        try:
            server.init_db(self.conn)
        finally:
            server.SERIES_BACKFILL_BATCH_SIZE = original_size
            server.SERIES_BACKFILL_MAX_BATCHES = original_batches

        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id IS NOT NULL"
            ).fetchone()[0],
            1,
        )
        self.assertEqual(server.backfill_metric_series(self.conn), 2)

    def test_tag_drift_audit_and_backfill_prefer_lookup_relation(self):
        cursor = self.conn.execute(
            """
            INSERT INTO metrics (metric_name, ts, value, tags)
            VALUES ('ercot.drift', 1, 2, '["zone:compatibility"]')
            """
        )
        self.conn.execute(
            "INSERT INTO metric_tags (metric_id, tag) VALUES (?, 'zone:lookup')",
            (cursor.lastrowid,),
        )

        self.assertEqual(
            server.audit_metric_tag_drift(self.conn),
            [
                {
                    "metric_id": cursor.lastrowid,
                    "metric_tags": ["zone:lookup"],
                    "tags_json": ["zone:compatibility"],
                }
            ],
        )
        server.backfill_metric_series(self.conn)
        self.assertEqual(
            self.conn.execute(
                """
                SELECT s.tags_json FROM metrics m
                JOIN series s ON s.id = m.series_id
                WHERE m.id = ?
                """,
                (cursor.lastrowid,),
            ).fetchone()[0],
            '["zone:lookup"]',
        )

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
        legacy.execute(
            """
            CREATE TABLE collector_sources (
                source_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                expected_interval_seconds INTEGER NOT NULL,
                last_attempt_ts INTEGER,
                last_success_ts INTEGER,
                source_timestamp_ts INTEGER,
                last_payload_hash TEXT,
                last_row_count INTEGER,
                consecutive_failures INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                publication_mode TEXT NOT NULL DEFAULT 'polling',
                publication_interval_seconds INTEGER,
                checkpoint_json TEXT,
                updated_at INTEGER NOT NULL
            )
            """
        )
        legacy.commit()

        server.init_db(legacy)
        server.init_db(legacy)

        self.assertEqual(legacy.execute("SELECT COUNT(*) FROM metrics").fetchone()[0], 1)
        self.assertIsNotNone(
            legacy.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                ("metric_correction_age",),
            ).fetchone()
        )
        self.assertIn(
            "dedupe_key", {row[1] for row in legacy.execute("PRAGMA table_info(metrics)")}
        )
        self.assertIn(
            "series_id", {row[1] for row in legacy.execute("PRAGMA table_info(metrics)")}
        )
        self.assertEqual(
            legacy.execute(
                "SELECT metric_name, ts, value FROM metrics"
            ).fetchone(),
            ("legacy.metric", 1, 2.0),
        )
        self.assertIsNotNone(
            legacy.execute("SELECT series_id FROM metrics").fetchone()[0]
        )
        self.assertIn(
            "data_timestamp_ts",
            {
                row[1]
                for row in legacy.execute("PRAGMA table_info(collector_sources)")
            },
        )
        self.assertEqual(
            sum(
                row[1] == "data_timestamp_ts"
                for row in legacy.execute("PRAGMA table_info(collector_sources)")
            ),
            1,
        )
        migrated_source_columns = [
            row[1] for row in legacy.execute("PRAGMA table_info(collector_sources)")
        ]
        self.assertEqual(migrated_source_columns.count("diagnostics_json"), 1)
        self.assertEqual(migrated_source_columns.count("provenance_json"), 1)
        self.assertEqual(migrated_source_columns.count("availability_status"), 1)
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
        self.assertEqual(server.list_metric_correction_age(self.conn), [])
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
        self.assertEqual(revised["correction_age_buckets"]["under_5m"], 1)
        self.assertEqual(revised["correction_age_buckets"]["future"], 1)
        self.assertEqual(sum(revised["correction_age_buckets"].values()), 2)
        persisted_corrections = server.list_metric_correction_age(self.conn)
        self.assertEqual(len(persisted_corrections), 2)
        self.assertEqual(
            {row["source_id"] for row in persisted_corrections}, {"supply_demand"}
        )
        self.assertEqual(sum(row["correction_count"] for row in persisted_corrections), 2)
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
        self.assertEqual(
            self.conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id IS NOT NULL"
            ).fetchone()[0],
            2,
        )

    def test_correction_can_move_sample_to_a_new_normalized_series(self):
        payload = [
            {
                "metric_name": "ercot.corrected",
                "tags": ["source:fixture", "zone:a"],
                "points": [
                    {"timestamp": 100, "value": 1, "dedupe_key": "corrected:100"}
                ],
            }
        ]
        server.ingest_metrics(self.conn, payload, current_ts=100)
        original_series = self.conn.execute(
            "SELECT series_id FROM metrics WHERE dedupe_key = 'corrected:100'"
        ).fetchone()[0]
        payload[0]["metric_name"] = "ercot.corrected.revised"
        payload[0]["tags"] = ["zone:b", "source:fixture"]
        payload[0]["points"][0]["timestamp"] = 200
        payload[0]["points"][0]["value"] = 2

        corrected = server.ingest_metrics(self.conn, payload, current_ts=300)
        row = self.conn.execute(
            """
            SELECT m.series_id, s.tags_json, m.value, m.metric_name, m.ts
            FROM metrics m JOIN series s ON s.id = m.series_id
            WHERE m.dedupe_key = 'corrected:100'
            """
        ).fetchone()

        self.assertEqual(corrected["updated"], 1)
        self.assertEqual(
            corrected["dependencies"],
            {"ercot.corrected", "ercot.corrected.revised"},
        )
        self.assertEqual(corrected["changes"]["ercot.corrected"], [(100, 100)])
        self.assertEqual(
            corrected["changes"]["ercot.corrected.revised"], [(200, 200)]
        )
        self.assertEqual(
            corrected["changes"][f"series:{original_series}"], [(100, 100)]
        )
        self.assertEqual(corrected["changes"][f"series:{row[0]}"], [(200, 200)])
        self.assertNotEqual(row[0], original_series)
        self.assertEqual(row[1], '["source:fixture","zone:b"]')
        self.assertEqual(row[2], 2)
        self.assertEqual(row[3:], ("ercot.corrected.revised", 200))
        self.assertEqual(
            self.conn.execute(
                "SELECT tag FROM metric_tags ORDER BY tag"
            ).fetchall(),
            [("source:fixture",), ("zone:b",)],
        )

    def test_correction_age_boundaries_and_missing_timestamp_use_prior_observation(self):
        boundaries = {
            -1: "future",
            0: "under_5m",
            299: "under_5m",
            300: "5m_to_1h",
            3599: "5m_to_1h",
            3600: "1h_to_24h",
            86399: "1h_to_24h",
            86400: "1d_to_7d",
            7 * 86400: "7d_to_30d",
            30 * 86400: "over_30d",
        }
        for age, expected in boundaries.items():
            self.assertEqual(server.correction_age_bucket(4_000_000, 4_000_000 - age), expected)

        server.ingest_metrics(
            self.conn,
            [
                {
                    "metric_name": "ercot.fixture",
                    "tags": ["source:fixture"],
                    "points": [
                        {"timestamp": 1_000, "value": 1, "dedupe_key": "fixture:one"}
                    ],
                }
            ],
            current_ts=1_000,
        )
        result = server.ingest_metrics(
            self.conn,
            [
                {
                    "metric_name": "ercot.fixture",
                    "tags": ["source:fixture"],
                    "points": [{"value": 2, "dedupe_key": "fixture:one"}],
                }
            ],
            current_ts=2_000,
        )
        self.assertEqual(result["correction_age_buckets"]["5m_to_1h"], 1)
        self.assertEqual(
            server.list_metric_correction_age(self.conn)[0]["source_id"], "fixture"
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

    def test_intentionally_disabled_source_is_not_reported_as_broken(self):
        server.update_source_health(
            self.conn,
            {
                "source_id": "poweroutages_us",
                "display_name": "PowerOutage.us Texas",
                "expected_interval_seconds": 1800,
                "attempted_at": 1000,
                "success": False,
                "row_count": 0,
                "error": "missing_api_key",
            },
            current_ts=1000,
        )

        self.assertEqual(server.list_source_health(self.conn, 1100), [])

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

    def test_core_data_timestamp_drives_freshness_instead_of_payload_timestamp(self):
        server.update_source_health(
            self.conn,
            {
                "source_id": "supply_demand",
                "display_name": "ERCOT Supply and Demand",
                "expected_interval_seconds": 300,
                "attempted_at": 10_000,
                "success": True,
                "source_timestamp_ts": 10_000,
                "data_timestamp_ts": 1_000,
                "row_count": 800,
            },
            current_ts=10_000,
        )

        health = server.list_source_health(self.conn, 10_060)[0]

        self.assertEqual(health["state"], "stale")
        self.assertEqual(health["source_age_seconds"], 60)
        self.assertEqual(health["data_age_seconds"], 9_060)
        self.assertEqual(health["data_timestamp_ts"], 1_000)

        server.update_source_health(
            self.conn,
            {
                "source_id": "supply_demand",
                "display_name": "ERCOT Supply and Demand",
                "expected_interval_seconds": 300,
                "attempted_at": 10_070,
                "success": False,
                "row_count": 0,
                "error": "source_http_503",
            },
            current_ts=10_070,
        )
        failed_health = server.list_source_health(self.conn, 10_080)[0]
        self.assertEqual(failed_health["data_timestamp_ts"], 1_000)
        self.assertEqual(failed_health["data_age_seconds"], 9_080)

    def test_source_metadata_is_sanitized_persisted_and_preserved_on_failure(self):
        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_public_api",
                "display_name": "ERCOT Public API",
                "expected_interval_seconds": 300,
                "attempted_at": 10_000,
                "success": True,
                "source_timestamp_ts": 10_000,
                "row_count": 12,
                "diagnostics": {
                    "pages": 2,
                    "authorization": "Bearer fixture-sensitive-value",
                    "clientSecret": "fixture-sensitive-value",
                    "request_url": (
                        "https://api.ercot.test/report?"
                        "subscription_key=fixture-sensitive-value"
                    ),
                    "contact": "fixture@example.test",
                },
                "provenance": {
                    "provider": "ERCOT",
                    "emil_id": "NP3-565-CD",
                    "artifact_path": "/np3-565-cd/lf_by_model_weather_zone",
                    "access_token": "fixture-sensitive-value",
                    "primaryKey": "fixture-sensitive-value",
                },
            },
            current_ts=10_000,
        )

        health = server.list_source_health(self.conn, 10_060)[0]
        self.assertEqual(health["diagnostics"]["pages"], 2)
        self.assertEqual(health["diagnostics"]["authorization"], "[redacted]")
        self.assertEqual(health["diagnostics"]["clientSecret"], "[redacted]")
        self.assertNotIn(
            "fixture-sensitive-value", health["diagnostics"]["request_url"]
        )
        self.assertEqual(health["diagnostics"]["contact"], "[redacted-email]")
        self.assertEqual(health["provenance"]["emil_id"], "NP3-565-CD")
        self.assertEqual(health["provenance"]["access_token"], "[redacted]")
        self.assertEqual(health["provenance"]["primaryKey"], "[redacted]")

        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_public_api",
                "display_name": "ERCOT Public API",
                "expected_interval_seconds": 300,
                "attempted_at": 10_100,
                "success": False,
                "row_count": 0,
                "error": "source_http_503",
            },
            current_ts=10_100,
        )

        failed_health = server.list_source_health(self.conn, 10_110)[0]
        self.assertEqual(failed_health["diagnostics"], health["diagnostics"])
        self.assertEqual(failed_health["provenance"], health["provenance"])

    def test_source_metadata_is_bounded_and_requires_objects(self):
        oversized = {f"field_{index}": "x" * 1_000 for index in range(50)}
        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_public_api",
                "display_name": "ERCOT Public API",
                "expected_interval_seconds": 300,
                "attempted_at": 10_000,
                "success": True,
                "row_count": 0,
                "diagnostics": oversized,
            },
            current_ts=10_000,
        )

        stored = self.conn.execute(
            "SELECT diagnostics_json FROM collector_sources WHERE source_id = ?",
            ("ercot_public_api",),
        ).fetchone()[0]
        self.assertLessEqual(len(stored.encode("utf-8")), server.MAX_SOURCE_METADATA_BYTES)
        diagnostics = server.list_source_health(self.conn, 10_010)[0]["diagnostics"]
        self.assertTrue(diagnostics["_truncated"])

        with self.assertRaisesRegex(ValueError, "invalid_source_diagnostics"):
            server.update_source_health(
                self.conn,
                {
                    "source_id": "invalid_metadata",
                    "display_name": "Invalid Metadata",
                    "expected_interval_seconds": 300,
                    "success": True,
                    "row_count": 0,
                    "diagnostics": ["not", "an", "object"],
                },
            )

    def test_valid_empty_availability_is_visible_and_survives_failure(self):
        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_esr_api",
                "display_name": "ERCOT ESR API",
                "expected_interval_seconds": 60,
                "attempted_at": 9_950,
                "success": True,
                "source_timestamp_ts": 9_950,
                "data_timestamp_ts": 9_940,
                "row_count": 1,
                "availability_status": "available",
            },
            current_ts=9_950,
        )
        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_esr_api",
                "display_name": "ERCOT ESR API",
                "expected_interval_seconds": 60,
                "attempted_at": 10_000,
                "success": True,
                "source_timestamp_ts": 10_000,
                "row_count": 0,
                "availability_status": "empty",
                "diagnostics": {"field_count": 5},
            },
            current_ts=10_000,
        )

        health = server.list_source_health(self.conn, 10_010)[0]
        self.assertEqual(health["availability_status"], "empty")
        self.assertEqual(health["collection_state"], "healthy")
        self.assertEqual(health["freshness_state"], "unknown")
        self.assertIsNone(health["data_timestamp_ts"])
        self.assertIsNone(health["data_age_seconds"])
        self.assertEqual(health["diagnostics"]["field_count"], 5)

        server.update_source_health(
            self.conn,
            {
                "source_id": "ercot_esr_api",
                "display_name": "ERCOT ESR API",
                "expected_interval_seconds": 60,
                "attempted_at": 10_020,
                "success": False,
                "row_count": 0,
                "error": "source_http_503",
            },
            current_ts=10_020,
        )
        self.assertEqual(
            server.list_source_health(self.conn, 10_030)[0]["availability_status"],
            "empty",
        )

        with self.assertRaisesRegex(ValueError, "invalid_availability_status"):
            server.update_source_health(
                self.conn,
                {
                    "source_id": "invalid_availability",
                    "display_name": "Invalid Availability",
                    "expected_interval_seconds": 300,
                    "success": True,
                    "row_count": 0,
                    "availability_status": "unknown",
                },
            )

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

    def test_sealed_range_cache_survives_unrelated_live_ingest(self):
        cache = server.Cache(60)
        cache.set(
            "sealed-demand-day",
            {"points": [[86_400, 10.0]]},
            {"ercot.demand"},
            ranges={"ercot.demand": (86_400, 172_799)},
            ttl_seconds=86_400,
            category="sealed",
        )

        cache.invalidate_changes({"ercot.demand": [(900_000, 900_000)]})
        self.assertIsNotNone(cache.get("sealed-demand-day"))
        cache.invalidate_changes({"ercot.demand": [(100_000, 100_000)]})
        self.assertIsNone(cache.get("sealed-demand-day"))

    def test_tile_range_invalidation_is_inclusive_start_exclusive_end(self):
        start = 86_400
        end = 172_800
        for changed_ts, invalidated in (
            (start - 1, False),
            (start, True),
            (start + 1, True),
            (end - 1, True),
            (end, False),
            (end + 1, False),
        ):
            cache = server.Cache(60)
            cache.set(
                "tile",
                {"buckets": []},
                {"series:17"},
                ranges={"series:17": (start, end - 1)},
            )
            cache.invalidate_changes({"series:17": [(changed_ts, changed_ts)]})
            self.assertEqual(cache.get("tile") is None, invalidated, changed_ts)

    def test_singleflight_propagates_failure_and_removes_key(self):
        singleflight = server.SingleFlight()
        started = threading.Barrier(10)
        calls = 0
        lock = threading.Lock()

        def generate():
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.05)
            raise ValueError("fixture_failure")

        def invoke():
            started.wait()
            with self.assertRaisesRegex(ValueError, "fixture_failure"):
                singleflight.do("same-key", generate)

        with ThreadPoolExecutor(max_workers=10) as executor:
            list(executor.map(lambda _index: invoke(), range(10)))

        self.assertEqual(calls, 1)
        self.assertEqual(singleflight.pending(), 0)

    def test_cache_identity_normalizes_tag_order(self):
        handler = server.Handler.__new__(server.Handler)
        first = handler._cache_key(
            "chunk", {"metric": "m", "tags": server.normalize_tags(["b", "a"])}
        )
        second = handler._cache_key(
            "chunk", {"tags": server.normalize_tags(["a", "b", "a"]), "metric": "m"}
        )
        self.assertEqual(first, second)


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
            {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        self.tmp.cleanup()

    def invoke(
        self,
        method,
        path,
        payload=None,
        request_headers=None,
        expected_status=200,
        return_raw=False,
    ):
        body = json.dumps(payload).encode() if payload is not None else b""
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            **(request_headers or {}),
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        try:
            if method == "GET":
                handler.do_GET()
            else:
                handler.do_POST()
        finally:
            thread_connection = getattr(server.DB_LOCAL, "conn", None)
            if thread_connection is not None:
                thread_connection.close()
                del server.DB_LOCAL.conn
        self.assertEqual(handler.response_status, expected_status)
        response_body = handler.wfile.getvalue()
        result = (
            json.loads(response_body) if response_body else None,
            handler.response_headers,
        )
        return (*result, response_body) if return_raw else result

    def ingest_metric(self, metric, tags, points):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            return server.ingest_metrics(
                conn,
                [{"metric_name": metric, "tags": tags, "points": points}],
                current_ts=max(
                    [point.get("timestamp", 0) for point in points] or [server.now_ts()]
                ),
            )
        finally:
            conn.close()

    def test_get_without_since_defaults_to_bounded_window(self):
        payload, _headers = self.invoke("GET", "/api/series?metric=fixture.raw")

        self.assertIsNotNone(payload["meta"]["since"])
        self.assertLessEqual(
            payload["meta"]["until"] - payload["meta"]["since"],
            server.MAX_RAW_SPAN_SECONDS,
        )

    def test_batch_without_since_uses_the_same_bounded_window(self):
        payload, _headers = self.invoke(
            "POST",
            "/api/series/batch",
            {"queries": [{"id": "raw", "metric": "fixture.raw"}]},
        )

        meta = payload["series"][0]["meta"]
        self.assertIsNotNone(meta["since"])
        self.assertLessEqual(meta["until"] - meta["since"], server.MAX_RAW_SPAN_SECONDS)

    def test_source_health_api_exposes_metadata_and_empty_availability(self):
        conn = sqlite3.connect(server.DB_PATH)
        server.update_source_health(
            conn,
            {
                "source_id": "ercot_esr_api",
                "display_name": "ERCOT ESR API",
                "expected_interval_seconds": 60,
                "attempted_at": server.now_ts(),
                "success": True,
                "row_count": 0,
                "availability_status": "empty",
                "diagnostics": {"field_count": 5},
                "provenance": {
                    "provider": "ERCOT",
                    "artifact_path": "/rptesr-m/4_sec_esr_charging_mw",
                },
            },
        )
        conn.close()

        payload, headers = self.invoke("GET", "/api/v1/source-health")

        source = payload["sources"][0]
        self.assertEqual(source["availability_status"], "empty")
        self.assertEqual(source["diagnostics"], {"field_count": 5})
        self.assertEqual(source["provenance"]["provider"], "ERCOT")
        self.assertIn("public", headers["Cache-Control"])

    def test_correction_age_api_exposes_durable_source_metric_buckets(self):
        observed_at = server.now_ts()
        payload = [
            {
                "metric_name": "ercot.fixture",
                "tags": ["source:fixture"],
                "points": [
                    {
                        "timestamp": observed_at - 400,
                        "value": 1,
                        "dedupe_key": "fixture:one",
                    }
                ],
            }
        ]

        cached_empty, _headers = self.invoke("GET", "/api/v1/correction-age")
        self.assertEqual(cached_empty, {"corrections": []})

        original_api_key = server.API_KEY
        server.API_KEY = "fixture-api-key"
        try:
            request_headers = {"X-API-Key": "fixture-api-key"}
            self.invoke("POST", "/api/ingest", payload, request_headers)
            payload[0]["points"][0]["value"] = 2
            self.invoke("POST", "/api/ingest", payload, request_headers)
        finally:
            server.API_KEY = original_api_key

        response, headers = self.invoke("GET", "/api/v1/correction-age")

        self.assertEqual(
            response,
            {
                "corrections": [
                    {
                        "age_bucket": "5m_to_1h",
                        "correction_count": 1,
                        "last_observed_at": observed_at,
                        "metric_name": "ercot.fixture",
                        "source_id": "fixture",
                        "tags": ["source:fixture"],
                    }
                ]
            },
        )
        self.assertIn("public", headers["Cache-Control"])

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

        payload, _headers = self.invoke(
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
        self.assertNotIn("series_id", json.dumps(payload))
        self.assertEqual(len(result["points"]), 1)
        self.assertEqual(result["meta"]["stats"]["count"], 3)
        self.assertEqual(result["meta"]["stats"]["latest"], 30)

    def test_v2_catalog_is_deterministic_validated_and_cacheable(self):
        payload, headers = self.invoke("GET", "/api/v2/tile-catalog")

        self.assertEqual(payload["schema"], 2)
        self.assertEqual(payload["tile_spans"], {"1d": 86400, "1h": 3600})
        self.assertFalse(payload["boundary_policy"]["coarse_partial_clipping"])
        self.assertEqual(payload["boundary_policy"]["edge_lod"], "native")
        self.assertEqual(
            [entry["key"] for entry in payload["series"]],
            sorted(entry["key"] for entry in payload["series"]),
        )
        keys = {entry["key"] for entry in payload["series"]}
        self.assertTrue(
            {
                "frequency.system",
                "generation-outages.total",
                "pricing.houston",
                "pricing.north",
                "pricing.west",
                "storage.charging",
                "storage.discharging",
                "storage.net-output",
                "supply-demand.forecast-demand",
                "fuel-mix.natural-gas",
                "renewables.wind-forecast",
                "renewables.wind-hsl",
                "renewables.solar-forecast",
            }.issubset(keys)
        )
        self.assertNotIn("series_id", json.dumps(payload))
        self.assertNotIn("immutable", headers["Cache-Control"])
        self.assertIn("must-revalidate", headers["Cache-Control"])
        self.assertTrue(headers["ETag"].startswith('"'))

        not_modified, repeat_headers = self.invoke(
            "GET",
            "/api/v2/tile-catalog",
            request_headers={"If-None-Match": headers["ETag"]},
            expected_status=304,
        )
        self.assertIsNone(not_modified)
        self.assertEqual(repeat_headers["ETag"], headers["ETag"])

        duplicate = [dict(server.TILE_SERIES_CATALOG[0])] * 2
        with self.assertRaisesRegex(ValueError, "duplicate_tile_series_key"):
            server.validate_tile_series_catalog(duplicate)
        unsorted = dict(server.TILE_CATALOG_BY_KEY["fuel-mix.wind"])
        unsorted["tags"] = list(reversed(unsorted["tags"]))
        with self.assertRaisesRegex(ValueError, "invalid_tile_series_tags"):
            server.validate_tile_series_catalog([unsorted])
        unsupported = dict(server.TILE_SERIES_CATALOG[0])
        unsupported["supported_lods"] = ["native", "7m"]
        with self.assertRaisesRegex(ValueError, "invalid_tile_supported_lods"):
            server.validate_tile_series_catalog([unsupported])
        exact_sum = dict(server.TILE_SERIES_CATALOG[0])
        exact_sum["rollup"] = "sum"
        with self.assertRaisesRegex(ValueError, "tile_exact_disallows_rollup"):
            server.validate_tile_series_catalog([exact_sum])
        bad_policy = dict(server.TILE_SERIES_CATALOG[0])
        bad_policy["statistic_policy"] = "money-ish"
        with self.assertRaisesRegex(ValueError, "invalid_tile_statistic_policy"):
            server.validate_tile_series_catalog([bad_policy])

    def test_v2_tile_rejects_unknown_lod_span_alignment_and_aliases_without_cache(self):
        cases = (
            ("/api/v2/tiles/not-known/1d/86400/native", 404),
            ("/api/v2/tiles/supply-demand.demand/2d/86400/native", 400),
            ("/api/v2/tiles/supply-demand.demand/1d/86401/native", 400),
            ("/api/v2/tiles/supply-demand.demand/1d/086400/native", 400),
            ("/api/v2/tiles/fuel-mix.wind/1d/86400/5m", 400),
            ("/api/v2/tiles/supply-demand.demand/1d/86400/native?x=1", 400),
        )
        for path, status in cases:
            payload, headers = self.invoke("GET", path, expected_status=status)
            self.assertIn("error", payload)
            self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.app.cache.stats()["entries"], 0)

    def test_v2_generation_failure_is_not_cached_or_leaked_by_singleflight(self):
        original = server.Handler._generate_tile

        def fail(_handler, *_args):
            raise RuntimeError("fixture_generation_failure")

        server.Handler._generate_tile = fail
        try:
            payload, headers = self.invoke(
                "GET",
                "/api/v2/tiles/supply-demand.demand/1d/86400/native",
                expected_status=500,
            )
        finally:
            server.Handler._generate_tile = original

        self.assertEqual(payload, {"error": "tile_generation_failed"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.app.cache.stats()["entries"], 0)
        self.assertEqual(self.app.singleflight.pending(), 0)

    def test_v2_exact_series_does_not_widen_to_tag_superset_and_native_is_lossless(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [
                {"timestamp": 90_000, "value": 30, "dedupe_key": "demand:90000"},
                {"timestamp": 90_300, "value": 10, "dedupe_key": "demand:90300"},
            ],
        )
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand", "variant:shadow"],
            [{"timestamp": 90_000, "value": 999, "dedupe_key": "shadow:90000"}],
        )
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"

        payload, headers = self.invoke("GET", path)

        self.assertEqual(headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(payload["boundary_policy"], "native_edges_coarse_aligned_interiors")
        self.assertEqual(len(payload["buckets"]), 2)
        self.assertEqual(
            [bucket["state"]["value_sum"] for bucket in payload["buckets"]],
            [30.0, 10.0],
        )
        self.assertTrue(all(bucket["state"]["count"] == 1 for bucket in payload["buckets"]))
        self.assertNotIn("series_id", json.dumps(payload))

    def test_v2_coarse_bucket_uses_left_step_mergeable_aggregate(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [
                {"timestamp": 90_000, "value": 30, "dedupe_key": "coarse:90000"},
                {"timestamp": 90_300, "value": 10, "dedupe_key": "coarse:90300"},
            ],
        )

        payload, _headers = self.invoke(
            "GET", "/api/v2/tiles/supply-demand.demand/1d/86400/5m"
        )

        states = [bucket["state"] for bucket in payload["buckets"]]
        self.assertEqual([state["count"] for state in states], [1, 1])
        self.assertTrue(all(state["integral_value_seconds"] == 0 for state in states))

        payload_15m, _headers = self.invoke(
            "GET", "/api/v2/tiles/supply-demand.demand/1d/86400/15m"
        )
        state = payload_15m["buckets"][0]["state"]
        self.assertEqual(state["count"], 2)
        self.assertEqual(state["integral_value_seconds"], 9_000.0)

    def test_v2_equal_timestamp_order_uses_tile_ordinals_not_values_or_db_ids(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [
                {"timestamp": 90_010, "value": 8, "dedupe_key": "tie:first"},
                {"timestamp": 90_010, "value": 2, "dedupe_key": "tie:second"},
                {"timestamp": 90_020, "value": 4, "dedupe_key": "tie:last"},
            ],
        )

        payload, _headers = self.invoke(
            "GET", "/api/v2/tiles/supply-demand.demand/1d/86400/15m"
        )
        state = payload["buckets"][0]["state"]
        encoded = json.dumps(payload, sort_keys=True)

        self.assertEqual(state["first_value"], 8.0)
        self.assertEqual(state["last_value"], 4.0)
        self.assertEqual(state["integral_value_seconds"], 20.0)
        self.assertEqual((state["first_ordinal"], state["last_ordinal"]), (0, 0))
        self.assertNotIn("metric_id", encoded)
        self.assertNotIn("series_id", encoded)

    def test_v2_miss_hit_and_304_do_not_regenerate_sqlite_tile(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 42, "dedupe_key": "cache:90000"}],
        )
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"

        first, first_headers, first_raw = self.invoke("GET", path, return_raw=True)
        second, second_headers, second_raw = self.invoke("GET", path, return_raw=True)
        not_modified, third_headers, not_modified_raw = self.invoke(
            "GET",
            path,
            request_headers={"If-None-Match": first_headers["ETag"]},
            expected_status=304,
            return_raw=True,
        )

        self.assertEqual(first, second)
        self.assertEqual(first_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(second_headers["X-ERCOT-Cache"], "HIT")
        self.assertIsNone(not_modified)
        self.assertEqual(not_modified_raw, b"")
        self.assertEqual(third_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(first_raw, second_raw)
        self.assertEqual(
            {first_headers["ETag"], second_headers["ETag"], third_headers["ETag"]},
            {first_headers["ETag"]},
        )
        self.assertEqual(self.app.cache_metrics["tile_generations"], 1)

        self.app.cache = server.Cache(60)
        regenerated, regenerated_headers, regenerated_raw = self.invoke(
            "GET", path, return_raw=True
        )
        self.assertEqual(regenerated, first)
        self.assertEqual(regenerated_raw, first_raw)
        self.assertEqual(regenerated_headers["ETag"], first_headers["ETag"])
        self.assertEqual(self.app.cache_metrics["tile_generations"], 2)

    def test_v2_correction_regenerates_affected_tile_and_keeps_unrelated_warm(self):
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        unrelated_path = "/api/v2/tiles/supply-demand.demand/1d/172800/native"
        points = [{"timestamp": 90_000, "value": 42, "dedupe_key": "version:90000"}]
        self.ingest_metric(
            "ercot.supply_demand.demand_mw", ["source:supply_demand"], points
        )
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 180_000, "value": 50, "dedupe_key": "version:180000"}],
        )

        initial, initial_headers, initial_raw = self.invoke("GET", path, return_raw=True)
        unrelated, unrelated_headers = self.invoke("GET", unrelated_path)
        self.assertNotIn("Content-Location", initial_headers)
        self.assertNotIn("X-ERCOT-Content-Version", initial_headers)
        self.assertNotIn("immutable", initial_headers["Cache-Control"])
        self.assertEqual(self.app.cache_metrics["tile_generations"], 2)

        points[0]["value"] = 43
        correction = self.ingest_metric(
            "ercot.supply_demand.demand_mw", ["source:supply_demand"], points
        )
        self.app.cache.invalidate_changes(correction["changes"])
        corrected, corrected_headers, corrected_raw = self.invoke(
            "GET", path, return_raw=True
        )
        unrelated_after, unrelated_after_headers = self.invoke("GET", unrelated_path)

        self.assertNotEqual(corrected_raw, initial_raw)
        self.assertNotEqual(corrected_headers["ETag"], initial_headers["ETag"])
        self.assertEqual(corrected_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(unrelated_after, unrelated)
        self.assertEqual(unrelated_after_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(unrelated_headers["ETag"], unrelated_after_headers["ETag"])
        self.assertEqual(self.app.cache_metrics["tile_generations"], 3)

        unchanged = self.ingest_metric(
            "ercot.supply_demand.demand_mw", ["source:supply_demand"], points
        )
        self.assertEqual(unchanged["unchanged"], 1)
        repeated, repeated_headers, repeated_raw = self.invoke(
            "GET", path, return_raw=True
        )
        self.assertEqual(repeated, corrected)
        self.assertEqual(repeated_raw, corrected_raw)
        self.assertEqual(repeated_headers["ETag"], corrected_headers["ETag"])

    def test_v2_fresh_receiver_regenerates_from_sqlite_without_disk_tile_cache(self):
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 42, "dedupe_key": "restart:90000"}],
        )

        first, first_headers, first_raw = self.invoke("GET", path, return_raw=True)
        self.assertEqual(self.app.cache_metrics["tile_generations"], 1)
        first_app = self.app

        self.app = type(
            "RestartedTestServer",
            (),
            {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()
        restarted, restarted_headers, restarted_raw = self.invoke(
            "GET", path, return_raw=True
        )

        self.assertEqual(first_app.cache_metrics["tile_generations"], 1)
        self.assertEqual(self.app.cache_metrics["tile_generations"], 1)
        self.assertEqual(restarted_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(restarted, first)
        self.assertEqual(restarted_raw, first_raw)
        self.assertEqual(restarted_headers["ETag"], first_headers["ETag"])
        with sqlite3.connect(server.DB_PATH) as conn:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_schema WHERE type = 'table'"
                ).fetchall()
            }
        self.assertNotIn("tile_resources", tables)

    def test_v2_queries_create_no_tile_filesystem_artifacts(self):
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 42, "dedupe_key": "files:90000"}],
        )
        root = Path(self.tmp.name)
        before = {item.relative_to(root) for item in root.rglob("*") if item.is_file()}

        self.invoke("GET", path)
        self.invoke("GET", path)

        after = {item.relative_to(root) for item in root.rglob("*") if item.is_file()}
        created = after - before
        self.assertTrue(
            all(str(item).startswith("metrics.db-") for item in created), created
        )
        self.assertFalse(any(item.suffix in {".json", ".tile"} for item in after))

    def test_v2_rejects_persistent_content_version_aliases(self):
        payload, headers = self.invoke(
            "GET",
            "/api/v2/tiles/supply-demand.demand/1d/86400/native/v1/"
            + "t2-"
            + "0" * 64,
            expected_status=400,
        )

        self.assertEqual(payload, {"error": "invalid_canonical_tile"})
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_v2_incomplete_backfill_is_503_and_not_cached(self):
        conn = sqlite3.connect(server.DB_PATH)
        conn.execute(
            """
            INSERT INTO metrics (metric_name, ts, value, tags)
            VALUES ('ercot.supply_demand.demand_mw', 90000, 1, '["source:supply_demand"]')
            """
        )
        conn.commit()
        conn.close()

        payload, headers = self.invoke(
            "GET",
            "/api/v2/tiles/supply-demand.demand/1d/86400/native",
            expected_status=503,
        )

        self.assertEqual(payload, {"error": "tile_series_backfill_incomplete"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.app.cache.stats()["entries"], 0)

    def test_v2_ten_concurrent_cold_requests_share_one_generation(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 42, "dedupe_key": "flight:90000"}],
        )
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        original = server.Handler._generate_tile
        calls = 0
        calls_lock = threading.Lock()
        start = threading.Barrier(10)

        def slow_generate(handler, *args):
            nonlocal calls
            with calls_lock:
                calls += 1
            time.sleep(0.05)
            return original(handler, *args)

        def request():
            start.wait()
            return self.invoke("GET", path, return_raw=True)

        server.Handler._generate_tile = slow_generate
        try:
            with ThreadPoolExecutor(max_workers=10) as executor:
                results = list(executor.map(lambda _index: request(), range(10)))
        finally:
            server.Handler._generate_tile = original

        self.assertEqual(calls, 1)
        self.assertEqual(self.app.cache_metrics["tile_generations"], 1)
        self.assertEqual(self.app.singleflight.pending(), 0)
        self.assertTrue(all(result[0] == results[0][0] for result in results))
        self.assertTrue(all(result[2] == results[0][2] for result in results))
        self.assertEqual({result[1]["ETag"] for result in results}, {results[0][1]["ETag"]})
        self.assertEqual(
            sum(result[1]["X-ERCOT-Singleflight"] == "LEADER" for result in results),
            1,
        )

    def test_v2_rollup_bytes_and_etag_match_cold_warm_and_regeneration(self):
        for fuel, value in (("wind", 10), ("solar", 5)):
            self.ingest_metric(
                "ercot.fuel_mix.generation_mw",
                [f"fuel:{fuel}", "source:fuel_mix"],
                [
                    {
                        "timestamp": 90_000,
                        "value": value,
                        "dedupe_key": f"rollup-bytes:{fuel}",
                    }
                ],
            )
        path = "/api/v2/tiles/fuel-mix.total/1d/86400/native"

        first, first_headers, first_raw = self.invoke("GET", path, return_raw=True)
        warm, warm_headers, warm_raw = self.invoke("GET", path, return_raw=True)
        not_modified, not_modified_headers, not_modified_raw = self.invoke(
            "GET",
            path,
            request_headers={"If-None-Match": first_headers["ETag"]},
            expected_status=304,
            return_raw=True,
        )
        self.app.cache = server.Cache(60)
        regenerated, regenerated_headers, regenerated_raw = self.invoke(
            "GET", path, return_raw=True
        )

        self.assertEqual(first, warm)
        self.assertEqual(regenerated, first)
        self.assertEqual(first_raw, warm_raw)
        self.assertEqual(regenerated_raw, first_raw)
        self.assertEqual(not_modified_raw, b"")
        self.assertIsNone(not_modified)
        self.assertEqual(
            {
                first_headers["ETag"],
                warm_headers["ETag"],
                not_modified_headers["ETag"],
                regenerated_headers["ETag"],
            },
            {first_headers["ETag"]},
        )

    def test_v2_different_tile_keys_generate_concurrently(self):
        for metric, dedupe in (
            ("ercot.supply_demand.demand_mw", "overlap:demand"),
            ("ercot.supply_demand.available_capacity_mw", "overlap:capacity"),
        ):
            self.ingest_metric(
                metric,
                ["source:supply_demand"],
                [{"timestamp": 90_000, "value": 1, "dedupe_key": dedupe}],
            )
        paths = (
            "/api/v2/tiles/supply-demand.demand/1d/86400/native",
            "/api/v2/tiles/supply-demand.available-capacity/1d/86400/native",
        )
        original = server.Handler._generate_tile
        rendezvous = threading.Barrier(2)

        def overlapping_generate(handler, *args):
            rendezvous.wait(timeout=2)
            return original(handler, *args)

        server.Handler._generate_tile = overlapping_generate
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda path: self.invoke("GET", path), paths))
        finally:
            server.Handler._generate_tile = original

        self.assertTrue(all(result[1]["X-ERCOT-Cache"] == "MISS" for result in results))
        self.assertEqual(self.app.cache_metrics["tile_generations"], 2)

    def test_v2_leader_rechecks_cache_after_election(self):
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 1, "dedupe_key": "recheck:90000"}],
        )
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        primed, _headers = self.invoke("GET", path)
        identity = {
            "schema": 2,
            "series_key": "supply-demand.demand",
            "tile_span": "1d",
            "tile_start": 86400,
            "lod": "native",
        }
        cache_key = server.Handler.__new__(server.Handler)._cache_key("tile:v2", identity)

        class MissOnceCache(server.Cache):
            def __init__(self):
                super().__init__(60)
                self.force_miss = True

            def get(self, key):
                if self.force_miss:
                    self.force_miss = False
                    return None
                return super().get(key)

        cache = MissOnceCache()
        cache.set(cache_key, primed)
        self.app.cache = cache
        self.app.cache_metrics = server.defaultdict(float)

        repeated, headers = self.invoke("GET", path)

        self.assertEqual(repeated, primed)
        self.assertEqual(headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(self.app.cache_metrics["tile_generations"], 0)
        self.assertEqual(self.app.cache_metrics["tile_lru_race_hits"], 1)

    def test_v2_post_invalidation_request_does_not_join_stale_flight(self):
        points = [{"timestamp": 90_000, "value": 1, "dedupe_key": "race:90000"}]
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            points,
        )
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        original = server.Handler._generate_tile
        first_queried = threading.Event()
        release_first = threading.Event()
        calls = 0
        calls_lock = threading.Lock()

        def controlled_generate(handler, *args):
            nonlocal calls
            with calls_lock:
                calls += 1
                call_number = calls
            result = original(handler, *args)
            if call_number == 1:
                first_queried.set()
                release_first.wait(timeout=2)
            return result

        server.Handler._generate_tile = controlled_generate
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                stale_future = executor.submit(self.invoke, "GET", path)
                self.assertTrue(first_queried.wait(timeout=2))
                points[0]["value"] = 2
                correction = self.ingest_metric(
                    "ercot.supply_demand.demand_mw",
                    ["source:supply_demand"],
                    points,
                )
                self.app.cache.invalidate_changes(correction["changes"])
                fresh_future = executor.submit(self.invoke, "GET", path)
                fresh = fresh_future.result(timeout=2)
                release_first.set()
                stale = stale_future.result(timeout=2)
        finally:
            release_first.set()
            server.Handler._generate_tile = original

        self.assertEqual(calls, 2)
        self.assertEqual(stale[0]["buckets"][0]["state"]["value_sum"], 1.0)
        self.assertEqual(stale[1]["X-ERCOT-Cache-Store"], "SKIPPED_RACE")
        self.assertEqual(fresh[0]["buckets"][0]["state"]["value_sum"], 2.0)
        cached, cached_headers = self.invoke("GET", path)
        self.assertEqual(cached["buckets"][0]["state"]["value_sum"], 2.0)
        self.assertEqual(cached_headers["X-ERCOT-Cache"], "HIT")

    def test_v2_exact_and_rollup_invalidation_tracks_internal_series_ranges(self):
        wind_points = [
            {"timestamp": 90_000, "value": 10, "dedupe_key": "fuel:wind:90000"}
        ]
        solar_points = [
            {"timestamp": 90_000, "value": 5, "dedupe_key": "fuel:solar:90000"}
        ]
        self.ingest_metric(
            "ercot.fuel_mix.generation_mw",
            ["fuel:wind", "source:fuel_mix"],
            wind_points,
        )
        self.ingest_metric(
            "ercot.fuel_mix.generation_mw",
            ["fuel:solar", "source:fuel_mix"],
            solar_points,
        )
        wind_path = "/api/v2/tiles/fuel-mix.wind/1d/86400/native"
        total_path = "/api/v2/tiles/fuel-mix.total/1d/86400/native"
        wind, _wind_headers = self.invoke("GET", wind_path)
        total, _total_headers = self.invoke("GET", total_path)
        self.assertEqual(wind["buckets"][0]["state"]["value_sum"], 10.0)
        self.assertEqual(total["buckets"][0]["state"]["value_sum"], 15.0)

        solar_points[0]["value"] = 7
        correction = self.ingest_metric(
            "ercot.fuel_mix.generation_mw",
            ["fuel:solar", "source:fuel_mix"],
            solar_points,
        )
        self.app.cache.invalidate_changes(correction["changes"])
        wind_after, wind_headers = self.invoke("GET", wind_path)
        total_after, total_headers = self.invoke("GET", total_path)

        self.assertEqual(wind_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual(wind_after, wind)
        self.assertEqual(total_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(total_after["buckets"][0]["state"]["value_sum"], 17.0)

    def test_v2_empty_exact_invalidation_ignores_unrelated_new_identity(self):
        path = "/api/v2/tiles/supply-demand.demand/1d/86400/native"
        empty, empty_headers = self.invoke("GET", path)
        self.assertEqual(empty["buckets"], [])
        self.assertEqual(empty_headers["X-ERCOT-Cache"], "MISS")

        unrelated = self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand", "zone:other"],
            [{"timestamp": 90_000, "value": 99, "dedupe_key": "identity:other"}],
        )
        self.app.cache.invalidate_changes(unrelated["changes"])
        still_empty, unrelated_headers = self.invoke("GET", path)
        self.assertEqual(still_empty, empty)
        self.assertEqual(unrelated_headers["X-ERCOT-Cache"], "HIT")

        matching = self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            [{"timestamp": 90_000, "value": 42, "dedupe_key": "identity:exact"}],
        )
        self.app.cache.invalidate_changes(matching["changes"])
        populated, matching_headers = self.invoke("GET", path)
        self.assertEqual(matching_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(populated["buckets"][0]["state"]["value_sum"], 42.0)

    def test_v2_empty_selector_invalidation_is_precise_for_new_series(self):
        path = "/api/v2/tiles/fuel-mix.total/1d/86400/native"
        empty, _headers = self.invoke("GET", path)
        self.assertEqual(empty["buckets"], [])

        unrelated = self.ingest_metric(
            "ercot.fuel_mix.generation_mw",
            ["fuel:wind", "source:other"],
            [{"timestamp": 90_000, "value": 99, "dedupe_key": "selector:other"}],
        )
        self.app.cache.invalidate_changes(unrelated["changes"])
        still_empty, unrelated_headers = self.invoke("GET", path)
        self.assertEqual(still_empty, empty)
        self.assertEqual(unrelated_headers["X-ERCOT-Cache"], "HIT")

        matching = self.ingest_metric(
            "ercot.fuel_mix.generation_mw",
            ["fuel:wind", "source:fuel_mix"],
            [{"timestamp": 90_000, "value": 10, "dedupe_key": "selector:match"}],
        )
        self.app.cache.invalidate_changes(matching["changes"])
        populated, matching_headers = self.invoke("GET", path)
        self.assertEqual(matching_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(populated["buckets"][0]["state"]["value_sum"], 10.0)

    def test_v2_native_edges_and_coarse_interiors_reconstruct_partial_window(self):
        points = [
            {"timestamp": 90_010, "value": 1, "dedupe_key": "edge:90010"},
            {"timestamp": 90_300, "value": 2, "dedupe_key": "edge:90300"},
            {"timestamp": 90_900, "value": 3, "dedupe_key": "edge:90900"},
            {"timestamp": 91_200, "value": 4, "dedupe_key": "edge:91200"},
            {"timestamp": 91_800, "value": 5, "dedupe_key": "edge:91800"},
            {"timestamp": 92_100, "value": 6, "dedupe_key": "edge:92100"},
            {"timestamp": 92_700, "value": 7, "dedupe_key": "edge:92700"},
            {"timestamp": 92_705, "value": 8, "dedupe_key": "edge:92705"},
        ]
        self.ingest_metric(
            "ercot.supply_demand.demand_mw",
            ["source:supply_demand"],
            points,
        )
        prefix = "/api/v2/tiles/supply-demand.demand/1d/86400"
        native, _headers = self.invoke("GET", f"{prefix}/native")
        coarse, _headers = self.invoke("GET", f"{prefix}/15m")

        fragments = [
            server.deserialize_aggregate(bucket["state"])
            for bucket in native["buckets"]
            if bucket["start"] < 90_900 or bucket["start"] >= 92_700
        ]
        fragments.extend(
            server.deserialize_aggregate(bucket["state"])
            for bucket in coarse["buckets"]
            if 90_900 <= bucket["start"] < 92_700
        )
        reconstructed = server.merge_aggregates(*fragments)
        direct = server.aggregate_points(
            [(point["timestamp"], point["value"], 0) for point in points]
        )

        self.assertEqual(reconstructed.count, direct.count)
        self.assertEqual(reconstructed.value_sum, direct.value_sum)
        self.assertEqual(
            (reconstructed.minimum, reconstructed.minimum_ts),
            (direct.minimum, direct.minimum_ts),
        )
        self.assertEqual(
            (reconstructed.maximum, reconstructed.maximum_ts),
            (direct.maximum, direct.maximum_ts),
        )
        self.assertEqual(
            reconstructed.integral_value_seconds,
            direct.integral_value_seconds,
        )

    def test_v2_catalog_wide_exact_semantic_mapping(self):
        exact_entries = [
            definition
            for definition in server.TILE_CATALOG_BY_KEY.values()
            if definition["match"] == "exact"
        ]
        expected = {}
        for index, definition in enumerate(exact_entries, start=1):
            value = float(1_000 + index)
            expected[definition["key"]] = value
            self.ingest_metric(
                definition["metric"],
                definition["tags"],
                [
                    {
                        "timestamp": 90_000,
                        "value": value,
                        "dedupe_key": f"catalog:{definition['key']}",
                    }
                ],
            )

        for definition in exact_entries:
            payload, _headers = self.invoke(
                "GET",
                f"/api/v2/tiles/{definition['key']}/1d/86400/native",
            )
            self.assertEqual(len(payload["buckets"]), 1, definition["key"])
            self.assertEqual(
                payload["buckets"][0]["state"]["value_sum"],
                expected[definition["key"]],
                definition["key"],
            )
            self.assertNotIn("series_id", json.dumps(payload))

        selector, _headers = self.invoke(
            "GET", "/api/v2/tiles/fuel-mix.total/1d/86400/native"
        )
        expected_fuel_total = sum(
            expected[definition["key"]]
            for definition in exact_entries
            if definition["metric"] == "ercot.fuel_mix.generation_mw"
            and "source:fuel_mix" in definition["tags"]
        )
        self.assertEqual(
            selector["buckets"][0]["state"]["value_sum"], expected_fuel_total
        )

    def test_canonical_chunk_has_strong_etag_and_returns_304(self):
        conn = sqlite3.connect(server.DB_PATH)
        conn.execute(
            """
            INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
            VALUES ('fixture.chunk', 90000, 42, 300, 'gauge', '["zone:a"]')
            """
        )
        metric_id = conn.execute("SELECT id FROM metrics").fetchone()[0]
        conn.execute(
            "INSERT INTO metric_tags (metric_id, tag) VALUES (?, 'zone:a')", (metric_id,)
        )
        conn.commit()
        conn.close()
        path = (
            "/api/v1/series/chunk?metric=fixture.chunk&start=86400&end=172800"
            "&chunk_seconds=86400&tag=zone%3Aa&resolution=300"
        )

        payload, headers = self.invoke("GET", path)
        self.assertEqual(payload["points"], [[90000, 42.0]])
        self.assertTrue(headers["ETag"].startswith('"'))
        self.assertNotIn("immutable", headers["Cache-Control"])
        self.assertIn("must-revalidate", headers["Cache-Control"])
        self.assertEqual(headers["X-ERCOT-Cache"], "MISS")

        payload_304, repeat_headers = self.invoke(
            "GET",
            path,
            request_headers={"If-None-Match": headers["ETag"]},
            expected_status=304,
        )
        self.assertIsNone(payload_304)
        self.assertEqual(repeat_headers["ETag"], headers["ETag"])
        self.assertEqual(repeat_headers["X-ERCOT-Cache"], "HIT")


if __name__ == "__main__":
    _ = unittest.main()
