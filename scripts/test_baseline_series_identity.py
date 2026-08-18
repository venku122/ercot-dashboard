#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("baseline_series_identity.py")
SPEC = importlib.util.spec_from_file_location("baseline_series_identity", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


class SeriesIdentityAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="series-identity-test-")
        self.addCleanup(self.tempdir.cleanup)
        self.report = baseline.run_acceptance(
            baseline.ROOT / "ercot-receiver" / "server.py",
            Path(self.tempdir.name) / "fixture.db",
        )

    def test_exact_old_new_parity(self):
        self.assertEqual(
            [
                "no_tags",
                "one_tag",
                "multi_tags_unsorted_duplicate",
                "missing_tag",
                "rollup_sum_inputs",
            ],
            [case["name"] for case in self.report["parity_cases"]],
        )
        self.assertTrue(all(case["exact_equal"] for case in self.report["parity_cases"]))

    def test_migration_and_correction_contract(self):
        self.assertEqual(0, self.report["migration"]["null_series_ids_after_first"])
        self.assertTrue(self.report["migration"]["second_run_exactly_idempotent"])
        correction = self.report["correction"]
        self.assertEqual(1, correction["same_identity_receiver_result"]["updated"])
        self.assertTrue(correction["same_identity"]["row_count_unchanged"])
        self.assertTrue(correction["same_identity"]["series_id_stable"])
        self.assertTrue(correction["same_identity"]["exact_query_parity"])
        self.assertEqual(1, correction["tag_change_receiver_result"]["updated"])
        self.assertTrue(correction["tag_change"]["row_count_unchanged"])
        self.assertTrue(correction["tag_change"]["series_id_changed"])
        self.assertTrue(
            all(correction["tag_change"]["north_and_south_query_parity"].values())
        )

    def test_indexed_read_only_acceptance(self):
        self.assertTrue(self.report["query_plan"]["indexed_series_id_ts_id"])
        self.assertTrue(self.report["read_only_recheck"]["exact_query_parity"])
        self.assertTrue(self.report["read_only_recheck"]["database_unchanged"])


if __name__ == "__main__":
    unittest.main()
