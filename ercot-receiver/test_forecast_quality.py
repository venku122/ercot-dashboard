import json
import io
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import forecast_quality as fq
import server
from forecast_vintages import init_forecast_schema, market_hour_target


DAY = 1_800_057_600  # UTC aligned


class ForecastQualityTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        init_forecast_schema(self.conn)
        fq.init_forecast_quality_schema(self.conn)
        self.next_id = 1

    def tearDown(self):
        self.conn.close()

    def publication(
        self,
        *,
        source,
        product,
        issued_at,
        retrieved_at,
        vintage,
        unit="MW",
    ):
        publication_id = self.next_id
        self.next_id += 1
        self.conn.execute(
            """
            INSERT INTO forecast_publications (
                id, source_id, product_id, vintage_key, issued_at, published_at,
                raw_posted_datetime, retrieved_at, artifact_href, query_window_json,
                parser_schema_version, schema_fingerprint, declared_unit, content_hash,
                row_count, created_at, publication_key_kind, publication_key
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, '{}', 'test', ?, ?, ?, 1, ?, 'test', ?)
            """,
            (
                publication_id,
                source,
                product,
                vintage,
                issued_at,
                retrieved_at,
                "https://example.test/artifact",
                "a" * 64,
                unit,
                "b" * 64,
                retrieved_at,
                vintage,
            ),
        )
        return publication_id

    def forecast(self, target, issued_at, value, *, model="A3", active=True, vintage=None):
        vintage = vintage or f"v1-forecast-{self.next_id}"
        publication_id = self.publication(
            source=fq.LOAD_FORECAST_SOURCE,
            product=fq.LOAD_FORECAST_PRODUCT,
            issued_at=issued_at,
            retrieved_at=issued_at + 60,
            vintage=vintage,
        )
        self.conn.execute(
            """
            INSERT INTO forecast_np3_565_rows (
                publication_id, target_ts, delivery_date, hour_ending, dst_flag,
                model, in_use_flag, system_total
            ) VALUES (?, ?, '2027-01-15', '1:00', 0, ?, ?, ?)
            """,
            (publication_id, target, model, int(active), value),
        )
        return publication_id

    def actual(self, target, value, *, retrieved_at, vintage=None, unit="MW"):
        vintage = vintage or f"v1-actual-{self.next_id}"
        publication_id = self.publication(
            source=fq.LOAD_ACTUAL_SOURCE,
            product=fq.LOAD_ACTUAL_PRODUCT,
            issued_at=None,
            retrieved_at=retrieved_at,
            vintage=vintage,
            unit=unit,
        )
        self.conn.execute(
            """
            INSERT INTO forecast_np6_345_rows (
                publication_id, target_ts, operating_day, hour_ending, dst_flag, total
            ) VALUES (?, ?, '2027-01-15', '1:00', 0, ?)
            """,
            (publication_id, target, value),
        )
        return publication_id

    def resource(self, horizon="1h"):
        result = fq.recompute_forecast_quality(
            self.conn, "load.system", DAY, current_ts=DAY + 100_000, horizons=[horizon]
        )[0]
        return fq.forecast_quality_resource(
            self.conn,
            "load.system",
            fq.METHODOLOGY_VERSION,
            result["content_version"],
            horizon,
            DAY,
        )

    def renewable_payload(
        self,
        *,
        product="NP4-732-CD",
        document="900001",
        issued_at=None,
        retrieved_at=None,
        forecast=90.0,
        actual=100.0,
    ):
        contract = fq.RENEWABLE_CONTRACTS[product]
        target = market_hour_target("2027-01-15", "02:00", False)
        issued_at = target - 3_600 if issued_at is None else issued_at
        retrieved_at = issued_at + 60 if retrieved_at is None else retrieved_at
        return {
            "publication": {
                "source_id": contract["source_id"],
                "product_id": product,
                "publication_key_kind": "official_mis_document",
                "publication_key": document,
                "issued_at": issued_at,
                "raw_publish_datetime": __import__("datetime").datetime.fromtimestamp(
                    issued_at, __import__("datetime").timezone.utc
                ).isoformat(),
                "document_id": document,
                "constructed_name": f"synthetic_{document}.zip",
                "artifact_href": (
                    "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId="
                    + document
                ),
                "retrieved_at": retrieved_at,
                "schema_fingerprint": contract["schema_fingerprint"],
                "parser_schema_version": "ercot-mis-renewable-v1",
                "declared_unit": "MW",
            },
            "rows": [
                {
                    "target_ts": target,
                    "delivery_date": "2027-01-15",
                    "hour_ending": "02:00",
                    "dst_flag": False,
                    "raw_delivery_date": "01/15/2027",
                    "raw_hour_ending": "2",
                    "raw_dst_flag": "N",
                    "forecast_mw": forecast,
                    "actual_hsl_mw": actual,
                }
            ],
        }

    def test_strict_renewable_ingest_replay_and_quality(self):
        payload = self.renewable_payload()
        first = fq.ingest_renewable_publication(
            self.conn, payload, current_ts=payload["publication"]["retrieved_at"]
        )
        second = fq.ingest_renewable_publication(
            self.conn, payload, current_ts=payload["publication"]["retrieved_at"]
        )
        self.assertEqual(first["status"], "inserted")
        self.assertEqual(second["status"], "unchanged")
        self.assertRegex(first["vintage_key"], r"^rv1-[0-9a-f]{64}$")
        target = payload["rows"][0]["target_ts"]
        day_start = target // fq.DAY_SECONDS * fq.DAY_SECONDS
        result = fq.recompute_forecast_quality(
            self.conn,
            "wind.stwpf",
            day_start,
            current_ts=target + 1_000,
            horizons=["1h"],
        )[0]
        resource = fq.forecast_quality_resource(
            self.conn, "wind.stwpf", "v1", result["content_version"], "1h", day_start
        )
        row = next(row for row in resource["rows"] if row["target_ts"] == target)
        self.assertEqual(row["model"], "STWPF")
        self.assertEqual(row["error_mw"], 10)

    def test_renewable_collision_and_contract_rejections(self):
        payload = self.renewable_payload()
        now = payload["publication"]["retrieved_at"]
        fq.ingest_renewable_publication(self.conn, payload, current_ts=now)
        changed = json.loads(json.dumps(payload))
        changed["rows"][0]["forecast_mw"] = 91
        with self.assertRaisesRegex(ValueError, "renewable_publication_collision"):
            fq.ingest_renewable_publication(self.conn, changed, current_ts=now)
        poison = json.loads(json.dumps(payload))
        poison["publication"]["artifact_href"] = "https://evil.test/secret"
        poison["publication"]["publication_key"] = "900002"
        poison["publication"]["document_id"] = "900002"
        with self.assertRaisesRegex(ValueError, "invalid_renewable_artifact_href"):
            fq.ingest_renewable_publication(self.conn, poison, current_ts=now)
        oversized = self.renewable_payload(document="900003", forecast=1_000_001)
        with self.assertRaisesRegex(ValueError, "invalid_renewable_measure"):
            fq.ingest_renewable_publication(
                self.conn, oversized, current_ts=oversized["publication"]["retrieved_at"]
            )

    def test_renewable_actual_prefers_newer_official_issue_over_late_retrieval(self):
        base = self.renewable_payload(document="900010", actual=100)
        target = base["rows"][0]["target_ts"]
        newer = self.renewable_payload(
            document="900011",
            issued_at=target - 3_600,
            retrieved_at=target - 3_000,
            forecast=90,
            actual=110,
        )
        older_late = self.renewable_payload(
            document="900012",
            issued_at=target - 7_200,
            retrieved_at=target - 1_000,
            forecast=80,
            actual=999,
        )
        for payload in (newer, older_late):
            fq.ingest_renewable_publication(
                self.conn, payload, current_ts=target + 100
            )
        day_start = target // fq.DAY_SECONDS * fq.DAY_SECONDS
        result = fq.recompute_forecast_quality(
            self.conn,
            "wind.stwpf",
            day_start,
            current_ts=target + 100,
            horizons=["1h"],
        )[0]
        resource = fq.forecast_quality_resource(
            self.conn, "wind.stwpf", "v1", result["content_version"], "1h", day_start
        )
        row = next(row for row in resource["rows"] if row["target_ts"] == target)
        self.assertEqual(row["actual_mw"], 110)

    def test_per_target_no_lookahead_latest_issue_and_formula(self):
        target = DAY + 7_200
        self.forecast(target, target - 1_000, 100)  # too new for 1h
        self.forecast(target, target - 3_600, 90, vintage="v1-selected")
        self.forecast(target, target - 7_200, 80, vintage="v1-prior")
        self.actual(target, 110, retrieved_at=target + 500)

        row = next(row for row in self.resource()["rows"] if row["target_ts"] == target)
        self.assertEqual(row["selected_issue_at"], target - 3_600)
        self.assertEqual(row["effective_lead_seconds"], 3_600)
        self.assertEqual(row["forecast_vintage_key"], "v1-selected")
        self.assertEqual(row["error_mw"], 20)
        self.assertEqual(row["absolute_error_mw"], 20)
        self.assertAlmostEqual(row["absolute_percentage_error"], 2000 / 110)
        self.assertEqual(row["revision_mw"], 10)

    def test_stale_lead_and_future_issue_are_not_used(self):
        target = DAY + 7_200
        self.forecast(target, target - 7_200, 80)
        self.forecast(target, target - 1_000, 999)
        self.actual(target, 100, retrieved_at=target + 1)
        row = next(row for row in self.resource()["rows"] if row["target_ts"] == target)
        self.assertEqual(row["missing_reason"], "lead_out_of_range")
        self.assertIsNone(row["error_mw"])

    def test_ambiguous_active_models_are_not_tie_broken(self):
        target = DAY + 7_200
        publication_id = self.forecast(target, target - 3_600, 80, model="A3")
        self.conn.execute(
            """
            INSERT INTO forecast_np3_565_rows (
                publication_id, target_ts, delivery_date, hour_ending, dst_flag,
                model, in_use_flag, system_total
            ) VALUES (?, ?, '2027-01-15', '1:00', 0, 'A6', 1, 81)
            """,
            (publication_id, target),
        )
        self.actual(target, 100, retrieved_at=target + 1)
        row = next(row for row in self.resource()["rows"] if row["target_ts"] == target)
        self.assertEqual(row["missing_reason"], "ambiguous_active_model")

    def test_latest_actual_correction_advances_version_and_preserves_old_body(self):
        target = DAY + 7_200
        self.forecast(target, target - 3_600, 90)
        self.actual(target, 100, retrieved_at=target + 1, vintage="actual-1")
        first_result = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=DAY + 100_000,
            dataset_cutoff=target + 1,
            horizons=["1h"],
        )[0]
        first = fq.forecast_quality_resource(
            self.conn, "load.system", "v1", first_result["content_version"], "1h", DAY
        )
        self.actual(target, 105, retrieved_at=target + 2, vintage="actual-2")
        second_result = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=DAY + 100_001,
            dataset_cutoff=target + 2,
            horizons=["1h"],
        )[0]
        second = fq.forecast_quality_resource(
            self.conn, "load.system", "v1", second_result["content_version"], "1h", DAY
        )
        first_again = fq.forecast_quality_resource(
            self.conn, "load.system", "v1", first_result["content_version"], "1h", DAY
        )
        self.assertNotEqual(first_result["content_version"], second_result["content_version"])
        self.assertEqual(first, first_again)
        first_row = next(row for row in first["rows"] if row["target_ts"] == target)
        second_row = next(row for row in second["rows"] if row["target_ts"] == target)
        self.assertEqual(first_row["actual_mw"], 100)
        self.assertEqual(second_row["actual_mw"], 105)

    def test_older_cutoff_recompute_cannot_regress_current_pointer(self):
        target = DAY + 7_200
        self.forecast(target, target - 3_600, 90)
        self.actual(target, 100, retrieved_at=target + 1, vintage="actual-old")
        self.actual(target, 120, retrieved_at=target + 2, vintage="actual-new")
        newest = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=target + 100,
            dataset_cutoff=target + 2,
            horizons=["1h"],
        )[0]
        older = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=target + 101,
            dataset_cutoff=target + 1,
            horizons=["1h"],
        )[0]
        self.assertNotEqual(newest["content_version"], older["content_version"])
        current = self.conn.execute(
            """
            SELECT content_version, dataset_cutoff FROM forecast_quality_current
            WHERE series_key='load.system' AND horizon='1h' AND day_start=?
            """,
            (DAY,),
        ).fetchone()
        self.assertEqual(current, (newest["content_version"], target + 2))

    def test_recompute_is_idempotent_and_manifest_is_bounded(self):
        target = DAY + 7_200
        self.forecast(target, target - 3_600, 90)
        self.actual(target, 100, retrieved_at=target + 1)
        first = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=DAY + 100_000,
            horizons=["1h"],
        )
        second = fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY,
            current_ts=DAY + 100_001,
            horizons=["1h"],
        )
        self.assertEqual(first[0]["content_version"], second[0]["content_version"])
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM forecast_quality_resources").fetchone()[0],
            1,
        )
        manifest = fq.forecast_quality_manifest(self.conn, now=DAY + fq.DAY_SECONDS)
        self.assertEqual(len(manifest["resources"]), 1)
        self.assertIn(first[0]["content_version"], manifest["resources"][0]["url"])
        json.dumps(manifest, allow_nan=False)
        manifest_again = fq.forecast_quality_manifest(
            self.conn, now=DAY + fq.DAY_SECONDS
        )
        self.assertEqual(fq.canonical_json(manifest), fq.canonical_json(manifest_again))

        before_summary = next(
            item
            for item in manifest["summaries"]
            if item["series_key"] == "load.system" and item["horizon"] == "1h"
        )["summary"]
        fq.recompute_forecast_quality(
            self.conn,
            "load.system",
            DAY + 7 * fq.DAY_SECONDS,
            current_ts=DAY + fq.DAY_SECONDS,
            horizons=["1h"],
        )
        after = fq.forecast_quality_manifest(self.conn, now=DAY + fq.DAY_SECONDS)
        after_summary = next(
            item
            for item in after["summaries"]
            if item["series_key"] == "load.system" and item["horizon"] == "1h"
        )["summary"]
        self.assertEqual(before_summary, after_summary)

    def test_statistics_use_separate_counts_type7_and_qualification(self):
        rows = []
        start = DAY - 40 * fq.DAY_SECONDS
        for index in range(120):
            error = float(index - 60)
            actual = 0.0 if index == 0 else 100.0
            rows.append(
                {
                    "target_ts": start + index * 21_600,
                    "delivery_date": f"2027-01-{index % 31 + 1:02d}",
                    "error_mw": error,
                    "absolute_error_mw": abs(error),
                    "absolute_percentage_error": None
                    if actual == 0
                    else abs(error),
                }
            )
        summary = fq.summarize_rows(rows, expected_count=125)
        self.assertEqual(summary["sample_count"], 120)
        self.assertEqual(summary["mape_sample_count"], 119)
        self.assertAlmostEqual(summary["joint_coverage"], 0.96)
        self.assertEqual(summary["signed_error_quantiles_mw"]["p50"], -0.5)
        self.assertTrue(summary["qualification"]["qualified"])
        self.assertIsNotNone(summary["empirical_interval"])

    def test_schema_and_query_plan_are_bounded_by_target(self):
        fq.init_forecast_quality_schema(self.conn)
        indexes = {
            row[1] for row in self.conn.execute("PRAGMA index_list(forecast_np3_565_rows)")
        }
        self.assertIn("idx_forecast_np3_565_quality_target", indexes)
        plan = " ".join(
            str(item)
            for row in self.conn.execute(
                """
                EXPLAIN QUERY PLAN SELECT target_ts FROM forecast_np3_565_rows
                INDEXED BY idx_forecast_np3_565_quality_target
                WHERE target_ts >= ? AND target_ts < ?
                """,
                (DAY, DAY + fq.DAY_SECONDS),
            )
            for item in row
        )
        self.assertIn("idx_forecast_np3_565_quality_target", plan)
        self.assertIn("target_ts>?", plan)

    def test_manifest_exactly_bounds_ninety_completed_days_at_midday_and_midnight(self):
        rows = [
            fq._missing_row(DAY + index * 3_600, "2027-01-15", "missing_forecast")
            for index in range(24)
        ]
        for offset in range(-90, 1):
            day_start = DAY + offset * fq.DAY_SECONDS
            shifted = [
                {**row, "target_ts": day_start + index * 3_600}
                for index, row in enumerate(rows)
            ]
            for series_key in fq.SERIES_KEYS:
                for horizon in fq.HORIZONS:
                    payload = fq._resource_payload(
                        series_key, horizon, day_start, shifted
                    )
                    content_version = "q1-" + __import__("hashlib").sha256(
                        fq.canonical_json(payload).encode()
                    ).hexdigest()
                    payload["content_version"] = content_version
                    self.conn.execute(
                        """
                        INSERT INTO forecast_quality_resources VALUES (?, 'v1', ?, ?, ?, ?, ?)
                        """,
                        (
                            series_key,
                            content_version,
                            horizon,
                            day_start,
                            fq.canonical_json(payload),
                            DAY,
                        ),
                    )
                    self.conn.execute(
                        """
                        INSERT INTO forecast_quality_current VALUES (?, 'v1', ?, ?, ?, ?, ?)
                        """,
                        (series_key, horizon, day_start, content_version, DAY, DAY),
                    )
        self.conn.commit()
        midnight = fq.forecast_quality_manifest(
            self.conn, now=DAY + fq.DAY_SECONDS
        )
        midday = fq.forecast_quality_manifest(
            self.conn, now=DAY + fq.DAY_SECONDS + 43_200
        )
        self.assertEqual(len(midnight["resources"]), 810)
        self.assertEqual(midnight["resources"], midday["resources"])
        counts = __import__("collections").Counter(
            (item["series_key"], item["horizon"])
            for item in midnight["resources"]
        )
        self.assertEqual(set(counts.values()), {90})
        self.assertTrue(
            all(
                item["day_start"] >= DAY - 89 * fq.DAY_SECONDS
                for item in midnight["resources"]
            )
        )


class ForecastQualityHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = str(Path(self.tmp.name) / "quality.db")
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
        server.API_KEY = "quality-key"
        server.now_ts = lambda: DAY + 100_000

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
        handler.send_response = lambda value: setattr(
            handler, "response_status", value
        )
        handler.response_headers = {}
        handler.send_header = lambda key, value: handler.response_headers.__setitem__(
            key, value
        )
        handler.end_headers = lambda: None
        getattr(handler, f"do_{method}")()
        self.assertEqual(handler.response_status, status)
        raw = handler.wfile.getvalue()
        return (None if not raw else json.loads(raw), handler.response_headers, raw)

    def test_manifest_and_immutable_resource_etag(self):
        conn = sqlite3.connect(server.DB_PATH)
        result = fq.recompute_forecast_quality(
            conn,
            "load.system",
            DAY,
            current_ts=DAY + 100_000,
            horizons=["1h"],
        )[0]
        conn.close()
        manifest, headers, first_raw = self.invoke("GET", "/api/v1/forecast-quality")
        self.assertEqual(headers["X-ERCOT-Cache"], "MISS")
        resource_url = next(
            item["url"]
            for item in manifest["resources"]
            if item["content_version"] == result["content_version"]
        )
        resource, resource_headers, resource_raw = self.invoke("GET", resource_url)
        self.assertEqual(resource["content_version"], result["content_version"])
        self.assertIn("immutable", resource_headers["Cache-Control"])
        etag = resource_headers["ETag"]
        warm, warm_headers, warm_raw = self.invoke("GET", resource_url)
        self.assertEqual(resource, warm)
        self.assertEqual(resource_raw, warm_raw)
        self.assertEqual(warm_headers["ETag"], etag)
        not_modified, not_modified_headers, not_modified_raw = self.invoke(
            "GET", resource_url, headers={"If-None-Match": etag}, status=304
        )
        self.assertIsNone(not_modified)
        self.assertEqual(not_modified_raw, b"")
        self.assertEqual(not_modified_headers["ETag"], etag)

    def test_recompute_is_authenticated_and_strict(self):
        self.invoke(
            "POST",
            "/api/forecast-quality/recompute",
            {"series_key": "load.system", "day_start": DAY},
            status=401,
        )
        result, headers, _raw = self.invoke(
            "POST",
            "/api/forecast-quality/recompute",
            {"series_key": "load.system", "day_start": DAY, "horizons": ["1h"]},
            headers={"X-API-Key": "quality-key"},
        )
        self.assertEqual(len(result["resources"]), 1)
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_recompute_rejects_cutoff_poison_without_moving_pointer(self):
        for cutoff in (-1, DAY + 100_001):
            self.invoke(
                "POST",
                "/api/forecast-quality/recompute",
                {
                    "series_key": "load.system",
                    "day_start": DAY,
                    "horizons": ["1h"],
                    "dataset_cutoff": cutoff,
                },
                headers={"X-API-Key": "quality-key"},
                status=400,
            )
        conn = sqlite3.connect(server.DB_PATH)
        self.assertEqual(
            conn.execute("SELECT COUNT(*) FROM forecast_quality_current").fetchone()[0],
            0,
        )
        conn.close()

    def test_renewable_handler_contract(self):
        helper = ForecastQualityTest("test_strict_renewable_ingest_replay_and_quality")
        helper.setUp()
        try:
            payload = helper.renewable_payload(retrieved_at=DAY + 99_000)
        finally:
            helper.tearDown()
        result, headers, _raw = self.invoke(
            "POST",
            "/api/renewable-publications/ingest",
            payload,
            headers={"X-API-Key": "quality-key"},
        )
        self.assertEqual(result["status"], "inserted")
        self.assertRegex(result["vintage_key"], r"^rv1-[0-9a-f]{64}$")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_manifest_marks_stopped_load_and_renewable_collectors_delayed(self):
        conn = sqlite3.connect(server.DB_PATH)
        old = DAY
        for source_id in (
            fq.LOAD_FORECAST_SOURCE,
            "ercot_mis_np4_732",
            "ercot_mis_np4_737",
        ):
            server.update_source_health(
                conn,
                {
                    "source_id": source_id,
                    "display_name": source_id,
                    "expected_interval_seconds": 3_600,
                    "publication_mode": "event",
                    "publication_interval_seconds": 3_600,
                    "attempted_at": old,
                    "success": True,
                    "availability_status": "available",
                    "source_timestamp_ts": old,
                    "data_timestamp_ts": old,
                },
                current_ts=old,
            )
        manifest = fq.forecast_quality_manifest(conn, now=old + 10_800)
        conn.close()
        health = {
            item["source_id"]: item
            for contract in manifest["source_contracts"]
            for item in contract["health"]
        }
        self.assertEqual(health[fq.LOAD_FORECAST_SOURCE]["state"], "delayed")
        self.assertEqual(health["ercot_mis_np4_732"]["state"], "delayed")
        self.assertEqual(health["ercot_mis_np4_732"]["freshness_state"], "event_driven")


if __name__ == "__main__":
    unittest.main()
