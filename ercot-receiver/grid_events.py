"""Strict, revision-aware multi-source grid event timeline."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from urllib.parse import urlparse


SCHEMA = 1
KIND = "grid_event_timeline"
POLICY = "multi_source_temporal_context_not_causal_attribution"
MAX_WINDOW_SECONDS = 31 * 86_400
MAX_PAGE_SIZE = 500
OFFICIAL_RETENTION_SECONDS = 400 * 86_400
DERIVED_RETENTION_SECONDS = 90 * 86_400
MAX_EVENTS_PER_INGEST = 500
MAX_TIMESTAMP = 253_402_300_799

IDENTITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._~/-]{0,511}$")
METHOD_RE = re.compile(r"^[a-z][a-z0-9_]{0,119}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CONTENT_VERSION_RE = re.compile(r"^ge1-[0-9a-f]{64}$")
EEA_LEVEL_EVENT_RE = re.compile(r"^eea_level_([0-3])_source_observation$")

STREAMS = {
    "operations_messages": ("operations_messages", "official_ercot"),
    "eea": ("ercot_eea", "source_observation"),
    "derived_annotations": ("dashboard_event_derivation", "derived_annotation"),
}
EVIDENCE_CLASSES = frozenset(
    {"official_ercot", "official_weather", "source_observation", "derived_annotation"}
)
SOURCE_TYPES = frozenset(
    {"operations_messages", "eea", "nws_alerts", "derived_annotations"}
)
TIME_BASES = frozenset(
    {
        "utc_exact",
        "america_chicago_wall_ambiguous",
        "source_snapshot_epoch_not_official_declaration_time",
        "derived_from_input_utc",
    }
)
COVERAGE = {
    "txans": "unavailable_unverified_source",
    "eea": "collector_accumulated_source_observations",
    "operations_messages": "collector_accumulated_official_messages",
    "nws_alerts": "texas_statewide_not_ercot_footprint_collected_after_pr19",
}
GAPS = [
    "txans_unavailable_unverified_source",
    "operations_messages_repeated_hour_ambiguous",
    "history_begins_at_collection",
]


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _exact(value, keys, code):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(code)
    return value


def _integer(value, code, *, nullable=False):
    if nullable and value is None:
        return None
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_TIMESTAMP
    ):
        raise ValueError(code)
    return value


def _text(value, code, maximum, *, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        raise ValueError(code)
    return value


def _source_url(value, source_type):
    if value is None:
        return None
    value = _text(value, "invalid_grid_event_source_url", 1_024)
    parsed = urlparse(value)
    host = "api.weather.gov" if source_type == "nws_alerts" else "www.ercot.com"
    if (
        parsed.scheme != "https"
        or parsed.hostname != host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid_grid_event_source_url")
    return value


def _utf8_excerpt(value, maximum):
    if value is None or len(value.encode("utf-8")) <= maximum:
        return value
    suffix = "..."
    output = ""
    for character in value:
        if len((output + character + suffix).encode("utf-8")) > maximum:
            break
        output += character
    return output + suffix


def init_grid_events_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS grid_event_revisions (
          identity TEXT NOT NULL,
          content_version TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          evidence_class TEXT NOT NULL,
          source_updated_at INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,
          sort_at INTEGER NOT NULL,
          starts_at INTEGER,
          retention_class TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          ingested_at INTEGER NOT NULL,
          PRIMARY KEY(identity, content_version),
          CHECK(retention_class IN ('official_source','derived'))
        );
        CREATE TABLE IF NOT EXISTS grid_event_current (
          identity TEXT PRIMARY KEY,
          content_version TEXT NOT NULL,
          source_updated_at INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,
          sort_at INTEGER NOT NULL,
          retention_class TEXT NOT NULL,
          FOREIGN KEY(identity,content_version)
            REFERENCES grid_event_revisions(identity,content_version)
        );
        CREATE INDEX IF NOT EXISTS idx_grid_event_current_sort
          ON grid_event_current(sort_at DESC, identity ASC);
        CREATE INDEX IF NOT EXISTS idx_grid_event_revision_retention
          ON grid_event_revisions(retention_class,sort_at);
        """
    )
    conn.commit()


