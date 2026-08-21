#!/usr/bin/env python3
"""Independent domain acceptance for PR15 market geography."""

from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest

import market_geography as mg
import server


NOW = int(datetime(2026, 8, 20, 18, tzinfo=timezone.utc).timestamp())
CURRENT_SCED = "08/20/2026 12:40:18"
CURRENT_SCED_TS = mg.sced_target_ts(CURRENT_SCED, False)
PRIOR_SCED = "08/19/2026 12:40:18"
PRIOR_SCED_TS = mg.sced_target_ts(PRIOR_SCED, False)

CONSTRUCTED_NAMES = {
    "NP6-788-CD": (
        "cdr.00012300.0000000000000000.20260820.124100000."
        "LMPSROSNODENP6788_20260820_124018_csv.zip"
    ),
    "NP6-905-CD": (
        "cdr.00012301.0000000000000000.20260820.124600000."
        "SPPHLZNP6905_20260820_1245_csv.zip"
    ),
    "NP6-86-CD": (
        "cdr.00012302.0000000000000000.20260820.130000000."
        "SCEDBTCNP686_csv.zip"
    ),
}


class MarketGeographyDomainAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        mg.init_market_geography_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def publication(self, product, rows, document_id, issued_at=None):
        issued_at = NOW - 600 if issued_at is None else issued_at
        contract = mg.CONTRACTS[product]
        raw_publish = datetime.fromtimestamp(issued_at, timezone.utc).astimezone(
            mg.CHICAGO
        ).isoformat(timespec="seconds")
        return {
            "publication": {
                "source_id": contract["source"],
                "product_id": product,
                "publication_key_kind": "official_mis_document",
                "publication_key": str(document_id),
                "issued_at": issued_at,
                "retrieved_at": issued_at + 30,
                "raw_publish_datetime": raw_publish,
                "document_id": str(document_id),
                "constructed_name": CONSTRUCTED_NAMES[product],
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    f"?doclookupId={document_id}"
                ),
                "schema_fingerprint": contract["fingerprint"],
                "parser_schema_version": contract["parser"],
            },
            "rows": rows,
        }

    def lmp_rows(self, raw=CURRENT_SCED, base=1.0):
        target = mg.sced_target_ts(raw, False)
        return [
            {
                "raw_sced_timestamp": raw,
                "repeated_hour_flag": False,
                "target_ts": target,
                "settlement_point": point,
                "lmp": float(base + index),
            }
            for index, (point, _point_type) in enumerate(mg.DISPLAY_POINTS)
        ]

    def price_rows(self, raw_date="08/20/2026", base=-10.0):
        target = mg.market_interval_target_ts(raw_date, 13, 1, False)
        return [
            {
                "raw_delivery_date": raw_date,
                "delivery_hour": 13,
                "delivery_interval": 1,
                "raw_dst_flag": "N",
                "repeated_hour_flag": False,
                "target_ts": target,
                "settlement_point": point,
                "settlement_point_type": point_type,
                "settlement_point_price": float(base + index * 20),
            }
            for index, (point, point_type) in enumerate(mg.DISPLAY_POINTS)
        ]

    def constraint_rows(self, raw=CURRENT_SCED, count=3):
        target = mg.sced_target_ts(raw, False)
        return [
            {
                "raw_sced_timestamp": raw,
                "repeated_hour_flag": False,
                "target_ts": target,
                "constraint_id": str(100 + index),
                "constraint_name": f"Constraint {index}",
                "contingency_name": f"Contingency {index}",
                "shadow_price": float(50 - index * 10),
                "max_shadow_price": float(75 - index * 10),
                "limit_mw": float(1_000 + index),
                "value_mw": float(990 + index),
                "violated_mw": float(index),
                "from_station": f"FROM {index}",
                "to_station": f"TO {index}",
                "from_station_kv": 345.0,
                "to_station_kv": 345.0,
                "cct_status": "COMP" if index % 2 == 0 else "NONCOMP",
            }
            for index in range(count)
        ]

    def ingest(self, product, rows, document_id, issued_at=None, now=NOW):
        return mg.ingest_market_geography_publication(
            self.conn,
            self.publication(product, rows, document_id, issued_at),
            current_ts=now,
        )

    def test_manifest_separates_13_cell_matrix_two_references_and_exact_sced_constraints(self):
        self.ingest("NP6-905-CD", self.price_rows(), 101)
        self.ingest("NP6-788-CD", self.lmp_rows(), 102, NOW - 500)
        self.ingest("NP6-86-CD", self.constraint_rows(), 103, NOW - 400)

        manifest = mg.market_geography_manifest(self.conn, now=NOW)
        prices = manifest["settlement_interval"]
        self.assertEqual("available", prices["state"])
        self.assertEqual(13, len(prices["rows"]))
        self.assertEqual(2, len(prices["reference_prices"]))
        self.assertEqual([], prices["missing"])
        self.assertEqual(
            set(mg.HEATMAP_POINTS),
            {
                (row["settlement_point"], row["settlement_point_type"])
                for row in prices["rows"]
            },
        )
        self.assertEqual(
            set(mg.REFERENCE_POINTS),
            {
                (row["settlement_point"], row["settlement_point_type"])
                for row in prices["reference_prices"]
            },
        )

        lmp = manifest["lmp_snapshot"]
        self.assertEqual("available", lmp["state"])
        self.assertEqual(CURRENT_SCED_TS, lmp["target_ts"])
        self.assertEqual(15, len(lmp["rows"]))

        constraints = manifest["constraints"]
        self.assertEqual("available", constraints["state"])
        self.assertEqual(CURRENT_SCED_TS, constraints["target_ts"])
        self.assertTrue(
            all(row["target_ts"] == CURRENT_SCED_TS for row in constraints["rows"])
        )
        self.assertEqual(
            [50.0, 40.0, 30.0],
            [row["shadow_price"] for row in constraints["rows"]],
        )
        self.assertEqual(
            "unavailable_without_shift_factors", manifest["attribution_status"]
        )
        self.assertEqual(
            "coincident_constraint_not_point_price_attribution",
            manifest["attribution_policy"],
        )
        encoded = json.dumps(manifest, sort_keys=True).lower()
        for forbidden in (
            "caused_by",
            "contribution_percent",
            "calculated_price",
            "price_decomposition",
        ):
            self.assertNotIn(forbidden, encoded)

    def test_latest_partial_price_publication_does_not_borrow_older_points(self):
        self.ingest("NP6-905-CD", self.price_rows(), 201, NOW - 700)
        partial = [
            row
            for row in self.price_rows(base=100.0)
            if not (
                row["settlement_point"] == "LZ_WEST"
                and row["settlement_point_type"] == "LZ"
            )
        ]
        self.ingest("NP6-905-CD", partial, 202, NOW - 500)

        prices = mg.market_geography_manifest(self.conn, now=NOW)[
            "settlement_interval"
        ]
        self.assertEqual("partial", prices["state"])
        self.assertEqual(12, len(prices["rows"]))
        self.assertEqual(2, len(prices["reference_prices"]))
        self.assertEqual(["LZ_WEST--LZ"], prices["missing"])
        self.assertTrue(all(row["value"] >= 100 for row in prices["rows"]))

    def test_constraints_require_exact_lmp_sced_and_never_use_nearest_rows(self):
        self.ingest("NP6-788-CD", self.lmp_rows(), 301)
        self.ingest(
            "NP6-86-CD",
            self.constraint_rows("08/20/2026 12:35:18"),
            302,
            NOW - 500,
        )
        constraints = mg.market_geography_manifest(self.conn, now=NOW)["constraints"]
        self.assertEqual("unavailable_no_exact_sced", constraints["state"])
        self.assertEqual(CURRENT_SCED_TS, constraints["target_ts"])
        self.assertEqual([], constraints["rows"])

    def test_partial_lmp_snapshot_is_not_labeled_available_or_filled_from_older_run(self):
        self.ingest("NP6-788-CD", self.lmp_rows(), 351, NOW - 700)
        partial = [
            row
            for row in self.lmp_rows(base=100.0)
            if row["settlement_point"] != "LZ_WEST"
        ]
        self.ingest("NP6-788-CD", partial, 352, NOW - 500)

        lmp = mg.market_geography_manifest(self.conn, now=NOW)["lmp_snapshot"]
        self.assertEqual("partial", lmp["state"])
        self.assertEqual(14, len(lmp["rows"]))
        self.assertEqual(["LZ_WEST"], lmp["missing"])
        self.assertTrue(all(row["value"] >= 100 for row in lmp["rows"]))

    def test_completed_day_correction_changes_only_new_version_and_preserves_old_bytes(self):
        prior_rows = self.price_rows("08/19/2026", base=1.0)
        self.ingest("NP6-905-CD", prior_rows, 401, NOW - 700)
        old_link = next(
            item
            for item in mg.market_geography_manifest(self.conn, now=NOW)["resources"]
            if item["kind"] == "prices" and item["identity"] == "HB_HOUSTON--HU"
        )
        old_body = mg.market_geography_resource(
            self.conn,
            old_link["kind"],
            old_link["identity"],
            "v1",
            old_link["content_version"],
            old_link["tile_start"],
            "native",
        )

        correction = self.price_rows("08/19/2026", base=1.0)
        corrected = next(
            row for row in correction if row["settlement_point"] == "HB_HOUSTON"
        )
        corrected["settlement_point_price"] = 999.0
        self.ingest("NP6-905-CD", correction, 402, NOW - 500)
        new_link = next(
            item
            for item in mg.market_geography_manifest(self.conn, now=NOW)["resources"]
            if item["kind"] == "prices" and item["identity"] == "HB_HOUSTON--HU"
        )
        self.assertNotEqual(old_link["content_version"], new_link["content_version"])
        self.assertEqual(
            old_body,
            mg.market_geography_resource(
                self.conn,
                old_link["kind"],
                old_link["identity"],
                "v1",
                old_link["content_version"],
                old_link["tile_start"],
                "native",
            ),
        )
        new_body = mg.market_geography_resource(
            self.conn,
            new_link["kind"],
            new_link["identity"],
            "v1",
            new_link["content_version"],
            new_link["tile_start"],
            "native",
        )
        self.assertEqual(999.0, new_body["rows"][0]["value"])
        self.assertEqual(1, len(old_body["rows"]))

    def test_300_current_snapshots_create_no_immutable_resources_then_rollover_once(self):
        day_start = CURRENT_SCED_TS // mg.DAY * mg.DAY
        for index in range(300):
            raw = datetime.fromtimestamp(
                day_start + 60 + index * 60, mg.CHICAGO
            ).strftime("%m/%d/%Y %H:%M:%S")
            self.ingest(
                "NP6-788-CD",
                self.lmp_rows(raw, float(index)),
                10_000 + index,
                NOW - 600,
            )
        self.assertEqual(
            0,
            self.conn.execute(
                "SELECT COUNT(*) FROM market_geography_resources"
            ).fetchone()[0],
        )
        first = mg.materialize_market_geography_day(
            self.conn, day_start, current_ts=NOW + mg.DAY
        )
        first_count = self.conn.execute(
            "SELECT COUNT(*) FROM market_geography_resources"
        ).fetchone()[0]
        second = mg.materialize_market_geography_day(
            self.conn, day_start, current_ts=NOW + mg.DAY + 1
        )
        self.assertEqual(15, len(first))
        self.assertEqual(15, len(second))
        self.assertEqual(
            first_count,
            self.conn.execute(
                "SELECT COUNT(*) FROM market_geography_resources"
            ).fetchone()[0],
        )

    def test_dst_and_raw_target_provenance_are_recomputed_not_trusted(self):
        first = mg.sced_target_ts("11/02/2025 01:30:18", False)
        repeated = mg.sced_target_ts("11/02/2025 01:30:18", True)
        self.assertEqual(3_600, repeated - first)
        with self.assertRaisesRegex(ValueError, "invalid_market_geography_timestamp"):
            mg.sced_target_ts("03/08/2026 02:30:18", False)

        payload = self.publication("NP6-788-CD", self.lmp_rows(), 501)
        payload["rows"][0]["target_ts"] += 1
        with self.assertRaisesRegex(ValueError, "invalid_market_geography_target"):
            mg.ingest_market_geography_publication(
                self.conn, payload, current_ts=NOW
            )

        bad_publish = self.publication("NP6-788-CD", self.lmp_rows(), 502)
        bad_publish["publication"]["raw_publish_datetime"] = "2026-08-20T17:50:00Z"
        with self.assertRaisesRegex(ValueError, "invalid_market_geography_provenance"):
            mg.ingest_market_geography_publication(
                self.conn, bad_publish, current_ts=NOW
            )


