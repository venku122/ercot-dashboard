"""Bounded current-snapshot contract for representative NWS weather context."""

from __future__ import annotations

import hashlib
import json
import math
import re
from urllib.parse import urlparse


SCHEMA = 1
KIND = "predictive_weather"
REGISTRY_VERSION = "representative-airport-points-v1"
POLICY = "representative_point_weather_context_not_grid_alert_or_load_causality"
ALERT_COVERAGE = "texas_statewide_not_ercot_footprint"
MAX_SNAPSHOTS_PER_STREAM = 8
MAX_ALERTS = 500
MAX_LAYER_ROWS = 512
# Application safety bound, not a claim about the NWS forecast horizon. Official
# grid data can contain multi-day intervals (for example, windChill P8DT1H).
MAX_FORECAST_SPAN_SECONDS = 10 * 86_400
MAX_CACHE_LIFETIME_SECONDS = 86_400
MAX_TEXT = 65_536

POINTS = (
    ("KDFW", "Dallas/Fort Worth", 32.8974, -97.0220),
    ("KAUS", "Austin", 30.1831, -97.6806),
    ("KHOU", "Houston Hobby", 29.6458, -95.2821),
    ("KSAT", "San Antonio", 29.5443, -98.4839),
)
POINT_BY_ID = {point[0]: point for point in POINTS}
LAYERS = (
    ("temperature", "wmoUnit:degC"),
    ("apparentTemperature", "wmoUnit:degC"),
    ("heatIndex", "wmoUnit:degC"),
    ("windChill", "wmoUnit:degC"),
    ("windSpeed", "wmoUnit:km_h-1"),
    ("windGust", "wmoUnit:km_h-1"),
)
LAYER_UNITS = dict(LAYERS)
STREAM_SOURCE = {
    "forecast": "nws_grid_forecast",
    "alerts": "nws_alerts_tx",
}
ALERT_ENUMS = {
    "severity": {"Extreme", "Severe", "Moderate", "Minor", "Unknown"},
    "urgency": {"Immediate", "Expected", "Future", "Past", "Unknown"},
    "certainty": {"Observed", "Likely", "Possible", "Unlikely", "Unknown"},
    "message_type": {"Alert", "Update", "Cancel", "Ack", "Error"},
    "response": {
        "Shelter",
        "Evacuate",
        "Prepare",
        "Execute",
        "Avoid",
        "Monitor",
        "Assess",
        "AllClear",
        "None",
    },
}


def _canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _exact_object(value, keys, code):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(code)
    return value


