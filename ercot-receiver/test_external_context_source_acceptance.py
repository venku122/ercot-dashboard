#!/usr/bin/env python3

import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("external_context_acceptance_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)
xc = sys.modules[server.ingest_external_context.__module__]


class ExternalContextSourceAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "TestServer",
            (),
            {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "cache_metrics_lock": threading.Lock(),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()
        self.old_key = server.API_KEY
        self.old_now = server.now_ts
        server.API_KEY = "external-context-receiver-key"
        server.now_ts = lambda: 2_000_000_000

    def tearDown(self):
        server.API_KEY = self.old_key
        server.now_ts = self.old_now
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        self.tmp.cleanup()

    def invoke(self, method, path, payload=None, headers=None, status=200):
        body = b"" if payload is None else json.dumps(payload).encode()
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12345)
        handler.server = self.app
        handler.headers = {
            "Content-Length": str(len(body)),
            "Content-Type": "application/json",
            **(headers or {}),
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda value: setattr(handler, "response_status", value)
        handler.response_headers = {}
        handler.send_header = lambda key, value: handler.response_headers.__setitem__(key, value)
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        self.assertEqual(status, handler.response_status)
        raw = handler.wfile.getvalue()
        return (None if not raw else json.loads(raw), handler.response_headers, raw)

    @staticmethod
    def egrid_payload(revision=2, released_on="2025-06-12", retrieved_at=1_999_000_000):
        suffix = f"_rev{revision}" if revision else ""
        return {
            "schema": 1,
            "kind": "external_context",
            "stream": "epa_egrid",
            "publication": {
                "artifact_url": (
                    "https://www.epa.gov/system/files/documents/2025-06/"
                    f"summary_tables{suffix}.xlsx"
                ),
                "data_year": 2023,
                "released_on": released_on,
                "revision": revision,
                "retrieved_at": retrieved_at,
                "source_page_url": "https://www.epa.gov/egrid/summary-data",
                "workbook_sha256": "sha256:" + "a" * 64,
                "table_title": "1. Subregion Output Emission Rates (eGRID2023)",
                "production_model": "eGRID R",
                "production_version": "1.0.2",
            },
            "resource": {
                "subregion": "ERCT",
                "subregion_name": "ERCOT All",
                "rates": [
                    {
                        "metric_id": metric_id,
                        "source_header": source_header,
                        "value": float(index),
                        "unit": "lb_mwh",
                    }
                    for index, (metric_id, source_header) in enumerate(xc.METRICS, 1)
                ],
            },
        }

    def ingest(self, payload, status=200):
        return self.invoke(
            "POST",
            "/api/external-context/ingest",
            payload,
            headers={"X-API-Key": "external-context-receiver-key"},
            status=status,
        )[0]

    def test_empty_manifest_is_small_honest_and_strictly_disabled(self):
        manifest, headers, _raw = self.invoke("GET", "/api/v1/external-context")
        self.assertEqual(
            {
                "schema",
                "kind",
                "policy",
                "generated_at",
                "eia_930",
                "natural_gas",
                "epa_egrid",
                "epa_camd",
                "source_health",
            },
            set(manifest),
        )
        disabled = {
            "state": "disabled",
            "reason": "eia_api_key_not_configured",
            "freshness": None,
            "selected": None,
        }
        self.assertEqual(disabled, manifest["eia_930"])
        self.assertEqual(disabled, manifest["natural_gas"])
        self.assertEqual(
            {
                "state": "unavailable",
                "reason": "ercot_footprint_and_coverage_methodology_not_frozen",
            },
            manifest["epa_camd"],
        )
        self.assertEqual(
            ["eia930_erco", "eia_henry_hub", "epa_egrid_erct"],
            [row["source_id"] for row in manifest["source_health"]],
        )
        self.assertEqual(["disabled", "disabled"], [row["state"] for row in manifest["source_health"][:2]])
        self.assertIn("ETag", headers)
        self.assertNotIn("DEMO_KEY", json.dumps(manifest))

        repeat, repeat_headers, _raw = self.invoke("GET", "/api/v1/external-context")
        self.assertEqual(manifest, repeat)
        self.assertEqual(headers["ETag"], repeat_headers["ETag"])
        self.invoke("GET", "/api/v1/external-context?rows=1", status=400)

    def test_egrid_exact_resource_collision_etag_and_secret_absence(self):
        first = self.ingest(self.egrid_payload())
        self.assertRegex(first["content_version"], r"^xc1-[0-9a-f]{64}$")
        manifest, manifest_headers, _raw = self.invoke("GET", "/api/v1/external-context")
        selected = manifest["epa_egrid"]["selected"]
        self.assertEqual(first["content_version"], selected["content_version"])
        self.assertEqual(
            f"/api/v2/external-context/epa_egrid/v1/{first['content_version']}",
            selected["url"],
        )
        self.assertNotIn("external-context-receiver-key", json.dumps(manifest))
        self.assertNotIn("?api_key=", json.dumps(manifest).lower())

        resource, headers, raw = self.invoke("GET", selected["url"])
        self.assertEqual("external_context_resource", resource["kind"])
        self.assertEqual("epa_egrid", resource["stream"])
        self.assertEqual(
            [metric_id for metric_id, _header in xc.METRICS],
            [row["metric_id"] for row in resource["rates"]],
        )
        self.assertTrue(all(row["unit"] == "lb_mwh" for row in resource["rates"]))
        self.assertEqual(f'"{first["content_version"]}"', headers["ETag"])
        self.assertEqual("public, max-age=31536000, immutable", headers["Cache-Control"])
        self.assertNotIn("external-context-receiver-key", raw.decode())
        _none, not_modified_headers, not_modified_raw = self.invoke(
            "GET",
            selected["url"],
            headers={"If-None-Match": headers["ETag"]},
            status=304,
        )
        self.assertEqual(b"", not_modified_raw)
        self.assertEqual(headers["ETag"], not_modified_headers["ETag"])

        unchanged = self.egrid_payload(retrieved_at=1_999_000_100)
        self.assertEqual("unchanged", self.ingest(unchanged)["status"])
        collision = self.egrid_payload(retrieved_at=1_999_000_200)
        collision["resource"]["rates"][0]["value"] = 99.0
        error = self.ingest(collision, status=400)
        self.assertEqual("external_context_same_identity_collision", error["error"])
        stable, _headers, stable_raw = self.invoke("GET", selected["url"])
        self.assertEqual(resource, stable)
        self.assertEqual(raw, stable_raw)
        current, current_headers, _raw = self.invoke("GET", "/api/v1/external-context")
        self.assertEqual(selected["content_version"], current["epa_egrid"]["selected"]["content_version"])
        self.assertNotEqual(manifest_headers["ETag"], current_headers["ETag"])

    def test_stream_local_failure_recovery_and_generation_guard(self):
        self.ingest(self.egrid_payload())
        manifest, _headers, _raw = self.invoke("GET", "/api/v1/external-context")
        stale_generation = self.app.cache.snapshot_generation()

        failure = {
            "schema": 1,
            "kind": "external_context",
            "stream": "epa_egrid",
            "attempted_at": 2_000_000_001,
            "status": "failed",
            "reason": "official_source_fetch_or_parse_failed",
        }
        self.invoke(
            "POST",
            "/api/external-context/source-attempt",
            failure,
            headers={"X-API-Key": "external-context-receiver-key"},
        )
        failed, _headers, _raw = self.invoke("GET", "/api/v1/external-context")
        self.assertEqual("available", failed["epa_egrid"]["state"])
        self.assertEqual("failed", failed["source_health"][2]["state"])
        self.assertEqual("disabled", failed["source_health"][0]["state"])
        self.assertEqual("disabled", failed["source_health"][1]["state"])
        self.assertFalse(
            self.app.cache.set_if_generation(
                "external-context:v1",
                manifest,
                stale_generation,
                {"external-context"},
                ttl_seconds=15,
                category="external-context:resolver",
            )
        )

        server.now_ts = lambda: 2_000_000_002
        self.assertEqual("unchanged", self.ingest(self.egrid_payload(retrieved_at=1_999_000_100))["status"])
        recovered, _headers, _raw = self.invoke("GET", "/api/v1/external-context")
        health = recovered["source_health"][2]
        self.assertEqual("healthy", health["state"])
        self.assertEqual(0, health["consecutive_failures"])
        self.assertIsNone(health["last_error"])

        failure["attempted_at"] = 2_000_000_002
        equal, _headers, _raw = self.invoke(
            "POST",
            "/api/external-context/source-attempt",
            failure,
            headers={"X-API-Key": "external-context-receiver-key"},
        )
        self.assertEqual("unchanged", equal["status"])
        failure["attempted_at"] = 2_000_000_001
        older, _headers, _raw = self.invoke(
            "POST",
            "/api/external-context/source-attempt",
            failure,
            headers={"X-API-Key": "external-context-receiver-key"},
        )
        self.assertEqual("ignored_older", older["status"])

    def test_strict_egrid_release_table_unit_and_url_boundaries(self):
        cases = []
        bad_page = self.egrid_payload()
        bad_page["publication"]["source_page_url"] += "?download=1"
        cases.append(bad_page)
        bad_artifact = self.egrid_payload()
        bad_artifact["publication"]["artifact_url"] = "https://example.com/summary_tables_rev2.xlsx"
        cases.append(bad_artifact)
        bad_table = self.egrid_payload()
        bad_table["publication"]["table_title"] = "Subregion Output Emission Rates"
        cases.append(bad_table)
        bad_unit = self.egrid_payload()
        bad_unit["resource"]["rates"][0]["unit"] = "kg_mwh"
        cases.append(bad_unit)
        bad_order = self.egrid_payload()
        bad_order["resource"]["rates"].reverse()
        cases.append(bad_order)
        for payload in cases:
            with self.subTest(payload=payload):
                self.ingest(payload, status=400)

        unknown = "xc1-" + "f" * 64
        self.invoke("GET", f"/api/v2/external-context/epa_egrid/v1/{unknown}", status=404)
        self.invoke("GET", f"/api/v2/external-context/epa_egrid/v1/{unknown}?x=1", status=400)
        self.invoke("GET", "/api/v2/external-context/epa_egrid/v1/XC1-" + "f" * 64, status=400)

    def test_retention_keeps_ten_year_grace_and_at_least_five_versions(self):
        conn = server.get_db()
        now = 2_000_000_000
        cutoff = now - 10 * 365 * 86_400
        versions = []
        for index in range(1, 8):
            version = f"xc1-{index:064x}"
            versions.append(version)
            retired_at = cutoff + 1 if index == 2 else cutoff
            conn.execute(
                """INSERT INTO external_context_resources
                   (stream,identity,content_version,payload_json,retrieved_at,created_at,retired_at)
                   VALUES ('epa_egrid',?,?,?,?,?,?)""",
                (f"egrid:200{index}:0:2000-01-01:ERCT", version, "{}", index, index, retired_at),
            )
        xc.prune_external_context(conn, now)
        remaining = {
            row[0]
            for row in conn.execute(
                "SELECT content_version FROM external_context_resources WHERE stream='epa_egrid'"
            )
        }
        self.assertNotIn(versions[0], remaining)
        self.assertIn(versions[1], remaining)
        self.assertTrue(set(versions[-5:]).issubset(remaining))

        xc.prune_external_context(conn, now + 2)
        remaining = {
            row[0]
            for row in conn.execute(
                "SELECT content_version FROM external_context_resources WHERE stream='epa_egrid'"
            )
        }
        self.assertEqual(set(versions[-5:]), remaining)

    def test_enabled_eia_attempt_failure_is_honest_and_does_not_mutate_peer_health(self):
        attempt = {
            "schema": 1,
            "kind": "external_context",
            "stream": "eia930_demand",
            "attempted_at": 2_000_000_001,
            "status": "failed",
            "reason": "upstream_auth_rejected",
        }
        self.invoke(
            "POST",
            "/api/external-context/source-attempt",
            attempt,
            headers={"X-API-Key": "external-context-receiver-key"},
            status=200,
        )
        manifest, _headers, _raw = self.invoke("GET", "/api/v1/external-context")
        self.assertEqual("failed", manifest["eia_930"]["state"])
        self.assertEqual("failed", manifest["source_health"][0]["state"])
        self.assertEqual(1, manifest["source_health"][0]["consecutive_failures"])
        self.assertEqual("disabled", manifest["natural_gas"]["state"])
        self.assertEqual("disabled", manifest["source_health"][1]["state"])


if __name__ == "__main__":
    unittest.main()
