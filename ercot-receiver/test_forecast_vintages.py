import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime
from urllib.parse import quote, urlencode


SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("forecast_receiver_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load receiver")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)
fv = __import__("forecast_vintages")


def publication(product, vintage, issued=1_700_000_000, unit=None):
    raw_posted = None
    if product != fv.PRODUCT_NP6_345:
        raw_posted = datetime.fromtimestamp(issued, fv.CHICAGO).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
    contract = fv.SOURCE_CONTRACTS[product]
    query_window = {
        fv.PRODUCT_NP3_565: {
            "deliveryDateFrom": "2026-08-18",
            "deliveryDateTo": "2026-08-18",
        },
        fv.PRODUCT_NP3_763: {
            "deliveryDateFrom": "2026-08-18",
            "deliveryDateTo": "2026-08-18",
        },
        fv.PRODUCT_NP6_345: {
            "operatingDayFrom": "2026-08-18",
            "operatingDayTo": "2026-08-18",
        },
    }[product]
    result = {
        "source_id": contract["source_id"],
        "product_id": product,
        "issued_at": None if product == fv.PRODUCT_NP6_345 else issued,
        "published_at": None,
        "raw_posted_datetime": raw_posted,
        "retrieved_at": issued + 60,
        "artifact_href": contract["artifact_href"],
        "query_window": query_window,
        "parser_schema_version": fv.PARSER_SCHEMA_VERSION,
        "schema_fingerprint": fv.schema_fingerprint(product),
        "declared_unit": unit,
    }
    if product == fv.PRODUCT_NP6_345:
        result["publication_key_kind"] = "content_hash"
    else:
        result["publication_key_kind"] = "official_posted_datetime"
        result["publication_key"] = raw_posted
    return result


def publication_payload(product, vintage, rows, issued=1_700_000_000, unit=None):
    metadata = publication(product, vintage, issued, unit)
    copied_rows = json.loads(json.dumps(rows))
    if product != fv.PRODUCT_NP6_345:
        for row in copied_rows:
            row["postedDatetime"] = metadata["raw_posted_datetime"]
    return {"publication": metadata, "rows": copied_rows}


TARGET_1 = fv.market_hour_target("2026-08-18", "1:00", False)
TARGET_2 = fv.market_hour_target("2026-08-18", "2:00", False)


def row_565(
    target=TARGET_1,
    value=10,
    model="A3",
    in_use=True,
    dst=False,
    day="2026-08-18",
    hour="1:00",
):
    return {
        "target_ts": target,
        "postedDatetime": "",
        "deliveryDate": day,
        "hourEnding": hour,
        **{field: value for field in fv.NP3_565_MEASURES},
        "model": model,
        "inUseFlag": in_use,
        "DSTFlag": dst,
    }


def row_763(
    target=TARGET_1,
    value=20,
    repeated=False,
    day="2026-08-18",
    hour="01:00",
):
    return {
        "target_ts": target,
        "postedDatetime": "",
        "deliveryDate": day,
        "hourEnding": hour,
        **{field: value for field in fv.NP3_763_MEASURES},
        "repeatHourFlag": repeated,
    }


def row_345(
    target=TARGET_1,
    value=12,
    dst=False,
    day="2026-08-18",
    hour="01:00",
):
    return {
        "target_ts": target,
        "operatingDay": day,
        "hourEnding": hour,
        **{field: value for field in fv.NP6_345_MEASURES},
        "DSTFlag": dst,
    }


class ForecastStorageTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        fv.init_forecast_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def ingest(self, product, vintage, rows, issued=1_700_000_000, unit=None):
        return fv.ingest_forecast_publication(
            self.conn,
            publication_payload(product, vintage, rows, issued, unit),
            current_ts=issued + 120,
        )

    def test_migration_is_idempotent_and_builds_wide_target_indexes(self):
        fv.init_forecast_schema(self.conn)
        tables = {
            row[0]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        self.assertTrue(
            {
                "forecast_publications",
                "forecast_np3_565_rows",
                "forecast_np3_763_rows",
                "forecast_np6_345_rows",
            }.issubset(tables)
        )
        indexes = {
            row[0]: row[1]
            for row in self.conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            )
        }
        self.assertIn(
            "(target_ts, publication_id, model)",
            indexes["idx_forecast_np3_565_target"],
        )
        self.assertIn(
            "(target_ts, publication_id)",
            indexes["idx_forecast_np3_763_target"],
        )
        self.assertIn(
            "(target_ts, publication_id)",
            indexes["idx_forecast_np6_345_target"],
        )
        primary_key_columns = [
            row[1]
            for row in sorted(
                self.conn.execute("PRAGMA table_info(forecast_np3_565_rows)"),
                key=lambda value: value[5] or 99,
            )
            if row[5]
        ]
        self.assertEqual(
            primary_key_columns, ["publication_id", "target_ts", "model"]
        )
        publication_columns = {
            row[1]
            for row in self.conn.execute("PRAGMA table_info(forecast_publications)")
        }
        self.assertTrue(
            {"publication_key_kind", "publication_key"}.issubset(
                publication_columns
            )
        )

    def test_schema_fingerprints_bind_names_and_declared_types(self):
        self.assertEqual(
            {
                product: fv.schema_fingerprint(product)
                for product in fv.SUPPORTED_PRODUCTS
            },
            {
                fv.PRODUCT_NP3_565: "b5969c5ca165d78a4db53d2e549ee557bf2dc527251ca843fcd1a8ecb273c12e",
                fv.PRODUCT_NP3_763: "7ab50540a9d1e25999ada90fab00de34c75f0a8e3eeb2fdb1877f9d9d1ddfafc",
                fv.PRODUCT_NP6_345: "7102e5159262c2f02f1b5c049e3d0e7fa977785ee8461b9c5c9fcf783559e4c3",
            },
        )

    def test_immutable_content_replay_collision_and_distinct_correction_vintage(self):
        rows = [row_565(TARGET_2, model="B", hour="2:00"), row_565(TARGET_1, model="A")]
        first = self.ingest(fv.PRODUCT_NP3_565, "publication-1", rows)
        replay = self.ingest(
            fv.PRODUCT_NP3_565, "publication-1", list(reversed(rows))
        )
        self.assertEqual(first["status"], "inserted")
        self.assertEqual(replay["status"], "unchanged")
        self.assertEqual(first["content_hash"], replay["content_hash"])

        shifted_window = publication_payload(
            fv.PRODUCT_NP3_565, "publication-1", rows
        )
        shifted_window["publication"]["query_window"] = {
            "deliveryDateFrom": "2026-08-17",
            "deliveryDateTo": "2026-08-19",
        }
        shifted_replay = fv.ingest_forecast_publication(
            self.conn, shifted_window, current_ts=1_700_000_240
        )
        self.assertEqual(shifted_replay["status"], "unchanged")
        self.assertEqual(shifted_replay["content_hash"], first["content_hash"])
        first_seen = fv.list_publications(
            self.conn,
            shifted_window["publication"]["source_id"],
            fv.PRODUCT_NP3_565,
        )[0]
        self.assertEqual(
            first_seen["query_window"],
            {
                "deliveryDateFrom": "2026-08-18",
                "deliveryDateTo": "2026-08-18",
            },
        )

        changed = [*rows]
        changed[0] = row_565(TARGET_2, value=99, model="B", hour="2:00")
        with self.assertRaisesRegex(ValueError, "forecast_publication_collision"):
            self.ingest(fv.PRODUCT_NP3_565, "publication-1", changed)
        corrected = self.ingest(
            fv.PRODUCT_NP3_565, "publication-2", changed, issued=1_700_003_600
        )
        self.assertEqual(corrected["status"], "inserted")

        metadata_changed = publication_payload(
            fv.PRODUCT_NP3_565, "publication-1", rows
        )
        metadata_changed["publication"]["declared_unit"] = "MW"
        with self.assertRaisesRegex(ValueError, "forecast_publication_collision"):
            fv.ingest_forecast_publication(self.conn, metadata_changed)

    def test_exact_schema_fingerprint_types_and_atomic_failure(self):
        payload = publication_payload(fv.PRODUCT_NP3_565, "schema", [row_565()])
        payload["publication"]["schema_fingerprint"] = "wrong"
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            fv.ingest_forecast_publication(self.conn, payload)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM forecast_publications").fetchone()[0],
            0,
        )

        payload["publication"]["schema_fingerprint"] = fv.schema_fingerprint(
            fv.PRODUCT_NP3_565
        )
        payload["rows"][0]["unexpected"] = 1
        with self.assertRaisesRegex(ValueError, "schema_mismatch"):
            fv.ingest_forecast_publication(self.conn, payload)
        payload["rows"] = publication_payload(
            fv.PRODUCT_NP3_565, "schema", [row_565()]
        )["rows"]
        payload["rows"][0]["coast"] = float("nan")
        with self.assertRaisesRegex(ValueError, "invalid_coast"):
            fv.ingest_forecast_publication(self.conn, payload)

        mismatch = publication_payload(fv.PRODUCT_NP3_565, "time", [row_565()])
        mismatch["publication"]["issued_at"] += 1
        with self.assertRaisesRegex(ValueError, "issued_at_posted_datetime_mismatch"):
            fv.ingest_forecast_publication(self.conn, mismatch)
        ambiguous = publication_payload(fv.PRODUCT_NP3_565, "time", [row_565()])
        ambiguous["publication"]["raw_posted_datetime"] = "2025-11-02T01:30:00"
        ambiguous["publication"]["publication_key"] = "2025-11-02T01:30:00"
        with self.assertRaisesRegex(ValueError, "ambiguous_or_nonexistent"):
            fv.ingest_forecast_publication(self.conn, ambiguous)
        invalid_unit = publication_payload(fv.PRODUCT_NP3_565, "unit", [row_565()])
        invalid_unit["publication"]["declared_unit"] = "MWh"
        with self.assertRaisesRegex(ValueError, "unverified_declared_unit"):
            fv.ingest_forecast_publication(self.conn, invalid_unit)

        unknown_query = publication_payload(
            fv.PRODUCT_NP3_565, "query", [row_565()]
        )
        unknown_query["publication"]["query_window"] = {"apiKey": "secret"}
        with self.assertRaisesRegex(ValueError, "invalid_query_window_field"):
            fv.ingest_forecast_publication(self.conn, unknown_query)
        nested_query = publication_payload(
            fv.PRODUCT_NP3_565, "query", [row_565()]
        )
        nested_query["publication"]["query_window"] = {
            "deliveryDateFrom": {"nested": True}
        }
        with self.assertRaisesRegex(ValueError, "invalid_query_window_value"):
            fv.ingest_forecast_publication(self.conn, nested_query)
        poisoned_value = publication_payload(
            fv.PRODUCT_NP3_565, "query", [row_565()]
        )
        poisoned_value["publication"]["query_window"] = {
            "model": "sk_live_secret"
        }
        with self.assertRaisesRegex(ValueError, "invalid_query_window_value"):
            fv.ingest_forecast_publication(self.conn, poisoned_value)

    def test_query_window_is_product_specific_normalized_and_public_safe(self):
        for model in ("A3", "A6", "E", "E1", "E2", "E3", "M", "X"):
            self.assertEqual(
                json.loads(
                    fv._query_window_json(fv.PRODUCT_NP3_565, {"model": model})
                ),
                {"model": model},
            )
        payload = publication_payload(fv.PRODUCT_NP3_565, "window", [row_565()])
        payload["publication"]["query_window"] = {
            "size": 1000,
            "deliveryDateTo": "2026-08-18",
            "deliveryDateFrom": "2026-08-18",
        }
        result = fv.ingest_forecast_publication(self.conn, payload)
        selected = fv.resolve_publication(
            self.conn,
            payload["publication"]["source_id"],
            fv.PRODUCT_NP3_565,
            result["vintage_key"],
        )
        public = fv.list_publications(
            self.conn, payload["publication"]["source_id"], fv.PRODUCT_NP3_565
        )[0]
        self.assertEqual(
            list(public["query_window"]),
            ["deliveryDateFrom", "deliveryDateTo", "size"],
        )
        self.assertEqual(selected[9], json.dumps(public["query_window"], separators=(",", ":")))
        replay = json.loads(json.dumps(payload))
        replay["publication"]["query_window"] = {
            key: replay["publication"]["query_window"][key]
            for key in reversed(replay["publication"]["query_window"])
        }
        self.assertEqual(
            fv.ingest_forecast_publication(self.conn, replay)["status"], "unchanged"
        )

    def test_in_use_is_attribute_not_identity_and_empty_publication_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate_forecast_publication_row"):
            self.ingest(
                fv.PRODUCT_NP3_565,
                "duplicate-model",
                [row_565(in_use=False), row_565(in_use=True)],
            )
        with self.assertRaisesRegex(ValueError, "invalid_forecast_publication_row_count"):
            self.ingest(fv.PRODUCT_NP3_763, "valid-empty", [])

    def test_verified_wide_schemas_preserve_all_fields_and_flags(self):
        self.assertEqual(len(fv.VERIFIED_FIELD_ORDER[fv.PRODUCT_NP3_565]), 15)
        self.assertEqual(len(fv.VERIFIED_FIELD_ORDER[fv.PRODUCT_NP3_763]), 29)
        self.assertEqual(len(fv.VERIFIED_FIELD_ORDER[fv.PRODUCT_NP6_345]), 12)

        fall_false = fv.market_hour_target("2025-11-02", "2:00", False)
        fall_true = fv.market_hour_target("2025-11-02", "2:00", True)
        adequacy = row_763(
            fall_true,
            value=21,
            repeated=True,
            day="2025-11-02",
            hour="02:00",
        )
        actual = row_345(
            fall_true, value=31, dst=True, day="2025-11-02", hour="02:00"
        )
        adequacy_result = self.ingest(fv.PRODUCT_NP3_763, "adequacy", [adequacy])
        actual_result = self.ingest(fv.PRODUCT_NP6_345, "actual-wide", [actual])
        for product_id, vintage, ingest_result, expected in (
            (fv.PRODUCT_NP3_763, "adequacy", adequacy_result, adequacy),
            (fv.PRODUCT_NP6_345, "actual-wide", actual_result, actual),
        ):
            pub = fv.resolve_publication(
                self.conn,
                publication(product_id, vintage)["source_id"],
                product_id,
                ingest_result["vintage_key"],
            )
            rows = fv.publication_rows(self.conn, pub, fall_false, fall_true + 1)
            expected_output = {key: expected[key] for key in rows[0]}
            if product_id == fv.PRODUCT_NP3_763:
                expected_output["postedDatetime"] = publication(
                    product_id, vintage
                )["raw_posted_datetime"]
            self.assertEqual(rows, [expected_output])

    def test_late_forecast_is_stored_but_excluded_from_known_at_comparison(self):
        target = TARGET_1
        self.ingest(
            fv.PRODUCT_NP3_565,
            "late-publication",
            [row_565(target, 10)],
            issued=target + 100,
        )
        self.ingest(
            fv.PRODUCT_NP6_345,
            "unknown-unit-actual",
            [row_345(target, 12)],
            issued=300,
        )
        forecast_pub, actual_pub, rows = fv.comparison_rows(
            self.conn,
            publication(fv.PRODUCT_NP3_565, "late-publication")["source_id"],
            publication(fv.PRODUCT_NP6_345, "unknown-unit-actual")["source_id"],
            target + 100,
            target,
            target + 1,
            "A3",
            True,
            "systemTotal",
        )
        self.assertEqual(forecast_pub[4], target + 100)
        self.assertEqual(actual_pub, [])
        self.assertEqual(rows, [])

    def test_source_and_product_identity_are_not_silently_ambiguous(self):
        primary = publication_payload(
            fv.PRODUCT_NP3_565, "same-key", [row_565(value=10)], issued=100
        )
        fv.ingest_forecast_publication(self.conn, primary)
        selected = fv.list_publications(
            self.conn,
            primary["publication"]["source_id"],
            fv.PRODUCT_NP3_565,
        )
        self.assertEqual(
            [item["source_id"] for item in selected],
            [primary["publication"]["source_id"]],
        )
        unverified = json.loads(json.dumps(primary))
        unverified["publication"]["source_id"] = "other-source"
        with self.assertRaisesRegex(ValueError, "unverified_forecast_source_contract"):
            fv.ingest_forecast_publication(self.conn, unverified)
        unverified = json.loads(json.dumps(primary))
        unverified["publication"]["artifact_href"] += "/guessed"
        with self.assertRaisesRegex(ValueError, "unverified_forecast_source_contract"):
            fv.ingest_forecast_publication(self.conn, unverified)
        caller_named = json.loads(json.dumps(primary))
        caller_named["publication"]["vintage_key"] = "caller-chosen"
        with self.assertRaisesRegex(ValueError, "caller_vintage_key_not_allowed"):
            fv.ingest_forecast_publication(self.conn, caller_named)
        with self.assertRaisesRegex(ValueError, "unsupported_forecast_product"):
            fv.list_publications(self.conn, primary["publication"]["source_id"], "NP3-UNKNOWN")

    def test_fall_dst_repeated_he2_preserves_raw_flags_and_distinct_utc_targets(self):
        first = row_565(1_762_066_800, dst=False)
        second = row_565(1_762_070_400, dst=True)
        first["deliveryDate"] = second["deliveryDate"] = "2025-11-02"
        first["hourEnding"] = second["hourEnding"] = "2:00"
        ingested = self.ingest(fv.PRODUCT_NP3_565, "fall-back", [first, second])
        pub = fv.resolve_publication(
            self.conn,
            publication(fv.PRODUCT_NP3_565, "fall-back")["source_id"],
            fv.PRODUCT_NP3_565,
            ingested["vintage_key"],
        )
        rows = fv.publication_rows(self.conn, pub, 1_762_060_000, 1_762_080_000)
        self.assertEqual([row["target_ts"] for row in rows], [1_762_066_800, 1_762_070_400])
        self.assertEqual([row["DSTFlag"] for row in rows], [False, True])
        self.assertTrue(all(row["hourEnding"] == "2:00" for row in rows))
        self.assertEqual(
            fv.market_hour_target("2026-03-08", "1:00", False), 1_772_953_200
        )
        self.assertEqual(
            fv.market_hour_target("2026-03-08", "3:00", False), 1_772_956_800
        )
        self.assertEqual(
            fv.market_hour_target("2026-03-08", "24:00", False), 1_773_032_400
        )
        with self.assertRaisesRegex(ValueError, "invalid_market_hour_sequence"):
            fv.market_hour_target("2026-03-08", "2:00", False)
        with self.assertRaisesRegex(ValueError, "forecast_target_timestamp_mismatch"):
            self.ingest(
                fv.PRODUCT_NP6_345,
                "mismatch",
                [row_345(1_762_066_801, dst=False, day="2025-11-02", hour="02:00")],
            )

    def test_as_of_comparison_selects_no_future_issue_and_links_actual_provenance(self):
        target = TARGET_1
        early = self.ingest(fv.PRODUCT_NP3_565, "early", [row_565(target, 10)], issued=100, unit="MW")
        self.ingest(fv.PRODUCT_NP3_565, "future", [row_565(target, 20)], issued=200, unit="MW")
        actual = self.ingest(fv.PRODUCT_NP6_345, "actual", [row_345(target, 12)], issued=300, unit="MW")
        forecast_pub, actual_pubs, rows = fv.comparison_rows(
            self.conn,
            publication(fv.PRODUCT_NP3_565, "early")["source_id"],
            publication(fv.PRODUCT_NP6_345, "actual")["source_id"],
            150,
            target,
            target + 1,
            "A3",
            True,
            "systemTotal",
        )
        self.assertEqual(forecast_pub[3], early["vintage_key"])
        self.assertEqual(actual_pubs[0]["vintage_key"], actual["vintage_key"])
        self.assertEqual(rows[0]["selected_issued_at"], 100)
        self.assertEqual(rows[0]["forecast_value"], 10)
        self.assertEqual(rows[0]["actual_value"], 12)
        self.assertEqual(rows[0]["error"], 2)

        forecast_pub, _actual_pub, rows = fv.comparison_rows(
            self.conn,
            publication(fv.PRODUCT_NP3_565, "early")["source_id"],
            publication(fv.PRODUCT_NP6_345, "actual")["source_id"],
            50,
            target,
            target + 1,
            "A3",
            True,
            "systemTotal",
        )
        self.assertIsNone(forecast_pub)
        self.assertEqual(rows, [])

    def test_comparison_selects_latest_actual_snapshot_per_target(self):
        forecast = self.ingest(
            fv.PRODUCT_NP3_565,
            "two-hours",
            [row_565(TARGET_1, 10), row_565(TARGET_2, 20, hour="2:00")],
            issued=100,
            unit="MW",
        )
        first_actual = self.ingest(
            fv.PRODUCT_NP6_345,
            "first-hour",
            [row_345(TARGET_1, 11)],
            issued=300,
            unit="MW",
        )
        second_actual = self.ingest(
            fv.PRODUCT_NP6_345,
            "second-hour",
            [row_345(TARGET_2, 22, hour="02:00")],
            issued=400,
            unit="MW",
        )
        selected, actuals, rows = fv.comparison_rows(
            self.conn,
            fv.SOURCE_CONTRACTS[fv.PRODUCT_NP3_565]["source_id"],
            fv.SOURCE_CONTRACTS[fv.PRODUCT_NP6_345]["source_id"],
            100,
            TARGET_1,
            TARGET_2 + 1,
            "A3",
            True,
            "systemTotal",
        )
        self.assertEqual(selected[3], forecast["vintage_key"])
        self.assertEqual(
            {item["vintage_key"] for item in actuals},
            {first_actual["vintage_key"], second_actual["vintage_key"]},
        )
        self.assertEqual([row["actual_value"] for row in rows], [11, 22])

    def test_future_retrieval_cannot_poison_actual_selection(self):
        self.ingest(
            fv.PRODUCT_NP3_565,
            "forecast",
            [row_565(TARGET_1, 10)],
            issued=100,
            unit="MW",
        )
        trusted = self.ingest(
            fv.PRODUCT_NP6_345,
            "trusted",
            [row_345(TARGET_1, 12)],
            issued=900,
            unit="MW",
        )
        poisoned = publication_payload(
            fv.PRODUCT_NP6_345,
            "poisoned",
            [row_345(TARGET_1, 999)],
            issued=1_241,
            unit="MW",
        )
        with self.assertRaisesRegex(ValueError, "retrieved_at_in_future"):
            fv.ingest_forecast_publication(self.conn, poisoned, current_ts=1_000)
        _forecast, actuals, rows = fv.comparison_rows(
            self.conn,
            fv.SOURCE_CONTRACTS[fv.PRODUCT_NP3_565]["source_id"],
            fv.SOURCE_CONTRACTS[fv.PRODUCT_NP6_345]["source_id"],
            100,
            TARGET_1,
            TARGET_1 + 1,
            "A3",
            True,
            "systemTotal",
        )
        self.assertEqual(actuals[0]["vintage_key"], trusted["vintage_key"])
        self.assertEqual(rows[0]["actual_value"], 12)

    def test_outlook_selects_active_load_day_prior_revision_and_avail_cap_res(self):
        issued = 1_700_000_000
        self.ingest(
            fv.PRODUCT_NP3_565,
            "prior",
            [row_565(TARGET_1, 9), row_565(TARGET_2, 18, hour="2:00")],
            issued=issued - 86_400,
            unit="MW",
        )
        self.ingest(
            fv.PRODUCT_NP3_565,
            "current",
            [
                row_565(TARGET_1, 10),
                row_565(TARGET_1, 999, model="X", in_use=False),
                row_565(TARGET_2, 20, hour="2:00"),
            ],
            issued=issued,
            unit="MW",
        )
        adequacy_row = row_763(TARGET_1, 1)
        adequacy_row["availCapGen"] = 100
        adequacy_row["availCapRes"] = 30
        self.ingest(
            fv.PRODUCT_NP3_763,
            "adequacy",
            [adequacy_row],
            issued=issued + 60,
            unit="MW",
        )

        result = fv.outlook_snapshot(self.conn)

        self.assertEqual(
            [row["demand_mw"] for row in result["forecast"]["rows"]], [10, 20]
        )
        self.assertEqual(
            [row["revision_mw"] for row in result["forecast"]["rows"]], [1, 2]
        )
        self.assertEqual(result["adequacy"]["headroom_field"], "availCapRes")
        self.assertEqual(
            result["adequacy"]["rows"][0]["projected_headroom_mw"], 30
        )
        self.assertEqual(
            result["adequacy"]["rows"][0]["available_generation_mw"], 100
        )
        self.assertNotIn("capGenRes", result["adequacy"]["rows"][0])
        self.assertFalse(result["interpretation"]["official_ercot_status"])

    def test_outlook_rejects_ambiguous_active_models(self):
        self.ingest(
            fv.PRODUCT_NP3_565,
            "ambiguous",
            [row_565(model="A3"), row_565(model="X")],
            unit="MW",
        )
        with self.assertRaisesRegex(ValueError, "ambiguous_active_outlook_model"):
            fv.outlook_snapshot(self.conn)

    def test_outlook_revision_requires_same_model_and_target(self):
        issued = 1_700_000_000
        self.ingest(
            fv.PRODUCT_NP3_565,
            "prior-model",
            [row_565(value=9, model="X")],
            issued=issued - 86_400,
            unit="MW",
        )
        self.ingest(
            fv.PRODUCT_NP3_565,
            "current-model",
            [row_565(value=10, model="A3")],
            issued=issued,
            unit="MW",
        )

        result = fv.outlook_snapshot(self.conn)

        self.assertIsNotNone(result["forecast"]["revision_reference"])
        self.assertIsNone(result["forecast"]["rows"][0]["revision_mw"])

    def test_query_bounds_and_target_first_eqp(self):
        ingested = self.ingest(fv.PRODUCT_NP3_565, "eqp", [row_565()])
        plan = " ".join(
            str(part)
            for row in self.conn.execute(
                """
                EXPLAIN QUERY PLAN SELECT target_ts
                FROM forecast_np3_565_rows
                WHERE target_ts >= ? AND target_ts < ?
                ORDER BY target_ts
                """,
                (TARGET_1 - 1, TARGET_2),
            )
            for part in row
        )
        self.assertIn("idx_forecast_np3_565_target", plan)
        profile_plan = " ".join(
            str(part)
            for row in self.conn.execute(
                """
                EXPLAIN QUERY PLAN SELECT target_ts, model
                FROM forecast_np3_565_rows
                WHERE publication_id = ? AND target_ts >= ? AND target_ts < ?
                ORDER BY target_ts, model
                """,
                (1, TARGET_1 - 1, TARGET_2),
            )
            for part in row
        )
        self.assertIn("sqlite_autoindex_forecast_np3_565_rows_1", profile_plan)
        actual_plan = " ".join(
            str(part)
            for row in self.conn.execute(
                """
                EXPLAIN QUERY PLAN SELECT r.target_ts
                FROM forecast_np6_345_rows AS r
                     INDEXED BY idx_forecast_np6_345_target
                JOIN forecast_publications AS p ON p.id = r.publication_id
                WHERE p.source_id = ? AND p.product_id = ?
                  AND r.target_ts >= ? AND r.target_ts < ?
                """,
                (
                    fv.SOURCE_CONTRACTS[fv.PRODUCT_NP6_345]["source_id"],
                    fv.PRODUCT_NP6_345,
                    TARGET_1,
                    TARGET_2,
                ),
            )
            for part in row
        )
        self.assertIn("idx_forecast_np6_345_target", actual_plan)
        with self.assertRaisesRegex(ValueError, "invalid_target_window"):
            pub = fv.resolve_publication(
                self.conn,
                publication(fv.PRODUCT_NP3_565, "eqp")["source_id"],
                fv.PRODUCT_NP3_565,
                ingested["vintage_key"],
            )
            fv.publication_rows(self.conn, pub, 0, fv.MAX_TARGET_SPAN + 1)


