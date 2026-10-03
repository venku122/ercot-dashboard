#!/usr/bin/env python3
"""No-lookahead forecast-quality materialization.

This module deliberately keeps forecast issue time and target time separate.  It
materializes bounded UTC-day resources; it never scans or rebuilds history at
startup.  Corrections create a new content version while old resources remain
addressable byte-for-byte.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
from collections import Counter, defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

from forecast_vintages import market_hour_target


METHODOLOGY_VERSION = "v1"
RESOURCE_SCHEMA_VERSION = 1
HORIZONS = {"1h": 3_600, "6h": 21_600, "24h": 86_400}
SERIES_KEYS = ("load.system", "wind.stwpf", "solar.stppf")
DAY_SECONDS = 86_400
MAX_MANIFEST_DAYS = 90
CHICAGO = ZoneInfo("America/Chicago")

LOAD_FORECAST_SOURCE = "ercot_public_np3_565_weather_zone_forecast"
LOAD_FORECAST_PRODUCT = "NP3-565-CD"
LOAD_ACTUAL_SOURCE = "ercot_public_np6_345_weather_zone_actual_load"
LOAD_ACTUAL_PRODUCT = "NP6-345-CD"
SERIES_SOURCE_IDS = {
    "load.system": (LOAD_FORECAST_SOURCE, LOAD_ACTUAL_SOURCE),
    "wind.stwpf": ("ercot_mis_np4_732",),
    "solar.stppf": ("ercot_mis_np4_737",),
}

RENEWABLE_CONTRACTS = {
    "NP4-732-CD": {
        "series_key": "wind.stwpf",
        "source_id": "ercot_mis_np4_732",
        "schema_fingerprint": "8b906df517cd9823499309dcc1adc594452c7fb5df5223b4b75476cd7679d3fb",
        "model": "STWPF",
    },
    "NP4-737-CD": {
        "series_key": "solar.stppf",
        "source_id": "ercot_mis_np4_737",
        "schema_fingerprint": "f17b161c2695047d29b1934bceccaf66e921a86125cafd389d69b454fc1f5974",
        "model": "STPPF",
    },
}

MISSING_REASONS = (
    "missing_actual",
    "missing_forecast",
    "ambiguous_active_model",
    "inactive_forecast",
    "lead_out_of_range",
    "unit_mismatch",
    "invalid_value",
)


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite(value):
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def _type7(values, probability):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    fraction = position - lower
    return ordered[lower] + fraction * (ordered[lower + 1] - ordered[lower])


def summarize_rows(rows, expected_count=None):
    valid = [row for row in rows if row.get("error_mw") is not None]
    errors = [row["error_mw"] for row in valid]
    absolute = [row["absolute_error_mw"] for row in valid]
    percentages = [
        row["absolute_percentage_error"]
        for row in valid
        if row.get("absolute_percentage_error") is not None
    ]
    dates = {row["delivery_date"] for row in valid if row.get("delivery_date")}
    targets = [row["target_ts"] for row in valid]
    expected = expected_count if expected_count is not None else len(rows)
    coverage = len(valid) / expected if expected else 0.0
    span = max(targets) - min(targets) if len(targets) > 1 else 0
    qualified = (
        len(valid) >= 100
        and len(dates) >= 30
        and span >= 28 * DAY_SECONDS
        and coverage >= 0.8
    )
    qualification_reasons = []
    if len(valid) < 100:
        qualification_reasons.append("insufficient_samples")
    if len(dates) < 30:
        qualification_reasons.append("insufficient_delivery_dates")
    if span < 28 * DAY_SECONDS:
        qualification_reasons.append("insufficient_sample_span")
    if coverage < 0.8:
        qualification_reasons.append("insufficient_joint_coverage")
    return {
        "sample_count": len(valid),
        "mape_sample_count": len(percentages),
        "expected_count": expected,
        "joint_coverage": coverage,
        "chicago_delivery_date_count": len(dates),
        "sample_span_seconds": span,
        "bias_mw": sum(errors) / len(errors) if errors else None,
        "mae_mw": sum(absolute) / len(absolute) if absolute else None,
        "mape_percent": sum(percentages) / len(percentages) if percentages else None,
        "signed_error_quantiles_mw": {
            "p10": _type7(errors, 0.10),
            "p50": _type7(errors, 0.50),
            "p90": _type7(errors, 0.90),
        },
        "absolute_error_p80_mw": _type7(absolute, 0.80),
        "empirical_interval": (
            {
                "kind": "historical_signed_error_type7_p10_p90",
                "lower_mw": _type7(errors, 0.10),
                "upper_mw": _type7(errors, 0.90),
            }
            if qualified
            else None
        ),
        "qualification": {
            "qualified": qualified,
            "reasons": qualification_reasons,
            "minimum_sample_count": 100,
            "minimum_chicago_delivery_dates": 30,
            "minimum_span_seconds": 28 * DAY_SECONDS,
            "minimum_joint_coverage": 0.8,
        },
    }


def init_forecast_quality_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS renewable_forecast_publications (
            id INTEGER PRIMARY KEY,
            source_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            vintage_key TEXT NOT NULL UNIQUE,
            publication_key TEXT NOT NULL,
            issued_at INTEGER NOT NULL,
            raw_publish_datetime TEXT NOT NULL,
            document_id TEXT NOT NULL,
            constructed_name TEXT NOT NULL,
            artifact_href TEXT NOT NULL,
            retrieved_at INTEGER NOT NULL,
            schema_fingerprint TEXT NOT NULL,
            parser_schema_version TEXT NOT NULL,
            declared_unit TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(source_id, product_id, publication_key)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_renewable_publications_issue
        ON renewable_forecast_publications(product_id, issued_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS renewable_forecast_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            delivery_date TEXT NOT NULL,
            hour_ending TEXT NOT NULL,
            dst_flag INTEGER NOT NULL,
            raw_delivery_date TEXT NOT NULL,
            raw_hour_ending TEXT NOT NULL,
            raw_dst_flag TEXT NOT NULL,
            forecast_mw REAL NOT NULL,
            actual_hsl_mw REAL,
            PRIMARY KEY(publication_id, target_ts),
            FOREIGN KEY(publication_id) REFERENCES renewable_forecast_publications(id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_renewable_forecast_target
        ON renewable_forecast_rows(target_ts, publication_id, forecast_mw, actual_hsl_mw)
        """
    )
    renewable_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(renewable_forecast_rows)")
    }
    for column in ("raw_delivery_date", "raw_hour_ending", "raw_dst_flag"):
        if column not in renewable_columns:
            conn.execute(f"ALTER TABLE renewable_forecast_rows ADD COLUMN {column} TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_quality_resources (
            series_key TEXT NOT NULL,
            methodology_version TEXT NOT NULL,
            content_version TEXT NOT NULL,
            horizon TEXT NOT NULL,
            day_start INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (
                series_key, methodology_version, content_version, horizon, day_start
            )
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_quality_current (
            series_key TEXT NOT NULL,
            methodology_version TEXT NOT NULL,
            horizon TEXT NOT NULL,
            day_start INTEGER NOT NULL,
            content_version TEXT NOT NULL,
            dataset_cutoff INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (series_key, methodology_version, horizon, day_start)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_quality_current_day
        ON forecast_quality_current(day_start DESC, series_key, horizon)
        """
    )
    current_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(forecast_quality_current)")
    }
    if "dataset_cutoff" not in current_columns:
        conn.execute(
            "ALTER TABLE forecast_quality_current "
            "ADD COLUMN dataset_cutoff INTEGER NOT NULL DEFAULT 0"
        )
    # This covering order bounds target-day selection before issue-time ranking.
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_np3_565_quality_target
        ON forecast_np3_565_rows(target_ts, publication_id, in_use_flag, model, system_total)
        """
    )
    conn.commit()


def _strict_text(value, name, maximum=512):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"invalid_renewable_{name}")
    return value


