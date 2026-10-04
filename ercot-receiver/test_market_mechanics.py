import copy
import sqlite3
import unittest
from datetime import datetime, timezone

import market_mechanics as mm


class MarketMechanicsTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        mm.init_market_mechanics_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def payload(self, product="NP6-322-CD"):
        contract = mm.CONTRACTS[product]
        raw = "08/18/2026 11:40:18"
        row = {"target_ts": mm.sced_timestamp(raw, False), "raw_sced_timestamp": raw,
               "repeated_hour_flag": False, "values": {field: float(index + 1) for index, field in enumerate(contract["fields"])}}
        if product == "NP6-332-CD":
            row["as_type"] = "ECRS"
        constructed = {
            "NP6-322-CD": "cdr.00013114.0000000000000000.20260818.114100000.SCEDSYSLAMBDANP6322_20260818_114100_csv.zip",
            "NP6-323-CD": "cdr.00013221.0000000000000000.20260818.114100000.RTSCEDpriceAdderNP6323_20260818_114100_csv.zip",
            "NP6-328-CD": "cdr.00024887.0000000000000000.20260818.114100000.TotASResCapabilityNP6328_20260818_114100_csv.zip",
            "NP6-332-CD": "cdr.00024891.0000000000000000.20260818.114100000.SCEDMCPCNP6332_csv.zip",
        }[product]
        return {"publication": {"source_id": contract["source"], "product_id": product,
                 "publication_key_kind": "official_mis_document", "publication_key": "12345",
                 "issued_at": int(datetime(2026,8,18,16,41,tzinfo=timezone.utc).timestamp()),
                 "retrieved_at": int(datetime(2026,8,18,16,42,tzinfo=timezone.utc).timestamp()),
                 "raw_publish_datetime": "2026-08-18T11:41:00-05:00", "document_id": "12345",
                 "constructed_name": constructed,
                 "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=12345",
                 "schema_fingerprint": contract["fingerprint"], "parser_schema_version": "ercot-mis-market-v1"},
                "rows": [row]}

    def test_split_revision_retires_obsolete_basis_pointer_but_preserves_bytes(self):
        payload = self.payload()
        now = payload["publication"]["retrieved_at"] + mm.DAY
        mm.ingest_market_mechanics_publication(self.conn, payload, now)
        old = mm.market_mechanics_manifest(self.conn, now)["resources"][0]
        correction = copy.deepcopy(payload)
        correction["publication"].update({"document_id": "12346", "publication_key": "12346", "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=12346", "schema_fingerprint": "4fc27af4f517fec6a81e3f2a280330e78a87eb9befae022842784df38090c583"})
        correction["rows"][0]["values"] = {"CappedSystemLambda": 1.25, "UncappedSystemLambda": 2.5}
        mm.ingest_market_mechanics_publication(self.conn, correction, now)
        keys = {r["series_key"] for r in mm.market_mechanics_manifest(self.conn, now)["resources"]}
        self.assertEqual({"market.sced.system-lambda.capped", "market.sced.system-lambda.uncapped"}, keys)
        self.assertIsNotNone(mm.market_mechanics_resource(self.conn, old["series_key"], "v1", old["content_version"], old["tile_start"], "native"))

    def test_split_snapshot_keeps_parity_unverified_and_transition_deltas_null(self):
        for current in (False, True):
            for product in mm.CONTRACTS:
                payload = self.payload(product)
                if product == "NP6-332-CD":
                    payload["rows"] = [dict(payload["rows"][0], as_type=value) for value in mm.AS_TYPES]
                if not current:
                    for row in payload["rows"]:
                        row["raw_sced_timestamp"] = "08/18/2026 11:35:18"
                        row["target_ts"] -= 300
                else:
                    payload["publication"].update({"document_id": "12346", "publication_key": "12346", "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=12346"})
                    split = mm.SPLIT_CONTRACTS.get(product)
                    if split:
                        payload["publication"]["schema_fingerprint"] = split["fingerprint"]
                        for row in payload["rows"]:
                            row["values"] = dict(zip(split["fields"], (1.25, 2.5)))
                now = payload["publication"]["retrieved_at"] + mm.DAY
                mm.ingest_market_mechanics_publication(self.conn, payload, now)
        manifest = mm.market_mechanics_manifest(self.conn, now)
        self.assertEqual(37, len(manifest["current"]["readings"]))
        self.assertEqual("unavailable_unverified_basis", manifest["current"]["lambda_parity"]["state"])
        self.assertIsNone(manifest["current"]["lambda_parity"]["delta"])
        self.assertIsNone(manifest["factors"]["energy_signal"])
        self.assertEqual(1.25, manifest["factors"]["capped_energy_signal"]["value"])
        self.assertIsNone(manifest["changes"]["market.sced.system-lambda.capped"]["delta"])
        self.assertEqual(0, manifest["changes"]["market.sced.price-adder.energy"]["delta"])

    def test_capped_uncapped_delivery_keeps_legacy_and_current_basis_separate(self):
        for product, fields, fingerprint in [
            ("NP6-322-CD", ("CappedSystemLambda", "UncappedSystemLambda"), "4fc27af4f517fec6a81e3f2a280330e78a87eb9befae022842784df38090c583"),
            ("NP6-332-CD", ("CappedMCPC", "UncappedMCPC"), "762059006d9754916ddc2c4c91a7a26c05d9cbfae9574e4dacfe2421e5763a28"),
        ]:
            payload = self.payload(product)
            payload["publication"]["schema_fingerprint"] = fingerprint
            payload["rows"][0]["values"] = dict(zip(fields, (1.25, 2.5)))
            if product == "NP6-332-CD":
                payload["rows"] = [dict(payload["rows"][0], as_type=value) for value in mm.AS_TYPES]
            now = payload["publication"]["retrieved_at"] + mm.DAY
            mm.ingest_market_mechanics_publication(self.conn, payload, now)
            links = [link for link in mm.market_mechanics_manifest(self.conn, now)["resources"] if link["series_key"].startswith("market.sced.system-lambda" if product == "NP6-322-CD" else "market.sced.as-mcpc")]
            self.assertEqual(2 if product == "NP6-322-CD" else 10, len(links))
            for link in links:
                body = mm.market_mechanics_resource(self.conn, link["series_key"], "v1", link["content_version"], link["tile_start"], "native")
                self.assertEqual(2.5 if ".uncapped" in link["series_key"] else 1.25, body["rows"][0]["value"])
                self.assertEqual("$/MWh" if product == "NP6-322-CD" else "$/MW", body["unit"])
            bad = copy.deepcopy(payload)
            bad["publication"]["schema_fingerprint"] = mm.CONTRACTS[product]["fingerprint"]
            with self.assertRaises(ValueError):
                mm.ingest_market_mechanics_publication(self.conn, bad, now)

    def test_idempotent_ingest_resource_and_collision(self):
        payload = self.payload()
        now = payload["publication"]["retrieved_at"] + mm.DAY
        first = mm.ingest_market_mechanics_publication(self.conn, payload, now)
        second = mm.ingest_market_mechanics_publication(self.conn, payload, now + 1)
        self.assertEqual(("inserted", "unchanged"), (first["status"], second["status"]))
        manifest = mm.market_mechanics_manifest(self.conn, now)
        link = manifest["resources"][0]
        body = mm.market_mechanics_resource(self.conn, link["series_key"], "v1", link["content_version"], link["tile_start"], "native")
        self.assertEqual(1.0, body["rows"][0]["value"])
        changed = copy.deepcopy(payload)
        changed["rows"][0]["values"]["SystemLambda"] = 2
        with self.assertRaisesRegex(ValueError, "collision"):
            mm.ingest_market_mechanics_publication(self.conn, changed, now + 2)

    def test_repeated_hour_and_contract_guards(self):
        first = mm.sced_timestamp("11/02/2025 01:30:00", False)
        repeated = mm.sced_timestamp("11/02/2025 01:30:00", True)
        self.assertEqual(3600, repeated - first)
        with self.assertRaises(ValueError):
            mm.sced_timestamp("08/18/2026 11:40:18", True)
        bad = self.payload("NP6-323-CD")
        bad["rows"][0]["values"].pop("RTRDPA")
        with self.assertRaises(ValueError):
            mm.ingest_market_mechanics_publication(self.conn, bad, bad["publication"]["retrieved_at"])

    def test_day_bytes_are_stable_across_ingest_order_and_retrieval_time(self):
        first = self.payload()
        second = copy.deepcopy(first)
        second["publication"].update({
            "publication_key": "12346",
            "document_id": "12346",
            "issued_at": first["publication"]["issued_at"] + 300,
            "retrieved_at": first["publication"]["retrieved_at"] + 300,
            "raw_publish_datetime": "2026-08-18T11:46:00-05:00",
            "artifact_href": "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=12346",
        })
        raw = "08/18/2026 11:45:02"
        second["rows"][0].update({
            "target_ts": mm.sced_timestamp(raw, False),
            "raw_sced_timestamp": raw,
        })

        bodies = []
        for reverse in (False, True):
            conn = sqlite3.connect(":memory:")
            mm.init_market_mechanics_schema(conn)
            payloads = [copy.deepcopy(first), copy.deepcopy(second)]
            if reverse:
                payloads.reverse()
                for payload in payloads:
                    payload["publication"]["retrieved_at"] += 120
            for offset, payload in enumerate(payloads):
                mm.ingest_market_mechanics_publication(
                    conn, payload, payload["publication"]["retrieved_at"] + mm.DAY + offset
                )
            link = next(
                item for item in mm.market_mechanics_manifest(conn, second["publication"]["retrieved_at"] + mm.DAY + 300)["resources"]
                if item["series_key"] == "market.sced.system-lambda"
            )
            bodies.append(mm.market_mechanics_resource(
                conn, link["series_key"], "v1", link["content_version"], link["tile_start"], "native"
            ))
            conn.close()
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(bodies[0]["content_version"], bodies[1]["content_version"])


if __name__ == "__main__":
    unittest.main()