class ForecastHttpTests(unittest.TestCase):
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
        self.original_api_key = server.API_KEY
        self.original_now_ts = server.now_ts
        server.API_KEY = "forecast-test-key"

    def tearDown(self):
        server.API_KEY = self.original_api_key
        server.now_ts = self.original_now_ts
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
        if method == "POST":
            handler.do_POST()
        else:
            handler.do_GET()
        self.assertEqual(handler.response_status, status)
        raw = handler.wfile.getvalue()
        return (None if not raw else json.loads(raw), handler.response_headers, raw)

    def test_authenticated_ingest_diagnostic_no_store_and_immutable_tile(self):
        data = publication_payload(
            fv.PRODUCT_NP3_565, "public:v1", [row_565(value=42)], unit="MW"
        )
        self.invoke("POST", "/api/forecast-publications/ingest", data, status=401)
        inserted, headers, _raw = self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            data,
            headers={"X-API-Key": "forecast-test-key"},
        )
        self.assertEqual(inserted["status"], "inserted")
        self.assertEqual(headers["Cache-Control"], "no-store")

        query = urlencode(
            {
                "source_id": data["publication"]["source_id"],
                "product_id": fv.PRODUCT_NP3_565,
            }
        )
        diagnostic, diagnostic_headers, _raw = self.invoke(
            "GET", f"/api/v1/forecast-publications?{query}"
        )
        self.assertEqual(diagnostic_headers["Cache-Control"], "no-store")
        self.assertEqual(
            diagnostic["publications"][0]["vintage_key"], inserted["vintage_key"]
        )
        self.assertNotIn("publication_id", inserted)

        path = (
            "/api/v2/forecast-publications/"
            + quote(data["publication"]["source_id"], safe="")
            + f"/{fv.PRODUCT_NP3_565}/"
            + quote(inserted["vintage_key"], safe="")
            + f"/1d/{TARGET_1 // 86_400 * 86_400}"
        )
        first, first_headers, first_raw = self.invoke("GET", path)
        second, second_headers, second_raw = self.invoke("GET", path)
        not_modified, third_headers, third_raw = self.invoke(
            "GET",
            path,
            headers={"If-None-Match": first_headers["ETag"]},
            status=304,
        )
        self.assertEqual(first["rows"][0]["systemTotal"], 42)
        self.assertEqual(first_raw, second_raw)
        self.assertIsNone(not_modified)
        self.assertEqual(third_raw, b"")
        self.assertEqual(first_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(second_headers["X-ERCOT-Cache"], "HIT")
        self.assertEqual({first_headers["ETag"], second_headers["ETag"], third_headers["ETag"]}, {first_headers["ETag"]})
        self.assertIn("immutable", first_headers["Cache-Control"])

    def test_outlook_is_bounded_cached_invalidated_and_weather_is_observation_only(self):
        auth = {"X-API-Key": "forecast-test-key"}
        issued = 1_700_000_000
        server.now_ts = lambda: issued + 180
        for name, value, publication_issued in (
            ("prior", 8, issued - 86_400),
            ("current", 10, issued),
        ):
            self.invoke(
                "POST",
                "/api/forecast-publications/ingest",
                publication_payload(
                    fv.PRODUCT_NP3_565,
                    name,
                    [row_565(value=value)],
                    publication_issued,
                    "MW",
                ),
                headers=auth,
            )
        adequacy = row_763(value=1)
        adequacy["availCapGen"] = 90
        adequacy["availCapRes"] = 25
        self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            publication_payload(
                fv.PRODUCT_NP3_763,
                "adequacy",
                [adequacy],
                issued + 60,
                "MW",
            ),
            headers=auth,
        )
        conn = server.get_db()
        server.ingest_metrics(
            conn,
            [
                {
                    "metric_name": "metar.temperature",
                    "tags": ["metar_code:KDFW"],
                    "points": [{"timestamp": issued, "value": 38}],
                }
            ],
            current_ts=issued,
        )
        server.update_source_health(
            conn,
            {
                "source_id": "metar",
                "display_name": "Aviation weather observations",
                "expected_interval_seconds": 300,
                "attempted_at": issued,
                "success": True,
                "data_timestamp_ts": issued,
                "row_count": 1,
            },
            current_ts=issued,
        )
        for product_id, display_name in (
            (fv.PRODUCT_NP3_565, "ERCOT seven-day load forecast"),
            (fv.PRODUCT_NP3_763, "ERCOT short-term system adequacy"),
        ):
            server.update_source_health(
                conn,
                {
                    "source_id": fv.SOURCE_CONTRACTS[product_id]["source_id"],
                    "display_name": display_name,
                    "expected_interval_seconds": 3_600,
                    "attempted_at": issued,
                    "success": True,
                    "source_timestamp_ts": issued,
                    "data_timestamp_ts": issued,
                    "availability_status": "available",
                    "row_count": 1,
                },
                current_ts=issued,
            )

        first, first_headers, first_raw = self.invoke("GET", "/api/v1/outlook")
        second, second_headers, second_raw = self.invoke("GET", "/api/v1/outlook")
        not_modified, not_modified_headers, not_modified_raw = self.invoke(
            "GET",
            "/api/v1/outlook",
            headers={"If-None-Match": first_headers["ETag"]},
            status=304,
        )

        self.assertEqual(first_raw, second_raw)
        self.assertEqual(first_headers["ETag"], second_headers["ETag"])
        self.assertEqual(first_headers["ETag"], not_modified_headers["ETag"])
        self.assertIsNone(not_modified)
        self.assertEqual(not_modified_raw, b"")
        self.assertEqual(first_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(second_headers["X-ERCOT-Cache"], "HIT")
        self.assertIn("must-revalidate", first_headers["Cache-Control"])
        self.assertEqual(first["forecast"]["rows"][0]["revision_mw"], 2)
        self.assertEqual(
            first["adequacy"]["rows"][0]["projected_headroom_mw"], 25
        )
        self.assertEqual(first["adequacy"]["headroom_field"], "availCapRes")
        self.assertEqual(
            first["forecast"]["source_health"]["availability_status"], "available"
        )
        self.assertEqual(first["forecast"]["source_health"]["freshness_state"], "fresh")
        self.assertEqual(
            first["adequacy"]["source_health"]["source_id"],
            fv.SOURCE_CONTRACTS[fv.PRODUCT_NP3_763]["source_id"],
        )
        self.assertEqual(
            first["weather_context"]["state"], "current_observations_only"
        )
        self.assertFalse(first["weather_context"]["forecast_driver_available"])
        self.assertIsNone(first["weather_context"]["driver"])
        self.assertEqual(first["weather_context"]["source"]["state"], "healthy")
        self.assertEqual(
            first["weather_context"]["source"]["freshness_state"], "fresh"
        )
        self.assertEqual(
            first["weather_context"]["source"]["availability_status"], None
        )
        self.assertEqual(first["weather_context"]["source"]["consecutive_failures"], 0)
        self.assertEqual(
            first["weather_context"]["observations"][0]["temperature_c"], 38
        )
        self.assertIsNone(first["interpretation"]["status"])
        self.invoke("GET", "/api/v1/outlook?days=7", status=400)

        server.now_ts = lambda: issued + 5_000
        for offset in (300, 600, 900):
            self.invoke(
                "POST",
                "/api/source-health",
                {
                    "source_id": "metar",
                    "display_name": "Aviation weather observations",
                    "expected_interval_seconds": 300,
                    "attempted_at": issued + offset,
                    "success": False,
                    "row_count": 0,
                    "error": "source_http_503",
                },
                headers=auth,
            )
        stale_weather, stale_headers, _raw = self.invoke("GET", "/api/v1/outlook")
        self.assertEqual(stale_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(stale_weather["weather_context"]["source"]["state"], "failed")
        self.assertEqual(
            stale_weather["weather_context"]["source"]["freshness_state"], "stale"
        )
        self.assertEqual(
            stale_weather["weather_context"]["source"]["consecutive_failures"], 3
        )

        self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            publication_payload(
                fv.PRODUCT_NP3_565,
                "new-current",
                [row_565(value=11)],
                issued + 120,
                "MW",
            ),
            headers=auth,
        )
        refreshed, refreshed_headers, _raw = self.invoke("GET", "/api/v1/outlook")
        self.assertEqual(refreshed_headers["X-ERCOT-Cache"], "MISS")
        self.assertEqual(refreshed["forecast"]["rows"][0]["demand_mw"], 11)

    def test_outlook_cold_concurrency_singleflights_one_generation(self):
        auth = {"X-API-Key": "forecast-test-key"}
        self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            publication_payload(
                fv.PRODUCT_NP3_565,
                "concurrent",
                [row_565(value=10)],
                unit="MW",
            ),
            headers=auth,
        )
        original = server.Handler._generate_outlook
        started = threading.Event()
        release = threading.Event()
        count_lock = threading.Lock()
        generation_count = 0
        all_entered = threading.Event()
        entered_count = 0
        original_do = self.app.singleflight.do

        def observed_do(*args, **kwargs):
            nonlocal entered_count
            with count_lock:
                entered_count += 1
                if entered_count == 10:
                    all_entered.set()
            return original_do(*args, **kwargs)

        self.app.singleflight.do = observed_do

        def delayed(handler):
            nonlocal generation_count
            with count_lock:
                generation_count += 1
            started.set()
            self.assertTrue(release.wait(5))
            return original(handler)

        server.Handler._generate_outlook = delayed
        results = []
        errors = []

        def request():
            try:
                results.append(self.invoke("GET", "/api/v1/outlook"))
            except Exception as error:
                errors.append(error)
            finally:
                conn = getattr(server.DB_LOCAL, "conn", None)
                if conn is not None:
                    conn.close()
                    delattr(server.DB_LOCAL, "conn")

        threads = [threading.Thread(target=request) for _index in range(10)]
        try:
            for thread in threads:
                thread.start()
            self.assertTrue(started.wait(5))
            self.assertTrue(all_entered.wait(5))
            release.set()
            for thread in threads:
                thread.join(5)
        finally:
            server.Handler._generate_outlook = original
            self.app.singleflight.do = original_do
            release.set()
        self.assertFalse(errors)
        self.assertEqual(generation_count, 1)
        self.assertEqual(len(results), 10)
        self.assertEqual(len({raw for _body, _headers, raw in results}), 1)
        self.assertEqual(
            sum(headers["X-ERCOT-Singleflight"] == "LEADER" for _body, headers, _raw in results),
            1,
        )
        self.assertEqual(
            sum(headers["X-ERCOT-Singleflight"] == "SHARED" for _body, headers, _raw in results),
            9,
        )

    def test_outlook_inflight_invalidation_cannot_repopulate_stale_cache(self):
        auth = {"X-API-Key": "forecast-test-key"}
        issued = 1_700_000_000
        self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            publication_payload(
                fv.PRODUCT_NP3_565,
                "race-old",
                [row_565(value=10)],
                issued,
                "MW",
            ),
            headers=auth,
        )
        original = server.Handler._generate_outlook
        old_generated = threading.Event()
        release_old = threading.Event()
        count_lock = threading.Lock()
        generation_count = 0

        def pause_first(handler):
            nonlocal generation_count
            with count_lock:
                generation_count += 1
                call = generation_count
            payload = original(handler)
            if call == 1:
                old_generated.set()
                self.assertTrue(release_old.wait(5))
            return payload

        server.Handler._generate_outlook = pause_first
        old_result = []
        errors = []

        def old_request():
            try:
                old_result.append(self.invoke("GET", "/api/v1/outlook"))
            except Exception as error:
                errors.append(error)
            finally:
                conn = getattr(server.DB_LOCAL, "conn", None)
                if conn is not None:
                    conn.close()
                    delattr(server.DB_LOCAL, "conn")

        thread = threading.Thread(target=old_request)
        try:
            thread.start()
            self.assertTrue(old_generated.wait(5))
            self.invoke(
                "POST",
                "/api/forecast-publications/ingest",
                publication_payload(
                    fv.PRODUCT_NP3_565,
                    "race-new",
                    [row_565(value=11)],
                    issued + 120,
                    "MW",
                ),
                headers=auth,
            )
            fresh, fresh_headers, _fresh_raw = self.invoke("GET", "/api/v1/outlook")
            release_old.set()
            thread.join(5)
        finally:
            server.Handler._generate_outlook = original
            release_old.set()
        self.assertFalse(errors)
        self.assertEqual(generation_count, 2)
        self.assertEqual(old_result[0][0]["forecast"]["rows"][0]["demand_mw"], 10)
        self.assertEqual(old_result[0][1]["X-ERCOT-Cache-Store"], "SKIPPED_RACE")
        self.assertEqual(fresh["forecast"]["rows"][0]["demand_mw"], 11)
        self.assertEqual(fresh_headers["X-ERCOT-Cache-Store"], "STORED")
        warm, warm_headers, _warm_raw = self.invoke("GET", "/api/v1/outlook")
        self.assertEqual(warm["forecast"]["rows"][0]["demand_mw"], 11)
        self.assertEqual(warm_headers["X-ERCOT-Cache"], "HIT")

    def test_forecast_ingest_has_reviewed_route_specific_one_mib_cap(self):
        self.assertEqual(server.MAX_FORECAST_BODY_BYTES, 1024 * 1024)
        within_forecast_cap = publication_payload(
            fv.PRODUCT_NP3_565, "large", [row_565()]
        )
        within_forecast_cap["publication"]["padding"] = "x" * (600 * 1024)
        body, headers, _raw = self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            within_forecast_cap,
            headers={"X-API-Key": "forecast-test-key"},
            status=400,
        )
        self.assertEqual(body, {"error": "invalid_publication_field"})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.invoke(
            "POST",
            "/api/source-health",
            within_forecast_cap,
            headers={"X-API-Key": "forecast-test-key"},
            status=413,
        )

        oversized = publication_payload(
            fv.PRODUCT_NP3_565, "oversized", [row_565()]
        )
        oversized["publication"]["padding"] = "x" * (1024 * 1024)
        body, headers, _raw = self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            oversized,
            headers={"X-API-Key": "forecast-test-key"},
            status=413,
        )
        self.assertEqual(body, {"error": "body_too_large"})
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_canonical_vintage_bytes_ignore_observational_provenance_across_databases(self):
        first_payload = publication_payload(
            fv.PRODUCT_NP3_565, "replica", [row_565(value=42)], unit="MW"
        )
        auth = {"X-API-Key": "forecast-test-key"}
        first_result, _headers, _raw = self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            first_payload,
            headers=auth,
        )
        path = (
            "/api/v2/forecast-publications/"
            + quote(first_payload["publication"]["source_id"], safe="")
            + f"/{fv.PRODUCT_NP3_565}/"
            + quote(first_result["vintage_key"], safe="")
            + f"/1d/{TARGET_1 // 86_400 * 86_400}"
        )
        first_body, first_headers, first_raw = self.invoke("GET", path)
        self.assertNotIn("retrieved_at", first_body["publication"])

        original_path = server.DB_PATH
        original_local = server.DB_LOCAL
        original_app = self.app
        with tempfile.TemporaryDirectory() as replica_directory:
            try:
                server.DB_PATH = str(Path(replica_directory) / "metrics.db")
                server.DB_LOCAL = threading.local()
                conn = sqlite3.connect(server.DB_PATH)
                server.init_db(conn)
                conn.close()
                self.app = type(
                    "ReplicaServer",
                    (),
                    {
                        "cache": server.Cache(60),
                        "cache_metrics": server.defaultdict(float),
                        "cache_metrics_lock": threading.Lock(),
                        "limiter": server.RateLimiter(),
                        "singleflight": server.SingleFlight(),
                    },
                )()
                replica_payload = json.loads(json.dumps(first_payload))
                replica_payload["publication"]["retrieved_at"] += 3_600
                replica_payload["publication"]["query_window"] = {
                    "deliveryDateFrom": "2026-08-17",
                    "deliveryDateTo": "2026-08-19",
                }
                replica_result, _headers, _raw = self.invoke(
                    "POST",
                    "/api/forecast-publications/ingest",
                    replica_payload,
                    headers=auth,
                )
                replica_body, replica_headers, replica_raw = self.invoke("GET", path)
                self.assertEqual(replica_result["vintage_key"], first_result["vintage_key"])
                self.assertEqual(replica_body, first_body)
                self.assertEqual(replica_raw, first_raw)
                self.assertEqual(replica_headers["ETag"], first_headers["ETag"])
                query = urlencode(
                    {
                        "source_id": replica_payload["publication"]["source_id"],
                        "product_id": fv.PRODUCT_NP3_565,
                    }
                )
                diagnostic, diagnostic_headers, _raw = self.invoke(
                    "GET", f"/api/v1/forecast-publications?{query}"
                )
                self.assertEqual(
                    diagnostic["publications"][0]["retrieved_at"],
                    replica_payload["publication"]["retrieved_at"],
                )
                self.assertEqual(diagnostic_headers["Cache-Control"], "no-store")
            finally:
                replica_conn = getattr(server.DB_LOCAL, "conn", None)
                if replica_conn is not None:
                    replica_conn.close()
                server.DB_PATH = original_path
                server.DB_LOCAL = original_local
                self.app = original_app

    def test_shifted_overlap_replay_and_checkpoint_advance_through_real_handlers(self):
        source_id = fv.SOURCE_CONTRACTS[fv.PRODUCT_NP3_565]["source_id"]
        first_payload = publication_payload(
            fv.PRODUCT_NP3_565, "overlap", [row_565(value=42)], unit="MW"
        )
        first_payload["publication"]["query_window"] = {
            "deliveryDateFrom": "2025-11-01",
            "deliveryDateTo": "2025-11-09",
            "postedDatetimeFrom": "2025-11-01T23:30:00",
            "postedDatetimeTo": "2025-11-02T00:30:00",
            "sort": "postedDatetime",
            "dir": "ASC",
        }
        second_payload = json.loads(json.dumps(first_payload))
        second_payload["publication"]["query_window"] = {
            "deliveryDateFrom": "2025-11-02",
            "deliveryDateTo": "2025-11-10",
            "postedDatetimeFrom": "2025-11-02T00:30:00",
            "postedDatetimeTo": "2025-11-02T02:30:00",
            "sort": "postedDatetime",
            "dir": "ASC",
        }
        auth = {"X-API-Key": "forecast-test-key"}
        first, _headers, _raw = self.invoke(
            "POST", "/api/forecast-publications/ingest", first_payload, headers=auth
        )
        self.assertEqual(first["status"], "inserted")

        for checkpoint_end in (1_762_056_000, 1_762_063_200):
            health = {
                "source_id": source_id,
                "display_name": "ERCOT NP3-565 weather-zone forecast",
                "expected_interval_seconds": 3600,
                "attempted_at": checkpoint_end,
                "success": True,
                "row_count": 1,
                "publication_mode": "polling",
                "publication_interval_seconds": 3600,
                "checkpoint": {
                    "version": 1,
                    "last_successful_window_end": checkpoint_end,
                },
                "availability_status": "available",
            }
            self.invoke("POST", "/api/source-health", health, headers=auth)
            checkpoint, checkpoint_headers, _raw = self.invoke(
                "GET",
                f"/api/source-checkpoint?{urlencode({'source_id': source_id})}",
                headers=auth,
            )
            self.assertEqual(
                checkpoint["checkpoint"],
                {
                    "version": 1,
                    "last_successful_window_end": checkpoint_end,
                },
            )
            self.assertEqual(checkpoint_headers["Cache-Control"], "no-store")
            if checkpoint_end == 1_762_056_000:
                replay, _headers, _raw = self.invoke(
                    "POST",
                    "/api/forecast-publications/ingest",
                    second_payload,
                    headers=auth,
                )
                self.assertEqual(replay["status"], "unchanged")
                self.assertEqual(replay["content_hash"], first["content_hash"])

    def test_comparison_is_explicit_bounded_no_lookahead_and_no_store(self):
        target = TARGET_1
        for vintage, issued, value in (("early", 100, 10), ("future", 200, 20)):
            self.invoke(
                "POST",
                "/api/forecast-publications/ingest",
                publication_payload(
                    fv.PRODUCT_NP3_565,
                    vintage,
                    [row_565(target, value)],
                    issued,
                    unit="MW",
                ),
                headers={"X-API-Key": "forecast-test-key"},
            )
        actual = publication(fv.PRODUCT_NP6_345, "actual", 300, unit="MW")
        self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            publication_payload(
                fv.PRODUCT_NP6_345, "actual", [row_345(target, 12)], 300, "MW"
            ),
            headers={"X-API-Key": "forecast-test-key"},
        )
        query = urlencode(
            {
                "forecast_source_id": publication(
                    fv.PRODUCT_NP3_565, "early"
                )["source_id"],
                "forecast_product_id": fv.PRODUCT_NP3_565,
                "actual_source_id": actual["source_id"],
                "actual_product_id": fv.PRODUCT_NP6_345,
                "as_of": 150,
                "target_start": target,
                "target_end": target + 1,
                "model": "A3",
                "in_use_flag": "true",
                "forecast_measure": "systemTotal",
            }
        )
        result, headers, _raw = self.invoke(
            "GET", f"/api/v1/forecast-comparison?{query}"
        )
        self.assertTrue(result["selected_forecast_vintage"].startswith("v1-"))
        self.assertEqual(result["selected_issued_at"], 100)
        self.assertEqual(result["actual_publications"][0]["published_at"], None)
        self.assertEqual(result["actual_publications"][0]["retrieved_at"], 360)
        self.assertEqual(result["rows"][0]["error"], 2)
        self.assertGreater(result["rows"][0]["horizon_seconds"], 0)
        self.assertEqual(
            result["rows"][0]["interpretation"], "known_at_diagnostic"
        )
        self.assertEqual(
            result["comparison_semantics"],
            "known_at_nonnegative_horizon_diagnostic",
        )
        self.assertEqual(headers["Cache-Control"], "no-store")

        missing_flag = query.replace("in_use_flag=true&", "")
        invalid, invalid_headers, _raw = self.invoke(
            "GET", f"/api/v1/forecast-comparison?{missing_flag}", status=400
        )
        self.assertEqual(invalid, {"error": "invalid_forecast_query"})
        self.assertEqual(invalid_headers["Cache-Control"], "no-store")

    def test_canonical_tile_rejects_noncanonical_paths_and_serves_adequacy(self):
        data = publication_payload(
            fv.PRODUCT_NP3_763, "adequacy:v1", [row_763()]
        )
        inserted, _headers, _raw = self.invoke(
            "POST",
            "/api/forecast-publications/ingest",
            data,
            headers={"X-API-Key": "forecast-test-key"},
        )
        path = (
            "/api/v2/forecast-publications/"
            + quote(data["publication"]["source_id"], safe="")
            + f"/{fv.PRODUCT_NP3_763}/"
            + quote(inserted["vintage_key"], safe="")
            + f"/1d/{TARGET_1 // 86_400 * 86_400}"
        )
        result, headers, _raw = self.invoke("GET", path)
        self.assertEqual(result["rows"][0]["capGenResSouth"], 20)
        self.assertEqual(result["publication"]["row_count"], 1)
        self.assertIn("immutable", headers["Cache-Control"])
        for malformed in (path + "?x=1", path.replace("/1d/", "/1h/"), path + "/extra"):
            body, bad_headers, _raw = self.invoke("GET", malformed, status=400)
            self.assertEqual(body, {"error": "invalid_canonical_forecast_tile"})
            self.assertEqual(bad_headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