def _strict_epoch(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 4_102_444_800:
        raise ValueError(f"invalid_renewable_{name}")
    return value


def _renewable_publication(payload, current_ts):
    if not isinstance(payload, dict) or set(payload) != {"publication", "rows"}:
        raise ValueError("invalid_renewable_payload")
    publication = payload["publication"]
    rows = payload["rows"]
    expected_publication_fields = {
        "source_id",
        "product_id",
        "publication_key_kind",
        "publication_key",
        "issued_at",
        "raw_publish_datetime",
        "document_id",
        "constructed_name",
        "artifact_href",
        "retrieved_at",
        "schema_fingerprint",
        "parser_schema_version",
        "declared_unit",
    }
    if not isinstance(publication, dict) or set(publication) != expected_publication_fields:
        raise ValueError("invalid_renewable_publication")
    product_id = _strict_text(publication["product_id"], "product_id", 40)
    contract = RENEWABLE_CONTRACTS.get(product_id)
    if contract is None or publication["source_id"] != contract["source_id"]:
        raise ValueError("unsupported_renewable_product")
    if publication["publication_key_kind"] != "official_mis_document":
        raise ValueError("invalid_renewable_publication_key_kind")
    document_id = _strict_text(publication["document_id"], "document_id", 64)
    publication_key = _strict_text(publication["publication_key"], "publication_key", 64)
    if not document_id.isdigit() or publication_key != document_id:
        raise ValueError("invalid_renewable_document_identity")
    issued_at = _strict_epoch(publication["issued_at"], "issued_at")
    raw_publish = _strict_text(publication["raw_publish_datetime"], "publish_datetime", 64)
    try:
        parsed_publish = datetime.fromisoformat(raw_publish.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid_renewable_publish_datetime") from exc
    if parsed_publish.tzinfo is None or int(parsed_publish.timestamp()) != issued_at:
        raise ValueError("renewable_issue_datetime_mismatch")
    retrieved_at = _strict_epoch(publication["retrieved_at"], "retrieved_at")
    if retrieved_at < issued_at:
        raise ValueError("renewable_retrieved_before_issue")
    if retrieved_at > current_ts + 300:
        raise ValueError("renewable_retrieved_at_future")
    if publication["schema_fingerprint"] != contract["schema_fingerprint"]:
        raise ValueError("renewable_schema_fingerprint_mismatch")
    if publication["parser_schema_version"] != "ercot-mis-renewable-v1":
        raise ValueError("renewable_parser_schema_mismatch")
    if publication["declared_unit"] != "MW":
        raise ValueError("renewable_unit_mismatch")
    constructed_name = _strict_text(publication["constructed_name"], "constructed_name")
    if re.fullmatch(r"[A-Za-z0-9_.-]+\.zip", constructed_name, re.IGNORECASE) is None:
        raise ValueError("invalid_renewable_constructed_name")
    artifact_href = _strict_text(publication["artifact_href"], "artifact_href", 1_000)
    expected_href = (
        "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId="
        + document_id
    )
    if artifact_href != expected_href:
        raise ValueError("invalid_renewable_artifact_href")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 512:
        raise ValueError("invalid_renewable_rows")
    normalized_rows = []
    expected_row_fields = {
        "target_ts",
        "delivery_date",
        "hour_ending",
        "dst_flag",
        "raw_delivery_date",
        "raw_hour_ending",
        "raw_dst_flag",
        "forecast_mw",
        "actual_hsl_mw",
    }
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != expected_row_fields:
            raise ValueError("invalid_renewable_row")
        target_ts = _strict_epoch(row["target_ts"], "target_ts")
        delivery_date = _strict_text(row["delivery_date"], "delivery_date", 10)
        hour_ending = _strict_text(row["hour_ending"], "hour_ending", 5)
        if not isinstance(row["dst_flag"], bool):
            raise ValueError("invalid_renewable_dst_flag")
        raw_delivery_date = _strict_text(
            row["raw_delivery_date"], "raw_delivery_date", 32
        )
        raw_hour_ending = _strict_text(row["raw_hour_ending"], "raw_hour_ending", 16)
        raw_dst_flag = _strict_text(row["raw_dst_flag"], "raw_dst_flag", 16)
        if target_ts != market_hour_target(delivery_date, hour_ending, row["dst_flag"]):
            raise ValueError("renewable_target_mismatch")
        forecast_mw = row["forecast_mw"]
        actual_mw = row["actual_hsl_mw"]
        if (
            not _finite(forecast_mw)
            or not 0 <= float(forecast_mw) <= 1_000_000
            or (
                actual_mw is not None
                and (
                    not _finite(actual_mw)
                    or not 0 <= float(actual_mw) <= 1_000_000
                )
            )
        ):
            raise ValueError("invalid_renewable_measure")
        if target_ts in seen:
            raise ValueError("duplicate_renewable_target")
        seen.add(target_ts)
        normalized_rows.append(
            {
                "target_ts": target_ts,
                "delivery_date": delivery_date,
                "hour_ending": hour_ending,
                "dst_flag": row["dst_flag"],
                "raw_delivery_date": raw_delivery_date,
                "raw_hour_ending": raw_hour_ending,
                "raw_dst_flag": raw_dst_flag,
                "forecast_mw": float(forecast_mw),
                "actual_hsl_mw": None if actual_mw is None else float(actual_mw),
            }
        )
    normalized_rows.sort(key=lambda row: row["target_ts"])
    immutable = {
        key: publication[key]
        for key in expected_publication_fields
        if key != "retrieved_at"
    }
    content_hash = hashlib.sha256(
        canonical_json({"publication": immutable, "rows": normalized_rows}).encode("utf-8")
    ).hexdigest()
    vintage_key = "rv1-" + hashlib.sha256(
        canonical_json(
            {
                "source_id": contract["source_id"],
                "product_id": product_id,
                "publication_key": publication_key,
                "content_hash": content_hash,
            }
        ).encode("utf-8")
    ).hexdigest()
    return publication, normalized_rows, contract, content_hash, vintage_key


def ingest_renewable_publication(conn, payload, current_ts=None):
    current = int(time.time()) if current_ts is None else int(current_ts)
    publication, rows, contract, content_hash, vintage_key = _renewable_publication(
        payload, current
    )
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            """
            SELECT content_hash, row_count FROM renewable_forecast_publications
            WHERE source_id = ? AND product_id = ? AND publication_key = ?
            """,
            (
                contract["source_id"],
                publication["product_id"],
                publication["publication_key"],
            ),
        ).fetchone()
        if existing is not None:
            if existing[0] == content_hash and int(existing[1]) == len(rows):
                conn.commit()
                return {
                    "status": "unchanged",
                    "vintage_key": vintage_key,
                    "content_hash": content_hash,
                    "row_count": len(rows),
                }
            raise ValueError("renewable_publication_collision")
        cursor = conn.execute(
            """
            INSERT INTO renewable_forecast_publications (
                source_id, product_id, vintage_key, publication_key, issued_at,
                raw_publish_datetime, document_id, constructed_name, artifact_href,
                retrieved_at, schema_fingerprint, parser_schema_version, declared_unit,
                content_hash, row_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                contract["source_id"],
                publication["product_id"],
                vintage_key,
                publication["publication_key"],
                publication["issued_at"],
                publication["raw_publish_datetime"],
                publication["document_id"],
                publication["constructed_name"],
                publication["artifact_href"],
                publication["retrieved_at"],
                publication["schema_fingerprint"],
                publication["parser_schema_version"],
                publication["declared_unit"],
                content_hash,
                len(rows),
                current,
            ),
        )
        publication_id = int(cursor.lastrowid)
        conn.executemany(
            """
            INSERT INTO renewable_forecast_rows (
                publication_id, target_ts, delivery_date, hour_ending, dst_flag,
                raw_delivery_date, raw_hour_ending, raw_dst_flag,
                forecast_mw, actual_hsl_mw
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    publication_id,
                    row["target_ts"],
                    row["delivery_date"],
                    row["hour_ending"],
                    int(row["dst_flag"]),
                    row["raw_delivery_date"],
                    row["raw_hour_ending"],
                    row["raw_dst_flag"],
                    row["forecast_mw"],
                    row["actual_hsl_mw"],
                )
                for row in rows
            ],
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "status": "inserted",
        "vintage_key": vintage_key,
        "content_hash": content_hash,
        "row_count": len(rows),
    }


