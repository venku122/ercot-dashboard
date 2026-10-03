import sqlite3
import unittest
from datetime import datetime

from market_geography import (
    DISPLAY_POINTS,
    ingest_market_geography_publication,
    init_market_geography_schema,
    market_geography_manifest,
    market_geography_resource,
    market_interval_target_ts,
    sced_target_ts,
)


PRODUCT = {
    "NP6-788-CD": (
        "ercot_mis_np6_788",
        "2ab04e739fba30bc2ee527b4927af212669c8932056745ddfe3bdad29e80ce9c",
        "cdr.00012300.0000000000000000.20260818.123500000.LMPSROSNODENP6788_20260818_123456_csv.zip",
    ),
    "NP6-905-CD": (
        "ercot_mis_np6_905",
        "4e6f1ec046967794271f9fd4c2f880b0382f561502c24e0f883aa0be0cc21974",
        "cdr.00012301.0000000000000000.20260818.123500000.SPPHLZNP6905_20260818_1249_csv.zip",
    ),
    "NP6-86-CD": (
        "ercot_mis_np6_86",
        "732f368c6be8e87cb0806a57c5ac510b4944011ea22c72bf354de0c48bd89ee7",
        "cdr.00012302.0000000000000000.20260818.123500000.SCEDBTCNP686_csv.zip",
    ),
}


def payload(product, document, rows, retrieved):
    source, fingerprint, constructed = PRODUCT[product]
    raw_publish = "2026-08-18T12:35:00-05:00"
    issued = int(datetime.fromisoformat(raw_publish).timestamp())
    return {
        "publication": {
            "source_id": source,
            "product_id": product,
            "publication_key_kind": "official_mis_document",
            "publication_key": document,
            "issued_at": issued,
            "retrieved_at": retrieved,
            "raw_publish_datetime": raw_publish,
            "document_id": document,
            "constructed_name": constructed,
            "artifact_href": f"https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={document}",
            "schema_fingerprint": fingerprint,
            "parser_schema_version": "ercot-market-geography-v1",
        },
        "rows": rows,
    }


def lmp_rows():
    raw = "08/18/2026 12:34:56"
    target = sced_target_ts(raw, False)
    return [
        {
            "raw_sced_timestamp": raw,
            "repeated_hour_flag": False,
            "target_ts": target,
            "settlement_point": point,
            "lmp": float(index + 1),
        }
        for index, (point, _kind) in enumerate(DISPLAY_POINTS)
    ]


def price_rows():
    target = market_interval_target_ts("08/18/2026", 13, 2, False)
    return [
        {
            "raw_delivery_date": "08/18/2026",
            "delivery_hour": 13,
            "delivery_interval": 2,
            "raw_dst_flag": "N",
            "repeated_hour_flag": False,
            "target_ts": target,
            "settlement_point": point,
            "settlement_point_type": point_type,
            "settlement_point_price": float(index - 4),
        }
        for index, (point, point_type) in enumerate(DISPLAY_POINTS)
    ]


def constraint_rows():
    raw = "08/18/2026 12:34:56"
    return [
        {
            "raw_sced_timestamp": raw,
            "repeated_hour_flag": False,
            "target_ts": sced_target_ts(raw, False),
            "constraint_id": "42",
            "constraint_name": "MONITORED ELEMENT",
            "contingency_name": "CONTINGENCY",
            "shadow_price": 75.5,
            "max_shadow_price": 9001.0,
            "limit_mw": 1000.0,
            "value_mw": 1005.0,
            "violated_mw": 5.0,
            "from_station": "FROM",
            "to_station": "TO",
            "from_station_kv": 345.0,
            "to_station_kv": 345.0,
            "cct_status": "COMP",
        }
    ]


class MarketGeographyTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        init_market_geography_schema(self.conn)
        self.current = sced_target_ts("08/18/2026 12:40:00", False)

    def tearDown(self):
        self.conn.close()

    def ingest_all(self, current=None):
        current = self.current if current is None else current
        for product, document, rows in (
            ("NP6-788-CD", "1001", lmp_rows()),
            ("NP6-905-CD", "1002", price_rows()),
            ("NP6-86-CD", "1003", constraint_rows()),
        ):
            ingest_market_geography_publication(
                self.conn, payload(product, document, rows, current), current_ts=current
            )

    def test_current_manifest_is_coherent_and_noncausal(self):
        self.ingest_all()
        manifest = market_geography_manifest(self.conn, now=self.current)
        self.assertEqual(manifest["settlement_interval"]["state"], "available")
        self.assertEqual(len(manifest["settlement_interval"]["rows"]), 13)
        self.assertEqual(len(manifest["settlement_interval"]["reference_prices"]), 2)
        self.assertEqual(manifest["constraints"]["state"], "available")
        self.assertEqual(
            manifest["constraints"]["target_ts"], manifest["lmp_snapshot"]["target_ts"]
        )
        self.assertEqual(
            manifest["constraints"]["attribution_status"],
            "unavailable_without_shift_factors",
        )
        self.assertEqual(manifest["resources"], [])

    def test_completed_day_seals_and_replay_is_idempotent(self):
        completed_now = self.current + 86_400
        self.ingest_all(completed_now)
        manifest = market_geography_manifest(self.conn, now=completed_now)
        self.assertGreaterEqual(len(manifest["resources"]), 31)
        link = next(item for item in manifest["resources"] if item["kind"] == "prices")
        resource = market_geography_resource(
            self.conn,
            link["kind"],
            link["identity"],
            "v1",
            link["content_version"],
            link["tile_start"],
            "native",
        )
        self.assertEqual(resource["content_version"], link["content_version"])
        before = self.conn.execute("SELECT COUNT(*) FROM market_geography_resources").fetchone()[0]
        result = ingest_market_geography_publication(
            self.conn,
            payload("NP6-788-CD", "1001", lmp_rows(), completed_now),
            current_ts=completed_now,
        )
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM market_geography_resources").fetchone()[0],
            before,
        )

    def test_nearest_constraint_timestamp_is_not_joined(self):
        self.ingest_all()
        self.conn.execute("DELETE FROM market_geography_constraint_rows")
        self.conn.commit()
        shifted = constraint_rows()
        shifted[0]["raw_sced_timestamp"] = "08/18/2026 12:35:00"
        shifted[0]["target_ts"] = sced_target_ts(shifted[0]["raw_sced_timestamp"], False)
        ingest_market_geography_publication(
            self.conn,
            payload("NP6-86-CD", "1004", shifted, self.current),
            current_ts=self.current,
        )
        manifest = market_geography_manifest(self.conn, now=self.current)
        self.assertEqual(manifest["constraints"]["state"], "unavailable_no_exact_sced")

    def test_durable_official_document_gap_is_delayed_not_healthy(self):
        self.conn.execute(
            """CREATE TABLE collector_sources(
              source_id TEXT PRIMARY KEY,last_success_ts INTEGER,data_timestamp_ts INTEGER,
              consecutive_failures INTEGER,last_error TEXT,availability_status TEXT,
              expected_interval_seconds INTEGER,diagnostics_json TEXT)"""
        )
        for source_id, _fingerprint, _constructed in PRODUCT.values():
            self.conn.execute(
                "INSERT INTO collector_sources VALUES(?,?,?,?,?,?,?,?)",
                (
                    source_id,
                    self.current,
                    self.current,
                    0,
                    None,
                    "available",
                    300,
                    '{"gap_count":1}',
                ),
            )
        manifest = market_geography_manifest(self.conn, now=self.current)
        self.assertTrue(all(item["state"] == "delayed" for item in manifest["source_health"]))
        self.assertTrue(all(item["gap_count"] == 1 for item in manifest["source_health"]))
        self.assertTrue(
            all(item["last_error"] == "document_gap" for item in manifest["source_health"])
        )


if __name__ == "__main__":
    unittest.main()
