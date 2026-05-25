import importlib.util
from pathlib import Path
import sqlite3
import tempfile
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

    def test_query_bucket_seconds_uses_max_points_window(self):
        self.assertEqual(self.handler._query_bucket_seconds(0, 100, 10, None), 11)
        self.assertEqual(self.handler._query_bucket_seconds(0, 100, 10, 60), 60)
        self.assertIsNone(self.handler._query_bucket_seconds(None, 100, 10, None))


if __name__ == "__main__":
    _ = unittest.main()