def _validate_identity(series_key, horizon, day_start):
    if series_key not in SERIES_KEYS:
        raise ValueError("unsupported_forecast_quality_series")
    if horizon not in HORIZONS:
        raise ValueError("unsupported_forecast_quality_horizon")
    if isinstance(day_start, bool) or not isinstance(day_start, int):
        raise ValueError("invalid_forecast_quality_day")
    if day_start < 0 or day_start % DAY_SECONDS:
        raise ValueError("invalid_forecast_quality_day")


def _load_forecast_candidates(conn, day_start, horizon_seconds, dataset_cutoff):
    rows = conn.execute(
        """
        WITH publication_target AS (
            SELECT r.target_ts, p.id AS publication_id, p.issued_at,
                   p.vintage_key, p.declared_unit,
                   SUM(CASE WHEN r.in_use_flag = 1 THEN 1 ELSE 0 END) active_count,
                   MAX(CASE WHEN r.in_use_flag = 1 THEN r.model END) active_model,
                   MAX(CASE WHEN r.in_use_flag = 1 THEN r.system_total END) forecast_mw
            FROM forecast_np3_565_rows AS r
                 INDEXED BY idx_forecast_np3_565_quality_target
            JOIN forecast_publications AS p ON p.id = r.publication_id
            WHERE r.target_ts >= ? AND r.target_ts < ?
              AND p.source_id = ? AND p.product_id = ?
              AND p.issued_at IS NOT NULL
              AND p.issued_at <= r.target_ts - ?
              AND p.issued_at <= ? AND p.retrieved_at <= ?
            GROUP BY r.target_ts, p.id
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY target_ts ORDER BY issued_at DESC, publication_id DESC
            ) selected_rank
            FROM publication_target
        )
        SELECT target_ts, publication_id, issued_at, vintage_key, declared_unit,
               active_count, active_model, forecast_mw
        FROM ranked WHERE selected_rank = 1 ORDER BY target_ts
        """,
        (
            day_start,
            day_start + DAY_SECONDS,
            LOAD_FORECAST_SOURCE,
            LOAD_FORECAST_PRODUCT,
            horizon_seconds,
            dataset_cutoff,
            dataset_cutoff,
        ),
    ).fetchall()
    return {int(row[0]): row for row in rows}


