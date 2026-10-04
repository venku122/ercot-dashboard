"""Synthetic NP6-905 35-elapsed-day archive, not captured source evidence.

Each ending epoch is a separate normal-ingest publication using official delivery
clock grammar. Numeric document IDs and prices are deliberately synthetic.
"""

from datetime import datetime, timezone
import json
import math
import sqlite3
import unittest

import market_geography as mg
import server
import test_market_geography_api_acceptance as acceptance

FIRST = int(datetime(2026, 10, 3, tzinfo=timezone.utc).timestamp())
LAST = FIRST + 35 * 86400
SLOTS = 3361
IDENTITY = "HB_NORTH--HU"
SYNTHETIC_DOCUMENT_BASE = 990000000


def synthetic_publication(target, index):
    # Official fields describe the interval START; canonical target is its END.
    local = datetime.fromtimestamp(target - 900, mg.CHICAGO)
    repeated = bool(local.fold)
    issued = target - 30
    raw_publish = datetime.fromtimestamp(issued, mg.CHICAGO).isoformat(timespec="seconds")
    document = str(SYNTHETIC_DOCUMENT_BASE + index)
    contract = mg.CONTRACTS["NP6-905-CD"]
    rows = []
    for point, price in (("HB_NORTH", index + 0.25), ("HB_HOUSTON", -index - 100.5)):
        rows.append({
            "raw_delivery_date": local.strftime("%m/%d/%Y"),
            "delivery_hour": local.hour + 1,
            "delivery_interval": local.minute // 15 + 1,
            "raw_dst_flag": "Y" if repeated else "N",
            "repeated_hour_flag": repeated,
            "target_ts": target,
            "settlement_point": point,
            "settlement_point_type": "HU",
            "settlement_point_price": price,
        })
    return {
        "publication": {
            "source_id": contract["source"], "product_id": "NP6-905-CD",
            "publication_key_kind": "official_mis_document",
            "publication_key": document, "document_id": document,
            "issued_at": issued, "retrieved_at": target,
            "raw_publish_datetime": raw_publish,
            "constructed_name": (
                f"cdr.00012301.0000000000000000.{local:%Y%m%d}.120000000."
                f"SPPHLZNP6905_{local:%Y%m%d}_1200_csv.zip"
            ),
            "artifact_href": f"https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={document}",
            "schema_fingerprint": contract["fingerprint"],
            "parser_schema_version": contract["parser"],
        },
        "rows": rows,
    }


