"""Verify the disposable fixture keeps source evidence and derived storage honest."""
import json
import sqlite3
import unittest

from serve_review_receiver import ROOT, load_server, seed_review_data


class ReviewFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receiver = load_server(ROOT / "ercot-receiver/server.py")
        cls.conn = sqlite3.connect(":memory:")
        cls.receiver.init_db(cls.conn)
        cls.end = 1791100800
        cls.manifest = seed_review_data(cls.receiver, cls.conn, cls.end, 7)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_physical_rows_have_source_cadence_and_no_derived_persistence(self):
        for item in self.receiver.TILE_SERIES_CATALOG:
            if item.get("match") != "exact":
                continue
            series_id = self.receiver.resolve_series_id(self.conn, item["metric"], item["tags"])
            intervals = self.conn.execute("SELECT DISTINCT interval FROM metrics WHERE series_id=?", (series_id,)).fetchall()
            self.assertEqual([(item["native_interval_seconds"],)], intervals)
        self.assertEqual(0, self.conn.execute("SELECT count(*) FROM metrics WHERE metric_name LIKE '%headroom%' OR metric_name LIKE '%paired%'").fetchone()[0])
        self.assertFalse(self.manifest["production"])

    def test_source_health_counts_its_own_rows_and_latest_native_epoch(self):
        for source in self.receiver.list_source_health(self.conn, current_ts=self.end):
            source_id = source["source_id"]
            definitions = [item for item in self.receiver.TILE_SERIES_CATALOG
                           if item.get("match") == "exact" and item["source"] == source_id]
            if not definitions:
                continue
            counts, latest = 0, 0
            for item in definitions:
                series_id = self.receiver.resolve_series_id(self.conn, item["metric"], item["tags"])
                count, last = self.conn.execute("SELECT count(*),max(ts) FROM metrics WHERE series_id=?", (series_id,)).fetchone()
                counts += count
                latest = max(latest, last)
            row = self.conn.execute("SELECT last_row_count,data_timestamp_ts,provenance_json FROM collector_sources WHERE source_id=?", (source_id,)).fetchone()
            self.assertEqual((counts, latest), row[:2])
            self.assertEqual("synthetic_local_review", json.loads(row[2])["mode"])


if __name__ == "__main__":
    unittest.main()