def _load_previous_forecasts(conn, selected, day_start, dataset_cutoff):
    previous = {}
    candidates = conn.execute(
        """
        WITH publication_target AS (
            SELECT r.target_ts, p.id publication_id, p.issued_at, p.vintage_key,
                   SUM(CASE WHEN r.in_use_flag = 1 THEN 1 ELSE 0 END) active_count,
                   MAX(CASE WHEN r.in_use_flag = 1 THEN r.model END) active_model,
                   MAX(CASE WHEN r.in_use_flag = 1 THEN r.system_total END) forecast_mw
            FROM forecast_np3_565_rows AS r
                 INDEXED BY idx_forecast_np3_565_quality_target
            JOIN forecast_publications AS p ON p.id = r.publication_id
            WHERE r.target_ts >= ? AND r.target_ts < ?
              AND p.source_id = ? AND p.product_id = ?
              AND p.issued_at IS NOT NULL AND p.issued_at <= ?
              AND p.retrieved_at <= ?
            GROUP BY r.target_ts, p.id
        )
        SELECT target_ts, issued_at, vintage_key, active_count, active_model, forecast_mw
        FROM publication_target ORDER BY target_ts, issued_at DESC, publication_id DESC
        """,
        (
            day_start,
            day_start + DAY_SECONDS,
            LOAD_FORECAST_SOURCE,
            LOAD_FORECAST_PRODUCT,
            dataset_cutoff,
            dataset_cutoff,
        ),
    ).fetchall()
    for candidate in candidates:
        target_ts = int(candidate[0])
        selected_row = selected.get(target_ts)
        if selected_row is None or target_ts in previous:
            continue
        if candidate[1] >= selected_row[2]:
            continue
        if int(candidate[3]) != 1 or candidate[4] != selected_row[6]:
            continue
        previous[target_ts] = (candidate[5], candidate[2], candidate[1])
    return previous


def _load_actuals(conn, day_start, dataset_cutoff):
    rows = conn.execute(
        """
        WITH ranked AS (
            SELECT r.target_ts, r.operating_day, r.total, p.vintage_key,
                   p.declared_unit, p.retrieved_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY r.target_ts
                       ORDER BY p.retrieved_at DESC, p.created_at DESC, p.id DESC
                   ) selected_rank
            FROM forecast_np6_345_rows AS r INDEXED BY idx_forecast_np6_345_target
            JOIN forecast_publications AS p ON p.id = r.publication_id
            WHERE r.target_ts >= ? AND r.target_ts < ?
              AND p.source_id = ? AND p.product_id = ?
              AND p.retrieved_at <= ?
        )
        SELECT target_ts, operating_day, total, vintage_key, declared_unit, retrieved_at
        FROM ranked WHERE selected_rank = 1 ORDER BY target_ts
        """,
        (
            day_start,
            day_start + DAY_SECONDS,
            LOAD_ACTUAL_SOURCE,
            LOAD_ACTUAL_PRODUCT,
            dataset_cutoff,
        ),
    ).fetchall()
    return {int(row[0]): row for row in rows}


