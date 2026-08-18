import importlib.util
from contextlib import closing
import math
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "baseline_historical_contract.py"
SERVER_PATH = ROOT / "ercot-receiver" / "server.py"


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


baseline = load_module(SCRIPT_PATH, "baseline_historical_contract_test_module")
receiver = load_module(SERVER_PATH, "ercot_receiver_baseline_test_module")


class HistoricalContractBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temporary.name) / "baseline.db"
        baseline.build_fixture(self.db_path, receiver, days=370)

    def tearDown(self):
        self.temporary.cleanup()

    def test_all_required_windows_capture_contract_and_sql_evidence(self):
        evidence = baseline.run_baseline(
            self.db_path,
            SERVER_PATH,
            iterations=2,
            max_points=500,
        )

        self.assertEqual(
            list(evidence["direct_sql_windows"]),
            ["6h", "24h", "7d", "30d", "90d", "1y"],
        )
        self.assertEqual(evidence["request_cardinality"]["windows"], 6)
        self.assertEqual(evidence["request_cardinality"]["unique_cache_keys"], 6)
        self.assertEqual(
            evidence["request_cardinality"]["requests_if_each_window_loaded_twice"],
            12,
        )
        self.assertEqual(
            evidence["request_cardinality"]["tag_order_variant_unique_keys"],
            2,
        )
        correction_contract = evidence["correction_age"]["current_ingest_contract"]
        self.assertTrue(correction_contract["available"])
        self.assertTrue(correction_contract["bucket_names_match_contract"])
        self.assertEqual(correction_contract["synthetic_corrections"], 7)
        self.assertEqual(sum(correction_contract["buckets"].values()), 7)
        self.assertFalse(
            evidence["correction_age"]["historical_observations"]["available"]
        )
        self.assertFalse(evidence["frontend_parse_merge"]["available"])
        for window in evidence["direct_sql_windows"].values():
            self.assertTrue(window["supported"])
            self.assertGreater(window["response_bytes"], 0)
            self.assertGreater(window["points"], 0)
            self.assertEqual(window["sqlite"]["executions_per_iteration"], [2, 2])
            self.assertEqual(window["sqlite"]["total_executions"], 4)
            self.assertGreaterEqual(window["sqlite"]["p95_seconds"], 0)
            self.assertGreaterEqual(window["parse"]["p95_seconds"], 0)
            self.assertIn("python json.loads", window["parse"]["runtime"])
            self.assertTrue(window["explain_query_plan"])
            self.assertTrue(
                any(
                    "INDEX" in step["detail"].upper()
                    for step in window["explain_query_plan"]
                )
            )

    def test_batch_handler_captures_real_contract_and_zero_sql_warm_cache(self):
        evidence = baseline.run_baseline(
            self.db_path,
            SERVER_PATH,
            iterations=2,
            max_points=500,
        )

        expected_meta = {
            "aggregation",
            "bucket_seconds",
            "max_points",
            "partial_current_bucket",
            "rollup",
            "since",
            "stats",
            "until",
        }
        for window in evidence["handler_batch_windows"].values():
            self.assertEqual(window["response_schema_keys"], ["series"])
            self.assertEqual(
                window["series_schema_keys"],
                ["id", "meta", "metric", "points"],
            )
            self.assertEqual(set(window["response_meta"]), expected_meta)
            self.assertEqual(window["cold"]["status"], 200)
            self.assertEqual(window["warm"]["status"], 200)
            self.assertEqual(window["cold"]["select_executions"], [2, 2])
            self.assertEqual(window["warm"]["select_executions"], [0, 0])
            self.assertTrue(window["receiver_cache"]["warm_zero_sql"])
            self.assertTrue(window["receiver_cache"]["cache_key"])
            self.assertEqual(window["cold"]["total_requests"], 2)
            self.assertEqual(window["warm"]["total_requests"], 2)
            self.assertEqual(window["warmup_requests"], 1)
            self.assertGreater(window["request_bytes"], 0)
            self.assertGreaterEqual(window["request_parse"]["p95_seconds"], 0)
            self.assertGreater(window["cold"]["response_bytes"], 0)
            self.assertEqual(
                window["cold"]["response_bytes"],
                window["warm"]["response_bytes"],
            )

    def test_chunk_handler_captures_canonical_full_fanout_and_warm_cache(self):
        evidence = baseline.run_baseline(
            self.db_path,
            SERVER_PATH,
            iterations=2,
            max_points=500,
        )

        expected_requests = {
            "6h": 1,
            "24h": 1,
            "7d": 7,
            "30d": 30,
            "90d": 90,
            "1y": 365,
        }
        expected_schema = [
            "aggregation",
            "chunk_seconds",
            "end",
            "metric",
            "points",
            "resolution",
            "rollup",
            "schema",
            "start",
            "tags",
        ]
        for label, window in evidence["handler_chunk_windows"].items():
            requests = expected_requests[label]
            self.assertEqual(window["requests_per_iteration"], requests)
            self.assertEqual(window["unique_urls"], requests)
            self.assertEqual(window["cold"]["total_requests"], requests * 2)
            self.assertEqual(window["warm"]["total_requests"], requests * 2)
            self.assertEqual(window["warmup_requests"], requests)
            self.assertEqual(window["cold"]["select_executions"], [requests] * 2)
            self.assertEqual(window["warm"]["select_executions"], [0, 0])
            self.assertEqual(window["cold_cache_headers"], ["MISS"])
            self.assertEqual(window["warm_cache_headers"], ["HIT"])
            self.assertEqual(window["response_schema_keys"], expected_schema)
            expected_resolution = max(1, math.ceil(dict(baseline.WINDOWS)[label] / 1200))
            self.assertTrue(
                all(
                    f"resolution={expected_resolution}" in url
                    and "chunk_seconds=86400" in url
                    for url in window["urls"]
                )
            )
            self.assertTrue(all(status == 200 for status in window["cold"]["statuses"]))
            self.assertTrue(all(status == 200 for status in window["warm"]["statuses"]))
            self.assertGreater(window["cold"]["response_bytes"], 0)
            self.assertEqual(
                window["cold"]["response_bytes"],
                window["warm"]["response_bytes"],
            )

    def test_existing_database_is_not_schema_mutated(self):
        with closing(sqlite3.connect(self.db_path)) as conn:
            before = conn.execute(
                "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
        baseline.run_baseline(self.db_path, SERVER_PATH, iterations=1)
        with closing(sqlite3.connect(self.db_path)) as conn:
            after = conn.execute(
                "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()

        self.assertEqual(before, after)

    def test_correction_age_is_explicitly_unavailable_without_audit_data(self):
        conn = baseline.open_read_only(self.db_path)
        try:
            result = baseline.correction_age_buckets(conn)
        finally:
            conn.close()

        self.assertFalse(result["available"])
        self.assertIn("no correction audit table", result["reason"])

    def test_correction_age_buckets_are_inferred_only_from_explicit_audit_columns(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "CREATE TABLE correction_audit (observation_ts INTEGER, corrected_at INTEGER)"
        )
        ages = [-60, 60, 600, 7200, 2 * 86400, 10 * 86400, 40 * 86400]
        conn.executemany(
            "INSERT INTO correction_audit VALUES (?, ?)",
            [(1_000_000, 1_000_000 + age) for age in ages],
        )
        conn.commit()
        conn.close()

        read_only = baseline.open_read_only(self.db_path)
        try:
            result = baseline.correction_age_buckets(read_only)
        finally:
            read_only.close()

        self.assertTrue(result["available"])
        self.assertEqual(result["table"], "correction_audit")
        self.assertEqual(result["rows"], 7)
        self.assertEqual(
            result["buckets"],
            {
                "future": 1,
                "under_5m": 1,
                "5m_to_1h": 1,
                "1h_to_24h": 1,
                "1d_to_7d": 1,
                "7d_to_30d": 1,
                "over_30d": 1,
            },
        )

    def test_percentile_uses_nearest_rank_and_arguments_are_bounded(self):
        self.assertEqual(baseline.percentile([1, 2, 3, 4, 5], 0.95), 5)
        with self.assertRaisesRegex(ValueError, "iterations"):
            baseline.run_baseline(self.db_path, SERVER_PATH, iterations=0)
        with self.assertRaisesRegex(ValueError, "max_points"):
            baseline.run_baseline(self.db_path, SERVER_PATH, max_points=5_001)


if __name__ == "__main__":
    unittest.main()