def _normalize_derivation(value, evidence_class):
    if evidence_class != "derived_annotation":
        if value is not None:
            raise ValueError("invalid_grid_event_derivation")
        return None
    item = _exact(
        value, {"method", "version", "input_identities"}, "invalid_grid_event_derivation"
    )
    method = _text(item["method"], "invalid_grid_event_derivation", 120)
    version = _text(item["version"], "invalid_grid_event_derivation", 64)
    identities = item["input_identities"]
    if (
        not METHOD_RE.fullmatch(method)
        or not VERSION_RE.fullmatch(version)
        or not isinstance(identities, list)
        or not 1 <= len(identities) <= 32
        or identities != sorted(set(identities))
        or any(not isinstance(identity, str) or not IDENTITY_RE.fullmatch(identity) for identity in identities)
    ):
        raise ValueError("invalid_grid_event_derivation")
    return {"method": method, "version": version, "input_identities": identities}


def _normalize_event(raw, source_id, source_type, evidence_class):
    item = _exact(
        raw,
        {
            "identity", "source_updated_at", "observed_at", "event_type", "status",
            "severity", "title", "body", "time_basis", "starts_at",
            "starts_at_candidates", "ends_at", "source_url", "derivation",
        },
        "invalid_grid_event",
    )
    identity = _text(item["identity"], "invalid_grid_event_identity", 512)
    if not IDENTITY_RE.fullmatch(identity):
        raise ValueError("invalid_grid_event_identity")
    source_updated_at = _integer(item["source_updated_at"], "invalid_grid_event_time")
    observed_at = _integer(item["observed_at"], "invalid_grid_event_time")
    if source_updated_at > observed_at:
        raise ValueError("invalid_grid_event_time")
    time_basis = item["time_basis"]
    if time_basis not in TIME_BASES:
        raise ValueError("invalid_grid_event_time_basis")
    expected_basis = {
        "operations_messages": {"utc_exact", "america_chicago_wall_ambiguous"},
        "eea": {"source_snapshot_epoch_not_official_declaration_time"},
        "nws_alerts": {"utc_exact"},
        "derived_annotations": {"derived_from_input_utc"},
    }[source_type]
    if time_basis not in expected_basis:
        raise ValueError("invalid_grid_event_time_basis")
    starts_at = _integer(item["starts_at"], "invalid_grid_event_start", nullable=True)
    candidates = item["starts_at_candidates"]
    if not isinstance(candidates, list):
        raise ValueError("invalid_grid_event_start")
    candidates = [_integer(value, "invalid_grid_event_start") for value in candidates]
    if time_basis == "america_chicago_wall_ambiguous":
        if starts_at is not None or len(candidates) != 2 or candidates != sorted(set(candidates)):
            raise ValueError("invalid_grid_event_start")
    elif starts_at is None or candidates != [starts_at]:
        raise ValueError("invalid_grid_event_start")
    ends_at = _integer(item["ends_at"], "invalid_grid_event_end", nullable=True)
    if ends_at is not None and (starts_at is None or ends_at <= starts_at):
        raise ValueError("invalid_grid_event_end")
    if source_type == "derived_annotations" and item["source_url"] is not None:
        raise ValueError("invalid_grid_event_source_url")
    output = {
        "identity": identity,
        "source_id": source_id,
        "source_type": source_type,
        "evidence_class": evidence_class,
        "event_type": _text(item["event_type"], "invalid_grid_event_text", 120),
        "status": _text(item["status"], "invalid_grid_event_text", 80, nullable=True),
        "severity": _text(item["severity"], "invalid_grid_event_text", 80, nullable=True),
        "title": _text(item["title"], "invalid_grid_event_text", 500),
        "body": _text(item["body"], "invalid_grid_event_text", 10_000, nullable=True),
        "time_basis": time_basis,
        "starts_at": starts_at,
        "starts_at_candidates": candidates,
        "ends_at": ends_at,
        "observed_at": observed_at,
        "source_updated_at": source_updated_at,
        "source_url": _source_url(item["source_url"], source_type),
        "derivation": _normalize_derivation(item["derivation"], evidence_class),
    }
    return output


