import json
import hashlib
import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import forecast_quality as fq
import net_load as nl
import server
from forecast_vintages import init_forecast_schema


class NetLoadTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        server.init_db(self.conn)
        init_forecast_schema(self.conn)
        fq.init_forecast_quality_schema(self.conn)
        nl.init_net_load_schema(self.conn)
        self.next_id = 1

    def tearDown(self):
        self.conn.close()

    def metric(self, name, timestamp, value):
        self.conn.execute(
            """
            INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags)
            VALUES(?,?,?,60,'gauge','[]')
            """,
            (name, timestamp, value),
        )

    def realtime_quartet(self, timestamp, demand, wind, solar, published):
        values = {"demand": demand, "wind": wind, "solar": solar, "published": published}
        for key, name in nl.REALTIME_METRICS.items():
            self.metric(name, timestamp, values[key])

    def load_publication(self, issued, retrieved, vintage):
        publication_id = self.next_id
        self.next_id += 1
        self.conn.execute(
            """
            INSERT INTO forecast_publications(
              id,source_id,product_id,vintage_key,issued_at,published_at,
              raw_posted_datetime,retrieved_at,artifact_href,query_window_json,
              parser_schema_version,schema_fingerprint,declared_unit,content_hash,
              row_count,created_at,publication_key_kind,publication_key
            ) VALUES(?,?,?,?,?,NULL,NULL,?,'https://example.test','{}','test',?,'MW',?,1,?,'test',?)
            """,
            (publication_id, nl.LOAD_SOURCE, nl.LOAD_PRODUCT, vintage, issued,
             retrieved, "a" * 64, "b" * 64, retrieved, vintage),
        )
        return publication_id

    def renewable_publication(self, source, product, issued, retrieved, vintage):
        publication_id = self.next_id
        self.next_id += 1
        self.conn.execute(
            """
            INSERT INTO renewable_forecast_publications(
              id,source_id,product_id,vintage_key,publication_key,issued_at,
              raw_publish_datetime,document_id,constructed_name,artifact_href,
              retrieved_at,schema_fingerprint,parser_schema_version,declared_unit,
              content_hash,row_count,created_at
            ) VALUES(?,?,?,?,?,?,'raw','1','name','https://example.test',?,?,'test','MW',?,1,?)
            """,
            (publication_id, source, product, vintage, vintage, issued, retrieved,
             "c" * 64, "d" * 64, retrieved),
        )
        return publication_id

    def test_actual_same_timestamp_formula_ramps_and_storage_is_context_only(self):
        start, end = nl._delivery_bounds("2026-01-15")
        for index in range(37):
            timestamp = start - 10_800 + index * 300
            demand = 100.0 + index
            self.realtime_quartet(timestamp, demand, 20.0, 10.0, demand - 31.0)
        self.metric(nl.STORAGE_METRIC, start, -8.0)
        payload = nl._build_payload(
            self.conn, nl.ACTUAL_SERIES_KEY, "actual", start, end, end,
            kind="net_load_daily_ramp",
        )
        first = payload["rows"][0]
        self.assertEqual(first["net_load_mw"], 106.0)
        self.assertEqual(first["published_residual_mw"], 1.0)
        self.assertEqual(first["storage_net_output_mw"], -8.0)
        self.assertEqual(first["ramp_1h_mw"], 12.0)
        self.assertEqual(first["ramp_3h_mw"], 36.0)
        self.assertEqual(payload["storage_policy"], "context_only_not_in_formula")

    def test_actual_rejects_cross_timestamp_inputs(self):
        start, end = nl._delivery_bounds("2026-01-15")
        self.metric(nl.REALTIME_METRICS["demand"], start, 100)
        self.metric(nl.REALTIME_METRICS["wind"], start + 1, 20)
        self.metric(nl.REALTIME_METRICS["solar"], start, 10)
        self.metric(nl.REALTIME_METRICS["published"], start, 70)
        payload = nl._build_payload(
            self.conn, nl.ACTUAL_SERIES_KEY, "actual", start, end, end,
            kind="net_load_daily_ramp",
        )
        self.assertEqual(payload["rows"][0]["missing_reason"], "missing_same_timestamp_quartet")

    def test_forecast_selects_one_curve_per_product_under_shared_cutoff(self):
        start, end = nl._delivery_bounds("2026-01-15")
        as_of = start - 3_600
        old_load = self.load_publication(as_of - 600, as_of - 500, "load-old")
        selected_load = self.load_publication(as_of, as_of + 10, "load-selected")
        future_load = self.load_publication(as_of + 1, as_of + 20, "load-future")
        wind = self.renewable_publication(
            nl.WIND_SOURCE, nl.WIND_PRODUCT, as_of - 600, as_of - 500, "wind-selected"
        )
        solar = self.renewable_publication(
            nl.SOLAR_SOURCE, nl.SOLAR_PRODUCT, as_of - 600, as_of - 500, "solar-selected"
        )
        for publication, value in ((old_load, 90), (selected_load, 100), (future_load, 999)):
            for hour in range(-2, 25):
                self.conn.execute(
                    """
                    INSERT INTO forecast_np3_565_rows(
                      publication_id,target_ts,delivery_date,hour_ending,dst_flag,
                      model,in_use_flag,system_total
                    ) VALUES(?,?,?,'1:00',0,'A3',1,?)
                    """,
                    (publication, start + hour * 3_600, "2026-01-15", value + hour),
                )
        for publication, value in ((wind, 20), (solar, 10)):
            for hour in range(-2, 25):
                self.conn.execute(
                    """
                    INSERT INTO renewable_forecast_rows(
                      publication_id,target_ts,delivery_date,hour_ending,dst_flag,
                      raw_delivery_date,raw_hour_ending,raw_dst_flag,forecast_mw,actual_hsl_mw
                    ) VALUES(?,?,?,'01:00',0,?,'01:00','N',?,NULL)
                    """,
                    (publication, start + hour * 3_600, "2026-01-15", "2026-01-15", value),
                )
        payload = nl._build_payload(
            self.conn, nl.FORECAST_SERIES_KEY, "1h", start, end, as_of + 30,
            kind="net_load_daily_ramp",
        )
        self.assertEqual(payload["policy_cutoff"], as_of)
        self.assertTrue(payload["finalized"])
        self.assertEqual(payload["contributors"]["load"]["vintage_key"], "load-selected")
        self.assertEqual(payload["rows"][0]["net_load_mw"], 71.0)
        self.assertEqual(payload["rows"][1]["ramp_1h_mw"], 1.0)
        self.assertEqual(payload["rows"][0]["ramp_1h_mw"], 1.0)
        self.assertEqual(payload["rows"][0]["ramp_3h_mw"], 3.0)
        self.assertTrue(payload["complete"])
        provisional_one = nl._build_payload(
            self.conn,
            nl.FORECAST_SERIES_KEY,
            "1h",
            start,
            end,
            as_of - 400,
            kind="net_load_daily_ramp",
        )
        provisional_two = nl._build_payload(
            self.conn,
            nl.FORECAST_SERIES_KEY,
            "1h",
            start,
            end,
            as_of - 300,
            kind="net_load_daily_ramp",
        )
        self.assertFalse(provisional_one["finalized"])
        self.assertEqual(
            provisional_one["content_version"], provisional_two["content_version"]
        )

    def test_chicago_day_lengths_and_evening_ties(self):
        self.assertEqual(nl._delivery_bounds("2026-03-08")[1] - nl._delivery_bounds("2026-03-08")[0], 82_800)
        self.assertEqual(nl._delivery_bounds("2025-11-02")[1] - nl._delivery_bounds("2025-11-02")[0], 90_000)
        start, end = nl._delivery_bounds("2026-01-15")
        points = [
            {"target_ts": start + 12 * 3_600, "net_load_mw": 40.0},
            {"target_ts": start + 17 * 3_600, "net_load_mw": 80.0},
            {"target_ts": start + 18 * 3_600, "net_load_mw": 80.0},
        ]
        summary = nl._daily_ramp(points, start, end)
        self.assertEqual(summary["minimum_target_ts"], start + 12 * 3_600)
        self.assertEqual(summary["evening_peak_target_ts"], start + 17 * 3_600)
        self.assertEqual(summary["ramp_mw"], 40.0)

    def test_content_version_is_idempotent_and_old_bytes_remain(self):
        start, end = nl._delivery_bounds("2026-01-15")
        day_start = (start // 86_400) * 86_400
        day_end = day_start + 86_400
        self.realtime_quartet(day_start, 100, 20, 10, 69)
        first = nl.recompute_net_load(
            self.conn, nl.ACTUAL_SERIES_KEY, day_start,
            current_ts=day_end + 100, dataset_cutoff=day_end,
        )[0]
        second = nl.recompute_net_load(
            self.conn, nl.ACTUAL_SERIES_KEY, day_start,
            current_ts=day_end + 200, dataset_cutoff=day_end + 1,
        )[0]
        self.assertEqual(first["content_version"], second["content_version"])
        original = nl.net_load_resource(
            self.conn, nl.ACTUAL_SERIES_KEY, "v1", first["content_version"],
            day_start, "native",
        )
        identity = dict(original)
        identity.pop("content_version")
        self.assertEqual(
            first["content_version"],
            "v1-" + hashlib.sha256(nl.canonical_json(identity).encode()).hexdigest(),
        )
        self.realtime_quartet(day_start + 300, 120, 20, 10, 89)
        corrected = nl.recompute_net_load(
            self.conn, nl.ACTUAL_SERIES_KEY, day_start,
            current_ts=day_end + 300, dataset_cutoff=day_end + 2,
        )[0]
        self.assertNotEqual(first["content_version"], corrected["content_version"])
        self.assertEqual(
            original,
            nl.net_load_resource(
                self.conn, nl.ACTUAL_SERIES_KEY, "v1", first["content_version"],
                day_start, "native",
            ),
        )

    def test_manifest_is_completed_bounded_and_canonical(self):
        start, end = nl._delivery_bounds("2026-01-15")
        day_start = (start // 86_400) * 86_400
        day_end = day_start + 86_400
        nl.recompute_net_load(
            self.conn, nl.ACTUAL_SERIES_KEY, day_start,
            current_ts=day_end + 100, dataset_cutoff=day_end,
        )
        manifest = nl.net_load_manifest(self.conn, now=day_end + 100)
        self.assertEqual(manifest["formula"], "demand_mw - wind_mw - solar_mw")
        self.assertEqual(len(manifest["resources"]), 1)
        self.assertRegex(manifest["resources"][0]["url"], r"^/api/v2/net-load/")


if __name__ == "__main__":
    unittest.main()
