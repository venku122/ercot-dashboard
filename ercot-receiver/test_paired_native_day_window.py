"""Synthetic normal-ingest proof for the frontend's native paired day transport."""
import unittest
import test_server as fixtures
import test_paired_headroom as paired_fixtures


class PairedNativeDayWindowTests(unittest.TestCase):
    setUp = fixtures.HttpQueryBoundsTests.setUp
    tearDown = fixtures.HttpQueryBoundsTests.tearDown
    invoke = fixtures.HttpQueryBoundsTests.invoke
    contributor = paired_fixtures.PairedHeadroomTests.contributor

    def test_day_native_preserves_selected_hour_tuples_and_contributor_correction_cache(self):
        start, end = 154800, 241200
        source = [(ts, -31 if i == 305 else 50 if i == 397 else i % 17 - 8)
                  for i, ts in enumerate(range(86400, end + 3601, 300))]
        self.contributor("available_capacity", [(ts, 1000 + i) for i, (ts, _) in enumerate(source)])
        self.contributor("demand", [(ts, 1000 + i - value) for i, (ts, value) in enumerate(source)])

        def tile(span, epoch):
            return self.invoke("GET", f"/api/v2/tiles/supply-demand.paired-headroom/{span}/{epoch}/native")

        days = [tile("1d", epoch) for epoch in (86400, 172800)]
        hours = [tile("1h", epoch) for epoch in range(start, end + 1, 3600)]

        def selected(tiles):
            return sorted((bucket["state"]["first_ts"], bucket["state"]["first_value"])
                          for body, _ in tiles for bucket in body["buckets"]
                          if start <= bucket["state"]["first_ts"] <= end)

        oracle = [(ts, value) for ts, value in source if start <= ts <= end]
        self.assertEqual(len(oracle), 289)
        self.assertEqual(selected(days), oracle)
        self.assertEqual(selected(hours), oracle)
        self.assertGreater(sum(len(body["buckets"]) for body, _ in days), 289)
        self.assertTrue(any(bucket["state"]["first_ts"] > end for body, _ in days for bucket in body["buckets"]))
        first, headers = days[0]
        warm, warm_headers = tile("1d", 86400)
        self.assertEqual(warm, first)
        self.assertEqual(warm_headers["ETag"], headers["ETag"])
        self.assertEqual(warm_headers["X-ERCOT-Cache"], "HIT")
        self.invoke("GET", "/api/v2/tiles/supply-demand.paired-headroom/1d/86400/native",
                    request_headers={"If-None-Match": headers["ETag"]}, expected_status=304)
        stable, stable_headers = tile("1d", 259200)
        for side, value in (("demand", 777), ("available_capacity", 1111)):
            _, before = tile("1d", 86400)
            self.contributor(side, [(start + 300, value)])
            changed, changed_headers = tile("1d", 86400)
            self.assertNotEqual(changed_headers["ETag"], before["ETag"])
            self.assertEqual(changed_headers["X-ERCOT-Cache"], "MISS")
            unaffected, unaffected_headers = tile("1d", 259200)
            self.assertEqual(unaffected, stable)
            self.assertEqual(unaffected_headers["ETag"], stable_headers["ETag"])
            self.assertEqual(unaffected_headers["X-ERCOT-Cache"], "HIT")
            self.assertEqual(len(selected([(changed, changed_headers), days[1]])), 289)