class SyntheticFullBoundHTTPTests(unittest.TestCase):
    setUp = acceptance.MarketGeographyHttpAcceptanceTests.setUp
    tearDown = acceptance.MarketGeographyHttpAcceptanceTests.tearDown
    request = acceptance.MarketGeographyHttpAcceptanceTests.request
    get = acceptance.MarketGeographyHttpAcceptanceTests.get

    def history(self, start, end):
        status, _, body = self.get(
            f"/api/v1/market-price-history?identity={IDENTITY}&start={start}&end={end}"
        )
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual(result["identity"], IDENTITY)
        self.assertEqual(result["policy"], "latest_published_corrections_not_as_known")
        return result["rows"]

    def assert_archive(self, rows, targets):
        self.assertEqual([row["target_ts"] for row in rows], targets)
        for row in rows:
            index = (row["target_ts"] - FIRST) // 900
            self.assertEqual((row["settlement_point"], row["settlement_point_type"]), ("HB_NORTH", "HU"))
            self.assertEqual(row["value"], index + 0.25)
            self.assertEqual(row["interval_start"], row["target_ts"] - 900)
            self.assertEqual(row["interval_end"], row["target_ts"])
            self.assertEqual(row["publication"]["document_id"], str(SYNTHETIC_DOCUMENT_BASE + index))

    def test_normal_ingested_full_archive_actual_sql_http_bounds_and_overflow(self):
        conn = sqlite3.connect(server.DB_PATH)
        try:
            for index in range(SLOTS):
                target = FIRST + index * 900
                result = mg.ingest_market_geography_publication(
                    conn, synthetic_publication(target, index), current_ts=target
                )
                self.assertEqual(result["status"], "inserted")
            server.now_ts = lambda: LAST
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM market_geography_price_rows WHERE settlement_point='HB_NORTH' AND settlement_point_type='HU'"
            ).fetchone()[0], SLOTS)
            expected = list(range(FIRST, LAST + 1, 900))
            # Exactly aligned 35 elapsed days, half-open query excludes closing end.
            self.assert_archive(self.history(FIRST, LAST), expected[:-1])
            # Loader pads final support by one second: all 3361 ending slots survive.
            self.assert_archive(self.history(FIRST, LAST + 1), expected)
            # Actual loader math: ceil fractional start and ceil final native end +1.
            for fraction in (0.0, 0.4, 0.6):
                selected_start = FIRST - 300 + fraction
                selected_end = selected_start + 35 * 86400
                query_start = math.ceil(selected_start)
                query_end = math.ceil(selected_end / 900) * 900 + 1
                self.assertEqual((query_end - 1) // 900 - (query_start + 899) // 900 + 1, SLOTS)
                self.assert_archive(self.history(query_start, query_end), expected)
            self.assertEqual(self.history(LAST, LAST + 1)[0]["value"], 3360.25)
            self.assertEqual(self.history(LAST + 1, LAST + 900), [])
            # Two repeated local 01:00 hours remain separate UTC ending epochs.
            fallback = [row for row in self.history(FIRST, LAST + 1)
                        if row["raw_delivery_date"] == "11/01/2026" and row["delivery_hour"] == 2]
            self.assertEqual(len(fallback), 8)
            for earlier, later in zip(fallback[:4], fallback[4:]):
                self.assertEqual(later["target_ts"] - earlier["target_ts"], 3600)
                self.assertEqual(earlier["raw_dst_flag"], "N")
                self.assertEqual(later["raw_dst_flag"], "Y")
                self.assertFalse(earlier["repeated_hour_flag"])
                self.assertTrue(later["repeated_hour_flag"])
            # Actual SQLite tracing confirms impossible source budget is rejected pre-query.
            statements = []
            conn.set_trace_callback(statements.append)
            with self.assertRaisesRegex(ValueError, "unsupported_market_price_window"):
                mg.market_price_history(conn, IDENTITY, FIRST, LAST + 901)
            self.assertEqual(statements, [])
            conn.set_trace_callback(None)
            self.assertEqual(self.get(
                f"/api/v1/market-price-history?identity={IDENTITY}&start={FIRST}&end={LAST + 901}"
            )[0], 400)
            # Deliberate persisted corruption only: an extra NONcanonical ending epoch.
            # This cannot pass normal ingest; it proves the post-SQL guard never truncates.
            conn.execute(
                """INSERT INTO market_geography_price_rows
                SELECT publication_id,target_ts+1,raw_delivery_date,delivery_hour,
                delivery_interval,raw_dst_flag,repeated_hour_flag,settlement_point,
                settlement_point_type,settlement_point_price
                FROM market_geography_price_rows WHERE target_ts=? AND settlement_point='HB_NORTH'""",
                (FIRST,),
            )
            conn.commit()
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM market_geography_price_rows WHERE settlement_point='HB_NORTH'"
            ).fetchone()[0], SLOTS + 1)
            statements.clear()
            conn.set_trace_callback(statements.append)
            with self.assertRaisesRegex(ValueError, "market_price_row_overflow"):
                mg.market_price_history(conn, IDENTITY, FIRST, LAST + 1)
            self.assertTrue(any("LIMIT 3362" in sql for sql in statements))
            conn.set_trace_callback(None)
            self.assertEqual(self.get(
                f"/api/v1/market-price-history?identity={IDENTITY}&start={FIRST}&end={LAST + 1}"
            )[0], 400)
        finally:
            conn.close()