def _missing_row(target_ts, delivery_date, reason):
    return {
        "target_ts": target_ts,
        "delivery_date": delivery_date,
        "forecast_mw": None,
        "actual_mw": None,
        "error_mw": None,
        "absolute_error_mw": None,
        "absolute_percentage_error": None,
        "revision_mw": None,
        "selected_issue_at": None,
        "effective_lead_seconds": None,
        "model": None,
        "forecast_vintage_key": None,
        "actual_vintage_key": None,
        "missing_reason": reason,
    }


def _compute_load_rows(conn, horizon, day_start, dataset_cutoff):
    horizon_seconds = HORIZONS[horizon]
    forecasts = _load_forecast_candidates(
        conn, day_start, horizon_seconds, dataset_cutoff
    )
    actuals = _load_actuals(conn, day_start, dataset_cutoff)
    previous = _load_previous_forecasts(conn, forecasts, day_start, dataset_cutoff)
    targets = list(range(day_start, day_start + DAY_SECONDS, 3_600))
    rows = []
    for target_ts in targets:
        forecast = forecasts.get(target_ts)
        actual = actuals.get(target_ts)
        delivery_date = (
            actual[1]
            if actual is not None
            else datetime.fromtimestamp(target_ts - 1, CHICAGO).date().isoformat()
        )
        if forecast is None:
            rows.append(_missing_row(target_ts, delivery_date, "missing_forecast"))
            continue
        lead = target_ts - int(forecast[2])
        if lead < horizon_seconds or lead >= horizon_seconds + 3_600:
            row = _missing_row(target_ts, delivery_date, "lead_out_of_range")
            row["selected_issue_at"] = int(forecast[2])
            row["effective_lead_seconds"] = lead
            rows.append(row)
            continue
        if int(forecast[5]) == 0:
            rows.append(_missing_row(target_ts, delivery_date, "inactive_forecast"))
            continue
        if int(forecast[5]) != 1:
            rows.append(_missing_row(target_ts, delivery_date, "ambiguous_active_model"))
            continue
        if actual is None:
            row = _missing_row(target_ts, delivery_date, "missing_actual")
            row.update(
                selected_issue_at=int(forecast[2]),
                effective_lead_seconds=lead,
                model=forecast[6],
                forecast_vintage_key=forecast[3],
            )
            rows.append(row)
            continue
        if forecast[4] != "MW" or actual[4] != "MW":
            rows.append(_missing_row(target_ts, delivery_date, "unit_mismatch"))
            continue
        forecast_value = forecast[7]
        actual_value = actual[2]
        if not _finite(forecast_value) or not _finite(actual_value):
            rows.append(_missing_row(target_ts, delivery_date, "invalid_value"))
            continue
        error = float(actual_value) - float(forecast_value)
        prior = previous.get(target_ts)
        revision = (
            None
            if prior is None or not _finite(prior[0])
            else float(forecast_value) - float(prior[0])
        )
        rows.append(
            {
                "target_ts": target_ts,
                "delivery_date": delivery_date,
                "forecast_mw": float(forecast_value),
                "actual_mw": float(actual_value),
                "error_mw": error,
                "absolute_error_mw": abs(error),
                "absolute_percentage_error": (
                    100.0 * abs(error) / abs(float(actual_value))
                    if float(actual_value) > 0
                    else None
                ),
                "revision_mw": revision,
                "selected_issue_at": int(forecast[2]),
                "effective_lead_seconds": lead,
                "model": forecast[6],
                "forecast_vintage_key": forecast[3],
                "actual_vintage_key": actual[3],
                "missing_reason": None,
            }
        )
    return rows


