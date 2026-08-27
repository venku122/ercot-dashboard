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
SPEC = importlib.util.spec_from_file_location("texas_grid_acceptance_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
server = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server
SPEC.loader.exec_module(server)
tg = sys.modules[server.ingest_texas_grid.__module__]


class TexasGridSourceAcceptanceTests(unittest.TestCase):
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
        server.API_KEY = "texas-grid-key"
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
    def publication(stream, published_at=1_999_000_000, retrieved_at=1_999_000_100):
        if stream == "gis":
            page = "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er"
            workbooks = [{"kind": "gis", "source_url": None, "sha256": "sha256:" + "1" * 64}]
        else:
            page = "https://www.ercot.com/gridinfo/resource"
            workbooks = [
                {
                    "kind": "annual",
                    "source_url": "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026.xlsx",
                    "sha256": "sha256:" + "2" * 64,
                },
                {
                    "kind": "planned_monthly",
                    "source_url": "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026_PlannedMonthly.xlsx",
                    "sha256": "sha256:" + "3" * 64,
                },
            ]
        return {
            "source_period": "2026-07",
            "published_at": published_at,
            "retrieved_at": retrieved_at,
            "source_page_url": page,
            "workbooks": workbooks,
        }

    @staticmethod
    def gis_resource(capacity=-7.25):
        return {
            "unit": "MW",
            "statistic": "project_count_and_source_capacity_sum",
            "phases": [
                {"id": key, "label": label}
                for key, label in zip(tg.PHASES, tg.PHASE_LABELS)
            ],
            "fuels": [
                {"code": code, "label": label}
                for code, label in zip(tg.FUEL_CODES, tg.FUEL_LABELS)
            ],
            "aggregates": [
                {
                    "phase": "small_generator",
                    "fuel": "wind",
                    "count": 1,
                    "capacity_mw": 2.0,
                },
                {
                    "phase": "ss_started_fis_not_started_no_ia",
                    "fuel": "gas",
                    "count": 2,
                    "capacity_mw": capacity,
                },
            ],
            "limits": {"max_aggregates": 132},
        }

    @staticmethod
    def trend_resource(total=65.0):
        series = []
        for series_id, label in zip(tg.SERIES, tg.SERIES_LABELS):
            other = 2.0 if series_id == "gas_other" else None
            components = {
                "official_total_mw": total if series_id == "gas_other" else 63.0,
                "operational_mw": 10.0,
                "ia_financial_security_posted_mw": 20.0,
                "ia_no_financial_security_mw": 30.0,
                "other_planned_mw": other,
                "small_generator_mw": 3.0,
            }
            series.append(
                {
                    "series_id": series_id,
                    "label": label,
                    "annual": [{"year": 2026, **components}],
                    "planned_monthly": [{"month": "2026-07", **components}],
                }
            )
        return {
            "unit": "MW",
            "series": series,
            "limits": {
                "max_annual_rows_per_series": 100,
                "max_planned_monthly_rows_per_series": 120,
            },
        }

    def payload(self, stream, resource, **publication_clocks):
        return {
            "schema": 1,
            "kind": "texas_grid_long_horizon",
            "stream": stream,
            "publication": self.publication(stream, **publication_clocks),
            "resource": resource,
        }

    def ingest(self, payload, status=200):
        return self.invoke(
            "POST",
            "/api/texas-grid/ingest",
            payload,
            headers={"X-API-Key": "texas-grid-key"},
            status=status,
        )[0]

    def test_empty_manifest_has_fixed_unavailable_contract(self):
        manifest, headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual(
            {
                "schema",
                "kind",
                "policy",
                "generated_at",
                "generator_interconnection",
                "resource_capacity_trend",
                "long_term_load_forecast",
                "large_load",
                "retirements",
                "source_health",
            },
            set(manifest),
        )
        self.assertEqual("MISS", headers["X-ERCOT-Cache"])
        self.assertEqual({"state": "unavailable", "selected": None}, manifest["generator_interconnection"])
        self.assertEqual(3, len(manifest["source_health"]))
        self.assertEqual(
            "ercot_long_term_load_forecast", manifest["source_health"][2]["source_id"]
        )

    def test_signed_gis_registry_order_immutable_etag_and_collision(self):
        payload = self.payload("gis", self.gis_resource())
        first = self.ingest(payload)
        manifest, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        selected = manifest["generator_interconnection"]["selected"]
        self.assertEqual(first["content_version"], selected["content_version"])
        resource, headers, raw = self.invoke("GET", selected["url"])
        self.assertEqual(-7.25, resource["aggregates"][0]["capacity_mw"])
        self.assertEqual(
            "ss_started_fis_not_started_no_ia", resource["aggregates"][0]["phase"]
        )
        self.assertNotIn("doclookupId", json.dumps(resource))
        _none, not_modified, not_modified_raw = self.invoke(
            "GET", selected["url"], headers={"If-None-Match": headers["ETag"]}, status=304
        )
        self.assertEqual(b"", not_modified_raw)
        self.assertEqual(headers["ETag"], not_modified["ETag"])

        self.assertEqual("unchanged", self.ingest(payload)["status"])
        collision = self.payload("gis", self.gis_resource(-8.0))
        error = self.ingest(collision, status=400)
        self.assertEqual("texas_grid_same_clock_collision", error["error"])
        stable, _headers, stable_raw = self.invoke("GET", selected["url"])
        self.assertEqual(resource, stable)
        self.assertEqual(raw, stable_raw)

    def test_official_total_includes_every_present_component(self):
        accepted = self.payload("resource_capacity_trend", self.trend_resource())
        result = self.ingest(accepted)
        resource = tg.texas_grid_resource(
            server.get_db(), "resource_capacity_trend", result["content_version"]
        )
        gas_other = resource["series"][-1]["annual"][0]
        self.assertEqual(65.0, gas_other["official_total_mw"])
        self.assertEqual(65.0, sum(gas_other[key] or 0 for key in (
            "operational_mw",
            "ia_financial_security_posted_mw",
            "ia_no_financial_security_mw",
            "other_planned_mw",
            "small_generator_mw",
        )))

        invalid = self.payload("resource_capacity_trend", self.trend_resource(total=60.0))
        self.ingest(invalid, status=400)

    def test_exact_official_source_pages_are_required(self):
        payload = self.payload("gis", self.gis_resource())
        payload["publication"]["source_page_url"] = "https://www.ercot.com/unrelated"
        self.ingest(payload, status=400)

        mismatched = self.payload("resource_capacity_trend", self.trend_resource())
        mismatched["publication"]["workbooks"][0]["source_url"] = (
            "https://www.ercot.com/files/docs/2026/07/07/"
            "Capacity-Changes-by-Fuel-Type-Charts_June_2026.xlsx"
        )
        self.ingest(mismatched, status=400)

    def test_collector_failure_is_stream_local_and_success_recovers_health(self):
        gis = self.payload("gis", self.gis_resource())
        trend = self.payload("resource_capacity_trend", self.trend_resource())
        self.ingest(gis)
        self.ingest(trend)
        attempt = {
            "schema": 1,
            "stream": "gis",
            "status": "failed",
            "attempted_at": 2_000_000_001,
            "error": "official_source_fetch_or_parse_failed",
        }
        self.invoke(
            "POST",
            "/api/texas-grid/source-attempt",
            attempt,
            headers={"X-API-Key": "texas-grid-key"},
        )
        failed, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual("available", failed["generator_interconnection"]["state"])
        self.assertIsNotNone(failed["generator_interconnection"]["selected"])
        self.assertEqual("available", failed["resource_capacity_trend"]["state"])
        gis_health, trend_health, ltlf_health = failed["source_health"]
        self.assertEqual("failed", gis_health["state"])
        self.assertEqual(1, gis_health["consecutive_failures"])
        self.assertEqual("healthy", gis_health["materialization"]["state"])
        self.assertEqual("healthy", trend_health["state"])
        self.assertEqual(0, trend_health["consecutive_failures"])
        self.assertEqual("unavailable", ltlf_health["state"])

        trend["publication"]["retrieved_at"] += 1
        self.assertEqual("inserted", self.ingest(trend)["status"])
        after_peer, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual("failed", after_peer["source_health"][0]["state"])
        self.assertEqual("healthy", after_peer["source_health"][1]["state"])

        server.now_ts = lambda: 2_000_000_002
        self.ingest(gis)
        recovered, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual("available", recovered["generator_interconnection"]["state"])
        health = recovered["source_health"][0]
        self.assertEqual("healthy", health["state"])
        self.assertEqual(0, health["consecutive_failures"])
        self.assertIsNone(health["last_error"])
        self.assertEqual("healthy", health["materialization"]["state"])

        attempt["attempted_at"] = 2_000_000_002
        equal, _headers, _raw = self.invoke(
            "POST",
            "/api/texas-grid/source-attempt",
            attempt,
            headers={"X-API-Key": "texas-grid-key"},
        )
        self.assertEqual("unchanged", equal["status"])
        attempt["attempted_at"] = 2_000_000_001
        older, _headers, _raw = self.invoke(
            "POST",
            "/api/texas-grid/source-attempt",
            attempt,
            headers={"X-API-Key": "texas-grid-key"},
        )
        self.assertEqual("ignored_older", older["status"])
        current, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual("healthy", current["source_health"][0]["state"])
        self.assertEqual(0, current["source_health"][0]["consecutive_failures"])

    def test_retention_honors_grace_then_max_four_and_120_months(self):
        conn = server.get_db()
        now = 2_000_000_000
        cutoff = now - 365 * 86_400

        def add(version_number, period, published, retired):
            version = f"tg1-{version_number:064x}"
            conn.execute(
                """INSERT INTO texas_grid_resources
                   (stream,source_period,published_at,retrieved_at,content_version,
                    payload_json,created_at,retired_at)
                   VALUES ('gis',?,?,?,?,?,?,?)""",
                (period, published, published + 1, version, "{}", published, retired),
            )
            return version

        correction_versions = [
            add(index + 1, "2026-07", 10_000 + index * 2, cutoff)
            for index in range(6)
        ]
        tg.prune_texas_grid(conn, now)
        remaining = {
            row[0]
            for row in conn.execute(
                "SELECT content_version FROM texas_grid_resources WHERE source_period='2026-07'"
            )
        }
        self.assertEqual(set(correction_versions[-4:]), remaining)

        conn.execute("DELETE FROM texas_grid_resources")
        periods = []
        year, month = 2016, 1
        for _index in range(121):
            periods.append(f"{year:04d}-{month:02d}")
            month += 1
            if month == 13:
                year += 1
                month = 1
        for index, period in enumerate(periods):
            add(1_000 + index, period, 20_000 + index * 2, cutoff)
        grace_version = add(9_999, "1900-01", 1, cutoff + 1)
        tg.prune_texas_grid(conn, now)
        retained_periods = {
            row[0]
            for row in conn.execute("SELECT source_period FROM texas_grid_resources")
        }
        self.assertNotIn(periods[0], retained_periods)
        self.assertTrue(set(periods[1:]).issubset(retained_periods))
        self.assertEqual(
            (grace_version,),
            conn.execute(
                "SELECT content_version FROM texas_grid_resources WHERE source_period='1900-01'"
            ).fetchone(),
        )

    def test_materialization_failure_rolls_back_publication_before_failed_health(self):
        original = tg.prune_texas_grid
        tg.prune_texas_grid = lambda _conn, _now: (_ for _ in ()).throw(
            RuntimeError("injected_materialization_failure")
        )
        try:
            response = self.ingest(self.payload("gis", self.gis_resource()), status=500)
        finally:
            tg.prune_texas_grid = original

        self.assertEqual("texas_grid_ingest_failed", response["error"])
        conn = server.get_db()
        self.assertEqual(0, conn.execute("SELECT count(*) FROM texas_grid_resources").fetchone()[0])
        self.assertEqual(0, conn.execute("SELECT count(*) FROM texas_grid_current").fetchone()[0])
        manifest, _headers, _raw = self.invoke("GET", "/api/v1/texas-grid")
        self.assertEqual(
            {"state": "failed", "selected": None},
            manifest["generator_interconnection"],
        )
        health = manifest["source_health"][0]
        self.assertEqual("failed", health["state"])
        self.assertEqual("failed", health["materialization"]["state"])


if __name__ == "__main__":
    unittest.main()
