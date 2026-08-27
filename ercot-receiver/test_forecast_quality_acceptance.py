"""Independent PR11 forecast-quality acceptance goldens.

These tests use the public forecast-quality functions and insert synthetic
source rows at the SQLite contract boundary. Expected selections and numbers
are calculated here, not by calling implementation helpers.
"""

from __future__ import annotations

import sqlite3
import unittest

import forecast_quality as quality
import forecast_vintages as vintages


DAY = 86_400
DAY_START = 1_800_057_600  # UTC aligned.


class ForecastQualityAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        vintages.init_forecast_schema(self.conn)
        quality.init_forecast_quality_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def publication(self, product, vintage, issued, retrieved, unit="MW"):
        source = {
            "NP3-565-CD": quality.LOAD_FORECAST_SOURCE,
            "NP6-345-CD": quality.LOAD_ACTUAL_SOURCE,
        }[product]
        cursor = self.conn.execute(
            """
            INSERT INTO forecast_publications (
                source_id, product_id, vintage_key, issued_at, published_at,
                raw_posted_datetime, retrieved_at, artifact_href,
                query_window_json, parser_schema_version, schema_fingerprint,
                declared_unit, content_hash, row_count, created_at,
                publication_key_kind, publication_key
            ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '{}', 'acceptance-v1',
                      ?, ?, ?, 1, ?, ?, ?)
            """,
            (
                source,
                product,
                vintage,
                issued,
                retrieved,
                f"https://acceptance.invalid/{product}",
                "a" * 64,
                unit,
                (vintage.encode().hex() + "0" * 64)[:64],
                retrieved,
                "official_posted_datetime" if issued is not None else "content_hash",
                vintage,
            ),
        )
        return cursor.lastrowid

    def forecast(self, publication_id, target, value, model="A3", active=True):
        self.conn.execute(
            """
            INSERT INTO forecast_np3_565_rows (
                publication_id, target_ts, delivery_date, hour_ending,
                dst_flag, model, in_use_flag, system_total
            ) VALUES (?, ?, '2027-01-15', '1:00', 0, ?, ?, ?)
            """,
            (publication_id, target, model, int(active), value),
        )

    def actual(self, publication_id, target, value, day="2027-01-15"):
        self.conn.execute(
            """
            INSERT INTO forecast_np6_345_rows (
                publication_id, target_ts, operating_day, hour_ending,
                dst_flag, total
            ) VALUES (?, ?, ?, '01:00', 0, ?)
            """,
            (publication_id, target, day, value),
        )

    def resource(self, result):
        return quality.forecast_quality_resource(
            self.conn,
            result["series_key"],
            quality.METHODOLOGY_VERSION,
            result["content_version"],
            result["horizon"],
            result["day_start"],
        )

    def test_per_target_cutoff_correction_version_and_complete_utc_day(self):
        target = DAY_START + 3_600
        old_issue = target - 5_400
        selected_issue = target - 3_600
        too_late_issue = target - 3_599
        for vintage, issue, value in (
            ("forecast-old", old_issue, 90.0),
            ("forecast-selected", selected_issue, 100.0),
            ("forecast-too-late", too_late_issue, 999.0),
        ):
            publication_id = self.publication(
                "NP3-565-CD", vintage, issue, selected_issue
            )
            self.forecast(publication_id, target, value)

        old_retrieved = target + 60
        corrected_retrieved = target + 7_200
        old_actual = self.publication(
            "NP6-345-CD", "actual-old", None, old_retrieved
        )
        corrected_actual = self.publication(
            "NP6-345-CD", "actual-corrected", None, corrected_retrieved
        )
        self.actual(old_actual, target, 110.0)
        self.actual(corrected_actual, target, 120.0)
        self.conn.commit()

        first_result = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 3_600,
            horizons=("1h",),
        )[0]
        first = self.resource(first_result)
        self.assertEqual(len(first["rows"]), 24)
        selected = next(row for row in first["rows"] if row["target_ts"] == target)
        self.assertEqual(selected["selected_issue_at"], selected_issue)
        self.assertEqual(selected["effective_lead_seconds"], 3_600)
        self.assertEqual(selected["forecast_mw"], 100.0)
        self.assertEqual(selected["actual_mw"], 110.0)
        self.assertEqual(selected["error_mw"], 10.0)
        self.assertEqual(selected["absolute_error_mw"], 10.0)
        self.assertEqual(selected["revision_mw"], 10.0)
        self.assertEqual(first["missing_reasons"]["missing_forecast"], 23)

        repeated_result = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 3_600,
            horizons=("1h",),
        )[0]
        self.assertEqual(repeated_result["content_version"], first_result["content_version"])

        corrected_result = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 10_800,
            horizons=("1h",),
        )[0]
        corrected = self.resource(corrected_result)
        corrected_row = next(row for row in corrected["rows"] if row["target_ts"] == target)
        self.assertEqual(corrected_row["actual_mw"], 120.0)
        self.assertEqual(corrected_row["error_mw"], 20.0)
        self.assertNotEqual(corrected_result["content_version"], first_result["content_version"])
        self.assertEqual(self.resource(first_result), first)

    def test_ambiguous_prior_operational_vintage_is_not_revision_reference(self):
        target = DAY_START + 7_200
        prior = self.publication(
            "NP3-565-CD", "ambiguous-prior", target - 7_200, target - 7_000
        )
        self.forecast(prior, target, 90.0, "A3", True)
        self.forecast(prior, target, 91.0, "X", True)
        selected = self.publication(
            "NP3-565-CD", "selected", target - 3_600, target - 3_500
        )
        self.forecast(selected, target, 100.0, "A3", True)
        actual = self.publication("NP6-345-CD", "actual", None, target + 60)
        self.actual(actual, target, 110.0)
        self.conn.commit()

        result = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 120,
            horizons=("1h",),
        )[0]
        row = next(item for item in self.resource(result)["rows"] if item["target_ts"] == target)
        self.assertEqual(row["error_mw"], 10.0)
        self.assertIsNone(row["revision_mw"])

    def test_wall_clock_recompute_does_not_mint_a_new_content_version(self):
        target = DAY_START + 7_200
        selected = self.publication(
            "NP3-565-CD", "stable-forecast", target - 3_600, target - 3_500
        )
        self.forecast(selected, target, 100.0)
        actual = self.publication("NP6-345-CD", "stable-actual", None, target + 60)
        self.actual(actual, target, 110.0)
        self.conn.commit()

        first = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 3_600,
            horizons=("1h",),
        )[0]
        second = quality.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY_START,
            current_ts=target + 3_601,
            horizons=("1h",),
        )[0]
        self.assertEqual(second["content_version"], first["content_version"])

    def test_recompute_rejects_a_cutoff_beyond_bounded_clock_skew(self):
        current = DAY_START + 10_000
        with self.assertRaisesRegex(ValueError, "invalid_forecast_quality_dataset_cutoff"):
            quality.recompute_forecast_quality(
                self.conn,
                "load.system",
                DAY_START,
                current_ts=current,
                dataset_cutoff=current + 301,
                horizons=("1h",),
            )
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM forecast_quality_current").fetchone()[0],
            0,
        )

    def test_formula_mape_count_and_type7_quantiles_are_independent_goldens(self):
        errors = [-2.0, 1.0, 3.0, -40.0]
        actuals = [8.0, 21.0, 33.0, 0.0]
        rows = [
            {
                "target_ts": DAY_START + index * 3_600,
                "delivery_date": "2027-01-15",
                "error_mw": error,
                "absolute_error_mw": abs(error),
                "absolute_percentage_error": (
                    100.0 * abs(error) / actual if actual > 0 else None
                ),
            }
            for index, (error, actual) in enumerate(zip(errors, actuals))
        ]
        summary = quality.summarize_rows(rows, expected_count=5)
        self.assertEqual(summary["sample_count"], 4)
        self.assertEqual(summary["mape_sample_count"], 3)
        self.assertAlmostEqual(summary["bias_mw"], -9.5)
        self.assertAlmostEqual(summary["mae_mw"], 11.5)
        self.assertAlmostEqual(summary["mape_percent"], 12.950_937_950_937_95)
        self.assertAlmostEqual(summary["signed_error_quantiles_mw"]["p10"], -28.6)
        self.assertAlmostEqual(summary["signed_error_quantiles_mw"]["p50"], -0.5)
        self.assertAlmostEqual(summary["signed_error_quantiles_mw"]["p90"], 2.4)
        self.assertAlmostEqual(summary["absolute_error_p80_mw"], 17.8)
        self.assertAlmostEqual(summary["joint_coverage"], 0.8)
        self.assertFalse(summary["qualification"]["qualified"])
        self.assertIsNone(summary["empirical_interval"])

    def test_dst_hour_endings_are_exact_utc_literals(self):
        self.assertEqual(
            vintages.market_hour_target("2025-11-02", "2:00", False),
            1_762_066_800,
        )
        self.assertEqual(
            vintages.market_hour_target("2025-11-02", "2:00", True),
            1_762_070_400,
        )
        self.assertEqual(
            vintages.market_hour_target("2026-03-08", "1:00", False),
            1_772_953_200,
        )
        self.assertEqual(
            vintages.market_hour_target("2026-03-08", "3:00", False),
            1_772_956_800,
        )
        with self.assertRaisesRegex(ValueError, "invalid_market_hour_sequence"):
            vintages.market_hour_target("2026-03-08", "2:00", False)


if __name__ == "__main__":
    unittest.main()
