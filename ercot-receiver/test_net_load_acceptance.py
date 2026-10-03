#!/usr/bin/env python3
"""Independent semantic acceptance for the PR12 net-load implementation."""

import hashlib
import json
import sqlite3
import unittest
from datetime import datetime, timezone

import net_load


def metric_schema(conn):
    conn.executescript(
        """
        CREATE TABLE metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            ts INTEGER NOT NULL,
            value REAL NOT NULL,
            tags TEXT NOT NULL DEFAULT '[]',
            series_id INTEGER
        );
        CREATE TABLE series (
            id INTEGER PRIMARY KEY,
            metric_name TEXT NOT NULL,
            tags_json TEXT NOT NULL
        );
        CREATE INDEX idx_metrics_name_ts_value_id
        ON metrics(metric_name, ts, value, id);
        """
    )


def forecast_schema(conn):
    conn.executescript(
        """
        CREATE TABLE forecast_publications (
            id INTEGER PRIMARY KEY,
            source_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            vintage_key TEXT NOT NULL,
            issued_at INTEGER NOT NULL,
            retrieved_at INTEGER NOT NULL
        );
        CREATE INDEX idx_forecast_publication_issue
        ON forecast_publications(source_id, product_id, issued_at DESC, id DESC);
        CREATE TABLE forecast_np3_565_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            in_use_flag INTEGER NOT NULL,
            model TEXT NOT NULL,
            system_total REAL NOT NULL
        );
        CREATE INDEX idx_forecast_np3_565_target
        ON forecast_np3_565_rows(target_ts, publication_id, in_use_flag, model, system_total);
        CREATE TABLE renewable_forecast_publications (
            id INTEGER PRIMARY KEY,
            source_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            vintage_key TEXT NOT NULL,
            issued_at INTEGER NOT NULL,
            retrieved_at INTEGER NOT NULL
        );
        CREATE INDEX idx_renewable_publications_issue
        ON renewable_forecast_publications(product_id, issued_at DESC, id DESC);
        CREATE TABLE renewable_forecast_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            forecast_mw REAL NOT NULL
        );
        CREATE INDEX idx_renewable_forecast_target
        ON renewable_forecast_rows(target_ts, publication_id, forecast_mw);
        """
    )


class NetLoadAcceptanceTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")

    def tearDown(self):
        self.conn.close()

    def insert_quartet(self, observed_at, *, demand, wind, solar, published):
        values = {"demand": demand, "wind": wind, "solar": solar, "published": published}
        self.conn.executemany(
            "INSERT INTO metrics(metric_name, ts, value) VALUES (?, ?, ?)",
            [
                (net_load.REALTIME_METRICS[name], observed_at, value)
                for name, value in values.items()
            ],
        )

    def test_actual_requires_same_timestamp_quartet_and_storage_is_context_only(self):
        metric_schema(self.conn)
        start = int(datetime(2026, 1, 15, tzinfo=timezone.utc).timestamp())
        end = start + 86_400
        visible_target = start
        for target, demand in (
            (visible_target - 10_800, 80_000),
            (visible_target - 3_600, 82_000),
            (visible_target, 87_000),
        ):
            self.insert_quartet(
                target,
                demand=demand,
                wind=10_000,
                solar=5_000,
                published=demand - 15_050,
            )
        self.conn.execute(
            "INSERT INTO metrics(metric_name, ts, value) VALUES (?, ?, ?)",
            (net_load.STORAGE_METRIC, start, -50_000),
        )

        rows = net_load._actual_rows(self.conn, start, end)
        first = rows[0]
        self.assertEqual(first["net_load_mw"], 72_000)
        self.assertEqual(first["ramp_1h_mw"], 5_000)
        self.assertEqual(first["ramp_3h_mw"], 7_000)
        self.assertEqual(first["published_residual_mw"], 50)
        self.assertEqual(first["storage_net_output_mw"], -50_000)
        self.assertEqual(first["net_load_mw"], first["demand_mw"] - first["wind_mw"] - first["solar_mw"])

        # Moving one component to another scrape timestamp invalidates both
        # incomplete groups instead of combining them.
        mixed_target = visible_target + 300
        self.insert_quartet(
            mixed_target,
            demand=90_000,
            wind=11_000,
            solar=6_000,
            published=73_000,
        )
        self.conn.execute(
            "UPDATE metrics SET ts=ts+1 WHERE metric_name=? AND ts=?",
            (net_load.REALTIME_METRICS["solar"], mixed_target),
        )
        rows = net_load._actual_rows(self.conn, start, end)
        self.assertEqual(rows[1]["missing_reason"], "missing_same_timestamp_quartet")
        self.assertTrue(all(start <= row["target_ts"] < end for row in rows))
        self.assertEqual(rows[0]["target_ts"], start)
        self.assertEqual(rows[-1]["target_ts"], end - 300)

    def test_forecast_uses_one_coherent_curve_and_exact_lookback(self):
        forecast_schema(self.conn)
        start = int(datetime(2026, 1, 15, tzinfo=timezone.utc).timestamp())
        end = start + 86_400
        issued = start - 7_200
        self.conn.execute(
            "INSERT INTO forecast_publications VALUES (1,?,?,?,?,?)",
            (net_load.LOAD_SOURCE, net_load.LOAD_PRODUCT, "v1-load", issued, issued + 60),
        )
        for identifier, source, product, vintage in (
            (2, net_load.WIND_SOURCE, net_load.WIND_PRODUCT, "rv1-wind"),
            (3, net_load.SOLAR_SOURCE, net_load.SOLAR_PRODUCT, "rv1-solar"),
        ):
            self.conn.execute(
                "INSERT INTO renewable_forecast_publications VALUES (?,?,?,?,?,?)",
                (identifier, source, product, vintage, issued, issued + 60),
            )
        for target in range(start - 10_800, end + 21_601, 3_600):
            step = (target - start) // 3_600
            self.conn.execute(
                "INSERT INTO forecast_np3_565_rows VALUES (?,?,?,?,?)",
                (1, target, 1, "A3", 70_000 + step * 1_000),
            )
            self.conn.execute(
                "INSERT INTO renewable_forecast_rows VALUES (?,?,?)", (2, target, 10_000)
            )
            self.conn.execute(
                "INSERT INTO renewable_forecast_rows VALUES (?,?,?)", (3, target, 5_000)
            )

        net_load.init_net_load_schema(self.conn)
        early_cutoff = issued + 60
        later_cutoff = issued + 120
        early_results = net_load.recompute_net_load(
            self.conn,
            net_load.FORECAST_SERIES_KEY,
            start,
            current_ts=end + 21_601,
            dataset_cutoff=early_cutoff,
            horizons=["1h"],
        )
        early_native = next(item for item in early_results if item.get("lod") == "native")
        early_bytes = self.conn.execute(
            """
            SELECT payload_json FROM net_load_resources
            WHERE series_key=? AND methodology_version=? AND content_version=?
              AND horizon='1h' AND day_start=? AND lod='native'
            """,
            (
                net_load.FORECAST_SERIES_KEY,
                net_load.METHODOLOGY_VERSION,
                early_native["content_version"],
                start,
            ),
        ).fetchone()[0]
        early_payload = json.loads(early_bytes)
        early_link = next(
            item
            for item in net_load.net_load_manifest(self.conn, now=early_cutoff)["resources"]
            if item["series_key"] == net_load.FORECAST_SEMANTIC_KEYS["1h"]
            and item["day_start"] == start
        )
        self.assertEqual(early_link["effective_as_of"], early_cutoff)
        self.assertFalse(early_link["finalized"])
        identity_projection = dict(early_payload)
        projected_version = identity_projection.pop("content_version")
        self.assertEqual(
            projected_version,
            "v1-"
            + hashlib.sha256(
                net_load.canonical_json(identity_projection).encode()
            ).hexdigest(),
        )

        later_results = net_load.recompute_net_load(
            self.conn,
            net_load.FORECAST_SERIES_KEY,
            start,
            current_ts=end + 21_601,
            dataset_cutoff=later_cutoff,
            horizons=["1h"],
        )
        later_native = next(item for item in later_results if item.get("lod") == "native")
        self.assertEqual(later_native["content_version"], early_native["content_version"])
        later_link = next(
            item
            for item in net_load.net_load_manifest(self.conn, now=later_cutoff)["resources"]
            if item["series_key"] == net_load.FORECAST_SEMANTIC_KEYS["1h"]
            and item["day_start"] == start
        )
        self.assertEqual(later_link["effective_as_of"], later_cutoff)
        self.assertFalse(later_link["finalized"])
        later_bytes = self.conn.execute(
            """
            SELECT payload_json FROM net_load_resources
            WHERE series_key=? AND methodology_version=? AND content_version=?
              AND horizon='1h' AND day_start=? AND lod='native'
            """,
            (
                net_load.FORECAST_SERIES_KEY,
                net_load.METHODOLOGY_VERSION,
                later_native["content_version"],
                start,
            ),
        ).fetchone()[0]
        self.assertEqual(later_bytes, early_bytes)
        self.assertNotIn("effective_as_of", json.loads(later_bytes))
        self.assertNotIn("selection_cutoff", json.loads(later_bytes))

        rows, contributors, policy_cutoff, cutoff = net_load._forecast_rows(
            self.conn, start, end, "1h", end
        )
        self.assertEqual(policy_cutoff, start - 3_600)
        self.assertEqual(cutoff, start - 3_600)
        self.assertEqual(
            {item["vintage_key"] for item in contributors.values()},
            {"v1-load", "rv1-wind", "rv1-solar"},
        )
        self.assertEqual(rows[0]["target_ts"], start)
        self.assertEqual(rows[-1]["target_ts"], end - 3_600)
        self.assertTrue(all(start <= row["target_ts"] < end for row in rows))
        self.assertEqual(rows[0]["ramp_1h_mw"], 1_000)
        self.assertEqual(rows[0]["ramp_3h_mw"], 3_000)

        provisional_early = net_load._resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", start, start - 7_000
        )
        provisional_later = net_load._resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", start, start - 5_000
        )
        self.assertFalse(provisional_early["finalized"])
        self.assertFalse(provisional_later["finalized"])
        self.assertNotIn("effective_as_of", provisional_early)
        self.assertNotIn("selection_cutoff", provisional_early)
        self.assertEqual(
            provisional_early["content_version"], provisional_later["content_version"]
        )

        results = net_load.recompute_net_load(
            self.conn,
            net_load.FORECAST_SERIES_KEY,
            start,
            current_ts=end + 21_601,
            dataset_cutoff=end,
            horizons=["1h"],
        )
        result = next(item for item in results if item.get("lod") == "native")
        self.assertNotIn("?", result["url"])
        resource = net_load.net_load_resource(
            self.conn,
            net_load.FORECAST_SEMANTIC_KEYS["1h"],
            net_load.METHODOLOGY_VERSION,
            result["content_version"],
            start,
            "native",
        )
        self.assertIsNotNone(resource)
        self.assertEqual(
            resource["series_key"],
            "net-load.forecast.latest-capped-1h-before-utc-day",
        )
        self.assertEqual(
            resource["selection_policy"],
            "coherent_whole_curve_latest_capped_before_utc_day",
        )
        self.assertEqual(resource["snapshot_lead_seconds"], 3_600)
        self.assertEqual(resource["policy_cutoff"], start - 3_600)
        self.assertTrue(resource["finalized"])
        unhashed = dict(resource)
        content_version = unhashed.pop("content_version")
        self.assertEqual(
            content_version,
            "v1-" + hashlib.sha256(net_load.canonical_json(unhashed).encode()).hexdigest(),
        )
        daily_result = next(
            item for item in results if item.get("delivery_date") == "2026-01-15"
        )
        self.assertTrue(daily_result["url"].startswith("/api/v2/net-load-daily/"))
        self.assertNotIn("?", daily_result["url"])
        stored_daily = net_load.net_load_daily_resource(
            self.conn,
            net_load.DAILY_FORECAST_SEMANTIC_KEYS["1h"],
            net_load.METHODOLOGY_VERSION,
            daily_result["content_version"],
            "2026-01-15",
        )
        self.assertEqual(stored_daily["kind"], "net_load_daily_ramp")
        daily = net_load._daily_resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", "2026-01-15", end
        )
        self.assertEqual(daily["kind"], "net_load_daily_ramp")
        self.assertEqual(daily["delivery_date"], "2026-01-15")
        self.assertEqual(daily["timezone"], "America/Chicago")
        self.assertIsNotNone(daily["daily_ramp"])

        self.conn.execute(
            "DELETE FROM renewable_forecast_rows WHERE publication_id=3 AND target_ts=?",
            (start + 21_600,),
        )
        incomplete = net_load._resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", start, end
        )
        self.assertFalse(incomplete["complete"])
        self.assertEqual(incomplete["observed_point_count"], 0)
        self.assertEqual(
            incomplete["exclusions"],
            {"missing_solar_publication": incomplete["expected_point_count"]},
        )
        self.assertNotIn("daily_ramp", incomplete)
        incomplete_daily = net_load._daily_resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", "2026-01-15", end
        )
        self.assertFalse(incomplete_daily["complete"])
        self.assertIsNone(incomplete_daily["daily_ramp"])

        future_cutoff = issued + 60
        future = net_load._resource_payload(
            self.conn, net_load.FORECAST_SERIES_KEY, "1h", start, future_cutoff
        )
        self.assertEqual(future["policy_cutoff"], start - 3_600)
        self.assertNotIn("effective_as_of", future)
        self.assertNotIn("selection_cutoff", future)
        self.assertFalse(future["finalized"])

    def test_forecast_bytes_version_and_etag_are_replica_deterministic(self):
        start = int(datetime(2026, 1, 15, tzinfo=timezone.utc).timestamp())
        end = start + 86_400

        def materialize(recompute_time):
            conn = sqlite3.connect(":memory:")
            try:
                forecast_schema(conn)
                net_load.init_net_load_schema(conn)
                issued = start - 8_000
                retrieved = start - 7_900
                conn.execute(
                    "INSERT INTO forecast_publications VALUES (1,?,?,?,?,?)",
                    (
                        net_load.LOAD_SOURCE,
                        net_load.LOAD_PRODUCT,
                        "v1-load",
                        issued,
                        retrieved,
                    ),
                )
                for identifier, source, product, vintage in (
                    (2, net_load.WIND_SOURCE, net_load.WIND_PRODUCT, "rv1-wind"),
                    (3, net_load.SOLAR_SOURCE, net_load.SOLAR_PRODUCT, "rv1-solar"),
                ):
                    conn.execute(
                        "INSERT INTO renewable_forecast_publications VALUES (?,?,?,?,?,?)",
                        (identifier, source, product, vintage, issued, retrieved),
                    )
                for target in range(start - 10_800, end, 3_600):
                    conn.execute(
                        "INSERT INTO forecast_np3_565_rows VALUES (?,?,?,?,?)",
                        (1, target, 1, "A3", 70_000),
                    )
                    conn.execute(
                        "INSERT INTO renewable_forecast_rows VALUES (?,?,?)",
                        (2, target, 10_000),
                    )
                    conn.execute(
                        "INSERT INTO renewable_forecast_rows VALUES (?,?,?)",
                        (3, target, 5_000),
                    )
                results = net_load.recompute_net_load(
                    conn,
                    net_load.FORECAST_SERIES_KEY,
                    start,
                    current_ts=recompute_time,
                    horizons=["1h"],
                )
                native = next(item for item in results if item.get("lod") == "native")
                payload_json = conn.execute(
                    """
                    SELECT payload_json FROM net_load_resources
                    WHERE series_key=? AND methodology_version=? AND content_version=?
                      AND horizon='1h' AND day_start=? AND lod='native'
                    """,
                    (
                        net_load.FORECAST_SERIES_KEY,
                        net_load.METHODOLOGY_VERSION,
                        native["content_version"],
                        start,
                    ),
                ).fetchone()[0]
                body = json.dumps(
                    json.loads(payload_json), sort_keys=True, separators=(",", ":")
                ).encode()
                return native["content_version"], body, f'"{hashlib.sha256(body).hexdigest()}"'
            finally:
                conn.close()

        first = materialize(start - 7_000)
        second = materialize(start - 6_000)
        self.assertEqual(first, second)

    def test_evening_window_is_literal_target_clock_and_dst_days_are_complete(self):
        for delivery_date, expected_count in (("2026-03-08", 23), ("2025-11-02", 25)):
            start, end = net_load._delivery_bounds(delivery_date)
            targets = list(range(start + 3_600, end + 1, 3_600))
            self.assertEqual(len(targets), expected_count)
            rows = []
            for target in targets:
                local = datetime.fromtimestamp(target, net_load.CHICAGO)
                value = 40_000.0
                if local.hour == 16:
                    value = 70_000.0
                elif local.hour == 22:
                    value = 99_000.0
                rows.append({"target_ts": target, "net_load_mw": value})
            rows[0]["net_load_mw"] = 30_000.0

            summary = net_load._daily_ramp(rows, start, end)
            self.assertIsNotNone(summary)
            self.assertTrue(summary["complete_day"])
            peak_local = datetime.fromtimestamp(summary["evening_peak_target_ts"], net_load.CHICAGO)
            self.assertEqual(peak_local.hour, 16)
            self.assertEqual(summary["ramp_mw"], 40_000)

if __name__ == "__main__":
    unittest.main()