def _compute_renewable_rows(conn, series_key, horizon, day_start, dataset_cutoff):
    product_id, contract = next(
        (product_id, contract)
        for product_id, contract in RENEWABLE_CONTRACTS.items()
        if contract["series_key"] == series_key
    )
    source_rows = conn.execute(
        """
        SELECT r.target_ts, r.delivery_date, r.forecast_mw, r.actual_hsl_mw,
               p.issued_at, p.retrieved_at, p.created_at, p.id, p.vintage_key,
               p.declared_unit
        FROM renewable_forecast_rows AS r INDEXED BY idx_renewable_forecast_target
        JOIN renewable_forecast_publications AS p ON p.id = r.publication_id
        WHERE r.target_ts >= ? AND r.target_ts < ?
          AND p.source_id = ? AND p.product_id = ?
          AND p.issued_at <= ? AND p.retrieved_at <= ?
        ORDER BY r.target_ts, p.issued_at DESC, p.id DESC
        LIMIT 50001
        """,
        (
            day_start,
            day_start + DAY_SECONDS,
            contract["source_id"],
            product_id,
            dataset_cutoff,
            dataset_cutoff,
        ),
    ).fetchall()
    if len(source_rows) > 50_000:
        raise ValueError("forecast_quality_candidate_limit")
    by_target = defaultdict(list)
    for row in source_rows:
        by_target[int(row[0])].append(row)
    horizon_seconds = HORIZONS[horizon]
    output = []
    for target_ts in range(day_start, day_start + DAY_SECONDS, 3_600):
        candidates = by_target.get(target_ts, [])
        forecast_candidates = [
            row for row in candidates if int(row[4]) <= target_ts - horizon_seconds
        ]
        actual_candidates = [row for row in candidates if row[3] is not None]
        forecast = max(forecast_candidates, key=lambda row: (row[4], row[7]), default=None)
        actual = max(
            actual_candidates,
            key=lambda row: (row[4], row[5], row[6], row[7]),
            default=None,
        )
        delivery_date = (
            (actual or forecast)[1]
            if (actual or forecast) is not None
            else datetime.fromtimestamp(target_ts - 1, CHICAGO).date().isoformat()
        )
        if forecast is None:
            output.append(_missing_row(target_ts, delivery_date, "missing_forecast"))
            continue
        lead = target_ts - int(forecast[4])
        if lead < horizon_seconds or lead >= horizon_seconds + 3_600:
            row = _missing_row(target_ts, delivery_date, "lead_out_of_range")
            row["selected_issue_at"] = int(forecast[4])
            row["effective_lead_seconds"] = lead
            row["model"] = contract["model"]
            row["forecast_vintage_key"] = forecast[8]
            output.append(row)
            continue
        if actual is None:
            row = _missing_row(target_ts, delivery_date, "missing_actual")
            row.update(
                selected_issue_at=int(forecast[4]),
                effective_lead_seconds=lead,
                model=contract["model"],
                forecast_vintage_key=forecast[8],
            )
            output.append(row)
            continue
        if forecast[9] != "MW" or actual[9] != "MW":
            output.append(_missing_row(target_ts, delivery_date, "unit_mismatch"))
            continue
        forecast_value = float(forecast[2])
        actual_value = float(actual[3])
        prior = max(
            (row for row in forecast_candidates if row[4] < forecast[4]),
            key=lambda row: (row[4], row[7]),
            default=None,
        )
        error = actual_value - forecast_value
        output.append(
            {
                "target_ts": target_ts,
                "delivery_date": delivery_date,
                "forecast_mw": forecast_value,
                "actual_mw": actual_value,
                "error_mw": error,
                "absolute_error_mw": abs(error),
                "absolute_percentage_error": (
                    100.0 * abs(error) / abs(actual_value) if actual_value > 0 else None
                ),
                "revision_mw": None if prior is None else forecast_value - float(prior[2]),
                "selected_issue_at": int(forecast[4]),
                "effective_lead_seconds": lead,
                "model": contract["model"],
                "forecast_vintage_key": forecast[8],
                "actual_vintage_key": actual[8],
                "missing_reason": None,
            }
        )
    return output