def _content_version(event):
    # Retrieval time is provenance, not source content. Excluding it prevents an
    # unchanged active alert from producing one revision per collector poll.
    semantic = {key: value for key, value in event.items() if key != "observed_at"}
    return "ge1-" + hashlib.sha256(_canonical(semantic).encode("utf-8")).hexdigest()


def _prune(conn, current_ts):
    removed = 0
    for retention_class, age in (
        ("official_source", OFFICIAL_RETENTION_SECONDS),
        ("derived", DERIVED_RETENTION_SECONDS),
    ):
        cutoff = current_ts - age
        identities = [
            row[0]
            for row in conn.execute(
                "SELECT identity FROM grid_event_current WHERE retention_class=? AND sort_at<?",
                (retention_class, cutoff),
            )
        ]
        if identities:
            conn.executemany("DELETE FROM grid_event_current WHERE identity=?", ((x,) for x in identities))
            removed += len(identities)
        conn.execute(
            "DELETE FROM grid_event_revisions WHERE retention_class=? AND sort_at<?",
            (retention_class, cutoff),
        )
    return removed


def _eea_level(event):
    if event["source_type"] != "eea":
        return None
    match = EEA_LEVEL_EVENT_RE.fullmatch(event["event_type"])
    if match is None:
        raise ValueError("invalid_grid_event_eea_level")
    return int(match.group(1))


def _eea_transition(previous, current):
    previous_level = _eea_level(previous)
    current_level = _eea_level(current)
    if previous_level == current_level:
        return None
    inputs = sorted([previous["identity"], current["identity"]])
    identity_hash = hashlib.sha256(_canonical(inputs).encode("utf-8")).hexdigest()
    return {
        "identity": f"derived:eea_transition_v1:{identity_hash}",
        "source_id": "dashboard_event_derivation",
        "source_type": "derived_annotations",
        "evidence_class": "derived_annotation",
        "event_type": "eea_transition_v1",
        "status": f"level_{current_level}",
        "severity": None,
        "title": f"EEA source observation changed from level {previous_level} to level {current_level}",
        "body": (
            "Derived from consecutive ERCOT Daily PRC source snapshots; "
            "the timestamp is not an official declaration time."
        ),
        "time_basis": "derived_from_input_utc",
        "starts_at": current["starts_at"],
        "starts_at_candidates": [current["starts_at"]],
        "ends_at": None,
        "observed_at": current["observed_at"],
        "source_updated_at": current["source_updated_at"],
        "source_url": None,
        "derivation": {
            "method": "eea_level_transition",
            "version": "v1",
            "input_identities": inputs,
        },
    }


