"""Immutable ERCOT publication storage using verified product-wide schemas."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from zoneinfo import ZoneInfo


MAX_PUBLICATION_ROWS = 50_000
MAX_QUERY_ROWS = 5_000
MAX_TARGET_SPAN = 366 * 86_400
MAX_OUTLOOK_TARGETS = 193
MAX_EPOCH_SECONDS = 32_503_680_000
MAX_RETRIEVED_FUTURE_SKEW = 300

PRODUCT_NP3_565 = "NP3-565-CD"
PRODUCT_NP3_763 = "NP3-763-CD"
PRODUCT_NP6_345 = "NP6-345-CD"
SUPPORTED_PRODUCTS = (PRODUCT_NP3_565, PRODUCT_NP3_763, PRODUCT_NP6_345)
PARSER_SCHEMA_VERSION = "ercot-public-wide-v1"
CHICAGO = ZoneInfo("America/Chicago")

NP3_565_MEASURES = (
    "coast",
    "east",
    "farWest",
    "north",
    "northCentral",
    "southCentral",
    "southern",
    "west",
    "systemTotal",
)
NP3_763_MEASURES = (
    "capGenResSouth",
    "capGenResNorth",
    "capGenResWest",
    "capGenResHouston",
    "capLoadResSouth",
    "capLoadResNorth",
    "capLoadResWest",
    "capLoadResHouston",
    "offAvailMWSouth",
    "offAvailMWNorth",
    "offAvailMWWest",
    "offAvailMWHouston",
    "availCapGen",
    "availCapRes",
    "capGenRes",
    "capLoadRes",
    "offAvailMW",
    "capREGUP",
    "capREGDN",
    "capRRS",
    "capECRS",
    "capNSPIN",
    "capREGUPRRS",
    "capREGUPRRSECRS",
    "capREGUPRRSECRSNSPIN",
)
NP6_345_MEASURES = (
    "coast",
    "east",
    "farWest",
    "north",
    "northC",
    "southern",
    "southC",
    "west",
    "total",
)
FORECAST_ACTUAL_MEASURE = {
    "coast": "coast",
    "east": "east",
    "farWest": "farWest",
    "north": "north",
    "northCentral": "northC",
    "southCentral": "southC",
    "southern": "southern",
    "west": "west",
    "systemTotal": "total",
}
VERIFIED_FIELDS = {
    PRODUCT_NP3_565: (
        ("postedDatetime", "DATETIME"),
        ("deliveryDate", "DATE"),
        ("hourEnding", "VARCHAR"),
        *((field, "DOUBLE") for field in NP3_565_MEASURES),
        ("model", "VARCHAR"),
        ("inUseFlag", "BOOLEAN"),
        ("DSTFlag", "BOOLEAN"),
    ),
    PRODUCT_NP3_763: (
        ("postedDatetime", "DATETIME"),
        ("deliveryDate", "DATE"),
        ("hourEnding", "DOUBLE"),
        *((field, "DOUBLE") for field in NP3_763_MEASURES),
        ("repeatHourFlag", "BOOLEAN"),
    ),
    PRODUCT_NP6_345: (
        ("operatingDay", "DATE"),
        ("hourEnding", "VARCHAR"),
        *((field, "DOUBLE") for field in NP6_345_MEASURES),
        ("DSTFlag", "BOOLEAN"),
    ),
}
VERIFIED_FIELD_ORDER = {
    product_id: tuple(name for name, _data_type in fields)
    for product_id, fields in VERIFIED_FIELDS.items()
}
SOURCE_CONTRACTS = {
    PRODUCT_NP3_565: {
        "source_id": "ercot_public_np3_565_weather_zone_forecast",
        "artifact_href": "https://api.ercot.com/api/public-reports/np3-565-cd/lf_by_model_weather_zone",
    },
    PRODUCT_NP3_763: {
        "source_id": "ercot_public_np3_763_system_adequacy",
        "artifact_href": "https://api.ercot.com/api/public-reports/np3-763-cd/st_sys_adequacy",
    },
    PRODUCT_NP6_345: {
        "source_id": "ercot_public_np6_345_weather_zone_actual_load",
        "artifact_href": "https://api.ercot.com/api/public-reports/np6-345-cd/act_sys_load_by_wzn",
    },
}
PRODUCT_QUERY_FIELDS = {
    PRODUCT_NP3_565: frozenset(
        {
            "deliveryDateFrom",
            "deliveryDateTo",
            "postedDatetimeFrom",
            "postedDatetimeTo",
            "hourEnding",
            "model",
            "inUseFlag",
            "DSTFlag",
            "page",
            "size",
            "sort",
            "dir",
        }
    ),
    PRODUCT_NP3_763: frozenset(
        {
            "postedDatetimeFrom",
            "postedDatetimeTo",
            "deliveryDateFrom",
            "deliveryDateTo",
            "hourEndingFrom",
            "hourEndingTo",
            "page",
            "size",
        }
    ),
    PRODUCT_NP6_345: frozenset(
        {
            "operatingDayFrom",
            "operatingDayTo",
            "hourEnding",
            "DSTFlag",
            "page",
            "size",
            "sort",
            "dir",
        }
    ),
}
VERIFIED_NP3_565_QUERY_MODELS = frozenset(
    {"A3", "A6", "E", "E1", "E2", "E3", "M", "X"}
)


def schema_fingerprint(product_id):
    encoded = json.dumps(
        VERIFIED_FIELDS[product_id], separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _text(value, field, limit=240, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f"invalid_{field}")
    return value.strip()


def _epoch(value, field, optional=False):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"invalid_{field}")
    if value < 0 or value > MAX_EPOCH_SECONDS:
        raise ValueError(f"invalid_{field}")
    return value


def _integer(value, field, minimum=0, maximum=10_000):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"invalid_{field}")
    if value < minimum or value > maximum:
        raise ValueError(f"invalid_{field}")
    return value


def _boolean(value, field):
    if not isinstance(value, bool):
        raise ValueError(f"invalid_{field}")
    return value


def _measure(value, field):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"invalid_{field}")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid_{field}") from exc
    if not math.isfinite(numeric):
        raise ValueError(f"invalid_{field}")
    return numeric


def market_hour_target(day_text, hour_ending, repeated):
    """Return the UTC end instant for one ERCOT America/Chicago market hour."""
    try:
        market_day = date.fromisoformat(day_text)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_market_day") from exc
    if market_day.isoformat() != day_text:
        raise ValueError("invalid_market_day")
    if not isinstance(hour_ending, str):
        raise ValueError("invalid_hourEnding")
    match = re.fullmatch(r"(?:0?([1-9])|(1\d|2[0-4])):00", hour_ending)
    if match is None:
        raise ValueError("invalid_hourEnding")
    hour = int(match.group(1) or match.group(2))
    repeated = _boolean(repeated, "repeated_hour_flag")
    local_start = datetime.combine(market_day, datetime_time(), CHICAGO)
    local_end = datetime.combine(market_day + timedelta(days=1), datetime_time(), CHICAGO)
    utc_start = local_start.astimezone(timezone.utc)
    utc_end = local_end.astimezone(timezone.utc)
    market_hours = int((utc_end - utc_start).total_seconds() // 3600)
    if market_hours == 23:
        labels = [(1, False), *((value, False) for value in range(3, 25))]
    elif market_hours == 25:
        labels = [
            (1, False),
            (2, False),
            (2, True),
            *((value, False) for value in range(3, 25)),
        ]
    else:
        labels = [(value, False) for value in range(1, 25)]
    try:
        ordinal = labels.index((hour, repeated)) + 1
    except ValueError as exc:
        raise ValueError("invalid_market_hour_sequence") from exc
    return int((utc_start + timedelta(hours=ordinal)).timestamp())


def posted_datetime_target(raw_posted_datetime):
    try:
        naive = datetime.strptime(raw_posted_datetime, "%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_raw_posted_datetime") from exc
    candidates = set()
    for fold in (0, 1):
        local = naive.replace(tzinfo=CHICAGO, fold=fold)
        utc = local.astimezone(timezone.utc)
        if utc.astimezone(CHICAGO).replace(tzinfo=None) == naive:
            candidates.add(int(utc.timestamp()))
    if len(candidates) != 1:
        raise ValueError("ambiguous_or_nonexistent_raw_posted_datetime")
    return candidates.pop()


def _query_window_json(product_id, value):
    if not isinstance(value, dict) or len(value) > len(PRODUCT_QUERY_FIELDS[product_id]):
        raise ValueError("invalid_query_window")
    if not set(value).issubset(PRODUCT_QUERY_FIELDS[product_id]):
        raise ValueError("invalid_query_window_field")
    normalized = {}
    for key in sorted(value):
        item = value[key]
        if key in ("deliveryDateFrom", "deliveryDateTo", "operatingDayFrom", "operatingDayTo"):
            try:
                parsed = date.fromisoformat(item)
            except (TypeError, ValueError) as exc:
                raise ValueError("invalid_query_window_value") from exc
            if parsed.isoformat() != item:
                raise ValueError("invalid_query_window_value")
        elif key in ("postedDatetimeFrom", "postedDatetimeTo"):
            if not isinstance(item, str):
                raise ValueError("invalid_query_window_value")
            try:
                parsed = datetime.strptime(item, "%Y-%m-%dT%H:%M:%S")
            except ValueError as exc:
                raise ValueError("invalid_query_window_value") from exc
            if parsed.strftime("%Y-%m-%dT%H:%M:%S") != item:
                raise ValueError("invalid_query_window_value")
        elif key in ("hourEnding", "hourEndingFrom", "hourEndingTo"):
            if not isinstance(item, str) or re.fullmatch(
                r"(?:0?[1-9]|1\d|2[0-4]):00", item
            ) is None:
                raise ValueError("invalid_query_window_value")
        elif key == "model":
            if item not in VERIFIED_NP3_565_QUERY_MODELS:
                raise ValueError("invalid_query_window_value")
        elif key in ("inUseFlag", "DSTFlag"):
            if not isinstance(item, bool):
                raise ValueError("invalid_query_window_value")
        elif key == "page":
            if isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 1_000_000:
                raise ValueError("invalid_query_window_value")
        elif key == "size":
            if isinstance(item, bool) or not isinstance(item, int) or not 1 <= item <= 1_000:
                raise ValueError("invalid_query_window_value")
        elif key == "sort":
            if item not in VERIFIED_FIELD_ORDER[product_id]:
                raise ValueError("invalid_query_window_value")
        elif key == "dir":
            if item not in ("ASC", "DESC"):
                raise ValueError("invalid_query_window_value")
        else:
            raise ValueError("invalid_query_window_value")
        normalized[key] = item
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 4_096:
        raise ValueError("query_window_too_large")
    return encoded


def init_forecast_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_publications (
            id INTEGER PRIMARY KEY,
            source_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            vintage_key TEXT NOT NULL,
            issued_at INTEGER,
            published_at INTEGER,
            raw_posted_datetime TEXT,
            retrieved_at INTEGER NOT NULL,
            artifact_href TEXT NOT NULL,
            query_window_json TEXT NOT NULL,
            parser_schema_version TEXT NOT NULL,
            schema_fingerprint TEXT NOT NULL,
            declared_unit TEXT,
            content_hash TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            publication_key_kind TEXT NOT NULL,
            publication_key TEXT NOT NULL,
            UNIQUE(source_id, product_id, vintage_key)
        )
        """
    )
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(forecast_publications)")
    }
    if "publication_key_kind" not in existing_columns:
        conn.execute("ALTER TABLE forecast_publications ADD COLUMN publication_key_kind TEXT")
    if "publication_key" not in existing_columns:
        conn.execute("ALTER TABLE forecast_publications ADD COLUMN publication_key TEXT")
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_publication_official_key
        ON forecast_publications(source_id, product_id, publication_key)
        WHERE publication_key IS NOT NULL
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_publication_issue
        ON forecast_publications(source_id, product_id, issued_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_publication_product_retrieved
        ON forecast_publications(product_id, retrieved_at DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_np3_565_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            delivery_date TEXT NOT NULL,
            hour_ending TEXT NOT NULL,
            dst_flag INTEGER NOT NULL,
            model TEXT NOT NULL,
            in_use_flag INTEGER NOT NULL,
            coast REAL, east REAL, far_west REAL, north REAL,
            north_central REAL, south_central REAL, southern REAL, west REAL,
            system_total REAL,
            PRIMARY KEY(publication_id, target_ts, model),
            FOREIGN KEY(publication_id) REFERENCES forecast_publications(id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_np3_565_target
        ON forecast_np3_565_rows(target_ts, publication_id, model)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_np3_763_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            delivery_date TEXT NOT NULL,
            hour_ending TEXT NOT NULL,
            repeat_hour_flag INTEGER NOT NULL,
            cap_gen_res_south REAL, cap_gen_res_north REAL,
            cap_gen_res_west REAL, cap_gen_res_houston REAL,
            cap_load_res_south REAL, cap_load_res_north REAL,
            cap_load_res_west REAL, cap_load_res_houston REAL,
            off_avail_mw_south REAL, off_avail_mw_north REAL,
            off_avail_mw_west REAL, off_avail_mw_houston REAL,
            avail_cap_gen REAL, avail_cap_res REAL, cap_gen_res REAL,
            cap_load_res REAL, off_avail_mw REAL, cap_regup REAL,
            cap_regdn REAL, cap_rrs REAL, cap_ecrs REAL, cap_nspin REAL,
            cap_regup_rrs REAL, cap_regup_rrs_ecrs REAL,
            cap_regup_rrs_ecrs_nspin REAL,
            PRIMARY KEY(publication_id, target_ts),
            FOREIGN KEY(publication_id) REFERENCES forecast_publications(id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_np3_763_target
        ON forecast_np3_763_rows(target_ts, publication_id)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS forecast_np6_345_rows (
            publication_id INTEGER NOT NULL,
            target_ts INTEGER NOT NULL,
            operating_day TEXT NOT NULL,
            hour_ending TEXT NOT NULL,
            dst_flag INTEGER NOT NULL,
            coast REAL, east REAL, far_west REAL, north REAL,
            north_c REAL, southern REAL, south_c REAL, west REAL, total REAL,
            PRIMARY KEY(publication_id, target_ts),
            FOREIGN KEY(publication_id) REFERENCES forecast_publications(id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_forecast_np6_345_target
        ON forecast_np6_345_rows(target_ts, publication_id)
        """
    )
    conn.commit()


def _publication(payload, current_ts):
    publication = payload.get("publication")
    if not isinstance(publication, dict):
        raise ValueError("invalid_publication")
    allowed_fields = {
        "source_id",
        "product_id",
        "publication_key_kind",
        "publication_key",
        "issued_at",
        "published_at",
        "raw_posted_datetime",
        "retrieved_at",
        "artifact_href",
        "query_window",
        "parser_schema_version",
        "schema_fingerprint",
        "declared_unit",
    }
    if not set(publication).issubset(allowed_fields):
        if "vintage_key" in publication:
            raise ValueError("caller_vintage_key_not_allowed")
        raise ValueError("invalid_publication_field")
    product_id = _text(publication.get("product_id"), "product_id", 40)
    if product_id not in SUPPORTED_PRODUCTS:
        raise ValueError("unsupported_forecast_product")
    issued_at = _epoch(publication.get("issued_at"), "issued_at", optional=True)
    if product_id in (PRODUCT_NP3_565, PRODUCT_NP3_763) and issued_at is None:
        raise ValueError("missing_issued_at")
    raw_posted_datetime = _text(
        publication.get("raw_posted_datetime"),
        "raw_posted_datetime",
        120,
        optional=True,
    )
    if product_id in (PRODUCT_NP3_565, PRODUCT_NP3_763) and raw_posted_datetime is None:
        raise ValueError("missing_raw_posted_datetime")
    if product_id in (PRODUCT_NP3_565, PRODUCT_NP3_763):
        if publication.get("published_at") is not None:
            raise ValueError("unverified_forecast_published_at")
        if posted_datetime_target(raw_posted_datetime) != issued_at:
            raise ValueError("issued_at_posted_datetime_mismatch")
    fingerprint = _text(
        publication.get("schema_fingerprint"), "schema_fingerprint", 128
    )
    if fingerprint != schema_fingerprint(product_id):
        raise ValueError("forecast_schema_fingerprint_mismatch")
    source_id = _text(publication.get("source_id"), "source_id", 120)
    artifact_href = _text(publication.get("artifact_href"), "artifact_href", 1_000)
    parser_schema_version = _text(
        publication.get("parser_schema_version"), "parser_schema_version", 120
    )
    contract = SOURCE_CONTRACTS[product_id]
    if (
        source_id != contract["source_id"]
        or artifact_href != contract["artifact_href"]
        or parser_schema_version != PARSER_SCHEMA_VERSION
    ):
        raise ValueError("unverified_forecast_source_contract")
    publication_key_kind = _text(
        publication.get("publication_key_kind"), "publication_key_kind", 40
    )
    publication_key = publication.get("publication_key")
    if product_id in (PRODUCT_NP3_565, PRODUCT_NP3_763):
        if publication_key_kind != "official_posted_datetime":
            raise ValueError("invalid_publication_key_kind")
        publication_key = _text(publication_key, "publication_key", 240)
        if publication_key != raw_posted_datetime:
            raise ValueError("invalid_publication_key")
    else:
        if publication_key_kind != "content_hash" or publication_key is not None:
            raise ValueError("invalid_publication_key_kind")
        if issued_at is not None or publication.get("published_at") is not None:
            raise ValueError("unverified_actual_publication_time")
    declared_unit = _text(
        publication.get("declared_unit"), "declared_unit", 80, optional=True
    )
    if declared_unit not in (None, "MW"):
        raise ValueError("unverified_declared_unit")
    retrieved_at = _epoch(publication.get("retrieved_at", current_ts), "retrieved_at")
    if retrieved_at > current_ts + MAX_RETRIEVED_FUTURE_SKEW:
        raise ValueError("retrieved_at_in_future")
    return {
        "source_id": source_id,
        "product_id": product_id,
        "issued_at": issued_at,
        "published_at": _epoch(
            publication.get("published_at"), "published_at", optional=True
        ),
        "raw_posted_datetime": raw_posted_datetime,
        "retrieved_at": retrieved_at,
        "artifact_href": artifact_href,
        "query_window_json": _query_window_json(
            product_id, publication.get("query_window")
        ),
        "parser_schema_version": parser_schema_version,
        "schema_fingerprint": fingerprint,
        "declared_unit": declared_unit,
        "publication_key_kind": publication_key_kind,
        "publication_key": publication_key,
    }


def _common_row(row, date_field, dst_field):
    if not isinstance(row, dict):
        raise ValueError("invalid_forecast_row")
    return {
        "target_ts": _epoch(row.get("target_ts"), "target_ts"),
        date_field: _text(row.get(date_field), date_field, 40),
        "hourEnding": _text(row.get("hourEnding"), "hourEnding", 20),
        dst_field: _boolean(row.get(dst_field), dst_field),
    }


def _normalize_np3_565(row, publication):
    output = _common_row(row, "deliveryDate", "DSTFlag")
    output["postedDatetime"] = _text(row.get("postedDatetime"), "postedDatetime", 120)
    output["model"] = _text(row.get("model"), "model", 120)
    output["inUseFlag"] = _boolean(row.get("inUseFlag"), "inUseFlag")
    for field in NP3_565_MEASURES:
        output[field] = _measure(row.get(field), field)
    if (
        publication["raw_posted_datetime"] is not None
        and output["postedDatetime"] != publication["raw_posted_datetime"]
    ):
        raise ValueError("publication_posted_datetime_mismatch")
    if output["target_ts"] != market_hour_target(
        output["deliveryDate"], output["hourEnding"], output["DSTFlag"]
    ):
        raise ValueError("forecast_target_timestamp_mismatch")
    return output


def _normalize_np3_763(row, publication):
    output = _common_row(row, "deliveryDate", "repeatHourFlag")
    output["postedDatetime"] = _text(row.get("postedDatetime"), "postedDatetime", 120)
    for field in NP3_763_MEASURES:
        output[field] = _measure(row.get(field), field)
    if (
        publication["raw_posted_datetime"] is not None
        and output["postedDatetime"] != publication["raw_posted_datetime"]
    ):
        raise ValueError("publication_posted_datetime_mismatch")
    if output["target_ts"] != market_hour_target(
        output["deliveryDate"], output["hourEnding"], output["repeatHourFlag"]
    ):
        raise ValueError("forecast_target_timestamp_mismatch")
    return output


def _normalize_np6_345(row, _publication):
    output = _common_row(row, "operatingDay", "DSTFlag")
    for field in NP6_345_MEASURES:
        output[field] = _measure(row.get(field), field)
    if output["target_ts"] != market_hour_target(
        output["operatingDay"], output["hourEnding"], output["DSTFlag"]
    ):
        raise ValueError("forecast_target_timestamp_mismatch")
    return output


NORMALIZERS = {
    PRODUCT_NP3_565: _normalize_np3_565,
    PRODUCT_NP3_763: _normalize_np3_763,
    PRODUCT_NP6_345: _normalize_np6_345,
}

EXPECTED_ROW_FIELDS = {
    PRODUCT_NP3_565: frozenset(
        {"target_ts", "postedDatetime", "deliveryDate", "hourEnding", "model", "inUseFlag", "DSTFlag", *NP3_565_MEASURES}
    ),
    PRODUCT_NP3_763: frozenset(
        {"target_ts", "postedDatetime", "deliveryDate", "hourEnding", "repeatHourFlag", *NP3_763_MEASURES}
    ),
    PRODUCT_NP6_345: frozenset(
        {"target_ts", "operatingDay", "hourEnding", "DSTFlag", *NP6_345_MEASURES}
    ),
}


def _row_key(product_id, row):
    if product_id == PRODUCT_NP3_565:
        return row["target_ts"], row["model"]
    return (row["target_ts"],)


def _content_hash(publication, rows):
    canonical_identity = {
        key: publication[key]
        for key in (
            "source_id",
            "product_id",
            "issued_at",
            "published_at",
            "raw_posted_datetime",
            "artifact_href",
            "parser_schema_version",
            "schema_fingerprint",
            "declared_unit",
            "publication_key_kind",
            "publication_key",
        )
    }
    encoded = json.dumps(
        {"identity": canonical_identity, "rows": rows},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _insert_rows(conn, publication_id, product_id, rows):
    if product_id == PRODUCT_NP3_565:
        conn.executemany(
            """
            INSERT INTO forecast_np3_565_rows VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            [
                (
                    publication_id, row["target_ts"], row["deliveryDate"],
                    row["hourEnding"], row["DSTFlag"], row["model"],
                    row["inUseFlag"], row["coast"], row["east"], row["farWest"],
                    row["north"], row["northCentral"], row["southCentral"],
                    row["southern"], row["west"], row["systemTotal"],
                )
                for row in rows
            ],
        )
    elif product_id == PRODUCT_NP3_763:
        fields = [
            "target_ts", "deliveryDate", "hourEnding", "repeatHourFlag",
            *NP3_763_MEASURES,
        ]
        placeholders = ",".join("?" for _ in range(len(fields) + 1))
        conn.executemany(
            f"INSERT INTO forecast_np3_763_rows VALUES ({placeholders})",
            [(publication_id, *(row[field] for field in fields)) for row in rows],
        )
    else:
        fields = ["target_ts", "operatingDay", "hourEnding", "DSTFlag", *NP6_345_MEASURES]
        placeholders = ",".join("?" for _ in range(len(fields) + 1))
        conn.executemany(
            f"INSERT INTO forecast_np6_345_rows VALUES ({placeholders})",
            [(publication_id, *(row[field] for field in fields)) for row in rows],
        )


def ingest_forecast_publication(conn, payload, current_ts=None):
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
        raise ValueError("invalid_forecast_publication_payload")
    if not payload["rows"] or len(payload["rows"]) > MAX_PUBLICATION_ROWS:
        raise ValueError("invalid_forecast_publication_row_count")
    current = int(time.time()) if current_ts is None else _epoch(current_ts, "created_at")
    publication = _publication(payload, current)
    if any(
        not isinstance(row, dict)
        or frozenset(row) != EXPECTED_ROW_FIELDS[publication["product_id"]]
        for row in payload["rows"]
    ):
        raise ValueError("forecast_publication_schema_mismatch")
    rows = [
        NORMALIZERS[publication["product_id"]](row, publication)
        for row in payload["rows"]
    ]
    rows.sort(key=lambda row: _row_key(publication["product_id"], row))
    keys = [_row_key(publication["product_id"], row) for row in rows]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate_forecast_publication_row")
    content_hash = _content_hash(publication, rows)
    if publication["publication_key_kind"] == "content_hash":
        publication["publication_key"] = content_hash
    vintage_identity = json.dumps(
        {
            "source_id": publication["source_id"],
            "product_id": publication["product_id"],
            "publication_key_kind": publication["publication_key_kind"],
            "publication_key": publication["publication_key"],
            "content_hash": content_hash,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    publication["vintage_key"] = "v1-" + hashlib.sha256(
        vintage_identity.encode("utf-8")
    ).hexdigest()
    # Serialize the identity check and insert. This makes concurrent replays
    # idempotent and prevents two writers from racing between SELECT and INSERT.
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            """
            SELECT id, content_hash, row_count FROM forecast_publications
            WHERE source_id = ? AND product_id = ? AND publication_key = ?
            """,
            (
                publication["source_id"],
                publication["product_id"],
                publication["publication_key"],
            ),
        ).fetchone()
        if existing is not None:
            if existing[1] == content_hash and int(existing[2]) == len(rows):
                conn.commit()
                return {
                    "status": "unchanged",
                    "vintage_key": publication["vintage_key"],
                    "content_hash": content_hash,
                    "row_count": len(rows),
                }
            raise ValueError("forecast_publication_collision")
        cursor = conn.execute(
            """
            INSERT INTO forecast_publications (
                source_id, product_id, vintage_key, issued_at, published_at,
                raw_posted_datetime, retrieved_at, artifact_href,
                query_window_json, parser_schema_version, schema_fingerprint,
                declared_unit, content_hash, row_count, created_at,
                publication_key_kind, publication_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                publication["source_id"], publication["product_id"],
                publication["vintage_key"], publication["issued_at"],
                publication["published_at"], publication["raw_posted_datetime"],
                publication["retrieved_at"], publication["artifact_href"],
                publication["query_window_json"],
                publication["parser_schema_version"],
                publication["schema_fingerprint"], publication["declared_unit"],
                content_hash, len(rows), current,
                publication["publication_key_kind"], publication["publication_key"],
            ),
        )
        publication_id = int(cursor.lastrowid)
        _insert_rows(conn, publication_id, publication["product_id"], rows)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "status": "inserted",
        "vintage_key": publication["vintage_key"],
        "content_hash": content_hash,
        "row_count": len(rows),
    }


def _publication_dict(row):
    return {
        "source_id": row[1],
        "product_id": row[2],
        "vintage_key": row[3],
        "issued_at": row[4],
        "published_at": row[5],
        "raw_posted_datetime": row[6],
        "retrieved_at": row[7],
        "artifact_href": row[8],
        "query_window": json.loads(row[9]),
        "parser_schema_version": row[10],
        "schema_fingerprint": row[11],
        "declared_unit": row[12],
        "content_hash": row[13],
        "row_count": row[14],
        "created_at": row[15],
        "publication_key_kind": row[16],
        "publication_key": row[17],
    }


def list_publications(conn, source_id, product_id, limit=100, issued_lte=None):
    source_id = _text(source_id, "source_id", 120)
    product_id = _text(product_id, "product_id", 40)
    if product_id not in SUPPORTED_PRODUCTS:
        raise ValueError("unsupported_forecast_product")
    limit = _integer(limit, "limit", 1, 500)
    clauses = ["source_id = ?", "product_id = ?"]
    params = [source_id, product_id]
    if issued_lte is not None:
        clauses.append("issued_at <= ?")
        params.append(_epoch(issued_lte, "issued_lte"))
    rows = conn.execute(
        "SELECT * FROM forecast_publications WHERE "
        + " AND ".join(clauses)
        + " ORDER BY issued_at DESC, id DESC LIMIT ?",
        (*params, limit),
    ).fetchall()
    return [_publication_dict(row) for row in rows]


def _latest_publication(conn, product_id, issued_lte=None):
    contract = SOURCE_CONTRACTS[product_id]
    clauses = ["source_id = ?", "product_id = ?", "issued_at IS NOT NULL"]
    params = [contract["source_id"], product_id]
    if issued_lte is not None:
        clauses.append("issued_at <= ?")
        params.append(issued_lte)
    return conn.execute(
        "SELECT * FROM forecast_publications WHERE "
        + " AND ".join(clauses)
        + " ORDER BY issued_at DESC, id DESC LIMIT 1",
        params,
    ).fetchone()


def _outlook_publication(publication):
    if publication is None:
        return None
    return {
        "source_id": publication[1],
        "product_id": publication[2],
        "vintage_key": publication[3],
        "issued_at": publication[4],
        "retrieved_at": publication[7],
        "declared_unit": publication[12],
    }


def _active_load_rows(conn, publication):
    if publication is None:
        return []
    rows = conn.execute(
        """
        SELECT target_ts, delivery_date, hour_ending, dst_flag, model, system_total
        FROM forecast_np3_565_rows
        WHERE publication_id = ? AND in_use_flag = 1
        ORDER BY target_ts, model
        LIMIT ?
        """,
        (publication[0], MAX_OUTLOOK_TARGETS + 1),
    ).fetchall()
    if len(rows) > MAX_OUTLOOK_TARGETS:
        raise ValueError("outlook_target_limit_exceeded")
    targets = [row[0] for row in rows]
    if len(targets) != len(set(targets)):
        raise ValueError("ambiguous_active_outlook_model")
    return [
        {
            "target_ts": row[0],
            "delivery_date": row[1],
            "hour_ending": row[2],
            "dst_flag": bool(row[3]),
            "model": row[4],
            "demand_mw": row[5],
        }
        for row in rows
    ]


def _adequacy_rows(conn, publication, start, end):
    if publication is None or start is None or end is None:
        return []
    rows = conn.execute(
        """
        SELECT target_ts, delivery_date, hour_ending, repeat_hour_flag,
               avail_cap_gen, avail_cap_res
        FROM forecast_np3_763_rows
        WHERE publication_id = ? AND target_ts >= ? AND target_ts <= ?
        ORDER BY target_ts
        LIMIT ?
        """,
        (publication[0], start, end, MAX_OUTLOOK_TARGETS + 1),
    ).fetchall()
    if len(rows) > MAX_OUTLOOK_TARGETS:
        raise ValueError("outlook_target_limit_exceeded")
    return [
        {
            "target_ts": row[0],
            "delivery_date": row[1],
            "hour_ending": row[2],
            "repeat_hour_flag": bool(row[3]),
            "available_generation_mw": row[4],
            "projected_headroom_mw": row[5],
        }
        for row in rows
    ]


def outlook_snapshot(conn):
    """Return the bounded current Grid Outlook source contract.

    NP3-763 ``availCapRes`` is the only projected-headroom field. ERCOT STAR
    defines it as available generation capacity minus forecast demand.
    """
    current = _latest_publication(conn, PRODUCT_NP3_565)
    current_rows = _active_load_rows(conn, current)
    revision = None
    revision_rows = []
    if current is not None:
        revision = _latest_publication(conn, PRODUCT_NP3_565, current[4] - 86_400)
        revision_rows = _active_load_rows(conn, revision)
    revision_by_target = {row["target_ts"]: row for row in revision_rows}
    for row in current_rows:
        reference = revision_by_target.get(row["target_ts"])
        row["revision_mw"] = (
            None
            if reference is None
            or reference["model"] != row["model"]
            or reference["demand_mw"] is None
            or row["demand_mw"] is None
            else row["demand_mw"] - reference["demand_mw"]
        )

    adequacy = _latest_publication(conn, PRODUCT_NP3_763)
    start = current_rows[0]["target_ts"] if current_rows else None
    end = current_rows[-1]["target_ts"] if current_rows else None
    adequacy_rows = _adequacy_rows(conn, adequacy, start, end)
    return {
        "schema": 1,
        "forecast": {
            "publication": _outlook_publication(current) if current_rows else None,
            "selection_policy": "in_use_flag_true",
            "revision_reference": _outlook_publication(revision)
            if current_rows and revision_rows
            else None,
            "revision_policy": "latest_issued_at_least_24h_before_current",
            "rows": current_rows,
        },
        "adequacy": {
            "publication": _outlook_publication(adequacy) if adequacy_rows else None,
            "headroom_field": "availCapRes",
            "headroom_definition": "AvailCapGen minus forecasted Demand for each hour",
            "rows": adequacy_rows,
        },
        "weather_context": {
            "state": "not_integrated",
            "provider": None,
            "driver": None,
        },
        "interpretation": {
            "kind": "dashboard_outlook",
            "official_ercot_status": False,
            "status": None,
        },
    }


def resolve_publication(conn, source_id, product_id, vintage_key):
    row = conn.execute(
        """
        SELECT * FROM forecast_publications
        WHERE source_id = ? AND product_id = ? AND vintage_key = ?
        """,
        (source_id, product_id, vintage_key),
    ).fetchone()
    return row


def _target_window(start, end):
    start = _epoch(start, "target_start")
    end = _epoch(end, "target_end")
    if end <= start or end - start > MAX_TARGET_SPAN:
        raise ValueError("invalid_target_window")
    return start, end


def publication_rows(conn, publication_row, start, end, model=None, in_use_flag=None):
    start, end = _target_window(start, end)
    publication_id = int(publication_row[0])
    product_id = publication_row[2]
    if product_id == PRODUCT_NP3_565:
        clauses = ["publication_id = ?", "target_ts >= ?", "target_ts < ?"]
        params = [publication_id, start, end]
        if model is not None:
            clauses.append("model = ?")
            params.append(_text(model, "model", 120))
        if in_use_flag is not None:
            clauses.append("in_use_flag = ?")
            params.append(1 if _boolean(in_use_flag, "in_use_flag") else 0)
        rows = conn.execute(
            "SELECT * FROM forecast_np3_565_rows WHERE "
            + " AND ".join(clauses)
            + " ORDER BY target_ts, model, in_use_flag LIMIT ?",
            (*params, MAX_QUERY_ROWS),
        ).fetchall()
        fields = (
            "target_ts", "deliveryDate", "hourEnding", "DSTFlag", "model",
            "inUseFlag", *NP3_565_MEASURES,
        )
    elif product_id == PRODUCT_NP3_763:
        rows = conn.execute(
            """
            SELECT * FROM forecast_np3_763_rows
            WHERE publication_id = ? AND target_ts >= ? AND target_ts < ?
            ORDER BY target_ts LIMIT ?
            """,
            (publication_id, start, end, MAX_QUERY_ROWS),
        ).fetchall()
        fields = (
            "target_ts", "deliveryDate", "hourEnding", "repeatHourFlag",
            *NP3_763_MEASURES,
        )
    else:
        rows = conn.execute(
            """
            SELECT * FROM forecast_np6_345_rows
            WHERE publication_id = ? AND target_ts >= ? AND target_ts < ?
            ORDER BY target_ts LIMIT ?
            """,
            (publication_id, start, end, MAX_QUERY_ROWS),
        ).fetchall()
        fields = (
            "target_ts", "operatingDay", "hourEnding", "DSTFlag", *NP6_345_MEASURES,
        )
    output = [dict(zip(fields, row[1:])) for row in rows]
    flag_fields = {
        PRODUCT_NP3_565: ("DSTFlag", "inUseFlag"),
        PRODUCT_NP3_763: ("repeatHourFlag",),
        PRODUCT_NP6_345: ("DSTFlag",),
    }[product_id]
    for item in output:
        if product_id in (PRODUCT_NP3_565, PRODUCT_NP3_763):
            item["postedDatetime"] = publication_row[6]
        for field in flag_fields:
            item[field] = bool(item[field])
    return output


def comparison_rows(
    conn,
    forecast_source_id,
    actual_source_id,
    as_of,
    start,
    end,
    model,
    in_use_flag,
    forecast_measure,
):
    forecast_source_id = _text(forecast_source_id, "forecast_source_id", 120)
    actual_source_id = _text(actual_source_id, "actual_source_id", 120)
    model = _text(model, "model", 120)
    in_use_flag = _boolean(in_use_flag, "in_use_flag")
    as_of = _epoch(as_of, "as_of")
    start, end = _target_window(start, end)
    if forecast_measure not in FORECAST_ACTUAL_MEASURE:
        raise ValueError("invalid_forecast_measure")
    forecast_publication = conn.execute(
        """
        SELECT * FROM forecast_publications
        WHERE source_id = ? AND product_id = ? AND issued_at <= ?
        ORDER BY issued_at DESC, id DESC LIMIT 1
        """,
        (forecast_source_id, PRODUCT_NP3_565, as_of),
    ).fetchone()
    if forecast_publication is None:
        return None, [], []
    forecast_rows = publication_rows(
        conn, forecast_publication, start, end, model, in_use_flag
    )
    forecast_rows = [
        row for row in forecast_rows if row["target_ts"] >= forecast_publication[4]
    ]
    if not forecast_rows:
        return forecast_publication, [], []
    actual_rows = conn.execute(
        """
        WITH ranked AS (
            SELECT r.*, p.vintage_key, p.published_at, p.retrieved_at,
                   p.declared_unit, p.created_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY r.target_ts
                       ORDER BY p.retrieved_at DESC, p.created_at DESC, p.id DESC
                   ) AS selected_rank
            FROM forecast_np6_345_rows AS r
                 INDEXED BY idx_forecast_np6_345_target
            JOIN forecast_publications AS p ON p.id = r.publication_id
            WHERE p.source_id = ? AND p.product_id = ?
              AND r.target_ts >= ? AND r.target_ts < ?
        )
        SELECT * FROM ranked WHERE selected_rank = 1
        ORDER BY target_ts LIMIT ?
        """,
        (actual_source_id, PRODUCT_NP6_345, start, end, MAX_QUERY_ROWS),
    ).fetchall()
    if not actual_rows:
        return forecast_publication, [], []
    actual_fields = (
        "publication_id", "target_ts", "operatingDay", "hourEnding", "DSTFlag",
        *NP6_345_MEASURES,
        "vintage_key", "published_at", "retrieved_at", "declared_unit", "created_at",
        "selected_rank",
    )
    actual_rows = [dict(zip(actual_fields, row)) for row in actual_rows]
    for row in actual_rows:
        row["DSTFlag"] = bool(row["DSTFlag"])
    actual_field = FORECAST_ACTUAL_MEASURE[forecast_measure]
    actual_by_target = {row["target_ts"]: row for row in actual_rows}
    actual_publications = []
    seen_actual_vintages = set()
    for row in actual_rows:
        if row["vintage_key"] in seen_actual_vintages:
            continue
        seen_actual_vintages.add(row["vintage_key"])
        actual_publications.append(
            {
                "vintage_key": row["vintage_key"],
                "published_at": row["published_at"],
                "retrieved_at": row["retrieved_at"],
                "declared_unit": row["declared_unit"],
            }
        )
    output = []
    for forecast in forecast_rows:
        actual = actual_by_target.get(forecast["target_ts"])
        forecast_value = forecast[forecast_measure]
        actual_value = None if actual is None else actual[actual_field]
        actual_unit = None if actual is None else actual["declared_unit"]
        unit_compatible = bool(
            forecast_publication[12]
            and actual_unit
            and forecast_publication[12] == actual_unit
        )
        error = (
            None
            if forecast_value is None or actual_value is None or not unit_compatible
            else actual_value - forecast_value
        )
        output.append(
            {
                "target_ts": forecast["target_ts"],
                "selected_issued_at": forecast_publication[4],
                "horizon_seconds": forecast["target_ts"] - forecast_publication[4],
                "interpretation": "known_at_diagnostic",
                "forecast_measure": forecast_measure,
                "actual_measure": actual_field,
                "forecast_value": forecast_value,
                "actual_value": actual_value,
                "forecast_declared_unit": forecast_publication[12],
                "actual_declared_unit": actual_unit,
                "actual_vintage_key": None if actual is None else actual["vintage_key"],
                "actual_published_at": None if actual is None else actual["published_at"],
                "actual_retrieved_at": None if actual is None else actual["retrieved_at"],
                "unit_compatible": unit_compatible,
                "error": error,
                "absolute_error": None if error is None else abs(error),
            }
        )
    return forecast_publication, actual_publications, output
