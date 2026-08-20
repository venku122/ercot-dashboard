import sqlite3
import unittest

from texas_grid import (
    FUEL_CODES,
    FUEL_LABELS,
    FUELS,
    KIND,
    PHASE_LABELS,
    PHASES,
    POLICY,
    ingest_texas_grid,
    init_texas_grid_schema,
    record_texas_grid_failure,
    texas_grid_manifest,
    texas_grid_resource,
)


NOW = 1_787_200_000


def publication(stream, published=NOW - 100, retrieved=NOW - 50):
    if stream == "gis":
        workbooks = [{"kind": "gis", "source_url": None, "sha256": "sha256:" + "1" * 64}]
        page = "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er"
    else:
        workbooks = [
            {"kind": "annual", "source_url": "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026.xlsx", "sha256": "sha256:" + "2" * 64},
            {"kind": "planned_monthly", "source_url": "https://www.ercot.com/files/docs/2026/08/07/Capacity-Changes-by-Fuel-Type-Charts_July_2026_PlannedMonthly.xlsx", "sha256": "sha256:" + "3" * 64},
        ]
        page = "https://www.ercot.com/gridinfo/resource"
    return {"source_period": "2026-07", "published_at": published, "retrieved_at": retrieved, "source_page_url": page, "workbooks": workbooks}


def gis_payload(published=NOW - 100, retrieved=NOW - 50, capacity=-7.2):
    return {
        "schema": 1, "kind": KIND, "stream": "gis",
        "publication": publication("gis", published, retrieved),
        "resource": {
            "unit": "MW", "statistic": "project_count_and_source_capacity_sum",
            "phases": [{"id": key, "label": label} for key, label in zip(PHASES, PHASE_LABELS)],
            "fuels": [{"code": code, "label": label} for code, label in zip(FUEL_CODES, FUEL_LABELS)],
            "aggregates": [{"phase": PHASES[0], "fuel": FUELS[0], "count": 1, "capacity_mw": capacity}],
            "limits": {"max_aggregates": 132},
        },
    }


class TexasGridTest(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        init_texas_grid_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_signed_gis_aggregate_and_manifest_resource(self):
        result = ingest_texas_grid(self.conn, gis_payload(), NOW)
        self.assertEqual(result["status"], "inserted")
        self.assertRegex(result["content_version"], r"^tg1-[0-9a-f]{64}$")
        resource = texas_grid_resource(self.conn, "gis", result["content_version"])
        self.assertEqual(resource["policy"], POLICY)
        self.assertEqual(resource["aggregates"][0]["capacity_mw"], -7.2)
        self.assertNotIn("document", str(resource).lower())
        manifest = texas_grid_manifest(self.conn, NOW)
        self.assertEqual(manifest["generator_interconnection"]["state"], "available")
        self.assertEqual(manifest["source_health"][0]["source_id"], "ercot_gis_report")
        self.assertEqual(manifest["resource_capacity_trend"]["selected"], None)

    def test_clock_correction_collision_and_reverse_replay(self):
        first = ingest_texas_grid(self.conn, gis_payload(), NOW)
        replay = ingest_texas_grid(self.conn, gis_payload(), NOW)
        self.assertEqual(replay["status"], "unchanged")
        with self.assertRaisesRegex(ValueError, "same_clock_collision"):
            ingest_texas_grid(self.conn, gis_payload(capacity=9), NOW)
        corrected = ingest_texas_grid(self.conn, gis_payload(retrieved=NOW - 40, capacity=9), NOW)
        self.assertEqual(corrected["status"], "inserted")
        old = texas_grid_resource(self.conn, "gis", first["content_version"])
        self.assertEqual(old["aggregates"][0]["capacity_mw"], -7.2)
        older = ingest_texas_grid(self.conn, gis_payload(published=NOW - 200, retrieved=NOW - 150), NOW)
        self.assertEqual(older["status"], "ignored_older")
        manifest = texas_grid_manifest(self.conn, NOW)
        self.assertEqual(manifest["generator_interconnection"]["selected"]["content_version"], corrected["content_version"])

    def test_queryless_public_shape_and_deferred_truth(self):
        manifest = texas_grid_manifest(self.conn, NOW)
        self.assertEqual(set(manifest), {"schema", "kind", "policy", "generated_at", "generator_interconnection", "resource_capacity_trend", "long_term_load_forecast", "large_load", "retirements", "source_health"})
        self.assertEqual(manifest["long_term_load_forecast"]["reason"], "units_not_authoritatively_frozen")
        self.assertEqual([row["source_id"] for row in manifest["source_health"]], ["ercot_gis_report", "ercot_resource_capacity_trend"])

    def test_delayed_or_duplicate_failure_cannot_regress_newer_success(self):
        ingest_texas_grid(self.conn, gis_payload(), NOW)
        self.assertEqual("unchanged", record_texas_grid_failure(self.conn, "gis", "late", NOW))
        self.assertEqual("ignored_older", record_texas_grid_failure(self.conn, "gis", "older", NOW - 1))
        health = texas_grid_manifest(self.conn, NOW)["source_health"][0]
        self.assertEqual("healthy", health["state"])
        self.assertEqual(0, health["consecutive_failures"])
        self.assertIsNone(health["last_error"])


if __name__ == "__main__":
    unittest.main()