def _ingest_normalized(conn, stream, events, current_ts):
    inserted = revised = unchanged = ignored_older = 0
    versions = []
    conn.execute("BEGIN IMMEDIATE")
    try:
        if stream == "eea":
            events = sorted(events, key=lambda event: (event["source_updated_at"], event["identity"]))
        pending = list(events)
        for event in pending:
            version = _content_version(event)
            versions.append(version)
            previous = conn.execute(
                """SELECT c.content_version,c.source_updated_at,r.source_id,r.source_type,r.evidence_class
                   FROM grid_event_current c JOIN grid_event_revisions r
                     ON r.identity=c.identity AND r.content_version=c.content_version
                   WHERE c.identity=?""",
                (event["identity"],),
            ).fetchone()
            if previous is not None and previous[2:] != (
                event["source_id"], event["source_type"], event["evidence_class"]
            ):
                raise ValueError("grid_event_identity_owner_conflict")
            if previous is not None and previous[0] == version:
                unchanged += 1
                continue
            if previous is not None and event["source_updated_at"] < previous[1]:
                ignored_older += 1
                continue
            if previous is not None and event["source_updated_at"] == previous[1]:
                raise ValueError("grid_event_publication_collision")
            content = {**event, "content_version": version}
            retention_class = "derived" if event["evidence_class"] == "derived_annotation" else "official_source"
            sort_at = max(event["starts_at_candidates"])
            conn.execute(
                """INSERT INTO grid_event_revisions(
                   identity,content_version,source_id,source_type,evidence_class,
                   source_updated_at,observed_at,sort_at,starts_at,retention_class,
                   payload_json,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    event["identity"], version, event["source_id"], event["source_type"],
                    event["evidence_class"], event["source_updated_at"], event["observed_at"],
                    sort_at, event["starts_at"], retention_class, _canonical(content), current_ts,
                ),
            )
            conn.execute(
                """INSERT INTO grid_event_current(
                   identity,content_version,source_updated_at,observed_at,sort_at,retention_class)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET
                   content_version=excluded.content_version,
                   source_updated_at=excluded.source_updated_at,
                   observed_at=excluded.observed_at,sort_at=excluded.sort_at,
                   retention_class=excluded.retention_class""",
                (
                    event["identity"], version, event["source_updated_at"], event["observed_at"],
                    sort_at, retention_class,
                ),
            )
            if previous is None:
                inserted += 1
            else:
                revised += 1
            if stream == "eea" and event["source_type"] == "eea":
                previous_row = conn.execute(
                    """SELECT r.payload_json FROM grid_event_current c
                       JOIN grid_event_revisions r
                         ON r.identity=c.identity AND r.content_version=c.content_version
                       WHERE r.source_type='eea' AND r.identity<>? AND r.source_updated_at<?
                       ORDER BY r.source_updated_at DESC,r.identity DESC LIMIT 1""",
                    (event["identity"], event["source_updated_at"]),
                ).fetchone()
                if previous_row is not None:
                    transition = _eea_transition(json.loads(previous_row[0]), event)
                    if transition is not None:
                        pending.append(transition)
        pruned = _prune(conn, current_ts)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    batch_version = "ge1-" + hashlib.sha256(_canonical(sorted(versions)).encode()).hexdigest()
    return {
        "schema": SCHEMA, "stream": stream, "status": "accepted", "inserted": inserted,
        "revised": revised, "unchanged": unchanged, "ignored_older": ignored_older,
        "pruned": pruned, "content_version": batch_version,
    }


def ingest_grid_events(conn, payload, current_ts):
    item = _exact(payload, {"schema", "stream", "events"}, "invalid_grid_event_ingest")
    stream = item["stream"]
    if item["schema"] != SCHEMA or stream not in STREAMS:
        raise ValueError("invalid_grid_event_stream")
    events = item["events"]
    if not isinstance(events, list) or len(events) > MAX_EVENTS_PER_INGEST:
        raise ValueError("invalid_grid_event_count")
    source_id, evidence = STREAMS[stream]
    normalized = [_normalize_event(event, source_id, stream, evidence) for event in events]
    if len({event["identity"] for event in normalized}) != len(normalized):
        raise ValueError("duplicate_grid_event_identity")
    return _ingest_normalized(conn, stream, normalized, current_ts)


def ingest_nws_alert_events(conn, alert_payload, current_ts):
    if not isinstance(alert_payload, dict) or alert_payload.get("stream") != "alerts":
        return None
    retrieved = alert_payload.get("retrieved_at")
    collection_updated = alert_payload.get("collection_updated_at")
    if not isinstance(retrieved, int) or not isinstance(collection_updated, int):
        raise ValueError("invalid_grid_event_nws_collection")
    events = []
    for alert in alert_payload.get("items", []):
        start = alert.get("onset") or alert.get("effective") or alert.get("sent")
        end = alert.get("ends") or alert.get("expires")
        raw = {
            "identity": alert.get("id"),
            "source_updated_at": alert.get("sent"),
            "observed_at": retrieved,
            "event_type": _utf8_excerpt(alert.get("event"), 120),
            "status": alert.get("message_type"),
            "severity": alert.get("severity"),
            "title": _utf8_excerpt(alert.get("headline") or alert.get("event"), 500),
            "body": _utf8_excerpt(alert.get("description"), 10_000),
            "time_basis": "utc_exact",
            "starts_at": start,
            "starts_at_candidates": [start],
            "ends_at": end if end is not None and end > start else None,
            "source_url": alert.get("source_url"),
            "derivation": None,
        }
        events.append(_normalize_event(raw, "nws_alerts_tx", "nws_alerts", "official_weather"))
    return _ingest_normalized(conn, "nws_alerts", events, current_ts)


def _cursor_encode(start, end, sort_at, identity):
    raw = _canonical([start, end, sort_at, identity]).encode()
    return "gec1-" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _cursor_decode(value, start, end):
    if not isinstance(value, str) or not value.startswith("gec1-") or len(value) > 1_024:
        raise ValueError("invalid_grid_event_cursor")
    try:
        encoded = value[5:]
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        decoded = json.loads(raw)
    except Exception as exc:
        raise ValueError("invalid_grid_event_cursor") from exc
    if (
        not isinstance(decoded, list) or len(decoded) != 4 or decoded[0] != start
        or decoded[1] != end or not isinstance(decoded[2], int)
        or not isinstance(decoded[3], str) or not IDENTITY_RE.fullmatch(decoded[3])
    ):
        raise ValueError("invalid_grid_event_cursor")
    sort_at = _integer(decoded[2], "invalid_grid_event_cursor")
    if _cursor_encode(start, end, sort_at, decoded[3]) != value:
        raise ValueError("invalid_grid_event_cursor")
    return sort_at, decoded[3]


def grid_events_page(conn, start, end, limit, cursor, current_ts):
    start = _integer(start, "invalid_grid_event_window")
    end = _integer(end, "invalid_grid_event_window")
    if end <= start or end - start > MAX_WINDOW_SECONDS:
        raise ValueError("invalid_grid_event_window")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError("invalid_grid_event_limit")
    clauses = [
        """(
          (json_extract(r.payload_json,'$.ends_at') IS NULL AND
           EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.starts_at_candidates')
                   WHERE value >= ? AND value < ?))
          OR
          (json_extract(r.payload_json,'$.ends_at') IS NOT NULL AND
           json_extract(r.payload_json,'$.ends_at') > ? AND
           EXISTS (SELECT 1 FROM json_each(r.payload_json,'$.starts_at_candidates')
                   WHERE value < ?))
        )""",
    ]
    params = [start, end, start, end]
    if cursor is not None:
        cursor_sort, cursor_identity = _cursor_decode(cursor, start, end)
        clauses.append("(c.sort_at < ? OR (c.sort_at = ? AND c.identity > ?))")
        params.extend([cursor_sort, cursor_sort, cursor_identity])
    rows = conn.execute(
        """SELECT c.sort_at,c.identity,r.payload_json FROM grid_event_current c
           JOIN grid_event_revisions r ON r.identity=c.identity AND r.content_version=c.content_version
           WHERE """ + " AND ".join(f"({clause})" for clause in clauses)
        + " ORDER BY c.sort_at DESC,c.identity ASC LIMIT ?",
        [*params, limit + 1],
    ).fetchall()
    selected = rows[:limit]
    events = [json.loads(row[2]) for row in selected]
    next_cursor = (
        _cursor_encode(start, end, selected[-1][0], selected[-1][1])
        if len(rows) > limit and selected else None
    )
    versions = [event["content_version"] for event in events]
    page_version = "ge1-" + hashlib.sha256(
        _canonical([start, end, limit, cursor, versions, next_cursor]).encode()
    ).hexdigest()
    return {
        "schema": SCHEMA,
        "kind": KIND,
        "policy": POLICY,
        "generated_at": current_ts,
        "content_version": page_version,
        "window": {"from": start, "to": end, "basis": "utc", "semantics": "half_open"},
        "coverage": dict(COVERAGE),
        "gaps": list(GAPS),
        "limits": {
            "max_window_seconds": MAX_WINDOW_SECONDS,
            "max_page_size": MAX_PAGE_SIZE,
            "official_source_retention_seconds": OFFICIAL_RETENTION_SECONDS,
            "derived_retention_seconds": DERIVED_RETENTION_SECONDS,
        },
        "events": events,
        "next_cursor": next_cursor,
    }