class MarketGeographyHttpAcceptanceTests(unittest.TestCase):
    price_rows = MarketGeographyDomainAcceptanceTests.price_rows
    publication = MarketGeographyDomainAcceptanceTests.publication

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        self.old_api_key = server.API_KEY
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: NOW
        server.API_KEY = "market-geography-acceptance-key"
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "MarketGeographyAcceptanceServer",
            (),
            {
                "cache": server.Cache(128),
                "cache_metrics": server.defaultdict(float),
                "cache_metrics_lock": threading.Lock(),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        server.DB_PATH = self.old_db_path
        server.DB_LOCAL = self.old_db_local
        server.now_ts = self.old_now_ts
        server.API_KEY = self.old_api_key
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            **(headers or {}),
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(
            handler, "response_status", status
        )
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(
            name, value
        )
        handler.end_headers = lambda: None
        try:
            getattr(handler, f"do_{method}")()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def post(self, payload, authenticated=True):
        headers = {"X-API-Key": server.API_KEY} if authenticated else {}
        return self.request(
            "POST", "/api/market-geography-publications/ingest", payload, headers
        )

    def get(self, path, headers=None):
        return self.request("GET", path, headers=headers)

    def test_auth_queryless_manifest_etag_and_ingest_invalidation(self):
        payload = self.publication(
            "NP6-905-CD", self.price_rows(), 601, NOW - 600
        )
        status, headers, _body = self.post(payload, authenticated=False)
        self.assertEqual(401, status)
        self.assertEqual("no-store", headers["Cache-Control"])
        self.assertEqual(200, self.post(payload)[0])

        status, headers, body = self.get("/api/v1/market-geography")
        self.assertEqual(200, status, body)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertIn("must-revalidate", headers["Cache-Control"])
        etag = headers["ETag"]
        status, repeat_headers, repeat_body = self.get(
            "/api/v1/market-geography", {"If-None-Match": etag}
        )
        self.assertEqual(304, status)
        self.assertEqual(etag, repeat_headers["ETag"])
        self.assertEqual(b"", repeat_body)
        status, query_headers, _body = self.get("/api/v1/market-geography?x=1")
        self.assertEqual(400, status)
        self.assertEqual("no-store", query_headers["Cache-Control"])

        changed = self.publication(
            "NP6-905-CD", self.price_rows(base=200.0), 602, NOW - 500
        )
        self.assertEqual(200, self.post(changed)[0])
        status, refreshed_headers, refreshed_body = self.get(
            "/api/v1/market-geography"
        )
        self.assertEqual(200, status, refreshed_body)
        self.assertEqual("MISS", refreshed_headers["X-ERCOT-Cache"])
        self.assertNotEqual(etag, refreshed_headers["ETag"])

    def test_immutable_resource_singleflight_bytes_etag_304_and_alias_rejection(self):
        payload = self.publication(
            "NP6-905-CD", self.price_rows("08/19/2026"), 701, NOW - 600
        )
        self.assertEqual(200, self.post(payload)[0])
        manifest = json.loads(self.get("/api/v1/market-geography")[2])
        link = next(
            item
            for item in manifest["resources"]
            if item["kind"] == "prices" and item["identity"] == "HB_HOUSTON--HU"
        )
        self.app.cache = server.Cache(128)
        original = server.market_geography_resource
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.market_geography_resource = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _index: self.get(link["url"]), range(10)))
        finally:
            server.market_geography_resource = original
        self.assertEqual(1, calls)
        self.assertEqual(1, len({body for _, _, body in responses}))
        self.assertEqual(1, len({headers["ETag"] for _, headers, _ in responses}))
        self.assertIn("max-age=3024000", responses[0][1]["Cache-Control"])
        self.assertIn("immutable", responses[0][1]["Cache-Control"])

        etag = responses[0][1]["ETag"]
        status, headers, body = self.get(link["url"], {"If-None-Match": etag})
        self.assertEqual(304, status)
        self.assertEqual(etag, headers["ETag"])
        self.assertEqual(b"", body)
        for invalid in (
            f"{link['url']}?range=duplicate",
            link["url"].replace("/v1/", "/latest/"),
            link["url"].replace(f"/{link['tile_start']}/", f"/0{link['tile_start']}/"),
        ):
            status, invalid_headers, _body = self.get(invalid)
            self.assertEqual(400, status, invalid)
            self.assertEqual("no-store", invalid_headers["Cache-Control"])

    def test_ingest_racing_manifest_generation_cannot_store_stale_snapshot(self):
        first = self.publication(
            "NP6-905-CD", self.price_rows(base=1.0), 801, NOW - 700
        )
        second = self.publication(
            "NP6-905-CD", self.price_rows(base=500.0), 802, NOW - 500
        )
        self.assertEqual(200, self.post(first)[0])
        self.app.cache = server.Cache(128)
        original = server.market_geography_manifest
        generated = threading.Event()
        release = threading.Event()

        def blocked(conn, now=None):
            result = original(conn, now=now)
            generated.set()
            self.assertTrue(release.wait(2))
            return result

        server.market_geography_manifest = blocked
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale = pool.submit(self.get, "/api/v1/market-geography")
                self.assertTrue(generated.wait(2))
                self.assertEqual(200, self.post(second)[0])
                release.set()
                self.assertEqual(200, stale.result()[0])
        finally:
            release.set()
            server.market_geography_manifest = original

        status, headers, body = self.get("/api/v1/market-geography")
        self.assertEqual(200, status, body)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        manifest = json.loads(body)
        self.assertTrue(
            all(row["value"] >= 500 for row in manifest["settlement_interval"]["rows"])
        )


if __name__ == "__main__":
    unittest.main()
