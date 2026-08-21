import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

import server

from external_context import (
    KIND, POLICY, external_context_manifest, external_context_resource,
    ingest_external_context, init_external_context_schema, record_external_context_failure,
)

NOW = 1_787_200_000


def payload(revision=2, released="2025-06-12", retrieved=NOW - 10, co2=733.862):
    headers = ("CO₂", "CH₄", "N₂O", "CO₂e", "Annual NOₓ", "Ozone Season NOₓ", "SO₂")
    ids = ("co2", "ch4", "n2o", "co2e", "annual_nox", "ozone_season_nox", "so2")
    values = (co2, .043, .006, 736.629, .443, .488, .319)
    suffix = f"_rev{revision}" if revision else ""
    return {
        "schema": 1, "kind": KIND, "stream": "epa_egrid",
        "publication": {
            "artifact_url": f"https://www.epa.gov/system/files/documents/2025-06/summary_tables{suffix}.xlsx",
            "data_year": 2023, "released_on": released, "revision": revision,
            "retrieved_at": retrieved, "source_page_url": "https://www.epa.gov/egrid/summary-data",
            "workbook_sha256": "sha256:" + str(revision or 1) * 64,
            "table_title": "1. Subregion Output Emission Rates (eGRID2023)",
            "production_model": "eGRID R", "production_version": "1.0.2",
        },
        "resource": {"subregion": "ERCT", "subregion_name": "ERCOT All", "rates": [
            {"metric_id": key, "source_header": header, "value": value, "unit": "lb_mwh"}
            for key, header, value in zip(ids, headers, values)
        ]},
    }


def eia_payload(retrieved=NOW - 10, demand=81_500.25, interchange=-321.5):
    rows = []
    for kind, name, value in (("D", "Demand", demand), ("TI", "Total Interchange", interchange)):
        rows.append({
            "period": "2026-08-20T20", "interval_start": 1_777_000_400,
            "interval_end": 1_777_004_000, "type": kind, "type_name": name,
            "value_decimal": str(value), "value_mwh": value,
        })
    return {"schema": 1, "kind": KIND, "stream": "eia930_demand",
            "publication": {"retrieved_at": retrieved, "source_url": "https://api.eia.gov/v2/electricity/rto/region-data/data/"},
            "resource": {"interval_basis": "hour_ending_utc_half_open", "rows": rows}}


def gas_payload(retrieved=NOW - 10, price=2.91):
    return {"schema": 1, "kind": KIND, "stream": "henry_hub_daily",
            "publication": {"retrieved_at": retrieved, "series_id": "NG.RNGWHHD.D",
                "source_url": "https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D",
                "source_page_url": "https://www.eia.gov/dnav/ng/hist/rngwhhdd.htm",
                "source_unit": "dollars per million Btu"},
            "resource": {"unit": "usd_per_mmbtu", "date_basis": "source_market_date_no_timezone",
                "rows": [{"market_date": "2026-08-20", "value_decimal": str(price), "price": price}]}}


class ExternalContextTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        init_external_context_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_no_key_manifest_is_honest_and_egrid_is_independent(self):
        empty = external_context_manifest(self.conn, NOW)
        self.assertEqual(empty["policy"], POLICY)
        self.assertEqual(empty["eia_930"]["state"], "disabled")
        self.assertEqual(empty["natural_gas"]["reason"], "eia_api_key_not_configured")
        self.assertEqual(empty["epa_camd"]["state"], "unavailable")
        result = ingest_external_context(self.conn, payload(), NOW)
        manifest = external_context_manifest(self.conn, NOW)
        self.assertEqual(manifest["epa_egrid"]["state"], "available")
        self.assertEqual(manifest["epa_egrid"]["selected"]["content_version"], result["content_version"])
        resource = external_context_resource(self.conn, "epa_egrid", result["content_version"])
        self.assertEqual(resource["kind"], "external_context_resource")
        self.assertEqual(len(resource["rates"]), 7)

    def test_replay_collision_and_explicit_revision_order(self):
        first = ingest_external_context(self.conn, payload(), NOW)
        replay = ingest_external_context(self.conn, payload(retrieved=NOW), NOW)
        self.assertEqual(replay["status"], "unchanged")
        self.assertEqual(replay["content_version"], first["content_version"])
        with self.assertRaisesRegex(ValueError, "same_identity_collision"):
            ingest_external_context(self.conn, payload(co2=999), NOW)
        with self.assertRaisesRegex(ValueError, "same_identity_collision"):
            ingest_external_context(self.conn, payload(released="2025-06-13"), NOW)
        newer = ingest_external_context(self.conn, payload(3, "2026-01-02", NOW, 700), NOW)
        self.assertEqual(newer["status"], "inserted")
        self.assertEqual(external_context_manifest(self.conn, NOW)["epa_egrid"]["selected"]["revision"], 3)

    def test_failure_does_not_enable_or_zero_deferred_sections(self):
        self.assertEqual(record_external_context_failure(self.conn, "epa_egrid", "fetch_failed", NOW), "recorded")
        manifest = external_context_manifest(self.conn, NOW)
        self.assertEqual(manifest["epa_egrid"]["state"], "failed")
        self.assertEqual(manifest["eia_930"]["state"], "disabled")
        self.assertEqual(manifest["source_health"][0]["state"], "disabled")
        self.assertEqual(manifest["source_health"][2]["state"], "failed")

    def test_eia_and_gas_corrections_are_independent_and_credential_free_on_wire(self):
        eia = ingest_external_context(self.conn, eia_payload(), NOW)
        gas = ingest_external_context(self.conn, gas_payload(), NOW)
        manifest = external_context_manifest(self.conn, NOW)
        self.assertEqual(manifest["eia_930"]["state"], "available")
        self.assertEqual(manifest["natural_gas"]["state"], "available")
        self.assertEqual(manifest["eia_930"]["selected"]["latest_demand_interval_end"], 1_777_004_000)
        self.assertNotIn("api_key", json.dumps(manifest))
        correction = ingest_external_context(self.conn, eia_payload(NOW, demand=82_000), NOW)
        self.assertNotEqual(correction["content_version"], eia["content_version"])
        self.assertIsNotNone(external_context_resource(self.conn, "eia930_demand", eia["content_version"]))
        self.assertEqual(external_context_resource(self.conn, "henry_hub_daily", gas["content_version"])["rows"][0]["price"], 2.91)
        with self.assertRaisesRegex(ValueError, "same_clock_collision"):
            ingest_external_context(self.conn, eia_payload(NOW, demand=83_000), NOW)


class ExternalContextHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = (server.DB_PATH, server.DB_LOCAL, server.API_KEY, server.now_ts)
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.API_KEY = "fixture-key"
        server.now_ts = lambda: NOW
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type("ExternalContextServer", (), {
            "cache": server.Cache(60), "cache_metrics": server.defaultdict(float),
            "cache_metrics_lock": threading.Lock(), "limiter": server.RateLimiter(),
            "singleflight": server.SingleFlight(),
        })()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        server.DB_PATH, server.DB_LOCAL, server.API_KEY, server.now_ts = self.old
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        handler = server.Handler.__new__(server.Handler)
        handler.path = path; handler.client_address = ("127.0.0.1", 12345); handler.server = self.app
        encoded = b"" if body is None else json.dumps(body).encode()
        handler.headers = {"Content-Length": str(len(encoded)), **(headers or {})}
        handler.rfile = io.BytesIO(encoded); handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close(); del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def test_authenticated_ingest_queryless_manifest_and_immutable_etag(self):
        self.assertEqual(self.request("POST", "/api/external-context/ingest", payload())[0], 401)
        posted = self.request("POST", "/api/external-context/ingest", payload(), {"X-API-Key": "fixture-key"})
        self.assertEqual(posted[0], 200)
        version = json.loads(posted[2])["content_version"]
        manifest = self.request("GET", "/api/v1/external-context")
        self.assertEqual(manifest[0], 200)
        self.assertEqual(self.request("GET", "/api/v1/external-context?x=1")[0], 400)
        resource = self.request("GET", f"/api/v2/external-context/epa_egrid/v1/{version}")
        self.assertEqual(resource[0], 200)
        self.assertEqual(resource[1]["ETag"], f'"{version}"')
        conditional = self.request("GET", f"/api/v2/external-context/epa_egrid/v1/{version}", headers={"If-None-Match": f'"{version}"'})
        self.assertEqual(conditional[0], 304)
        self.assertEqual(conditional[2], b"")

    def test_http_accepts_eia_resources_and_failure_attempts_without_cross_source_regression(self):
        for body in (eia_payload(), gas_payload()):
            response = self.request("POST", "/api/external-context/ingest", body, {"X-API-Key": "fixture-key"})
            self.assertEqual(response[0], 200)
            version = json.loads(response[2])["content_version"]
            stream = body["stream"]
            resource = self.request("GET", f"/api/v2/external-context/{stream}/v1/{version}")
            self.assertEqual(resource[0], 200)
        failed = {"schema": 1, "kind": KIND, "stream": "eia930_demand", "attempted_at": NOW + 1,
                  "status": "failed", "reason": "upstream_auth_rejected"}
        self.assertEqual(self.request("POST", "/api/external-context/source-attempt", failed, {"X-API-Key": "fixture-key"})[0], 200)
        manifest = json.loads(self.request("GET", "/api/v1/external-context")[2])
        self.assertEqual(manifest["eia_930"]["state"], "available")
        self.assertEqual(manifest["source_health"][0]["state"], "failed")
        self.assertEqual(manifest["natural_gas"]["state"], "available")


if __name__ == "__main__":
    unittest.main()
