#!/usr/bin/env python3

import importlib.util
from datetime import date, timedelta
from pathlib import Path
import sqlite3
import sys
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("historical_context_test_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)
hc = sys.modules[server.resolve_historical_context.__module__]


class HistoricalContextTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        server.init_db(self.conn)

    def tearDown(self):
        self.conn.close()

    def insert_points(self, points, *, prefix="point"):
        result = server.ingest_metrics(
            self.conn,
            [{
                "metric": hc.METRIC,
                "tags": ["source:supply_demand"],
                "interval": 300,
                "metric_type": "gauge",
                "points": [
                    {"timestamp": timestamp, "value": value, "dedupe_key": f"{prefix}:{timestamp}"}
                    for timestamp, value in points
                ],
            }],
            current_ts=max((point[0] for point in points), default=0) + 10,
        )
        return result

    def hour_points(self, day, hour, value=1.0):
        return [
            (start + offset, value + offset / 300)
            for start in hc._hour_starts(day, hour)
            for offset in range(0, 3600, 300)
        ]

    def day_points(self, day, value=1.0):
        start, end = hc._date_bounds(day)
        return [(timestamp, value + (timestamp - start) / 300) for timestamp in range(start, end, 300)]

    def test_selected_hour_uses_maximum_observed_and_exact_coverage(self):
        day = date(2026, 1, 15)
        points = self.hour_points(day, 10, 10.0)
        self.insert_points(points)
        as_of = hc._hour_bounds(day, 10)[1]
        resolver = hc.resolve_historical_context(self.conn, as_of)
        selected = resolver["summary"]["selected_hour"]
        self.assertEqual(12, selected["coverage"]["expected_count"])
        self.assertEqual(12, selected["coverage"]["observed_count"])
        self.assertEqual(points[0][0], selected["coverage"]["first_observed_at"])
        self.assertEqual(points[-1][0], selected["coverage"]["last_observed_at"])
        self.assertEqual(max(value for _timestamp, value in points), selected["value"]["value"])
        self.assertEqual(hc.POLICY, resolver["policy"])
        self.assertRegex(resolver["resource"]["content_version"], r"^hc1-[0-9a-f]{64}$")

    def test_fall_one_am_combines_both_folds_and_spring_hour_is_unavailable(self):
        fall = date(2025, 11, 2)
        points = self.hour_points(fall, 1, 20.0)
        self.assertEqual(24, len(points))
        self.insert_points(points)
        resolver = hc.resolve_historical_context(self.conn, hc._hour_bounds(fall, 1)[1])
        selected = resolver["summary"]["selected_hour"]
        self.assertEqual(2, selected["occurrence_count"])
        self.assertEqual(2, len(selected["utc_intervals"]))
        self.assertEqual(24, selected["coverage"]["expected_count"])

        spring_next = date(2026, 3, 9)
        self.insert_points(self.hour_points(spring_next, 2, 30.0), prefix="spring")
        spring = hc.resolve_historical_context(
            self.conn, hc._hour_bounds(spring_next, 2)[1]
        )["summary"]
        self.assertEqual("unavailable", spring["comparisons"]["previous_day"]["state"])
        self.assertEqual("nonexistent_local_hour", spring["comparisons"]["previous_day"]["reason"])
        expected_candidates = sum(
            hc._season(spring_next - timedelta(days=offset)) == hc._season(spring_next)
            for offset in range(1, 401)
        )
        cohort = spring["seasonal_local_hour_percentiles"]
        self.assertEqual(expected_candidates, cohort["eligible_date_count"])
        self.assertEqual(expected_candidates, cohort["excluded_date_count"])

    def test_february_29_has_no_coerced_previous_year(self):
        leap = date(2028, 2, 29)
        self.insert_points(self.hour_points(leap, 8), prefix="leap")
        summary = hc.resolve_historical_context(
            self.conn, hc._hour_bounds(leap, 8)[1]
        )["summary"]
        previous = summary["comparisons"]["previous_year"]
        self.assertEqual("unavailable_no_calendar_anniversary", previous["reason"])
        self.assertIsNone(previous["market_date"])

    def test_type7_percentiles_require_thirty_prior_same_season_hours(self):
        selected_day = date(2026, 2, 15)
        points = self.hour_points(selected_day, 10, 100.0)
        for offset in range(1, 31):
            points.extend(self.hour_points(selected_day - timedelta(days=offset), 10, float(offset)))
        self.insert_points(points, prefix="cohort")
        summary = hc.resolve_historical_context(
            self.conn, hc._hour_bounds(selected_day, 10)[1]
        )["summary"]
        cohort = summary["seasonal_local_hour_percentiles"]
        self.assertEqual("available", cohort["state"])
        self.assertEqual(30, cohort["sample_count"])
        values = [max(value for _ts, value in self.hour_points(selected_day - timedelta(days=offset), 10, float(offset))) for offset in range(1, 31)]
        self.assertEqual(hc._type7(values, .1), cohort["p10"])
        self.assertEqual(hc._type7(values, .5), cohort["p50"])
        self.assertEqual(hc._type7(values, .9), cohort["p90"])

    def test_oldest_of_four_hundred_prior_dates_is_materialized(self):
        selected_day = date(2026, 2, 15)
        oldest = selected_day - timedelta(days=400)
        self.insert_points(
            self.hour_points(oldest, 10, 1.0) + self.hour_points(selected_day, 10, 2.0),
            prefix="oldest",
        )
        summary = hc.resolve_historical_context(
            self.conn, hc._hour_bounds(selected_day, 10)[1]
        )["summary"]
        self.assertIsNotNone(self.conn.execute(
            "SELECT 1 FROM historical_demand_hours WHERE market_date=? AND local_hour=10",
            (oldest.isoformat(),),
        ).fetchone())
        cohort = summary["seasonal_local_hour_percentiles"]
        self.assertLessEqual(cohort["first_cohort_date"], oldest.isoformat())

    def test_rank_is_partial_but_present_with_fewer_than_thirty_prior_days(self):
        selected_day = date(2026, 1, 10)
        prior_day = selected_day - timedelta(days=1)
        self.insert_points(self.day_points(prior_day, 1.0) + self.day_points(selected_day, 2.0), prefix="rank")
        as_of = hc._date_bounds(selected_day)[1]
        rank = hc.resolve_historical_context(self.conn, as_of)["summary"]["completed_day_peak_rank"]
        self.assertEqual("partial", rank["state"])
        self.assertEqual(1, rank["rank"])
        self.assertEqual(2, rank["denominator"])
        self.assertEqual(1, rank["qualified_prior_count"])

    def test_incremental_correction_rebuilds_only_dirty_market_day(self):
        first = date(2026, 1, 1)
        second = date(2026, 1, 2)
        self.insert_points(self.hour_points(first, 3) + self.hour_points(second, 3), prefix="incremental")
        as_of = hc._hour_bounds(second, 3)[1]
        hc.resolve_historical_context(self.conn, as_of)
        prior_generation = self.conn.execute(
            "SELECT generation FROM historical_demand_days WHERE market_date=?", (first.isoformat(),)
        ).fetchone()[0]
        timestamp = self.hour_points(second, 3)[0][0]
        self.insert_points([(timestamp, 999.0)], prefix="incremental")
        statements = []
        self.conn.set_trace_callback(statements.append)
        hc.resolve_historical_context(self.conn, as_of)
        self.conn.set_trace_callback(None)
        self.assertEqual(
            prior_generation,
            self.conn.execute("SELECT generation FROM historical_demand_days WHERE market_date=?", (first.isoformat(),)).fetchone()[0],
        )
        raw_queries = [statement for statement in statements if "SELECT ts,value FROM metrics" in statement]
        self.assertEqual(1, len(raw_queries), raw_queries)
        self.assertIn("LIMIT 301", raw_queries[0])

    def test_content_version_is_replica_deterministic_and_old_bytes_stable(self):
        day = date(2026, 1, 15)
        points = self.hour_points(day, 10, 10.0)
        as_of = hc._hour_bounds(day, 10)[1]
        self.insert_points(points, prefix="replica")
        first = hc.resolve_historical_context(self.conn, as_of)
        old_version = first["resource"]["content_version"]
        old_payload = hc.historical_context_resource(self.conn, old_version, as_of)

        other = sqlite3.connect(":memory:")
        server.init_db(other)
        try:
            server.ingest_metrics(other, [{
                "metric": hc.METRIC, "tags": ["source:supply_demand"], "interval": 300,
                "points": [{"timestamp": timestamp, "value": value, "dedupe_key": f"replica:{timestamp}"} for timestamp, value in reversed(points)],
            }])
            replica = hc.resolve_historical_context(other, as_of)
            self.assertEqual(old_version, replica["resource"]["content_version"])
            self.assertEqual(first["summary"], replica["summary"])
        finally:
            other.close()

        timestamp = points[0][0]
        self.insert_points([(timestamp, 999.0)], prefix="replica")
        corrected = hc.resolve_historical_context(self.conn, as_of)
        self.assertNotEqual(old_version, corrected["resource"]["content_version"])
        self.assertEqual(old_payload, hc.historical_context_resource(self.conn, old_version, as_of))


if __name__ == "__main__":
    unittest.main()
