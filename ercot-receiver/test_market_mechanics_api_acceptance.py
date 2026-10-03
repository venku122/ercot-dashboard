#!/usr/bin/env python3
"""Independent black-box acceptance for PR14 market mechanics."""

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

import market_mechanics
import server


NOW = int(datetime(2026, 8, 18, 18, tzinfo=timezone.utc).timestamp())
TARGET = "08/18/2026 11:40:18"
TARGET_TS = market_mechanics.sced_timestamp(TARGET, False)
PRIOR_TARGET = "08/17/2026 11:40:18"
POLICY = "time_adjacent_context_not_causal_decomposition"

CONSTRUCTED_NAMES = {
    "NP6-322-CD": (
        "cdr.00013114.0000000000000000.20260818.124500000."
        "SCEDSYSLAMBDANP6322_20260818_124500_csv.zip"
    ),
    "NP6-323-CD": (
        "cdr.00013221.0000000000000000.20260818.124500000."
        "RTSCEDpriceAdderNP6323_20260818_124500_csv.zip"
    ),
    "NP6-328-CD": (
        "cdr.00024887.0000000000000000.20260818.124500000."
        "TotASResCapabilityNP6328_20260818_124500_csv.zip"
    ),
    "NP6-332-CD": (
        "cdr.00024891.0000000000000000.20260818.124500000.SCEDMCPCNP6332_csv.zip"
    ),
}

SCALAR_SERIES = {
    "market.sced.system-lambda": "$/MWh",
    "market.sced.price-adder.energy": "$/MWh",
    "market.sced.price-adder.regup": "$/MW",
    "market.sced.price-adder.regdown": "$/MW",
    "market.sced.price-adder.rrs": "$/MW",
    "market.sced.price-adder.ecrs": "$/MW",
    "market.sced.price-adder.nonspin": "$/MW",
    **{
        f"market.sced.adder-input.{name}": "MW"
        for name in (
            "ruc-ldl-relaxed",
            "rmr-ldl-relaxed",
            "deployed-load-resource",
            "deployed-ers",
            "dc-tie-import",
            "dc-tie-export",
            "rtblt-import",
            "rtblt-export",
            "online-lsl",
            "online-hsl",
            "rtdll",
        )
    },
    **{
        f"market.sced.as-capability.{name}": "MW"
        for name in (
            "regup",
            "regdown",
            "rrs",
            "ecrs",
            "nonspin",
            "regup-rrs",
            "regup-rrs-ecrs",
            "regup-rrs-ecrs-nonspin",
        )
    },
    **{
        f"market.sced.as-mcpc.{name}": "$/MW"
        for name in ("ecrs", "nonspin", "regdown", "regup", "rrs")
    },
}


class MarketMechanicsApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        self.old_api_key = server.API_KEY
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: NOW
        server.API_KEY = "market-acceptance-key"
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "MarketAcceptanceServer",
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

    def payload(
        self,
        product,
        *,
        document_id,
        issued_at,
        raw_publish_datetime,
        target=TARGET,
        base=1.0,
    ):
        contract = market_mechanics.CONTRACTS[product]
        rows = []
        as_types = market_mechanics.AS_TYPES if product == "NP6-332-CD" else ("",)
        for as_index, as_type in enumerate(as_types):
            values = {
                field: float(base + field_index + as_index)
                for field_index, field in enumerate(contract["fields"])
            }
            row = {
                "target_ts": market_mechanics.sced_timestamp(target, False),
                "raw_sced_timestamp": target,
                "repeated_hour_flag": False,
                "values": values,
            }
            if as_type:
                row["as_type"] = as_type
            rows.append(row)
        return {
            "publication": {
                "source_id": contract["source"],
                "product_id": product,
                "publication_key_kind": "official_mis_document",
                "publication_key": document_id,
                "issued_at": issued_at,
                "retrieved_at": issued_at + 60,
                "raw_publish_datetime": raw_publish_datetime,
                "document_id": document_id,
                "constructed_name": CONSTRUCTED_NAMES[product],
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    f"?doclookupId={document_id}"
                ),
                "schema_fingerprint": contract["fingerprint"],
                "parser_schema_version": "ercot-mis-market-v1",
            },
            "rows": rows,
        }

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
        handler.send_response = lambda status: setattr(handler, "response_status", status)
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

    def post(self, payload):
        return self.request(
            "POST",
            "/api/market-mechanics-publications/ingest",
            payload,
            {"X-API-Key": server.API_KEY},
        )

    def get(self, path, headers=None):
        return self.request("GET", path, headers=headers)

    def manifest_response(self):
        status, headers, body = self.get("/api/v1/market-mechanics")
        self.assertEqual(200, status, body)
        return headers, json.loads(body)

    def seed_coherent_snapshot(
        self, target=TARGET, base=1.0, document_base=100
    ):
        products = (
            "NP6-322-CD",
            "NP6-323-CD",
            "NP6-328-CD",
            "NP6-332-CD",
        )
        for index, product in enumerate(products, start=1):
            issued_at = NOW - 600 + index
            payload = self.payload(
                product,
                document_id=str(document_base + index),
                issued_at=issued_at,
                raw_publish_datetime=datetime.fromtimestamp(
                    issued_at, timezone.utc
                ).astimezone(market_mechanics.CHICAGO).isoformat(timespec="seconds"),
                target=target,
                base=base,
            )
            # Canonical lambda and NP6-323's parity value match.
            if product == "NP6-323-CD":
                payload["rows"][0]["values"]["SystemLambda"] = base
            status, _headers, body = self.post(payload)
            self.assertEqual(200, status, body)

    def test_exact_scalar_catalog_cardinality_units_and_canonical_lambda(self):
        self.assertEqual(31, len(SCALAR_SERIES))
        self.seed_coherent_snapshot()
        _headers, current_manifest = self.manifest_response()
        self.assertEqual(TARGET_TS, current_manifest["current"]["target_ts"])
        self.assertEqual([], current_manifest["resources"])
        self.assertEqual(
            0,
            server.get_db()
            .execute("SELECT COUNT(*) FROM market_mechanics_resources")
            .fetchone()[0],
        )

        self.seed_coherent_snapshot(
            target=PRIOR_TARGET, base=10.0, document_base=200
        )
        _headers, manifest = self.manifest_response()
        resources = manifest["resources"]
        self.assertEqual(31, len(resources))
        self.assertEqual(set(SCALAR_SERIES), {item["series_key"] for item in resources})
        self.assertEqual(
            31,
            server.get_db()
            .execute("SELECT COUNT(*) FROM market_mechanics_resources")
            .fetchone()[0],
        )
        self.assertNotIn("market.sced.np6-323-system-lambda", SCALAR_SERIES)

        for link in resources:
            status, _resource_headers, body = self.get(link["url"])
            self.assertEqual(200, status, body)
            resource = json.loads(body)
            self.assertEqual(SCALAR_SERIES[link["series_key"]], resource["unit"])
            self.assertTrue(resource["rows"])
            self.assertTrue(all(type(row.get("value")) is float for row in resource["rows"]))
            self.assertTrue(all("values" not in row for row in resource["rows"]))

    def test_accumulated_day_correction_preserves_old_bytes_and_row_publish_dates(self):
        first = self.payload(
            "NP6-322-CD",
            document_id="200",
            issued_at=NOW - 86_400 - 900,
            raw_publish_datetime="2026-08-17T12:45:00-05:00",
            target="08/17/2026 11:35:01",
            base=10,
        )
        second = self.payload(
            "NP6-322-CD",
            document_id="201",
            issued_at=NOW - 86_400 - 600,
            raw_publish_datetime="2026-08-17T12:50:00-05:00",
            target=PRIOR_TARGET,
            base=20,
        )
        self.assertEqual(200, self.post(first)[0])
        self.assertEqual(200, self.post(second)[0])
        _headers, manifest = self.manifest_response()
        old_url = next(
            item["url"]
            for item in manifest["resources"]
            if item["series_key"] == "market.sced.system-lambda"
        )
        old_response = self.get(old_url)
        self.assertEqual(200, old_response[0], old_response[2])
        old_body = json.loads(old_response[2])
        self.assertEqual([10.0, 20.0], [row["value"] for row in old_body["rows"]])
        self.assertEqual(
            ["2026-08-17T12:45:00-05:00", "2026-08-17T12:50:00-05:00"],
            [row["source"]["raw_publish_datetime"] for row in old_body["rows"]],
        )

        correction = copy.deepcopy(first)
        correction["publication"].update(
            {
                "publication_key": "202",
                "document_id": "202",
                "issued_at": NOW - 86_400 - 300,
                "retrieved_at": NOW - 86_400 - 240,
                "raw_publish_datetime": "2026-08-17T12:55:00-05:00",
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    "?doclookupId=202"
                ),
            }
        )
        correction["rows"][0]["values"]["SystemLambda"] = 11.0
        self.assertEqual(200, self.post(correction)[0])
        _headers, changed_manifest = self.manifest_response()
        new_url = next(
            item["url"]
            for item in changed_manifest["resources"]
            if item["series_key"] == "market.sced.system-lambda"
        )
        self.assertNotEqual(old_url, new_url)
        new_body = json.loads(self.get(new_url)[2])
        self.assertEqual([11.0, 20.0], [row["value"] for row in new_body["rows"]])
        self.assertEqual(old_response[2], self.get(old_url)[2])
        self.assertEqual(old_response[1]["ETag"], self.get(old_url)[1]["ETag"])

    def test_publish_date_must_equal_issued_at_and_remain_raw(self):
        payload = self.payload(
            "NP6-322-CD",
            document_id="300",
            issued_at=NOW - 600,
            raw_publish_datetime="2026-08-18T12:00:00-05:00",
        )
        # The supplied raw value normalizes to a different instant and cannot
        # be accepted as provenance for issued_at.
        status, headers, _body = self.post(payload)
        self.assertEqual(400, status)
        self.assertEqual("no-store", headers["Cache-Control"])

    def test_current_snapshot_requires_same_sced_and_reports_lambda_parity(self):
        self.seed_coherent_snapshot()
        _headers, manifest = self.manifest_response()
        current = manifest["current"]
        self.assertEqual(TARGET_TS, current["target_ts"])
        self.assertEqual("match", current["lambda_parity"]["state"])
        self.assertEqual(0.0, current["lambda_parity"]["delta"])
        self.assertEqual(POLICY, manifest["explanation_policy"])
        encoded = json.dumps(manifest, sort_keys=True).lower()
        for forbidden in ("calculated_price", "explained_price", "caused_by", "contribution_percent"):
            self.assertNotIn(forbidden, encoded)

        # A newer NP6-328 row by itself must not move the coherent snapshot.
        later = self.payload(
            "NP6-328-CD",
            document_id="999",
            issued_at=NOW - 10,
            raw_publish_datetime="2026-08-18T12:59:50-05:00",
            target="08/18/2026 11:45:02",
        )
        self.assertEqual(200, self.post(later)[0])
        self.assertEqual(TARGET_TS, self.manifest_response()[1]["current"]["target_ts"])

    def test_resource_singleflight_deterministic_etag_hit_and_304(self):
        payload = self.payload(
            "NP6-322-CD",
            document_id="400",
            issued_at=NOW - 86_400 - 600,
            raw_publish_datetime="2026-08-17T12:50:00-05:00",
            target=PRIOR_TARGET,
        )
        self.assertEqual(200, self.post(payload)[0])
        path = next(
            item["url"]
            for item in self.manifest_response()[1]["resources"]
            if item["series_key"] == "market.sced.system-lambda"
        )
        self.app.cache = server.Cache(128)
        original = server.market_mechanics_resource
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.market_mechanics_resource = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _index: self.get(path), range(10)))
        finally:
            server.market_mechanics_resource = original
        self.assertEqual(1, calls)
        self.assertEqual(1, len({body for _, _, body in responses}))
        self.assertEqual(1, len({headers["ETag"] for _, headers, _ in responses}))
        etag = responses[0][1]["ETag"]
        status, headers, body = self.get(path, {"If-None-Match": etag})
        self.assertEqual(304, status)
        self.assertEqual(etag, headers["ETag"])
        self.assertEqual(b"", body)
        status, headers, body = self.get(f"{path}?range=duplicate")
        self.assertEqual(400, status, body)
        self.assertEqual("no-store", headers["Cache-Control"])

    def test_ingest_racing_manifest_generation_cannot_publish_stale_cache(self):
        first = self.payload(
            "NP6-322-CD",
            document_id="500",
            issued_at=NOW - 86_400 - 900,
            raw_publish_datetime="2026-08-17T12:45:00-05:00",
            target="08/17/2026 11:35:01",
            base=10,
        )
        second = self.payload(
            "NP6-322-CD",
            document_id="501",
            issued_at=NOW - 86_400 - 600,
            raw_publish_datetime="2026-08-17T12:50:00-05:00",
            target=PRIOR_TARGET,
            base=20,
        )
        self.assertEqual(200, self.post(first)[0])
        self.app.cache = server.Cache(128)
        original = server.market_mechanics_manifest
        generated = threading.Event()
        release = threading.Event()

        def blocked(conn, now=None):
            result = original(conn, now=now)
            generated.set()
            self.assertTrue(release.wait(2))
            return result

        server.market_mechanics_manifest = blocked
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale = pool.submit(self.get, "/api/v1/market-mechanics")
                self.assertTrue(generated.wait(2))
                self.assertEqual(200, self.post(second)[0])
                release.set()
                self.assertEqual(200, stale.result()[0])
        finally:
            release.set()
            server.market_mechanics_manifest = original

        status, headers, body = self.get("/api/v1/market-mechanics")
        self.assertEqual(200, status, body)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        manifest = json.loads(body)
        lambda_link = next(
            item
            for item in manifest["resources"]
            if item["series_key"] == "market.sced.system-lambda"
        )
        resource = json.loads(self.get(lambda_link["url"])[2])
        self.assertEqual([10.0, 20.0], [row["value"] for row in resource["rows"]])

    def test_300_current_runs_create_no_blobs_then_rollover_and_correction_once(self):
        self.app.limiter = type(
            "UnlimitedAcceptanceLimiter", (), {"allow": lambda *_args: True}
        )()
        day_start = TARGET_TS // 86_400 * 86_400
        publications = []
        for index in range(300):
            target_ts = day_start + 3_600 + index * 60
            issued_at = NOW - 2_000 + index
            payload = self.payload(
                "NP6-322-CD",
                document_id=str(10_000 + index),
                issued_at=issued_at,
                raw_publish_datetime=datetime.fromtimestamp(
                    issued_at, timezone.utc
                ).astimezone(market_mechanics.CHICAGO).isoformat(timespec="seconds"),
                target=datetime.fromtimestamp(
                    target_ts, market_mechanics.CHICAGO
                ).strftime("%m/%d/%Y %H:%M:%S"),
                base=float(index),
            )
            publications.append(payload)
            self.assertEqual(200, self.post(payload)[0])

        conn = sqlite3.connect(server.DB_PATH)
        try:
            self.assertEqual(
                0,
                conn.execute(
                    "SELECT COUNT(*) FROM market_mechanics_resources"
                ).fetchone()[0],
            )
            self.assertEqual(
                0,
                conn.execute(
                    "SELECT COUNT(*) FROM market_mechanics_current"
                ).fetchone()[0],
            )
        finally:
            conn.close()
        _headers, live_manifest = self.manifest_response()
        self.assertLessEqual(len(json.dumps(live_manifest).encode()), 256 * 1024)
        self.assertFalse(
            any(item["tile_start"] == day_start for item in live_manifest["resources"])
        )

        rollover_now = day_start + 86_400 + 120
        server.now_ts = lambda: rollover_now
        rollover_issue = rollover_now - 60
        rollover = self.payload(
            "NP6-322-CD",
            document_id="20000",
            issued_at=rollover_issue,
            raw_publish_datetime=datetime.fromtimestamp(
                rollover_issue, timezone.utc
            ).astimezone(market_mechanics.CHICAGO).isoformat(timespec="seconds"),
            target=datetime.fromtimestamp(
                day_start + 86_400 + 60, market_mechanics.CHICAGO
            ).strftime("%m/%d/%Y %H:%M:%S"),
            base=400,
        )
        self.assertEqual(200, self.post(rollover)[0])
        _headers, sealed_manifest = self.manifest_response()
        old_url = next(
            item["url"]
            for item in sealed_manifest["resources"]
            if item["series_key"] == "market.sced.system-lambda"
            and item["tile_start"] == day_start
        )
        old_status, old_headers, old_bytes = self.get(old_url)
        self.assertEqual(200, old_status, old_bytes)

        # An unchanged replay and another open-day run cannot mint blobs.
        self.assertEqual(200, self.post(rollover)[0])
        another = copy.deepcopy(rollover)
        another["publication"].update(
            {
                "publication_key": "20001",
                "document_id": "20001",
                "issued_at": rollover_issue + 1,
                "retrieved_at": rollover_issue + 61,
                "raw_publish_datetime": datetime.fromtimestamp(
                    rollover_issue + 1, timezone.utc
                ).astimezone(market_mechanics.CHICAGO).isoformat(timespec="seconds"),
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    "?doclookupId=20001"
                ),
            }
        )
        another_target = day_start + 86_400 + 90
        another["rows"][0].update(
            {
                "raw_sced_timestamp": datetime.fromtimestamp(
                    another_target, market_mechanics.CHICAGO
                ).strftime("%m/%d/%Y %H:%M:%S"),
                "target_ts": another_target,
            }
        )
        self.assertEqual(200, self.post(another)[0])
        conn = sqlite3.connect(server.DB_PATH)
        try:
            self.assertEqual(
                1,
                conn.execute(
                    "SELECT COUNT(*) FROM market_mechanics_resources"
                ).fetchone()[0],
            )
        finally:
            conn.close()

        correction = copy.deepcopy(publications[0])
        correction["publication"].update(
            {
                "publication_key": "30000",
                "document_id": "30000",
                "issued_at": rollover_issue + 2,
                "retrieved_at": rollover_issue + 62,
                "raw_publish_datetime": datetime.fromtimestamp(
                    rollover_issue + 2, timezone.utc
                ).astimezone(market_mechanics.CHICAGO).isoformat(timespec="seconds"),
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    "?doclookupId=30000"
                ),
            }
        )
        correction["rows"][0]["values"]["SystemLambda"] = 999.0
        self.assertEqual(200, self.post(correction)[0])
        _headers, corrected_manifest = self.manifest_response()
        new_url = next(
            item["url"]
            for item in corrected_manifest["resources"]
            if item["series_key"] == "market.sced.system-lambda"
            and item["tile_start"] == day_start
        )
        self.assertNotEqual(old_url, new_url)
        self.assertEqual(old_bytes, self.get(old_url)[2])
        self.assertEqual(old_headers["ETag"], self.get(old_url)[1]["ETag"])
        conn = sqlite3.connect(server.DB_PATH)
        try:
            self.assertEqual(
                2,
                conn.execute(
                    "SELECT COUNT(*) FROM market_mechanics_resources"
                ).fetchone()[0],
            )
        finally:
            conn.close()

        self.assertEqual(200, self.post(correction)[0])
        conn = sqlite3.connect(server.DB_PATH)
        try:
            self.assertEqual(
                2,
                conn.execute(
                    "SELECT COUNT(*) FROM market_mechanics_resources"
                ).fetchone()[0],
            )
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
