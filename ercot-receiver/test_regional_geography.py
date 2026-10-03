import copy
import sqlite3
import unittest
from datetime import datetime, timezone

import regional_geography as rg
from forecast_vintages import init_forecast_schema, market_hour_target


class RegionalGeographyTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        init_forecast_schema(self.conn)
        rg.init_regional_geography_schema(self.conn)

    def payload(self, product="NP4-742-CD", hours=("01:00", "02:00")):
        contract = rg.CONTRACTS[product]
        issue = int(datetime(2026, 8, 18, 6, tzinfo=timezone.utc).timestamp())
        regions = contract["regions"]
        rows = []
        for index, hour in enumerate(hours):
            region_values = {
                region: {
                    "gen_mw": float(10 + index),
                    "cop_hsl_mw": 20.0,
                    "forecast_mw": 15.0,
                    "resource_plan_mw": 18.0,
                }
                for region in regions
            }
            rows.append({
                "target_ts": market_hour_target("2026-08-18", hour, False),
                "delivery_date": "2026-08-18", "hour_ending": hour, "dst_flag": False,
                "raw_delivery_date": "08/18/2026", "raw_hour_ending": hour[:2], "raw_dst_flag": "N",
                "system": {
                    "gen_mw": float(len(regions) * (10 + index)),
                    "cop_hsl_mw": 100.0, "forecast_mw": float(len(regions) * 15),
                    "resource_plan_mw": float(len(regions) * 18), "system_wide_hsl_mw": 110.0,
                },
                "regions": region_values,
            })
        return {
            "publication": {
                "source_id": contract["source_id"], "product_id": product,
                "publication_key_kind": "official_mis_document", "publication_key": "12345",
                "issued_at": issue, "raw_publish_datetime": "2026-08-18T01:00:00-05:00",
                "document_id": "12345", "constructed_name": "synthetic.csv",
                "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=12345",
                "retrieved_at": issue + 60, "schema_fingerprint": contract["fingerprint"],
                "parser_schema_version": "ercot-mis-regional-v1", "declared_unit": "MW",
            },
            "rows": rows,
        }

    def test_ingest_idempotency_parity_and_resource(self):
        payload = self.payload()
        first = rg.ingest_regional_renewable_publication(self.conn, payload, current_ts=payload["publication"]["retrieved_at"])
        second = rg.ingest_regional_renewable_publication(self.conn, payload, current_ts=payload["publication"]["retrieved_at"] + 1)
        self.assertEqual("inserted", first["status"])
        self.assertEqual("unchanged", second["status"])
        manifest = rg.regional_geography_manifest(self.conn, now=payload["rows"][0]["target_ts"])
        self.assertEqual(["NP4-743-CD", "NP4-746-CD"], manifest["deferred_products"])
        link = next(item for item in manifest["resources"] if item["series_key"] == "regional.wind.panhandle.hourly")
        resource = rg.regional_geography_resource(self.conn, link["series_key"], "v1", link["content_version"], link["tile_start"], "native")
        self.assertEqual([10.0, 11.0], [row["current_mw"] for row in resource["rows"]])
        self.assertEqual([None, 1.0], [row["change_1h_mw"] for row in resource["rows"]])
        self.assertFalse(resource["forecast_error_available"])

    def test_collision_membership_parity_and_null_pattern(self):
        payload = self.payload()
        bad_membership = copy.deepcopy(payload)
        bad_membership["rows"][0]["regions"]["invented"] = bad_membership["rows"][0]["regions"].pop("north")
        bad_parity = copy.deepcopy(payload)
        bad_parity["rows"][0]["system"]["gen_mw"] += 1
        bad_null = copy.deepcopy(payload)
        bad_null["rows"][1]["regions"]["north"]["gen_mw"] = None
        for bad in (bad_membership, bad_parity, bad_null):
            with self.assertRaises(ValueError):
                rg.ingest_regional_renewable_publication(self.conn, bad, current_ts=payload["publication"]["retrieved_at"])
        rg.ingest_regional_renewable_publication(self.conn, payload, current_ts=payload["publication"]["retrieved_at"])
        changed = copy.deepcopy(payload)
        changed["rows"][0]["regions"]["north"]["forecast_mw"] += 1
        with self.assertRaisesRegex(ValueError, "collision"):
            rg.ingest_regional_renewable_publication(self.conn, changed, current_ts=payload["publication"]["retrieved_at"] + 1)

    def test_target_index_and_bounded_prune_requires_materialization(self):
        indexes = {row[1] for row in self.conn.execute("PRAGMA index_list(regional_renewable_hourly_rows)")}
        self.assertIn("idx_regional_hourly_target", indexes)
        plan = " ".join(str(value) for row in self.conn.execute(
            "EXPLAIN QUERY PLAN SELECT publication_id FROM regional_renewable_hourly_rows WHERE target_ts>=? AND target_ts<?",
            (1, 2),
        ) for value in row)
        self.assertIn("idx_regional_hourly_target", plan)
        self.assertEqual(0, rg.prune_regional_publications(self.conn, now=40 * rg.DAY_SECONDS, batch_size=10))

    def test_materialization_health_persists_failure_and_recovery(self):
        rg.record_regional_materialization_health(
            self.conn, False, 100, "load_materialization_failed"
        )
        failed = rg.regional_geography_manifest(self.conn, now=100)[
            "materialization_health"
        ]
        self.assertEqual("failed", failed["state"])
        self.assertEqual(1, failed["consecutive_failures"])
        rg.record_regional_materialization_health(self.conn, True, 101)
        recovered = rg.regional_geography_manifest(self.conn, now=101)[
            "materialization_health"
        ]
        self.assertEqual("healthy", recovered["state"])
        self.assertEqual(0, recovered["consecutive_failures"])
        self.assertEqual(101, recovered["last_success_ts"])

    def test_current_pointer_uses_official_issue_and_doc_order_not_retrieval(self):
        newer = self.payload()
        newer["publication"].update({
            "publication_key": "200", "document_id": "200",
            "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=200",
        })
        older = self.payload()
        older["publication"].update({
            "publication_key": "199", "document_id": "199",
            "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=199",
            "retrieved_at": newer["publication"]["retrieved_at"] + 100,
        })
        rg.ingest_regional_renewable_publication(self.conn, newer, current_ts=older["publication"]["retrieved_at"])
        rg.ingest_regional_renewable_publication(self.conn, older, current_ts=older["publication"]["retrieved_at"])
        document_ids = {row[0] for row in self.conn.execute("""
            SELECT p.document_id FROM regional_geography_current c
            JOIN regional_geography_resources r ON r.series_key=c.series_key
              AND r.content_version=c.content_version AND r.day_start=c.day_start
            JOIN regional_renewable_publications p ON p.vintage_key=json_extract(r.payload_json,'$.source.vintage_key')
        """)}
        self.assertEqual({"200"}, document_ids)

    def test_load_day_materializes_exact_actual_and_coherent_forecast_resources(self):
        day = 1_787_011_200
        self.conn.execute("""
            INSERT INTO forecast_publications
            (id,source_id,product_id,vintage_key,issued_at,published_at,raw_posted_datetime,
             retrieved_at,artifact_href,query_window_json,parser_schema_version,schema_fingerprint,
             declared_unit,content_hash,row_count,created_at,publication_key_kind,publication_key)
            VALUES(1,'actual','NP6-345-CD','v1-actual',NULL,NULL,NULL,?,'https://example.test','{}',
                   'test',?,'MW',?,25,?,'content_hash','actual-1')
        """, (day + 100, "a" * 64, "b" * 64, day + 100))
        self.conn.execute("""
            INSERT INTO forecast_publications
            (id,source_id,product_id,vintage_key,issued_at,published_at,raw_posted_datetime,
             retrieved_at,artifact_href,query_window_json,parser_schema_version,schema_fingerprint,
             declared_unit,content_hash,row_count,created_at,publication_key_kind,publication_key)
            VALUES(2,'forecast','NP3-565-CD','v1-forecast',?,NULL,NULL,?,'https://example.test','{}',
                   'test',?,'MW',?,24,?,'official_posted_datetime','forecast-1')
        """, (day - 3600, day, "c" * 64, "d" * 64, day))
        for index, target in enumerate(range(day - 3600, day + 86400, 3600)):
            self.conn.execute(
                "INSERT INTO forecast_np6_345_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (1, target, "2026-08-18", "01:00", 0, *([10.0 + index] * 8), 8 * (10.0 + index)),
            )
            if target >= day:
                self.conn.execute(
                    "INSERT INTO forecast_np3_565_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (2, target, "2026-08-18", "01:00", 0, "A3", 1, *([12.0 + index] * 8), 8 * (12.0 + index)),
                )
        resources = rg.materialize_load_day(self.conn, day, day + 200)
        self.assertEqual(16, len(resources))
        manifest = rg.regional_geography_manifest(self.conn, now=day + 200)
        actual = next(item for item in manifest["resources"] if item["series_key"] == "regional.load.weather-zone.coast.actual")
        forecast = next(item for item in manifest["resources"] if item["series_key"] == "regional.load.weather-zone.coast.forecast")
        self.assertEqual(day - 3600, forecast["policy_cutoff"])
        self.assertTrue(forecast["finalized"])
        actual_body = rg.regional_geography_resource(self.conn, actual["series_key"], "v1", actual["content_version"], day, "native")
        forecast_body = rg.regional_geography_resource(self.conn, forecast["series_key"], "v1", forecast["content_version"], day, "native")
        self.assertEqual(1.0, actual_body["rows"][0]["change_1h_mw"])
        self.assertEqual(actual_body["rows"][0]["current_mw"] - forecast_body["rows"][0]["forecast_mw"], forecast_body["rows"][0]["forecast_error_mw"])
        self.assertEqual("latest-capped-1h-before-utc-day", forecast_body["selection_policy"])


if __name__ == "__main__":
    unittest.main()