def _integer(value, code, *, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(code)
    return value


def _number(value, code):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(code)
    output = float(value)
    if not math.isfinite(output) or abs(output) > 1_000_000:
        raise ValueError(code)
    return 0.0 if output == 0 else output


def _text(value, code, maximum=MAX_TEXT, *, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        raise ValueError(code)
    return value


def _https_weather_url(value, code, path_prefix):
    value = _text(value, code, 1_024)
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.weather.gov"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith(path_prefix)
    ):
        raise ValueError(code)
    return value


def init_predictive_weather_schema(conn) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS predictive_weather_snapshots (
          stream TEXT NOT NULL,
          content_version TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(stream, content_version),
          CHECK(stream IN ('forecast','alerts'))
        );
        CREATE TABLE IF NOT EXISTS predictive_weather_current (
          stream TEXT PRIMARY KEY,
          content_version TEXT NOT NULL,
          retrieved_at INTEGER NOT NULL,
          source_updated_at INTEGER NOT NULL,
          cache_fresh_until INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(stream, content_version)
            REFERENCES predictive_weather_snapshots(stream, content_version),
          CHECK(stream IN ('forecast','alerts'))
        );
        CREATE TABLE IF NOT EXISTS predictive_weather_health (
          stream TEXT PRIMARY KEY,
          last_attempt_ts INTEGER,
          last_success_ts INTEGER,
          source_updated_at INTEGER,
          retrieved_at INTEGER,
          cache_fresh_until INTEGER,
          availability_status TEXT,
          content_version TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          materialization_last_success_ts INTEGER,
          materialization_consecutive_failures INTEGER,
          materialization_last_error TEXT,
          CHECK(stream IN ('forecast','alerts'))
        );
        """
    )
    conn.commit()


def _validate_cache_times(source_updated_at, retrieved_at, cache_fresh_until, code):
    source_updated_at = _integer(source_updated_at, code)
    retrieved_at = _integer(retrieved_at, code)
    cache_fresh_until = _integer(cache_fresh_until, code)
    if (
        source_updated_at > retrieved_at
        or cache_fresh_until < retrieved_at
        or cache_fresh_until - retrieved_at > MAX_CACHE_LIFETIME_SECONDS
    ):
        raise ValueError(code)
    return source_updated_at, retrieved_at, cache_fresh_until


def _normalize_mapping(value, point_id):
    item = _exact_object(
        value,
        {
            "grid_id",
            "grid_x",
            "grid_y",
            "time_zone",
            "forecast_grid_data_url",
        },
        "invalid_predictive_weather_mapping",
    )
    grid_id = _text(item["grid_id"], "invalid_predictive_weather_mapping", 3)
    grid_x = _integer(item["grid_x"], "invalid_predictive_weather_mapping")
    grid_y = _integer(item["grid_y"], "invalid_predictive_weather_mapping")
    if not re.fullmatch(r"[A-Z]{3}", grid_id) or grid_x > 10_000 or grid_y > 10_000:
        raise ValueError("invalid_predictive_weather_mapping")
    if item["time_zone"] != "America/Chicago":
        raise ValueError("invalid_predictive_weather_mapping")
    url = _https_weather_url(
        item["forecast_grid_data_url"],
        "invalid_predictive_weather_mapping",
        "/gridpoints/",
    )
    if urlparse(url).path != f"/gridpoints/{grid_id}/{grid_x},{grid_y}":
        raise ValueError("invalid_predictive_weather_mapping")
    return {
        "grid_id": grid_id,
        "grid_x": grid_x,
        "grid_y": grid_y,
        "time_zone": "America/Chicago",
        "forecast_grid_data_url": url,
    }


def _normalize_layer(value, expected_key, expected_unit):
    item = _exact_object(
        value, {"key", "unit", "rows"}, "invalid_predictive_weather_layer"
    )
    if item["key"] != expected_key or item["unit"] != expected_unit:
        raise ValueError("invalid_predictive_weather_layer")
    if not isinstance(item["rows"], list) or len(item["rows"]) > MAX_LAYER_ROWS:
        raise ValueError("invalid_predictive_weather_layer_rows")
    output = []
    previous_end = None
    for raw in item["rows"]:
        row = _exact_object(
            raw,
            {"valid_start", "valid_end", "value"},
            "invalid_predictive_weather_layer_row",
        )
        start = _integer(row["valid_start"], "invalid_predictive_weather_layer_row")
        end = _integer(row["valid_end"], "invalid_predictive_weather_layer_row")
        if end <= start or end - start > MAX_FORECAST_SPAN_SECONDS:
            raise ValueError("invalid_predictive_weather_layer_row")
        if previous_end is not None and start < previous_end:
            raise ValueError("invalid_predictive_weather_layer_order")
        previous_end = end
        number = (
            None
            if row["value"] is None
            else _number(row["value"], "invalid_predictive_weather_layer_value")
        )
        output.append({"valid_start": start, "valid_end": end, "value": number})
    if output and output[-1]["valid_end"] - output[0]["valid_start"] > MAX_FORECAST_SPAN_SECONDS:
        raise ValueError("invalid_predictive_weather_layer_span")
    return {"key": expected_key, "unit": expected_unit, "rows": output}


def _normalize_forecast(payload):
    item = _exact_object(payload, {"schema", "stream", "points"}, "invalid_predictive_weather")
    if item["schema"] != SCHEMA or item["stream"] != "forecast":
        raise ValueError("invalid_predictive_weather")
    if not isinstance(item["points"], list) or len(item["points"]) != len(POINTS):
        raise ValueError("invalid_predictive_weather_points")
    output = []
    for raw, registry in zip(item["points"], POINTS, strict=True):
        point = _exact_object(
            raw,
            {
                "point_id",
                "label",
                "latitude",
                "longitude",
                "mapping",
                "update_time",
                "retrieved_at",
                "cache_fresh_until",
                "layers",
            },
            "invalid_predictive_weather_point",
        )
        point_id, label, latitude, longitude = registry
        if (
            point["point_id"] != point_id
            or point["label"] != label
            or _number(point["latitude"], "invalid_predictive_weather_point") != latitude
            or _number(point["longitude"], "invalid_predictive_weather_point") != longitude
        ):
            raise ValueError("invalid_predictive_weather_point")
        update_time, retrieved_at, cache_fresh_until = _validate_cache_times(
            point["update_time"],
            point["retrieved_at"],
            point["cache_fresh_until"],
            "invalid_predictive_weather_point_time",
        )
        if not isinstance(point["layers"], list) or len(point["layers"]) != len(LAYERS):
            raise ValueError("invalid_predictive_weather_layers")
        layers = [
            _normalize_layer(layer, key, unit)
            for layer, (key, unit) in zip(point["layers"], LAYERS, strict=True)
        ]
        output.append(
            {
                "point_id": point_id,
                "label": label,
                "latitude": latitude,
                "longitude": longitude,
                "mapping": _normalize_mapping(point["mapping"], point_id),
                "update_time": update_time,
                "retrieved_at": retrieved_at,
                "cache_fresh_until": cache_fresh_until,
                "layers": layers,
            }
        )
    return {
        "points": output,
        "source_updated_at": max(point["update_time"] for point in output),
        "retrieved_at": max(point["retrieved_at"] for point in output),
        "cache_fresh_until": min(point["cache_fresh_until"] for point in output),
        "availability_status": "available",
    }


def _normalize_reference(value):
    item = _exact_object(
        value, {"identifier", "sender", "sent"}, "invalid_predictive_weather_alert_reference"
    )
    return {
        "identifier": _text(
            item["identifier"], "invalid_predictive_weather_alert_reference", 512
        ),
        "sender": _text(item["sender"], "invalid_predictive_weather_alert_reference", 256),
        "sent": _integer(item["sent"], "invalid_predictive_weather_alert_reference"),
    }


def _normalize_alert(value):
    keys = {
        "id",
        "event",
        "headline",
        "area_desc",
        "severity",
        "urgency",
        "certainty",
        "message_type",
        "sent",
        "effective",
        "onset",
        "expires",
        "ends",
        "description",
        "instruction",
        "response",
        "affected_zones",
        "references",
        "source_url",
    }
    item = _exact_object(value, keys, "invalid_predictive_weather_alert")
    output = {
        "id": _text(item["id"], "invalid_predictive_weather_alert", 512),
        "event": _text(item["event"], "invalid_predictive_weather_alert", 160),
        "headline": _text(
            item["headline"], "invalid_predictive_weather_alert", 2_000, nullable=True
        ),
        "area_desc": _text(item["area_desc"], "invalid_predictive_weather_alert", 2_000),
        "severity": item["severity"],
        "urgency": item["urgency"],
        "certainty": item["certainty"],
        "message_type": item["message_type"],
        "sent": _integer(item["sent"], "invalid_predictive_weather_alert_time"),
        "effective": _integer(item["effective"], "invalid_predictive_weather_alert_time"),
        "onset": _integer(
            item["onset"], "invalid_predictive_weather_alert_time", nullable=True
        ),
        "expires": _integer(item["expires"], "invalid_predictive_weather_alert_time"),
        "ends": _integer(item["ends"], "invalid_predictive_weather_alert_time", nullable=True),
        "description": _text(
            item["description"], "invalid_predictive_weather_alert", 16_000
        ),
        "instruction": _text(
            item["instruction"],
            "invalid_predictive_weather_alert",
            16_000,
            nullable=True,
        ),
        "response": item["response"],
        "source_url": _https_weather_url(
            _text(item["source_url"], "invalid_predictive_weather_alert", 512),
            "invalid_predictive_weather_alert",
            "/alerts/",
        ),
    }
    if any(output[key] not in allowed for key, allowed in ALERT_ENUMS.items()):
        raise ValueError("invalid_predictive_weather_alert_enum")
    if output["effective"] > output["expires"]:
        raise ValueError("invalid_predictive_weather_alert_time")
    if output["onset"] is not None and output["ends"] is not None and output["onset"] > output["ends"]:
        raise ValueError("invalid_predictive_weather_alert_time")
    zones = item["affected_zones"]
    if not isinstance(zones, list) or len(zones) > 512:
        raise ValueError("invalid_predictive_weather_alert_zones")
    normalized_zones = [
        _https_weather_url(
            _text(zone, "invalid_predictive_weather_alert_zones", 512),
            "invalid_predictive_weather_alert_zones",
            "/zones/",
        )
        for zone in zones
    ]
    if len(set(normalized_zones)) != len(normalized_zones):
        raise ValueError("invalid_predictive_weather_alert_zones")
    references = item["references"]
    if not isinstance(references, list) or len(references) > 32:
        raise ValueError("invalid_predictive_weather_alert_references")
    output["affected_zones"] = sorted(normalized_zones)
    output["references"] = sorted(
        (_normalize_reference(reference) for reference in references),
        key=lambda reference: (reference["sent"], reference["identifier"]),
    )
    return output


def _normalize_alerts(payload):
    item = _exact_object(
        payload,
        {
            "schema",
            "stream",
            "collection_updated_at",
            "retrieved_at",
            "cache_fresh_until",
            "truncated",
            "items",
        },
        "invalid_predictive_weather",
    )
    if item["schema"] != SCHEMA or item["stream"] != "alerts":
        raise ValueError("invalid_predictive_weather")
    updated, retrieved, fresh = _validate_cache_times(
        item["collection_updated_at"],
        item["retrieved_at"],
        item["cache_fresh_until"],
        "invalid_predictive_weather_alert_collection_time",
    )
    if not isinstance(item["truncated"], bool):
        raise ValueError("invalid_predictive_weather_alert_collection")
    if not isinstance(item["items"], list) or len(item["items"]) > MAX_ALERTS:
        raise ValueError("invalid_predictive_weather_alert_count")
    items = sorted(
        (_normalize_alert(alert) for alert in item["items"]),
        key=lambda alert: (alert["effective"], alert["id"]),
    )
    if len({alert["id"] for alert in items}) != len(items):
        raise ValueError("duplicate_predictive_weather_alert")
    return {
        "collection_updated_at": updated,
        "retrieved_at": retrieved,
        "cache_fresh_until": fresh,
        "truncated": item["truncated"],
        "items": items,
        "source_updated_at": updated,
        "availability_status": "empty" if not items else "available",
    }


def _stream(payload):
    if not isinstance(payload, dict) or payload.get("stream") not in STREAM_SOURCE:
        raise ValueError("invalid_predictive_weather_stream")
    return payload["stream"]


def _record_success(conn, stream, normalized, content_version, current_ts):
    conn.execute(
        """INSERT INTO predictive_weather_health(
             stream,last_attempt_ts,last_success_ts,source_updated_at,retrieved_at,
             cache_fresh_until,availability_status,content_version,
             consecutive_failures,last_error,materialization_last_success_ts,
             materialization_consecutive_failures,materialization_last_error)
           VALUES(?,?,?,?,?,?,?,?,0,NULL,?,0,NULL)
           ON CONFLICT(stream) DO UPDATE SET
             last_attempt_ts=excluded.last_attempt_ts,
             last_success_ts=excluded.last_success_ts,
             source_updated_at=excluded.source_updated_at,
             retrieved_at=excluded.retrieved_at,
             cache_fresh_until=excluded.cache_fresh_until,
             availability_status=excluded.availability_status,
             content_version=excluded.content_version,
             consecutive_failures=0,last_error=NULL,
             materialization_last_success_ts=excluded.materialization_last_success_ts,
             materialization_consecutive_failures=0,
             materialization_last_error=NULL""",
        (
            stream,
            current_ts,
            current_ts,
            normalized["source_updated_at"],
            normalized["retrieved_at"],
            normalized["cache_fresh_until"],
            normalized["availability_status"],
            content_version,
            current_ts,
        ),
    )


def record_predictive_weather_failure(conn, stream, error, current_ts):
    if stream not in STREAM_SOURCE:
        return
    message = str(error)
    if not re.fullmatch(r"[a-z0-9_]{1,120}", message):
        message = "predictive_weather_ingest_failed"
    conn.execute(
        """INSERT INTO predictive_weather_health(
             stream,last_attempt_ts,consecutive_failures,last_error,
             materialization_consecutive_failures,materialization_last_error)
           VALUES(?,?,1,?,1,?)
           ON CONFLICT(stream) DO UPDATE SET
             last_attempt_ts=excluded.last_attempt_ts,
             consecutive_failures=predictive_weather_health.consecutive_failures+1,
             last_error=excluded.last_error,
             materialization_consecutive_failures=
               COALESCE(predictive_weather_health.materialization_consecutive_failures,0)+1,
             materialization_last_error=excluded.materialization_last_error""",
        (stream, current_ts, message, message),
    )
    conn.commit()


def _prune(conn, stream):
    rows = conn.execute(
        """SELECT content_version FROM predictive_weather_snapshots
           WHERE stream=? ORDER BY created_at DESC,content_version DESC""",
        (stream,),
    ).fetchall()
    stale = [row[0] for row in rows[MAX_SNAPSHOTS_PER_STREAM:]]
    if stale:
        conn.executemany(
            "DELETE FROM predictive_weather_snapshots WHERE stream=? AND content_version=?",
            ((stream, version) for version in stale),
        )
    return len(stale)


def ingest_predictive_weather(conn, payload, current_ts):
    stream = _stream(payload)
    normalized = (
        _normalize_forecast(payload) if stream == "forecast" else _normalize_alerts(payload)
    )
    snapshot = (
        {"points": normalized["points"]}
        if stream == "forecast"
        else {
            "collection_updated_at": normalized["collection_updated_at"],
            "retrieved_at": normalized["retrieved_at"],
            "cache_fresh_until": normalized["cache_fresh_until"],
            "truncated": normalized["truncated"],
            "items": normalized["items"],
        }
    )
    encoded = _canonical(snapshot)
    content_version = "pw1-" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    row_count = (
        sum(
            len(layer["rows"])
            for point in normalized["points"]
            for layer in point["layers"]
        )
        if stream == "forecast"
        else len(normalized["items"])
    )
    try:
        conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute(
            """SELECT content_version,source_updated_at,retrieved_at
               FROM predictive_weather_current WHERE stream=?""",
            (stream,),
        ).fetchone()
        if previous is not None:
            previous_version, previous_source, previous_retrieved = previous
            incoming_clock = (
                normalized["source_updated_at"],
                normalized["retrieved_at"],
            )
            previous_clock = (previous_source, previous_retrieved)
            if incoming_clock < previous_clock:
                conn.commit()
                return {
                    "status": "ignored_older",
                    "stream": stream,
                    "content_version": previous_version,
                    "availability_status": normalized["availability_status"],
                    "row_count": row_count,
                    "pruned": 0,
                }
            if incoming_clock == previous_clock and content_version != previous_version:
                raise ValueError("predictive_weather_publication_collision")
        conn.execute(
            """INSERT OR IGNORE INTO predictive_weather_snapshots
               (stream,content_version,payload_json,created_at) VALUES(?,?,?,?)""",
            (stream, content_version, encoded, current_ts),
        )
        conn.execute(
            """INSERT INTO predictive_weather_current(
                 stream,content_version,retrieved_at,source_updated_at,
                 cache_fresh_until,updated_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(stream) DO UPDATE SET
                 content_version=excluded.content_version,
                 retrieved_at=excluded.retrieved_at,
                 source_updated_at=excluded.source_updated_at,
                 cache_fresh_until=excluded.cache_fresh_until,
                 updated_at=excluded.updated_at
               WHERE excluded.source_updated_at > predictive_weather_current.source_updated_at
                  OR (excluded.source_updated_at = predictive_weather_current.source_updated_at
                      AND excluded.retrieved_at >= predictive_weather_current.retrieved_at)""",
            (
                stream,
                content_version,
                normalized["retrieved_at"],
                normalized["source_updated_at"],
                normalized["cache_fresh_until"],
                current_ts,
            ),
        )
        _record_success(conn, stream, normalized, content_version, current_ts)
        pruned = _prune(conn, stream)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "status": (
            "unchanged"
            if previous is not None and previous[0] == content_version
            else "corrected"
            if previous is not None
            and previous[1] == normalized["source_updated_at"]
            else "inserted"
        ),
        "stream": stream,
        "content_version": content_version,
        "availability_status": normalized["availability_status"],
        "row_count": row_count,
        "pruned": pruned,
    }


def _health_rows(conn, current_ts):
    rows = {
        row[0]: row
        for row in conn.execute(
            """SELECT stream,last_attempt_ts,last_success_ts,source_updated_at,
                      retrieved_at,cache_fresh_until,availability_status,
                      content_version,consecutive_failures,last_error,
                      materialization_last_success_ts,
                      materialization_consecutive_failures,
                      materialization_last_error
               FROM predictive_weather_health"""
        )
    }
    output = []
    for stream in ("forecast", "alerts"):
        row = rows.get(stream)
        if row is None:
            output.append(
                {
                    "source_id": STREAM_SOURCE[stream],
                    "state": "unavailable",
                    "availability_status": None,
                    "content_version": None,
                    "last_attempt_ts": None,
                    "last_success_ts": None,
                    "source_updated_at": None,
                    "retrieved_at": None,
                    "cache_fresh_until": None,
                    "consecutive_failures": 0,
                    "last_error": None,
                    "materialization": {
                        "state": "unavailable",
                        "last_success_ts": None,
                        "consecutive_failures": None,
                        "last_error": None,
                    },
                }
            )
            continue
        failed = row[8] > 0
        state = "failed" if failed else ("stale" if row[5] < current_ts else "healthy")
        materialization_state = (
            "failed"
            if row[11] is not None and row[11] > 0
            else ("healthy" if row[10] is not None else "unavailable")
        )
        output.append(
            {
                "source_id": STREAM_SOURCE[stream],
                "state": state,
                "availability_status": row[6],
                "content_version": row[7],
                "last_attempt_ts": row[1],
                "last_success_ts": row[2],
                "source_updated_at": row[3],
                "retrieved_at": row[4],
                "cache_fresh_until": row[5],
                "consecutive_failures": row[8],
                "last_error": row[9],
                "materialization": {
                    "state": materialization_state,
                    "last_success_ts": row[10],
                    "consecutive_failures": row[11],
                    "last_error": row[12],
                },
            }
        )
    return output


def _current_snapshot(conn, stream):
    row = conn.execute(
        """SELECT c.content_version,s.payload_json
           FROM predictive_weather_current c
           JOIN predictive_weather_snapshots s
             ON s.stream=c.stream AND s.content_version=c.content_version
           WHERE c.stream=?""",
        (stream,),
    ).fetchone()
    return None if row is None else (row[0], json.loads(row[1]))


def _empty_point(registry):
    point_id, label, latitude, longitude = registry
    return {
        "point_id": point_id,
        "label": label,
        "latitude": latitude,
        "longitude": longitude,
        "state": "unavailable",
        "mapping": None,
        "update_time": None,
        "retrieved_at": None,
        "cache_fresh_until": None,
        "layers": [{"key": key, "unit": unit, "rows": []} for key, unit in LAYERS],
    }


def predictive_weather_manifest(conn, current_ts):
    health = _health_rows(conn, current_ts)
    health_by_source = {item["source_id"]: item for item in health}
    forecast_current = _current_snapshot(conn, "forecast")
    if forecast_current is None:
        points = [_empty_point(point) for point in POINTS]
        forecast_health = health_by_source[STREAM_SOURCE["forecast"]]
        forecast_state = "failed" if forecast_health["state"] == "failed" else "unavailable"
        forecast_version = None
    else:
        forecast_version, forecast_snapshot = forecast_current
        points = []
        for point in forecast_snapshot["points"]:
            point = dict(point)
            point["state"] = (
                "available" if point["cache_fresh_until"] >= current_ts else "stale"
            )
            points.append(point)
        point_states = {point["state"] for point in points}
        forecast_state = (
            "available"
            if point_states == {"available"}
            else "stale"
            if point_states == {"stale"}
            else "partial"
        )
    alerts_current = _current_snapshot(conn, "alerts")
    if alerts_current is None:
        alerts_health = health_by_source[STREAM_SOURCE["alerts"]]
        alerts = {
            "state": "failed" if alerts_health["state"] == "failed" else "unavailable",
            "content_version": None,
            "coverage": ALERT_COVERAGE,
            "collection_updated_at": None,
            "retrieved_at": None,
            "cache_fresh_until": None,
            "truncated": False,
            "items": [],
        }
    else:
        alert_version, snapshot = alerts_current
        if snapshot["cache_fresh_until"] < current_ts:
            state = "stale"
        elif snapshot["truncated"]:
            state = "partial"
        elif snapshot["items"]:
            state = "available"
        else:
            state = "valid_empty"
        alerts = {
            "state": state,
            "content_version": alert_version,
            "coverage": ALERT_COVERAGE,
            "collection_updated_at": snapshot["collection_updated_at"],
            "retrieved_at": snapshot["retrieved_at"],
            "cache_fresh_until": snapshot["cache_fresh_until"],
            "truncated": snapshot["truncated"],
            "items": snapshot["items"],
        }
    return {
        "schema": SCHEMA,
        "kind": KIND,
        "registry_version": REGISTRY_VERSION,
        "policy": POLICY,
        "generated_at": current_ts,
        "forecast": {
            "state": forecast_state,
            "content_version": forecast_version,
            "points": points,
        },
        "alerts": alerts,
        "source_health": health,
    }
