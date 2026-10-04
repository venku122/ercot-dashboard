"""Captured official NP6-905 display-subset replay; no live requests."""

import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import Mock

import market_geography as mg
import server
import test_market_geography_api_acceptance as acceptance

CAPTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "e2e/fixtures/np6-905-captured-display-subset.json").read_text()
)
TARGET = CAPTURE["rows"][0]["target_ts"]


class SettlementDeliveryEdgeTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        mg.init_market_geography_schema(self.conn)
        mg.ingest_market_geography_publication(
            self.conn, CAPTURE, current_ts=CAPTURE["publication"]["retrieved_at"]
        )

    def tearDown(self):
        self.conn.close()

    def test_captured_source_exact_bounds_and_padded_maximum(self):
        for row in CAPTURE["rows"]:
            identity = f"{row['settlement_point']}--{row['settlement_point_type']}"
            result = mg.market_price_history(self.conn, identity, TARGET - 900, TARGET + 1)
            self.assertEqual(result["policy"], "latest_published_corrections_not_as_known")
            self.assertEqual(len(result["rows"]), 1)
            self.assertEqual(result["rows"][0]["value"], row["settlement_point_price"])
            self.assertEqual(
                result["rows"][0]["publication"]["document_id"],
                CAPTURE["publication"]["document_id"],
            )
        for fractional_rounding in (0, 1):
            result = mg.market_price_history(
                self.conn, "HB_HOUSTON--HU",
                TARGET - 300 - 35 * 86400 + fractional_rounding, TARGET + 1,
            )
            self.assertEqual(len(result["rows"]), 1)

    def test_target_budget_rejected_before_sql(self):
        conn = Mock()
        with self.assertRaisesRegex(ValueError, "unsupported_market_price_window"):
            mg.market_price_history(conn, "HB_HOUSTON--HU", 0, 35 * 86400 + 901)
        conn.execute.assert_not_called()

    def test_no_silent_row_overflow(self):
        conn = Mock()
        conn.execute.return_value.fetchall.return_value = [None] * 3362
        with self.assertRaisesRegex(ValueError, "market_price_row_overflow"):
            mg.market_price_history(conn, "HB_HOUSTON--HU", 1, 35 * 86400 + 901)
        self.assertEqual(conn.execute.call_args.args[1][-1], 3362)


class SettlementDeliveryHTTPTests(unittest.TestCase):
    setUp = acceptance.MarketGeographyHttpAcceptanceTests.setUp
    tearDown = acceptance.MarketGeographyHttpAcceptanceTests.tearDown
    request = acceptance.MarketGeographyHttpAcceptanceTests.request
    post = acceptance.MarketGeographyHttpAcceptanceTests.post
    get = acceptance.MarketGeographyHttpAcceptanceTests.get

    def test_captured_ingest_padded_partial_maximum_http(self):
        server.now_ts = lambda: CAPTURE["publication"]["retrieved_at"]
        self.assertEqual(self.post(CAPTURE)[0], 200)
        status, _, raw = self.get(
            "/api/v1/market-price-history?identity=HB_HOUSTON--HU"
            f"&start={TARGET - 300 - 35 * 86400}&end={TARGET + 1}"
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["rows"][0]["target_ts"], TARGET)
