"""PR19 strict grid event timeline domain and HTTP acceptance."""

from concurrent.futures import ThreadPoolExecutor
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest

import grid_events as ge
import server


NOW = 1_787_232_000


def event(identity="operations_messages:fixture", starts=NOW - 600, updated=None):
    updated = starts if updated is None else updated
    return {
        "identity": identity,
        "source_updated_at": updated,
        "observed_at": max(updated, NOW - 300),
        "event_type": "Operational Information",
        "status": "Active",
        "severity": "info",
        "title": "Fixture operations message",
        "body": "Fixture source body",
        "time_basis": "utc_exact",
        "starts_at": starts,
        "starts_at_candidates": [starts],
        "ends_at": None,
        "source_url": "https://www.ercot.com/services/comm/mkt_notices/opsmessages/index",
        "derivation": None,
    }


def publication(events=None, stream="operations_messages"):
    return {"schema": 1, "stream": stream, "events": [event()] if events is None else events}


def eea_event(level, starts, identity=None):
    return {
        "identity": identity or f"ercot_eea:state:fixture-{level}-{starts}",
        "source_updated_at": starts,
        "observed_at": starts + 30,
        "event_type": f"eea_level_{level}_source_observation",
        "status": "normal" if level == 0 else f"eea{level}",
        "severity": None,
        "title": "Normal Conditions" if level == 0 else f"Energy Emergency Alert Level {level}",
        "body": f"Fixture EEA level {level} source state.",
        "time_basis": "source_snapshot_epoch_not_official_declaration_time",
        "starts_at": starts,
        "starts_at_candidates": [starts],
        "ends_at": None,
        "source_url": "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
        "derivation": None,
    }


def nws_alerts():
    return {
        "schema": 1,
        "stream": "alerts",
        "collection_updated_at": NOW - 60,
        "retrieved_at": NOW,
        "cache_fresh_until": NOW + 60,
        "truncated": False,
        "items": [
            {
                "id": "urn:oid:fixture.alert.1",
                "event": "Heat Advisory",
                "headline": "Fixture heat advisory",
                "area_desc": "Fixture counties",
                "severity": "Moderate",
                "urgency": "Expected",
                "certainty": "Likely",
                "message_type": "Alert",
                "sent": NOW - 120,
                "effective": NOW - 60,
                "onset": NOW,
                "expires": NOW + 3_600,
                "ends": NOW + 3_600,
                "description": "Fixture NWS description",
                "instruction": None,
                "response": "Prepare",
                "affected_zones": ["https://api.weather.gov/zones/forecast/TXZ119"],
                "references": [],
                "source_url": "https://api.weather.gov/alerts/urn:oid:fixture.alert.1",
            }
        ],
    }


class GridEventDomainTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        ge.init_grid_events_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def test_exact_manifest_contract_and_provenance(self):
        result = ge.ingest_grid_events(self.conn, publication(), NOW)
        self.assertEqual("accepted", result["status"])
        self.assertRegex(result["content_version"], ge.CONTENT_VERSION_RE)
        page = ge.grid_events_page(self.conn, NOW - 3_600, NOW, 50, None, NOW)
        self.assertEqual(
            {
                "schema", "kind", "policy", "generated_at", "content_version", "window",
                "coverage", "gaps", "limits", "events", "next_cursor",
            },
            set(page),
        )
        self.assertEqual("half_open", page["window"]["semantics"])
        self.assertEqual("unavailable_unverified_source", page["coverage"]["txans"])
        item = page["events"][0]
        self.assertEqual("official_ercot", item["evidence_class"])
        self.assertEqual("operations_messages", item["source_type"])
        self.assertRegex(item["content_version"], ge.CONTENT_VERSION_RE)

    def test_revision_monotonicity_collision_and_reverse_replay(self):
        first = event(updated=NOW - 500)
        ge.ingest_grid_events(self.conn, publication([first]), NOW)
        replay = ge.ingest_grid_events(self.conn, publication([first]), NOW + 1)
        self.assertEqual(1, replay["unchanged"])

        older = copy.deepcopy(first)
        older["source_updated_at"] -= 1
        older["title"] = "Older replay"
        ignored = ge.ingest_grid_events(self.conn, publication([older]), NOW + 2)
        self.assertEqual(1, ignored["ignored_older"])

        collision = copy.deepcopy(first)
        collision["title"] = "Different bytes at same source time"
        with self.assertRaisesRegex(ValueError, "grid_event_publication_collision"):
            ge.ingest_grid_events(self.conn, publication([collision]), NOW + 3)

        correction = copy.deepcopy(collision)
        correction["source_updated_at"] += 1
        correction["observed_at"] += 1
        revised = ge.ingest_grid_events(self.conn, publication([correction]), NOW + 4)
        self.assertEqual(1, revised["revised"])

        stolen = copy.deepcopy(correction)
        stolen.update(
            {
                "source_updated_at": correction["source_updated_at"] + 1,
                "observed_at": correction["observed_at"] + 1,
                "time_basis": "source_snapshot_epoch_not_official_declaration_time",
                "source_url": "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
            }
        )
        with self.assertRaisesRegex(ValueError, "grid_event_identity_owner_conflict"):
            ge.ingest_grid_events(self.conn, publication([stolen], "eea"), NOW + 5)

    def test_eea_level_changes_materialize_deterministic_non_official_transitions(self):
        level_zero = eea_event(0, NOW - 1_800)
        first = ge.ingest_grid_events(
            self.conn, publication([level_zero], "eea"), NOW - 1_700
        )
        self.assertEqual(1, first["inserted"])

        level_one = eea_event(1, NOW - 1_200)
        changed = ge.ingest_grid_events(
            self.conn, publication([level_one], "eea"), NOW - 1_100
        )
        self.assertEqual(2, changed["inserted"])
        transitions = self.conn.execute(
            """SELECT r.payload_json FROM grid_event_current c
               JOIN grid_event_revisions r
                 ON r.identity=c.identity AND r.content_version=c.content_version
               WHERE r.source_type='derived_annotations'"""
        ).fetchall()
        self.assertEqual(1, len(transitions))
        up = json.loads(transitions[0][0])
        self.assertEqual("eea_transition_v1", up["event_type"])
        self.assertEqual("dashboard_event_derivation", up["source_id"])
        self.assertEqual("derived_annotation", up["evidence_class"])
        self.assertEqual("derived_from_input_utc", up["time_basis"])
        self.assertEqual(level_one["starts_at"], up["starts_at"])
        self.assertIsNone(up["source_url"])
        self.assertEqual(
            sorted([level_zero["identity"], level_one["identity"]]),
            up["derivation"]["input_identities"],
        )
        self.assertEqual("eea_level_transition", up["derivation"]["method"])
        self.assertEqual("v1", up["derivation"]["version"])

        replay = ge.ingest_grid_events(
            self.conn, publication([level_one], "eea"), NOW - 1_000
        )
        self.assertEqual(1, replay["unchanged"])
        self.assertEqual(1, len(transitions))
        self.assertEqual(
            1,
            self.conn.execute(
                """SELECT COUNT(*) FROM grid_event_current c
                   JOIN grid_event_revisions r
                     ON r.identity=c.identity AND r.content_version=c.content_version
                   WHERE r.source_type='derived_annotations'"""
            ).fetchone()[0],
        )

        unchanged_level = eea_event(1, NOW - 900)
        same = ge.ingest_grid_events(
            self.conn, publication([unchanged_level], "eea"), NOW - 800
        )
        self.assertEqual(1, same["inserted"])
        self.assertEqual(
            1,
            self.conn.execute(
                """SELECT COUNT(*) FROM grid_event_current c
                   JOIN grid_event_revisions r
                     ON r.identity=c.identity AND r.content_version=c.content_version
                   WHERE r.source_type='derived_annotations'"""
            ).fetchone()[0],
        )

        back_to_zero = eea_event(0, NOW - 600)
        down = ge.ingest_grid_events(
            self.conn, publication([back_to_zero], "eea"), NOW - 500
        )
        self.assertEqual(2, down["inserted"])
        derived = [
            json.loads(row[0])
            for row in self.conn.execute(
                """SELECT r.payload_json FROM grid_event_current c
                   JOIN grid_event_revisions r
                     ON r.identity=c.identity AND r.content_version=c.content_version
                   WHERE r.source_type='derived_annotations' ORDER BY c.sort_at"""
            )
        ]
        self.assertEqual(["level_1", "level_0"], [item["status"] for item in derived])
        self.assertEqual(2, len({item["identity"] for item in derived}))

        ge.ingest_grid_events(self.conn, publication(), NOW)
        classes = {
            row[0]
            for row in self.conn.execute(
                """SELECT DISTINCT r.evidence_class FROM grid_event_current c
                   JOIN grid_event_revisions r
                     ON r.identity=c.identity AND r.content_version=c.content_version"""
            )
        }
        self.assertEqual(
            {"official_ercot", "source_observation", "derived_annotation"}, classes
        )

    def test_ambiguous_wall_time_preserves_two_candidates_and_window_matches_either(self):
        ambiguous = event("operations_messages:fall-fold", starts=NOW - 7_200)
        ambiguous.update(
            {
                "source_updated_at": NOW - 100,
                "observed_at": NOW - 100,
                "time_basis": "america_chicago_wall_ambiguous",
                "starts_at": None,
                "starts_at_candidates": [NOW - 7_200, NOW - 3_600],
            }
        )
        ge.ingest_grid_events(self.conn, publication([ambiguous]), NOW)
        first_fold = ge.grid_events_page(self.conn, NOW - 7_300, NOW - 7_100, 10, None, NOW)
        second_fold = ge.grid_events_page(self.conn, NOW - 3_700, NOW - 3_500, 10, None, NOW)
        self.assertEqual(1, len(first_fold["events"]))
        self.assertEqual(1, len(second_fold["events"]))
        self.assertIsNone(first_fold["events"][0]["starts_at"])
        self.assertEqual([NOW - 7_200, NOW - 3_600], first_fold["events"][0]["starts_at_candidates"])

        outside = ge.grid_events_page(self.conn, NOW - 3_000, NOW - 2_000, 10, None, NOW)
        self.assertEqual([], outside["events"])

    def test_half_open_bounds_cursor_and_cursor_window_binding(self):
        rows = [event(f"operations_messages:e{index:03}", NOW - 1_000 + index) for index in range(8)]
        ge.ingest_grid_events(self.conn, publication(rows), NOW)
        page1 = ge.grid_events_page(self.conn, NOW - 2_000, NOW, 3, None, NOW)
        self.assertEqual(3, len(page1["events"]))
        self.assertIsNotNone(page1["next_cursor"])
        page2 = ge.grid_events_page(
            self.conn, NOW - 2_000, NOW, 3, page1["next_cursor"], NOW
        )
        self.assertTrue(set(x["identity"] for x in page1["events"]).isdisjoint(
            x["identity"] for x in page2["events"]
        ))
        with self.assertRaisesRegex(ValueError, "invalid_grid_event_cursor"):
            ge.grid_events_page(
                self.conn, NOW - 2_001, NOW, 3, page1["next_cursor"], NOW
            )
        at_end = event("operations_messages:at-end", starts=NOW)
        ge.ingest_grid_events(self.conn, publication([at_end]), NOW)
        page = ge.grid_events_page(self.conn, NOW - 2_000, NOW, 500, None, NOW)
        self.assertNotIn("operations_messages:at-end", [x["identity"] for x in page["events"]])
        old_point = event("operations_messages:old-point", starts=NOW - 10_000)
        ge.ingest_grid_events(self.conn, publication([old_point]), NOW)
        page = ge.grid_events_page(self.conn, NOW - 2_000, NOW, 500, None, NOW)
        self.assertNotIn("operations_messages:old-point", [x["identity"] for x in page["events"]])

    def test_evidence_retention_classes_are_bounded(self):
        old_official = event(
            "operations_messages:expired", NOW - ge.OFFICIAL_RETENTION_SECONDS - 1
        )
        old_official["source_updated_at"] = old_official["starts_at"]
        old_official["observed_at"] = old_official["starts_at"]
        ge.ingest_grid_events(self.conn, publication([old_official]), NOW)
        self.assertEqual(0, self.conn.execute("SELECT COUNT(*) FROM grid_event_current").fetchone()[0])

        derived = event("derived:expired", NOW - ge.DERIVED_RETENTION_SECONDS - 1)
        derived.update(
            {
                "source_updated_at": derived["starts_at"],
                "observed_at": derived["starts_at"],
                "time_basis": "derived_from_input_utc",
                "source_url": None,
                "derivation": {
                    "method": "eea_level_transition",
                    "version": "v1",
                    "input_identities": ["eea:fixture"],
                },
            }
        )
        ge.ingest_grid_events(self.conn, publication([derived], "derived_annotations"), NOW)
        self.assertEqual(0, self.conn.execute("SELECT COUNT(*) FROM grid_event_current").fetchone()[0])

    def test_nws_alert_eventization_keeps_weather_evidence_distinct(self):
        ge.ingest_nws_alert_events(self.conn, nws_alerts(), NOW)
        repeated = nws_alerts()
        repeated["collection_updated_at"] += 30
        repeated["retrieved_at"] += 30
        repeated["cache_fresh_until"] += 30
        replay = ge.ingest_nws_alert_events(self.conn, repeated, NOW + 30)
        self.assertEqual(1, replay["unchanged"])
        self.assertEqual(
            1, self.conn.execute("SELECT COUNT(*) FROM grid_event_revisions").fetchone()[0]
        )
        page = ge.grid_events_page(self.conn, NOW - 600, NOW + 600, 20, None, NOW)
        alert = page["events"][0]
        self.assertEqual("official_weather", alert["evidence_class"])
        self.assertEqual("nws_alerts", alert["source_type"])
        self.assertNotEqual("official_ercot", alert["evidence_class"])

    def test_strict_provenance_url_derivation_and_window_bounds_fail_closed(self):
        poisoned = event()
        poisoned["extra"] = True
        with self.assertRaisesRegex(ValueError, "invalid_grid_event"):
            ge.ingest_grid_events(self.conn, publication([poisoned]), NOW)
        poisoned = event()
        poisoned["source_url"] += "?mutable=1"
        with self.assertRaisesRegex(ValueError, "invalid_grid_event_source_url"):
            ge.ingest_grid_events(self.conn, publication([poisoned]), NOW)
        poisoned = event()
        poisoned["time_basis"] = "source_snapshot_epoch_not_official_declaration_time"
        with self.assertRaisesRegex(ValueError, "invalid_grid_event_time_basis"):
            ge.ingest_grid_events(self.conn, publication([poisoned]), NOW)
        with self.assertRaisesRegex(ValueError, "invalid_grid_event_window"):
            ge.grid_events_page(
                self.conn, NOW - ge.MAX_WINDOW_SECONDS - 1, NOW, 20, None, NOW
            )


class GridEventHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_db_path = server.DB_PATH
        self.old_db_local = server.DB_LOCAL
        self.old_api_key = server.API_KEY
        self.old_now = server.now_ts
        server.DB_PATH = str(Path(self.tmp.name) / "metrics.db")
        server.DB_LOCAL = threading.local()
        server.API_KEY = "fixture-key"
        server.now_ts = lambda: NOW
        conn = sqlite3.connect(server.DB_PATH)
        server.init_db(conn)
        conn.close()
        self.app = type(
            "GridEventServer",
            (),
            {
                "cache": server.Cache(60),
                "cache_metrics": server.defaultdict(float),
                "cache_metrics_lock": threading.Lock(),
                "limiter": server.RateLimiter(),
                "singleflight": server.SingleFlight(),
            },
        )()

    def tearDown(self):
        conn = getattr(server.DB_LOCAL, "conn", None)
        if conn is not None:
            conn.close()
        server.DB_PATH = self.old_db_path
        server.DB_LOCAL = self.old_db_local
        server.API_KEY = self.old_api_key
        server.now_ts = self.old_now
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        handler = server.Handler.__new__(server.Handler)
        handler.path = path
        handler.client_address = ("127.0.0.1", 12_345)
        handler.server = self.app
        encoded = b"" if payload is None else json.dumps(payload).encode()
        handler.headers = {"Content-Length": str(len(encoded)), **(headers or {})}
        handler.rfile = io.BytesIO(encoded)
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.response_headers = {}
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        try:
            getattr(handler, f"do_{method}")()
        finally:
            conn = getattr(server.DB_LOCAL, "conn", None)
            if conn is not None:
                conn.close()
                del server.DB_LOCAL.conn
        return handler.response_status, handler.response_headers, handler.wfile.getvalue()

    def test_auth_strict_query_etag_and_generation_invalidation(self):
        self.assertEqual(401, self.request("POST", "/api/grid-events/ingest", publication())[0])
        posted = self.request(
            "POST", "/api/grid-events/ingest", publication(), {"X-API-Key": "fixture-key"}
        )
        self.assertEqual(200, posted[0])
        path = f"/api/v1/grid-events?from={NOW-3600}&to={NOW}&limit=20"
        cold = self.request("GET", path)
        warm = self.request("GET", path)
        conditional = self.request("GET", path, headers={"If-None-Match": cold[1]["ETag"]})
        self.assertEqual((200, 200, 304), (cold[0], warm[0], conditional[0]))
        self.assertEqual("MISS", cold[1]["X-ERCOT-Cache"])
        self.assertEqual("HIT", warm[1]["X-ERCOT-Cache"])
        self.assertEqual(b"", conditional[2])
        self.assertEqual(
            400, self.request("GET", path + "&source=operations_messages")[0]
        )
        revised = event(updated=NOW - 500)
        revised["title"] = "Revised fixture"
        self.assertEqual(
            200,
            self.request(
                "POST", "/api/grid-events/ingest", publication([revised]),
                {"X-API-Key": "fixture-key"},
            )[0],
        )
        self.assertIsNone(self.app.cache.get("grid-events:v1:does-not-matter"))
        refreshed = self.request("GET", path)
        self.assertEqual("MISS", refreshed[1]["X-ERCOT-Cache"])

    def test_grid_event_query_rejects_noncanonical_integer_aliases(self):
        canonical_zero = self.request("GET", "/api/v1/grid-events?from=0&to=1&limit=1")
        self.assertEqual(200, canonical_zero[0])
        aliases = [
            f"from=0{NOW-3600}&to={NOW}&limit=20",
            f"from={NOW-3600}&to=0{NOW}&limit=20",
            f"from={NOW-3600}&to={NOW}&limit=020",
            f"from=%2B{NOW-3600}&to={NOW}&limit=20",
            f"from=-{NOW-3600}&to={NOW}&limit=20",
        ]
        for query in aliases:
            with self.subTest(query=query):
                response = self.request("GET", "/api/v1/grid-events?" + query)
                self.assertEqual(400, response[0])
                self.assertEqual(
                    {"error": "invalid_grid_event_query"}, json.loads(response[2])
                )

    def test_parallel_cold_get_is_singleflight(self):
        self.request(
            "POST", "/api/grid-events/ingest", publication(), {"X-API-Key": "fixture-key"}
        )
        original = server.grid_events_page
        calls = 0
        lock = threading.Lock()

        def counted(*args, **kwargs):
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.03)
            return original(*args, **kwargs)

        server.grid_events_page = counted
        path = f"/api/v1/grid-events?from={NOW-3600}&to={NOW}"
        try:
            with ThreadPoolExecutor(max_workers=8) as pool:
                responses = list(pool.map(lambda _index: self.request("GET", path), range(8)))
        finally:
            server.grid_events_page = original
        self.assertEqual(1, calls)
        self.assertEqual({200}, {response[0] for response in responses})
        self.assertEqual(1, len({response[2] for response in responses}))

    def test_predictive_alert_ingest_materializes_nws_timeline_event(self):
        posted = self.request(
            "POST",
            "/api/predictive-weather/ingest",
            nws_alerts(),
            {"X-API-Key": "fixture-key"},
        )
        self.assertEqual(200, posted[0], posted[2])
        response = self.request(
            "GET", f"/api/v1/grid-events?from={NOW-600}&to={NOW+600}"
        )
        self.assertEqual(200, response[0])
        item = json.loads(response[2])["events"][0]
        self.assertEqual("official_weather", item["evidence_class"])
        self.assertEqual("urn:oid:fixture.alert.1", item["identity"])

    def test_inflight_ingest_generation_guard_cannot_recache_stale_page(self):
        self.request(
            "POST", "/api/grid-events/ingest", publication(), {"X-API-Key": "fixture-key"}
        )
        original = server.grid_events_page
        generated = threading.Event()
        release = threading.Event()

        def blocked(*args, **kwargs):
            value = original(*args, **kwargs)
            generated.set()
            self.assertTrue(release.wait(2))
            return value

        server.grid_events_page = blocked
        path = f"/api/v1/grid-events?from={NOW-3600}&to={NOW}"
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                stale = pool.submit(self.request, "GET", path)
                self.assertTrue(generated.wait(2))
                correction = event(updated=NOW - 500)
                correction["title"] = "Correction during read"
                self.assertEqual(
                    200,
                    self.request(
                        "POST", "/api/grid-events/ingest", publication([correction]),
                        {"X-API-Key": "fixture-key"},
                    )[0],
                )
                release.set()
                self.assertEqual(200, stale.result()[0])
        finally:
            release.set()
            server.grid_events_page = original
        fresh = self.request("GET", path)
        self.assertEqual("MISS", fresh[1]["X-ERCOT-Cache"])
        self.assertIn(b"Correction during read", fresh[2])


if __name__ == "__main__":
    unittest.main()
