#!/usr/bin/env python3
"""Independent black-box acceptance for PR13 regional resources."""

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

import regional_geography
import server
from forecast_vintages import market_hour_target


NOW = int(datetime(2026, 8, 18, 12, tzinfo=timezone.utc).timestamp())
ISSUE = int(datetime(2026, 8, 18, 7, tzinfo=timezone.utc).timestamp())


class RegionalGeographyApiAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_now_ts = server.now_ts
        self.old_api_key = server.API_KEY
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.now_ts = lambda: NOW
        server.API_KEY = "regional-acceptance-key"
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "RegionalAcceptanceServer",
            (),
            {
                "cache": server.Cache(60),
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
        *,
        document_id="200",
        issued_at=ISSUE,
        retrieved_at=ISSUE + 60,
        points=(("2026-08-18", "01:00"), ("2026-08-18", "02:00")),
        base=10.0,
    ):
        contract = regional_geography.CONTRACTS["NP4-742-CD"]
        offset_issue = datetime.fromtimestamp(
            issued_at, timezone.utc
        ).astimezone().isoformat(timespec="seconds")
        rows = []
        for index, (delivery_date, hour_ending) in enumerate(points):
            generation = base + index
            regions = {
                region: {
                    "gen_mw": generation,
                    "cop_hsl_mw": 20.0,
                    "forecast_mw": 15.0,
                    "resource_plan_mw": 18.0,
                }
                for region in contract["regions"]
            }
            rows.append(
                {
                    "target_ts": market_hour_target(
                        delivery_date, hour_ending, False
                    ),
                    "delivery_date": delivery_date,
                    "hour_ending": hour_ending,
                    "dst_flag": False,
                    "raw_delivery_date": datetime.strptime(
                        delivery_date, "%Y-%m-%d"
                    ).strftime("%m/%d/%Y"),
                    "raw_hour_ending": hour_ending[:2],
                    "raw_dst_flag": "N",
                    "system": {
                        "gen_mw": len(regions) * generation,
                        "cop_hsl_mw": 100.0,
                        "forecast_mw": len(regions) * 15.0,
                        "resource_plan_mw": len(regions) * 18.0,
                        "system_wide_hsl_mw": 110.0,
                    },
                    "regions": regions,
                }
            )
        return {
            "publication": {
                "source_id": contract["source_id"],
                "product_id": "NP4-742-CD",
                "publication_key_kind": "official_mis_document",
                "publication_key": document_id,
                "issued_at": issued_at,
                "raw_publish_datetime": offset_issue,
                "document_id": document_id,
                "constructed_name": f"regional-{document_id}.csv.zip",
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload"
                    f"?doclookupId={document_id}"
                ),
                "retrieved_at": retrieved_at,
                "schema_fingerprint": contract["fingerprint"],
                "parser_schema_version": "ercot-mis-regional-v1",
                "declared_unit": "MW",
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
            "/api/regional-renewable-publications/ingest",
            payload,
            {"X-API-Key": server.API_KEY},
        )

    def get(self, path, headers=None):
        return self.request("GET", path, headers=headers)

    def manifest(self):
        status, _headers, body = self.get("/api/v1/regional-geography")
        self.assertEqual(200, status, body)
        return json.loads(body)

    def panhandle_url(self):
        return next(
            item["url"]
            for item in self.manifest()["resources"]
            if item["series_key"] == "regional.wind.panhandle.hourly"
        )

    def test_immutable_resource_bytes_etag_singleflight_and_304(self):
        status, _headers, body = self.post(self.payload())
        self.assertEqual(200, status, body)
        path = self.panhandle_url()
        self.app.cache = server.Cache(60)

        original = server.regional_geography_resource
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.regional_geography_resource = counted
        try:
            with ThreadPoolExecutor(max_workers=10) as pool:
                responses = list(pool.map(lambda _index: self.get(path), range(10)))
        finally:
            server.regional_geography_resource = original

        self.assertEqual(1, calls)
        self.assertTrue(all(status == 200 for status, _headers, _body in responses))
        self.assertEqual(1, len({response_body for _, _, response_body in responses}))
        self.assertEqual(1, len({headers["ETag"] for _, headers, _ in responses}))
        first_body = responses[0][2]
        first_etag = responses[0][1]["ETag"]
        self.assertNotIn(b"publication_id", first_body)
        self.assertNotIn(b'"forecast_error_mw"', first_body)
        status, headers, conditional = self.get(path, {"If-None-Match": first_etag})
        self.assertEqual(304, status)
        self.assertEqual(first_etag, headers["ETag"])
        self.assertEqual(b"", conditional)
        self.assertEqual("public, max-age=3024000, immutable", headers["Cache-Control"])

    def test_superseded_resource_survives_advertised_lifetime_then_prunes(self):
        older = self.payload(
            document_id="100", issued_at=ISSUE - 3_600, retrieved_at=ISSUE - 3_500
        )
        newer = self.payload(
            document_id="200", issued_at=ISSUE, retrieved_at=ISSUE + 60, base=20.0
        )
        self.assertEqual(200, self.post(older)[0])
        old_path = self.panhandle_url()
        self.assertEqual(200, self.post(newer)[0])
        self.assertNotEqual(old_path, self.panhandle_url())

        conn = sqlite3.connect(server.DB_PATH)
        try:
            regional_geography.prune_regional_publications(
                conn, now=NOW + 35 * 86_400, batch_size=500
            )
            old_version = old_path.split("/")[6]
            day_start = int(old_path.split("/")[8])
            self.assertIsNotNone(
                regional_geography.regional_geography_resource(
                    conn,
                    "regional.wind.panhandle.hourly",
                    "v1",
                    old_version,
                    day_start,
                    "native",
                )
            )
            regional_geography.prune_regional_publications(
                conn, now=NOW + 35 * 86_400 + 1, batch_size=500
            )
            self.assertIsNone(
                regional_geography.regional_geography_resource(
                    conn,
                    "regional.wind.panhandle.hourly",
                    "v1",
                    old_version,
                    day_start,
                    "native",
                )
            )
        finally:
            conn.close()

        # A process restart cannot resurrect an expired version from memory.
        self.app.cache = server.Cache(60)
        status, headers, _body = self.get(old_path)
        self.assertEqual(404, status)
        self.assertEqual("no-store", headers["Cache-Control"])

    def test_late_replay_of_older_issue_cannot_replace_newer_pointer(self):
        newer = self.payload(document_id="200", issued_at=ISSUE, retrieved_at=ISSUE + 60)
        older = self.payload(
            document_id="100",
            issued_at=ISSUE - 3_600,
            retrieved_at=ISSUE + 3_600,
            base=20.0,
        )
        self.assertEqual(200, self.post(newer)[0])
        self.assertEqual(200, self.post(older)[0])
        status, _headers, body = self.get(self.panhandle_url())
        self.assertEqual(200, status)
        resource = json.loads(body)
        self.assertEqual(ISSUE, resource["source"]["issued_at"])
        self.assertEqual(10.0, resource["rows"][0]["current_mw"])

    def test_ingest_racing_manifest_generation_cannot_publish_stale_cache(self):
        older = self.payload(
            document_id="100", issued_at=ISSUE - 3_600, retrieved_at=ISSUE - 3_500
        )
        newer = self.payload(
            document_id="200", issued_at=ISSUE, retrieved_at=ISSUE + 60, base=20.0
        )
        self.assertEqual(200, self.post(older)[0])
        self.app.cache = server.Cache(60)

        original = server.regional_geography_manifest
        generated = threading.Event()
        release = threading.Event()

        def blocked(conn, now=None):
            result = original(conn, now=now)
            generated.set()
            self.assertTrue(release.wait(2))
            return result

        server.regional_geography_manifest = blocked
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale_response = pool.submit(self.get, "/api/v1/regional-geography")
                self.assertTrue(generated.wait(2))
                self.assertEqual(200, self.post(newer)[0])
                release.set()
                self.assertEqual(200, stale_response.result()[0])
        finally:
            release.set()
            server.regional_geography_manifest = original

        status, headers, body = self.get("/api/v1/regional-geography")
        self.assertEqual(200, status)
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertEqual(
            ISSUE,
            json.loads(body)["current"]["wind"]["source"]["issued_at"],
        )

    def test_change_requires_exact_elapsed_hour_and_bridges_utc_tiles(self):
        gap = self.payload(points=(("2026-08-18", "01:00"), ("2026-08-18", "03:00")))
        self.assertEqual(200, self.post(gap)[0])
        status, _headers, body = self.get(self.panhandle_url())
        self.assertEqual(200, status)
        self.assertEqual([None, None], [row["change_1h_mw"] for row in json.loads(body)["rows"]])

        # Chicago HE19 ends at 00:00Z in summer and is the next UTC tile's
        # first point. Its exact HE18 predecessor must still be used.
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app.cache = server.Cache(60)
        boundary = self.payload(
            document_id="201",
            points=(("2026-08-18", "18:00"), ("2026-08-18", "19:00")),
        )
        self.assertEqual(200, self.post(boundary)[0])
        manifest = self.manifest()
        links = sorted(
            (
                item
                for item in manifest["resources"]
                if item["series_key"] == "regional.wind.panhandle.hourly"
            ),
            key=lambda item: item["tile_start"],
        )
        self.assertEqual(2, len(links))
        status, _headers, body = self.get(links[1]["url"])
        self.assertEqual(200, status)
        self.assertEqual(1.0, json.loads(body)["rows"][0]["change_1h_mw"])

    def test_raw_provenance_must_match_normalized_identity(self):
        payload = self.payload()
        bad_date = copy.deepcopy(payload)
        bad_date["rows"][0]["raw_delivery_date"] = "08/17/2026"
        bad_hour = copy.deepcopy(payload)
        bad_hour["rows"][0]["raw_hour_ending"] = "03"
        for bad in (bad_date, bad_hour):
            status, headers, _body = self.post(bad)
            self.assertEqual(400, status)
            self.assertEqual("no-store", headers["Cache-Control"])


if __name__ == "__main__":
    unittest.main()