def _resource_payload(series_key, horizon, day_start, rows):
    reasons = Counter(
        row["missing_reason"] for row in rows if row.get("missing_reason") is not None
    )
    models = Counter(row["model"] for row in rows if row.get("model") is not None)
    summary = summarize_rows(rows, DAY_SECONDS // 3_600)
    return {
        "schema": RESOURCE_SCHEMA_VERSION,
        "kind": "forecast_quality_daily",
        "series_key": series_key,
        "horizon": horizon,
        "horizon_seconds": HORIZONS[horizon],
        "tile_span": "1d",
        "day_start": day_start,
        "day_end": day_start + DAY_SECONDS,
        "unit": "MW",
        "methodology_version": METHODOLOGY_VERSION,
        "methodology": {
            "selection": "per_target_latest_issue_at_or_before_cutoff",
            "lead_window": "[horizon,horizon+3600)",
            "model_policy": (
                "exactly_one_in_use_row"
                if series_key == "load.system"
                else "product_implicit_model"
            ),
            "error_formula": "actual_minus_forecast",
            "positive_error_meaning": "underforecast",
            "mape_denominator": "positive_actual_only",
            "quantile_method": "Type 7",
            "diagnostic_pairing": {
                "load.system": "NP3-565 systemTotal vs NP6-345 total",
                "wind.stwpf": "NP4-732 STWPF_SYSTEM_WIDE vs SYSTEM_WIDE_HSL",
                "solar.stppf": "NP4-737 STPPF_SYSTEM_WIDE vs SYSTEM_WIDE_HSL",
            }[series_key],
        },
        "model_counts": dict(sorted(models.items())),
        "missing_reasons": {reason: reasons.get(reason, 0) for reason in MISSING_REASONS},
        "summary": summary,
        "rows": rows,
    }


def recompute_forecast_quality(
    conn: sqlite3.Connection,
    series_key: str,
    day_start: int,
    current_ts=None,
    dataset_cutoff=None,
    horizons=None,
):
    selected_horizons = tuple(HORIZONS) if horizons is None else tuple(horizons)
    for horizon in selected_horizons:
        _validate_identity(series_key, horizon, day_start)
    now = int(time.time()) if current_ts is None else int(current_ts)
    # ``current_ts`` was the original public recompute argument and remains an
    # explicit evaluation cutoff for compatibility.  A caller may provide a
    # distinct receiver-owned creation time via ``current_ts`` and selection
    # cutoff via ``dataset_cutoff`` when rebuilding an older snapshot.
    if dataset_cutoff is None:
        dataset_cutoff = now
    if isinstance(dataset_cutoff, bool) or not isinstance(dataset_cutoff, int):
        raise ValueError("invalid_forecast_quality_dataset_cutoff")
    if dataset_cutoff < 0 or dataset_cutoff > now:
        raise ValueError("invalid_forecast_quality_dataset_cutoff")
    nested = conn.in_transaction
    conn.execute("SAVEPOINT forecast_quality_recompute" if nested else "BEGIN IMMEDIATE")
    try:
        results = []
        for horizon in selected_horizons:
            rows = (
                _compute_load_rows(conn, horizon, day_start, dataset_cutoff)
                if series_key == "load.system"
                else _compute_renewable_rows(
                    conn, series_key, horizon, day_start, dataset_cutoff
                )
            )
            payload = _resource_payload(series_key, horizon, day_start, rows)
            content_version = "q1-" + hashlib.sha256(
                canonical_json(payload).encode("utf-8")
            ).hexdigest()
            payload["content_version"] = content_version
            encoded = canonical_json(payload)
            conn.execute(
                """
                INSERT OR IGNORE INTO forecast_quality_resources (
                    series_key, methodology_version, content_version, horizon,
                    day_start, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    series_key,
                    METHODOLOGY_VERSION,
                    content_version,
                    horizon,
                    day_start,
                    encoded,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO forecast_quality_current (
                    series_key, methodology_version, horizon, day_start,
                    content_version, dataset_cutoff, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(series_key, methodology_version, horizon, day_start)
                DO UPDATE SET content_version=excluded.content_version,
                              dataset_cutoff=excluded.dataset_cutoff,
                              updated_at=excluded.updated_at
                WHERE excluded.dataset_cutoff >= forecast_quality_current.dataset_cutoff
                  AND forecast_quality_current.content_version != excluded.content_version
                """,
                (
                    series_key,
                    METHODOLOGY_VERSION,
                    horizon,
                    day_start,
                    content_version,
                    dataset_cutoff,
                    now,
                ),
            )
            results.append(
                {
                    "series_key": series_key,
                    "horizon": horizon,
                    "day_start": day_start,
                    "content_version": content_version,
                    "row_count": len(rows),
                }
            )
        if nested:
            conn.execute("RELEASE SAVEPOINT forecast_quality_recompute")
        else:
            conn.commit()
        return results
    except Exception:
        if nested:
            conn.execute("ROLLBACK TO SAVEPOINT forecast_quality_recompute")
            conn.execute("RELEASE SAVEPOINT forecast_quality_recompute")
        else:
            conn.rollback()
        raise


def forecast_quality_resource(
    conn,
    series_key,
    methodology_version,
    content_version,
    horizon,
    day_start,
):
    _validate_identity(series_key, horizon, day_start)
    if methodology_version != METHODOLOGY_VERSION:
        raise ValueError("unsupported_forecast_quality_methodology")
    if not isinstance(content_version, str) or len(content_version) != 67:
        raise ValueError("invalid_forecast_quality_content_version")
    if not content_version.startswith("q1-") or any(
        char not in "0123456789abcdef" for char in content_version[3:]
    ):
        raise ValueError("invalid_forecast_quality_content_version")
    row = conn.execute(
        """
        SELECT payload_json FROM forecast_quality_resources
        WHERE series_key = ? AND methodology_version = ? AND content_version = ?
          AND horizon = ? AND day_start = ?
        """,
        (series_key, methodology_version, content_version, horizon, day_start),
    ).fetchone()
    return None if row is None else json.loads(row[0])


def forecast_quality_manifest(conn, now=None):
    current = int(time.time()) if now is None else int(now)
    completed_day_start = current // DAY_SECONDS * DAY_SECONDS
    cutoff = completed_day_start - MAX_MANIFEST_DAYS * DAY_SECONDS
    rows = conn.execute(
        """
        SELECT c.series_key, c.horizon, c.day_start, c.content_version,
               c.updated_at, r.payload_json
        FROM forecast_quality_current AS c
        JOIN forecast_quality_resources AS r
          ON r.series_key = c.series_key
         AND r.methodology_version = c.methodology_version
         AND r.content_version = c.content_version
         AND r.horizon = c.horizon AND r.day_start = c.day_start
        WHERE c.methodology_version = ? AND c.day_start >= ? AND c.day_start < ?
        ORDER BY c.series_key, c.horizon, c.day_start
        LIMIT ?
        """,
        (
            METHODOLOGY_VERSION,
            cutoff,
            completed_day_start,
            len(SERIES_KEYS) * len(HORIZONS) * MAX_MANIFEST_DAYS,
        ),
    ).fetchall()
    grouped_rows = defaultdict(list)
    represented_days = defaultdict(list)
    resources = []
    update_times = []
    for series_key, horizon, day_start, content_version, updated_at, payload_json in rows:
        if day_start + DAY_SECONDS > current:
            continue
        payload = json.loads(payload_json)
        grouped_rows[(series_key, horizon)].extend(payload["rows"])
        represented_days[(series_key, horizon)].append(day_start)
        update_times.append(updated_at)
        resources.append(
            {
                "series_key": series_key,
                "horizon": horizon,
                "day_start": day_start,
                "content_version": content_version,
                "url": (
                    f"/api/v2/forecast-quality/{series_key}/{METHODOLOGY_VERSION}/"
                    f"{content_version}/{horizon}/1d/{day_start}"
                ),
            }
        )
    summaries = []
    for series_key in SERIES_KEYS:
        for horizon in HORIZONS:
            key = (series_key, horizon)
            combined = grouped_rows.get(key, [])
            days = represented_days.get(key, [])
            expected_count = (
                ((max(days) - min(days)) // DAY_SECONDS + 1) * 24 if days else 0
            )
            reasons = Counter(
                row.get("missing_reason") for row in combined if row.get("missing_reason")
            )
            summaries.append(
                {
                    "series_key": series_key,
                    "horizon": horizon,
                    "availability": "available" if combined else "unavailable",
                    "summary": summarize_rows(combined, expected_count),
                    "missing_reasons": dict(sorted(reasons.items())),
                }
            )
    updated_at = max(update_times, default=None)
    source_contracts = []
    health_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collector_sources'"
    ).fetchone()
    for series_key, source_ids in SERIES_SOURCE_IDS.items():
        health = []
        if health_table is not None:
            for source_id in source_ids:
                row = conn.execute(
                    """
                    SELECT source_id, display_name, availability_status,
                           consecutive_failures, last_success_ts, source_timestamp_ts,
                           data_timestamp_ts, expected_interval_seconds,
                           publication_mode, publication_interval_seconds
                    FROM collector_sources WHERE source_id = ?
                    """,
                    (source_id,),
                ).fetchone()
                expected_interval = None if row is None else int(row[7])
                failures = None if row is None else int(row[3] or 0)
                last_success = None if row is None else row[4]
                collection_age = (
                    None if last_success is None else max(0, current - int(last_success))
                )
                collection_state = (
                    "unavailable"
                    if row is None
                    else "failed"
                    if last_success is None or failures >= 3
                    else "delayed"
                    if failures > 0
                    or collection_age is None
                    or collection_age > expected_interval * 2
                    else "healthy"
                )
                source_age = (
                    None if row is None or row[5] is None else max(0, current - int(row[5]))
                )
                data_age = (
                    None if row is None or row[6] is None else max(0, current - int(row[6]))
                )
                publication_interval = (
                    expected_interval
                    if row is None or row[9] is None
                    else int(row[9])
                )
                freshness_state = (
                    "unknown"
                    if row is None
                    else "event_driven"
                    if row[8] == "event"
                    else "unknown"
                    if data_age is None
                    else "stale"
                    if data_age > publication_interval * 4
                    else "delayed"
                    if data_age > publication_interval * 2
                    else "fresh"
                )
                state = collection_state
                if collection_state != "failed" and freshness_state == "stale":
                    state = "stale"
                elif collection_state == "healthy" and freshness_state in (
                    "delayed",
                    "unknown",
                ):
                    state = "delayed"
                health.append(
                    {
                        "source_id": source_id,
                        "display_name": None if row is None else row[1],
                        "availability_status": None if row is None else row[2],
                        "consecutive_failures": None if row is None else row[3],
                        "last_success_ts": None if row is None else row[4],
                        "source_timestamp_ts": None if row is None else row[5],
                        "data_timestamp_ts": None if row is None else row[6],
                        "expected_interval_seconds": expected_interval,
                        "collection_age_seconds": collection_age,
                        "source_age_seconds": source_age,
                        "data_age_seconds": data_age,
                        "state": state,
                        "collection_state": collection_state,
                        "freshness_state": freshness_state,
                    }
                )
        source_contracts.append(
            {
                "series_key": series_key,
                "source_ids": list(source_ids),
                "health": health,
                "interpretation": (
                    "diagnostic_product_pairing"
                    if series_key == "load.system"
                    else "forecast_vs_system_wide_hsl"
                ),
            }
        )
    return {
        "schema": RESOURCE_SCHEMA_VERSION,
        "kind": "forecast_quality_manifest",
        "methodology_version": METHODOLOGY_VERSION,
        "dataset_updated_through": updated_at,
        "window_days": MAX_MANIFEST_DAYS,
        "supported_series": list(SERIES_KEYS),
        "supported_horizons": list(HORIZONS),
        "source_contracts": source_contracts,
        "summaries": summaries,
        "resources": resources,
    }


def affected_utc_days_for_forecast_vintage(conn, vintage_key):
    publication = conn.execute(
        "SELECT id, product_id FROM forecast_publications WHERE vintage_key = ?",
        (vintage_key,),
    ).fetchone()
    if publication is None:
        return []
    table = {
        LOAD_FORECAST_PRODUCT: "forecast_np3_565_rows",
        LOAD_ACTUAL_PRODUCT: "forecast_np6_345_rows",
    }.get(publication[1])
    if table is None:
        return []
    return [
        int(row[0])
        for row in conn.execute(
            f"SELECT DISTINCT (target_ts / {DAY_SECONDS}) * {DAY_SECONDS} "
            f"FROM {table} WHERE publication_id = ? ORDER BY 1 LIMIT 32",
            (publication[0],),
        )
    ]


def affected_utc_days_for_renewable_vintage(conn, vintage_key):
    publication = conn.execute(
        "SELECT id FROM renewable_forecast_publications WHERE vintage_key = ?",
        (vintage_key,),
    ).fetchone()
    if publication is None:
        return []
    return [
        int(row[0])
        for row in conn.execute(
            f"SELECT DISTINCT (target_ts / {DAY_SECONDS}) * {DAY_SECONDS} "
            "FROM renewable_forecast_rows WHERE publication_id = ? "
            "ORDER BY 1 LIMIT 32",
            (publication[0],),
        )
    ]


def renewable_series_for_vintage(conn, vintage_key):
    row = conn.execute(
        "SELECT product_id FROM renewable_forecast_publications WHERE vintage_key = ?",
        (vintage_key,),
    ).fetchone()
    if row is None or row[0] not in RENEWABLE_CONTRACTS:
        return None
    return RENEWABLE_CONTRACTS[row[0]]["series_key"]
