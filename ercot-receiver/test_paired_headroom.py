"""Raw-pair oracle and canonical lifecycle regressions for observed headroom."""
import json
import sqlite3
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import test_server as fixtures

server = fixtures.server


class PairedHeadroomTests(unittest.TestCase):
    setUp = fixtures.HttpQueryBoundsTests.setUp
    tearDown = fixtures.HttpQueryBoundsTests.tearDown
    invoke = fixtures.HttpQueryBoundsTests.invoke
    ingest_metric = fixtures.HttpQueryBoundsTests.ingest_metric
    path = "/api/v2/tiles/supply-demand.paired-headroom/1d/86400/1h"

    def test_paired_catalog_is_explicitly_opted_in_without_changing_legacy_schema(self):
        legacy, legacy_headers = self.invoke("GET", "/api/v2/tile-catalog")
        self.assertNotIn("supply-demand.paired-headroom", {entry["key"] for entry in legacy["series"]})
        old_keys = {"key", "match", "metric", "native_interval_seconds", "rollup", "source", "statistic_policy", "supported_lods", "tags", "unit"}
        for entry in legacy["series"]:
            self.assertEqual(set(entry), old_keys)
            self.assertIn(entry["match"], ("exact", "selector"))
        opted, opted_headers = self.invoke("GET", "/api/v2/tile-catalog?include=paired-headroom")
        entries = [entry for entry in opted["series"] if entry["match"] == "paired"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["key"], "supply-demand.paired-headroom")
        self.assertEqual({**opted, "series": [entry for entry in opted["series"] if entry["match"] != "paired"]}, legacy)
        self.assertNotEqual(legacy_headers["ETag"], opted_headers["ETag"])
        self.invoke("GET", "/api/v2/tile-catalog?include=paired-headroom", request_headers={"If-None-Match": legacy_headers["ETag"]})
        body, headers = self.invoke("GET", "/api/v2/tile-catalog?include=paired-headroom", request_headers={"If-None-Match": opted_headers["ETag"]}, expected_status=304)
        self.assertIsNone(body)
        self.assertEqual(headers["ETag"], opted_headers["ETag"])
        for query in ("include=other", "include=paired-headroom&include=paired-headroom", "include=", "unknown=1"):
            self.invoke("GET", "/api/v2/tile-catalog?" + query, expected_status=400)

    def contributor(self, side, values, source="supply_demand"):
        metric = f"ercot.supply_demand.{side}_mw"
        points = [{"timestamp": ts, "value": value, "dedupe_key": f"{side}:{source}:{ts}"} for ts, value in values]
        with mock.patch.object(server, "API_KEY", "paired-test"):
            return self.invoke("POST", "/api/ingest", [{"metric_name": metric, "tags": [f"source:{source}"], "points": points}], {"X-API-Key": "paired-test"})

    def seed(self):
        self.contributor("available_capacity", [(90000, 100), (90300, 200), (90600, 0), (90900, 150)])
        self.contributor("demand", [(90000, 90), (90300, 195), (90600, 10), (91200, 999)])

    def test_pair_before_aggregate_matches_independent_raw_oracle(self):
        self.seed()
        payload, _ = self.invoke("GET", self.path)
        raw_capacity = {90000: 100, 90300: 200, 90600: 0, 90900: 150}
        raw_demand = {90000: 90, 90300: 195, 90600: 10, 91200: 999}
        oracle = [(ts, raw_capacity[ts] - raw_demand[ts]) for ts in sorted(raw_capacity.keys() & raw_demand.keys())]
        state = payload["buckets"][0]["state"]
        self.assertEqual(state["count"], len(oracle))
        self.assertEqual(state["value_sum"], sum(value for _, value in oracle))
        self.assertEqual((state["minimum"], state["minimum_ts"]), (-10, 90600))
        self.assertEqual((state["maximum"], state["maximum_ts"]), (10, 90000))
        self.assertEqual(payload["statistic_policy"], "gauge")
        self.assertEqual(payload["pairing"]["policy"], "supply-demand-observed-exact-epoch-v1")
        self.assertEqual(payload["pairing"]["paired_count"], 3)
        self.assertEqual(payload["pairing"]["unpaired_count"], 2)
        self.assertEqual(payload["pairing"]["expected_count"], 288)

    def test_same_width_wrong_source_does_not_pair(self):
        self.contributor("available_capacity", [(90000, 100)])
        self.contributor("demand", [(90000, 90)], source="ercot_realtime")
        payload, _ = self.invoke("GET", self.path)
        self.assertEqual(payload["buckets"], [])
        self.assertEqual(payload["pairing"]["reason"], "missing_compatible_contributor")

    def test_duplicate_native_epoch_is_unavailable_not_cartesian_product(self):
        self.seed()
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute("INSERT INTO metrics(metric_name,ts,value,tags,series_id) SELECT metric_name,ts,999,tags,series_id FROM metrics WHERE metric_name='ercot.supply_demand.demand_mw' AND ts=90300")
        payload, _ = self.invoke("GET", self.path)
        state = payload["buckets"][0]["state"]
        self.assertEqual(state["count"], 2)
        self.assertEqual(payload["pairing"]["ambiguous_count"], 1)

    def test_either_contributor_correction_invalidates_only_intersecting_tiles(self):
        self.seed()
        first, first_headers = self.invoke("GET", self.path)
        untouched_path = self.path.replace("86400", "172800")
        untouched, untouched_headers = self.invoke("GET", untouched_path)
        for side, value in [("demand", 250), ("available_capacity", 350)]:
            self.contributor(side, [(90300, value)])
            changed, headers = self.invoke("GET", self.path)
            self.assertNotEqual(first_headers["ETag"], headers["ETag"])
            self.assertEqual(headers["X-ERCOT-Cache"], "MISS")
            stable, stable_headers = self.invoke("GET", untouched_path)
            self.assertEqual(stable, untouched)
            self.assertEqual(stable_headers["ETag"], untouched_headers["ETag"])
            self.assertEqual(stable_headers["X-ERCOT-Cache"], "HIT")
            first, first_headers = changed, headers

    def test_restart_has_identical_bytes_etag_and_no_generic_persistence(self):
        self.seed()
        first, headers, body = self.invoke("GET", self.path, return_raw=True)
        self.app.cache = server.Cache(60)
        restarted, restarted_headers, restarted_body = self.invoke("GET", self.path, return_raw=True)
        self.assertEqual(first, restarted)
        self.assertEqual(body, restarted_body)
        self.assertEqual(headers["ETag"], restarted_headers["ETag"])
        with sqlite3.connect(server.DB_PATH) as conn:
            tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
        self.assertFalse(any("headroom" in name or "tile_resource" in name for name in tables))

    def test_missing_contributor_arrival_invalidates_cached_empty_pair(self):
        self.contributor("available_capacity", [(90000, 100)])
        empty, headers = self.invoke("GET", self.path)
        self.assertEqual(empty["buckets"], [])
        self.contributor("demand", [(90000, 90)])
        populated, populated_headers = self.invoke("GET", self.path)
        self.assertEqual(populated["buckets"][0]["state"]["value_sum"], 10)
        self.assertNotEqual(headers["ETag"], populated_headers["ETag"])
        self.assertEqual(populated_headers["X-ERCOT-Cache"], "MISS")

    def test_two_sample_counterexample_has_mean_seven_point_five(self):
        self.contributor("available_capacity", [(90000, 100), (90300, 200)])
        self.contributor("demand", [(90000, 90), (90300, 195)])
        tile, _ = self.invoke("GET", self.path)
        state = tile["buckets"][0]["state"]
        self.assertEqual(state["value_sum"] / state["count"], 7.5)
        self.assertEqual((state["minimum"], state["minimum_ts"]), (5, 90300))
        self.assertEqual((state["maximum"], state["maximum_ts"]), (10, 90000))
        self.assertEqual(tile["pairing"]["partial_buckets"], [90000])

    def test_query_plan_uses_bounded_covering_source_scans(self):
        from paired_headroom import PAIRED_SQL
        self.seed()
        with sqlite3.connect(server.DB_PATH) as conn:
            ids = [row[0] for row in conn.execute("SELECT id FROM series ORDER BY id")]
            plan = [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + PAIRED_SQL, (ids[0], 86400, 172800, ids[1], 86400, 172800))]
        scans = [line for line in plan if "metrics" in line]
        self.assertEqual(len(scans), 2)
        self.assertTrue(all("COVERING INDEX idx_metrics_series_ts_id_value" in line and "ts>?" in line and "ts<?" in line for line in scans), plan)

    def test_identical_concurrent_requests_generate_once(self):
        self.seed()
        original = server.Handler._generate_tile
        entered = threading.Event()
        release = threading.Event()
        calls = []
        def slow(handler, *args):
            calls.append(args)
            entered.set()
            release.wait(5)
            return original(handler, *args)
        with mock.patch.object(server.Handler, "_generate_tile", slow):
            with ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(self.invoke, "GET", self.path) for _ in range(4)]
                self.assertTrue(entered.wait(5))
                time.sleep(0.05)
                release.set()
                results = [future.result() for future in futures]
        self.assertEqual(len(calls), 1)
        self.assertEqual(len({headers["ETag"] for _, headers in results}), 1)


if __name__ == "__main__":
    unittest.main()
