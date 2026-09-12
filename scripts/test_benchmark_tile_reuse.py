import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "benchmark_tile_reuse.py"
sys.dont_write_bytecode = True


def load_module():
    spec = importlib.util.spec_from_file_location("benchmark_tile_reuse_test_module", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load tile reuse benchmark")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = load_module()


class TileReuseBenchmarkTests(unittest.TestCase):
    def test_window_generation_is_deterministic_and_bounded(self):
        first = benchmark.deterministic_windows(benchmark.DAY * 20_000)
        second = benchmark.deterministic_windows(benchmark.DAY * 20_000)
        self.assertEqual(first, second)
        self.assertEqual(list(first), [label for label, _span in benchmark.RANGES])
        self.assertTrue(all(len(rows) == 50 for rows in first.values()))
        for rows in first.values():
            self.assertTrue(all(row["start"] < row["end"] for row in rows))

    def test_full_benchmark_proves_reuse_and_restart_regeneration(self):
        evidence = benchmark.run()
        self.assertEqual(evidence["benchmark"]["total_windows"], 300)
        self.assertTrue(evidence["restart"]["persistent_tile_table_absent"])
        self.assertEqual(evidence["restart"]["cache_header"], "MISS")
        self.assertEqual(evidence["restart"]["sqlite_generations"], 1)
        self.assertTrue(evidence["restart"]["bytes_identical"])
        self.assertTrue(evidence["restart"]["etag_identical"])
        self.assertEqual(
            evidence["same_key_concurrency"]["tile_sqlite_generations_total"], 1
        )
        self.assertEqual(evidence["mixed_key_concurrency"]["statuses"], [200])
        self.assertEqual(evidence["mixed_key_concurrency"]["sqlite_generations"], 2)
        self.assertEqual(evidence["mixed_key_concurrency"]["singleflight_waiters"], 0)
        self.assertTrue(evidence["correction"]["affected_etag_changed"])
        self.assertEqual(evidence["correction"]["unrelated_cache_after"], "HIT")
        for row in evidence["ranges"].values():
            self.assertGreater(row["planner"]["application_cache_hits"], 0)
            self.assertGreater(row["planner"]["reuse_factor"], 1)
            self.assertEqual(row["receiver"]["warm"]["sqlite_generations"], 0)
            self.assertEqual(row["receiver"]["warm"]["sqlite_statements"], 0)


if __name__ == "__main__":
    unittest.main()
