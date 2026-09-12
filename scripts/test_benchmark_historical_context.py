import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "benchmark_historical_context.py"
SERVER = ROOT / "ercot-receiver" / "server.py"


def load_module():
    spec = importlib.util.spec_from_file_location(
        "benchmark_historical_context_test_module", SCRIPT
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load benchmark module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


benchmark = load_module()


class HistoricalContextBenchmarkTests(unittest.TestCase):
    def test_materialization_reuse_and_correction_cardinality(self):
        evidence = benchmark.run(SERVER, days=45)
        self.assertEqual(evidence["fixture"]["chicago_local_dates"], 45)
        self.assertEqual(evidence["materialization"]["day_rows"], 45)
        self.assertLessEqual(evidence["materialization"]["hour_rows"], 45 * 24)
        self.assertEqual(
            evidence["materialization"]["rewritten_days_after_correction"], 1
        )
        self.assertEqual(
            evidence["materialization"]["bounded_raw_queries_after_correction"], 1
        )
        self.assertTrue(evidence["resources"]["replay_content_version_stable"])
        self.assertTrue(evidence["resources"]["correction_created_version"])
        self.assertTrue(evidence["resources"]["old_resource_bytes_stable"])
        self.assertEqual(evidence["resources"]["rows"], 2)
        self.assertGreater(evidence["resources"]["payload_bytes"], 0)
        self.assertGreater(evidence["database_bytes"], 0)
        self.assertEqual(evidence["selected_state"], "available")


if __name__ == "__main__":
    unittest.main()
