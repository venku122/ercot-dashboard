#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("benchmark_series_migration.py")
SPEC = importlib.util.spec_from_file_location("benchmark_series_migration", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class SeriesMigrationBenchmarkContractTest(unittest.TestCase):
    def test_interruption_resume_integrity_and_index_contract(self):
        report = benchmark.run_benchmark(10_000, 2_000, 8)
        self.assertEqual(10_000, report["before"]["normalized_series"]["unassigned_series_id_rows"])
        self.assertEqual(8_000, report["interruption"]["remaining_rows"])
        self.assertEqual(8_000, report["resume"]["migrated_rows"])
        self.assertTrue(report["resume"]["verification"]["passed"])
        self.assertTrue(report["after"]["normalized_series"]["ready"])
        self.assertEqual(0, report["after"]["normalized_series"]["unassigned_series_id_rows"])
        self.assertTrue(
            any(
                "idx_metrics_series_ts_id_value" in detail
                for detail in report["queries"]["normalized_plan"]
            )
        )


if __name__ == "__main__":
    unittest.main()
