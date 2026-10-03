#!/usr/bin/env python3
"""Strict regional load and hourly renewable publication domain for PR13."""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from datetime import datetime

from forecast_vintages import market_hour_target

DAY_SECONDS = 86_400
METHODOLOGY = "v1"
SCHEMA_VERSION = 1
FORECAST_ERROR_REASON = "generation_is_curtailment_affected_forecast_targets_hsl"
LOAD_REGIONS = (
    "coast", "east", "far-west", "north", "north-central",
    "south-central", "southern", "west",
)
CONTRACTS = {
    "NP4-742-CD": {
        "source_id": "ercot_mis_np4_742",
        "fingerprint": "19cd7f070b74ac47bc1678b3804015a994def81971bce1fb327d6e941be15b22",
        "kind": "wind",
        "regions": ("panhandle", "coastal", "south", "west", "north"),
    },
    "NP4-745-CD": {
        "source_id": "ercot_mis_np4_745",
        "fingerprint": "6e18bdac7331a4b544205a9010601b130d92e5f5c5ac4e74e2cbd001de276954",
        "kind": "solar",
        "regions": (
            "center-west", "north-west", "far-west", "far-east",
            "south-east", "center-east",
        ),
    },
}
PUBLICATION_FIELDS = {
    "source_id", "product_id", "publication_key_kind", "publication_key",
    "issued_at", "raw_publish_datetime", "document_id", "constructed_name",
    "artifact_href", "retrieved_at", "schema_fingerprint",
    "parser_schema_version", "declared_unit",
}
ROW_FIELDS = {
    "target_ts", "delivery_date", "hour_ending", "dst_flag",
    "raw_delivery_date", "raw_hour_ending", "raw_dst_flag", "system", "regions",
}
MEASURE_FIELDS = {"gen_mw", "cop_hsl_mw", "forecast_mw", "resource_plan_mw"}


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite_mw(value, nullable=False):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("invalid_regional_measure")
    result = float(value)
    if not math.isfinite(result) or result < 0 or result > 1_000_000:
        raise ValueError("invalid_regional_measure")
    return 0.0 if result == 0 else result


def _measure(value):
    if not isinstance(value, dict) or set(value) != MEASURE_FIELDS:
        raise ValueError("invalid_regional_measure_shape")
    return {
        "gen_mw": _finite_mw(value["gen_mw"], nullable=True),
        "cop_hsl_mw": _finite_mw(value["cop_hsl_mw"]),
        "forecast_mw": _finite_mw(value["forecast_mw"]),
        "resource_plan_mw": _finite_mw(value["resource_plan_mw"]),
    }


def _publication(payload, current_ts):
    if not isinstance(payload, dict) or set(payload) != {"publication", "rows"}:
        raise ValueError("invalid_regional_publication_payload")
    publication = payload["publication"]
    rows = payload["rows"]
    if not isinstance(publication, dict) or set(publication) != PUBLICATION_FIELDS:
        raise ValueError("invalid_regional_publication")
    product_id = publication["product_id"]
    contract = CONTRACTS.get(product_id)
    if contract is None or publication["source_id"] != contract["source_id"]:
        raise ValueError("unsupported_regional_product")
    if publication["publication_key_kind"] != "official_mis_document":
        raise ValueError("invalid_regional_publication_key_kind")
    document_id = publication["document_id"]
    if not isinstance(document_id, str) or not re.fullmatch(r"[0-9]{1,20}", document_id):
        raise ValueError("invalid_regional_document_id")
    if publication["publication_key"] != document_id:
        raise ValueError("invalid_regional_publication_key")
    if publication["artifact_href"] != (
        "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=" + document_id
    ):
        raise ValueError("invalid_regional_artifact_href")
    if publication["schema_fingerprint"] != contract["fingerprint"]:
        raise ValueError("invalid_regional_schema_fingerprint")
    if publication["parser_schema_version"] != "ercot-mis-regional-v1":
        raise ValueError("invalid_regional_parser_version")
    if publication["declared_unit"] != "MW":
        raise ValueError("invalid_regional_unit")
    raw_publish = publication["raw_publish_datetime"]
    try:
        parsed_issue = datetime.fromisoformat(raw_publish)
    except (TypeError, ValueError):
        raise ValueError("invalid_regional_publish_datetime") from None
    if parsed_issue.tzinfo is None or int(parsed_issue.timestamp()) != publication["issued_at"]:
        raise ValueError("invalid_regional_issued_at")
    issued_at = publication["issued_at"]
    retrieved_at = publication["retrieved_at"]
    if any(isinstance(value, bool) or not isinstance(value, int) for value in (issued_at, retrieved_at)):
        raise ValueError("invalid_regional_timestamp")
    if retrieved_at < issued_at or retrieved_at > current_ts + 300:
        raise ValueError("invalid_regional_retrieved_at")
    if not isinstance(publication["constructed_name"], str) or not 1 <= len(publication["constructed_name"]) <= 300:
        raise ValueError("invalid_regional_constructed_name")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 512:
        raise ValueError("invalid_regional_row_count")

    normalized = []
    nulls_started = False
    prior_target = None
    for row in rows:
        if not isinstance(row, dict) or set(row) != ROW_FIELDS:
            raise ValueError("invalid_regional_row")
        if set(row["regions"]) != set(contract["regions"]):
            raise ValueError("invalid_regional_region_membership")
        system = row["system"]
        if not isinstance(system, dict) or set(system) != MEASURE_FIELDS | {"system_wide_hsl_mw"}:
            raise ValueError("invalid_regional_system_shape")
        normalized_system = _measure({key: system[key] for key in MEASURE_FIELDS})
        normalized_system["system_wide_hsl_mw"] = _finite_mw(
            system["system_wide_hsl_mw"], nullable=True
        )
        normalized_regions = {
            region: _measure(row["regions"][region]) for region in contract["regions"]
        }
        nullable = [normalized_system["gen_mw"], normalized_system["system_wide_hsl_mw"]]
        nullable.extend(value["gen_mw"] for value in normalized_regions.values())
        row_is_null = all(value is None for value in nullable)
        if not row_is_null and any(value is None for value in nullable):
            raise ValueError("invalid_regional_null_pattern")
        if nulls_started and not row_is_null:
            raise ValueError("invalid_regional_generation_reappearance")
        nulls_started = nulls_started or row_is_null
        if not isinstance(row["dst_flag"], bool):
            raise ValueError("invalid_regional_dst_flag")
        if row["raw_dst_flag"] not in ("N", "Y") or (row["raw_dst_flag"] == "Y") != row["dst_flag"]:
            raise ValueError("invalid_regional_raw_dst")
        if not re.fullmatch(r"\d{2}/\d{2}/\d{4}", row["raw_delivery_date"]):
            raise ValueError("invalid_regional_raw_date")
        if not re.fullmatch(r"(?:0[1-9]|1[0-9]|2[0-4])", row["raw_hour_ending"]):
            raise ValueError("invalid_regional_raw_hour")
        month, day, year = row["raw_delivery_date"].split("/")
        if row["delivery_date"] != f"{year}-{month}-{day}":
            raise ValueError("invalid_regional_normalized_date")
        if row["hour_ending"] != f"{row['raw_hour_ending']}:00":
            raise ValueError("invalid_regional_normalized_hour")
        expected_target = market_hour_target(
            row["delivery_date"], row["hour_ending"], row["dst_flag"]
        )
        target = row["target_ts"]
        if isinstance(target, bool) or not isinstance(target, int) or target != expected_target:
            raise ValueError("invalid_regional_target")
        if prior_target is not None and target <= prior_target:
            raise ValueError("invalid_regional_target_order")
        prior_target = target
        if not row_is_null:
            region_sum = sum(value["gen_mw"] for value in normalized_regions.values())
            if abs(region_sum - normalized_system["gen_mw"]) > 0.1:
                raise ValueError("regional_generation_parity")
        normalized.append({
            **{key: row[key] for key in ROW_FIELDS - {"system", "regions"}},
            "system": normalized_system,
            "regions": normalized_regions,
        })
    immutable_publication = {key: publication[key] for key in PUBLICATION_FIELDS if key != "retrieved_at"}
    content_hash = hashlib.sha256(canonical_json({"publication": immutable_publication, "rows": normalized}).encode()).hexdigest()
    vintage_key = "rgv1-" + hashlib.sha256(canonical_json({
        "source_id": contract["source_id"], "product_id": product_id,
        "publication_key": document_id, "content_hash": content_hash,
    }).encode()).hexdigest()
    return publication, normalized, contract, content_hash, vintage_key


def init_regional_geography_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS regional_renewable_publications (
            id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, product_id TEXT NOT NULL,
            kind TEXT NOT NULL, publication_key TEXT NOT NULL, vintage_key TEXT NOT NULL UNIQUE,
            issued_at INTEGER NOT NULL, raw_publish_datetime TEXT NOT NULL,
            document_id TEXT NOT NULL, constructed_name TEXT NOT NULL, artifact_href TEXT NOT NULL,
            retrieved_at INTEGER NOT NULL, schema_fingerprint TEXT NOT NULL,
            parser_schema_version TEXT NOT NULL, declared_unit TEXT NOT NULL,
            content_hash TEXT NOT NULL, row_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(source_id, product_id, publication_key)
        );
        CREATE INDEX IF NOT EXISTS idx_regional_publication_issue
          ON regional_renewable_publications(product_id, issued_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS regional_renewable_hourly_rows (
            publication_id INTEGER NOT NULL, target_ts INTEGER NOT NULL,
            delivery_date TEXT NOT NULL, hour_ending TEXT NOT NULL, dst_flag INTEGER NOT NULL,
            raw_delivery_date TEXT NOT NULL, raw_hour_ending TEXT NOT NULL, raw_dst_flag TEXT NOT NULL,
            system_json TEXT NOT NULL, regions_json TEXT NOT NULL,
            PRIMARY KEY(publication_id, target_ts),
            FOREIGN KEY(publication_id) REFERENCES regional_renewable_publications(id)
        );
        CREATE INDEX IF NOT EXISTS idx_regional_hourly_target
          ON regional_renewable_hourly_rows(target_ts, publication_id);
        CREATE TABLE IF NOT EXISTS regional_geography_resources (
            series_key TEXT NOT NULL, content_version TEXT NOT NULL,
            day_start INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(series_key, content_version, day_start)
        );
        CREATE TABLE IF NOT EXISTS regional_geography_current (
            series_key TEXT NOT NULL, day_start INTEGER NOT NULL,
            content_version TEXT NOT NULL, dataset_cutoff INTEGER NOT NULL,
            issued_at INTEGER NOT NULL, document_id TEXT NOT NULL,
            PRIMARY KEY(series_key, day_start)
        );
        CREATE TABLE IF NOT EXISTS regional_geography_materialization_health (
            pipeline TEXT PRIMARY KEY CHECK(pipeline IN ('load')),
            last_attempt_ts INTEGER NOT NULL,
            last_success_ts INTEGER,
            consecutive_failures INTEGER NOT NULL,
            last_error TEXT
        );
    """)
    conn.commit()


def record_regional_materialization_health(conn, succeeded, current_ts, error=None):
    if not isinstance(current_ts, int) or isinstance(current_ts, bool) or current_ts < 0:
        raise ValueError("invalid_regional_materialization_time")
    conn.execute(
        """
        INSERT INTO regional_geography_materialization_health
          (pipeline,last_attempt_ts,last_success_ts,consecutive_failures,last_error)
        VALUES ('load',?,?,?,?)
        ON CONFLICT(pipeline) DO UPDATE SET
          last_attempt_ts=excluded.last_attempt_ts,
          last_success_ts=CASE WHEN excluded.consecutive_failures=0
            THEN excluded.last_success_ts ELSE regional_geography_materialization_health.last_success_ts END,
          consecutive_failures=CASE WHEN excluded.consecutive_failures=0 THEN 0
            ELSE regional_geography_materialization_health.consecutive_failures+1 END,
          last_error=excluded.last_error
        """,
        (current_ts, current_ts if succeeded else None, 0 if succeeded else 1,
         None if succeeded else (error or "materialization_failed")),
    )
    conn.commit()


def regional_materialization_health(conn):
    row = conn.execute(
        """SELECT last_attempt_ts,last_success_ts,consecutive_failures,last_error
           FROM regional_geography_materialization_health WHERE pipeline='load'"""
    ).fetchone()
    return {
        "pipeline": "load",
        "state": "unknown" if row is None else ("healthy" if row[2] == 0 else "failed"),
        "last_attempt_ts": None if row is None else row[0],
        "last_success_ts": None if row is None else row[1],
        "consecutive_failures": 0 if row is None else row[2],
        "last_error": None if row is None else row[3],
    }


def _series_key(kind, region):
    return f"regional.{kind}.{region}.hourly"


def materialize_load_day(conn, day_start, current_ts):
    if isinstance(day_start, bool) or not isinstance(day_start, int) or day_start % DAY_SECONDS:
        raise ValueError("invalid_regional_load_day")
    actual_rows = conn.execute("""
        SELECT target_ts,coast,east,far_west,north,north_c,south_c,southern,west,total,vintage_key,retrieved_at
        FROM (
          SELECT r.*,p.vintage_key,p.retrieved_at,
            ROW_NUMBER() OVER (PARTITION BY r.target_ts ORDER BY p.retrieved_at DESC,p.id DESC) rank
          FROM forecast_np6_345_rows r JOIN forecast_publications p ON p.id=r.publication_id
          WHERE r.target_ts>=? AND r.target_ts<? AND p.retrieved_at<=?
        ) WHERE rank=1 ORDER BY target_ts
    """, (day_start - 3600, day_start + DAY_SECONDS, current_ts)).fetchall()
    policy_cutoff = day_start - 3600
    effective_as_of = min(policy_cutoff, current_ts)
    forecast_publication = conn.execute("""
        SELECT p.id,p.vintage_key,p.issued_at,p.retrieved_at,p.publication_key
        FROM forecast_publications p JOIN forecast_np3_565_rows r ON r.publication_id=p.id
        WHERE p.product_id='NP3-565-CD' AND p.issued_at<=? AND p.retrieved_at<=?
          AND r.target_ts>=? AND r.target_ts<? AND r.in_use_flag=1
        GROUP BY p.id HAVING COUNT(*)=24 AND COUNT(DISTINCT r.target_ts)=24
        ORDER BY p.issued_at DESC,p.id DESC LIMIT 1
    """, (effective_as_of, current_ts, day_start, day_start + DAY_SECONDS)).fetchone()
    forecast_rows = [] if forecast_publication is None else conn.execute("""
        SELECT target_ts,coast,east,far_west,north,north_central,south_central,southern,west,system_total
        FROM forecast_np3_565_rows WHERE publication_id=? AND target_ts>=? AND target_ts<? AND in_use_flag=1
        ORDER BY target_ts
    """, (forecast_publication[0], day_start, day_start + DAY_SECONDS)).fetchall()
    outputs = []
    actual_by_target = {row[0]: row for row in actual_rows}
    for region_index, region in enumerate(LOAD_REGIONS, start=1):
        for kind, source_rows in (("actual", actual_rows), ("forecast", forecast_rows)):
            visible = [row for row in source_rows if day_start <= row[0] < day_start + DAY_SECONDS]
            if not visible:
                continue
            rows = []
            for row in visible:
                value = row[region_index]
                system_total = row[9]
                if abs(sum(row[1:9]) - system_total) > 0.1:
                    raise ValueError("regional_load_parity")
                prior = actual_by_target.get(row[0] - 3600) if kind == "actual" else None
                actual = actual_by_target.get(row[0])
                rows.append({
                    "target_ts": row[0],
                    "current_mw": value if kind == "actual" else None,
                    "share_percent": 100 * value / system_total if system_total else None,
                    "change_1h_mw": None if prior is None or kind != "actual" else value - prior[region_index],
                    "forecast_mw": value if kind == "forecast" else None,
                    "forecast_error_mw": None if kind != "forecast" or actual is None else actual[region_index] - value,
                })
            series_key = f"regional.load.weather-zone.{region}.{kind}"
            payload = {
                "schema_version": 1, "methodology": METHODOLOGY, "series_key": series_key,
                "kind": "load", "region": region, "tile_span": "1d", "tile_start": day_start,
                "tile_end": day_start + DAY_SECONDS, "lod": "native", "native_interval_seconds": 3600,
                "unit": "MW", "diagnostic_error_formula": "actual_minus_forecast" if kind == "forecast" else None,
                "positive_error_meaning": "underforecast" if kind == "forecast" else None,
                "selection_policy": "latest-capped-1h-before-utc-day" if kind == "forecast" else "latest_actual_per_target",
                "policy_cutoff": policy_cutoff if kind == "forecast" else None,
                "finalized": current_ts >= policy_cutoff if kind == "forecast" else True,
                "source": (
                    {"vintage_key": forecast_publication[1], "issued_at": forecast_publication[2], "retrieved_at": forecast_publication[3]}
                    if kind == "forecast" else {"vintage_keys": sorted({row[10] for row in visible})}
                ),
                "rows": rows,
            }
            version = "rg1-" + hashlib.sha256(canonical_json(payload).encode()).hexdigest()
            payload["content_version"] = version
            conn.execute("INSERT OR IGNORE INTO regional_geography_resources VALUES (?,?,?,?,?)",
                         (series_key, version, day_start, canonical_json(payload), current_ts))
            rank = forecast_publication[2] if kind == "forecast" else max(row[11] for row in visible)
            document = forecast_publication[4] if kind == "forecast" else str(rank)
            conn.execute("""
                INSERT INTO regional_geography_current VALUES (?,?,?,?,?,?)
                ON CONFLICT(series_key,day_start) DO UPDATE SET content_version=excluded.content_version,
                  dataset_cutoff=excluded.dataset_cutoff,issued_at=excluded.issued_at,document_id=excluded.document_id
                WHERE (excluded.issued_at,excluded.document_id) >=
                      (regional_geography_current.issued_at,regional_geography_current.document_id)
            """, (series_key, day_start, version, current_ts, rank, document))
            outputs.append({"series_key": series_key, "day_start": day_start, "content_version": version})
    conn.commit()
    return outputs


def _materialize_publication(conn, publication_id, contract, current_ts):
    raw_rows = conn.execute(
        "SELECT target_ts,system_json,regions_json FROM regional_renewable_hourly_rows WHERE publication_id=? ORDER BY target_ts",
        (publication_id,),
    ).fetchall()
    publication = conn.execute(
        "SELECT vintage_key,issued_at,retrieved_at FROM regional_renewable_publications WHERE id=?",
        (publication_id,),
    ).fetchone()
    outputs = []
    for region in contract["regions"]:
        for day_start in sorted({int(row[0]) // DAY_SECONDS * DAY_SECONDS for row in raw_rows}):
            rows = []
            prior = None
            for target, system_json, regions_json in raw_rows:
                if target < day_start:
                    prior = (target, json.loads(regions_json)[region]["gen_mw"])
                    continue
                if not day_start <= target < day_start + DAY_SECONDS:
                    continue
                system = json.loads(system_json)
                value = json.loads(regions_json)[region]
                gen = value["gen_mw"]
                change = (
                    None
                    if gen is None or prior is None or prior[1] is None or target - prior[0] != 3600
                    else gen - prior[1]
                )
                rows.append({
                    "target_ts": target, "current_mw": gen,
                    "share_percent": None if gen is None or not system["gen_mw"] else 100 * gen / system["gen_mw"],
                    "change_1h_mw": change, "forecast_mw": value["forecast_mw"],
                    "forecast_share_percent": None if not system["forecast_mw"] else 100 * value["forecast_mw"] / system["forecast_mw"],
                    "cop_hsl_mw": value["cop_hsl_mw"], "resource_plan_mw": value["resource_plan_mw"],
                })
                prior = (target, gen)
            payload = {
                "schema_version": SCHEMA_VERSION, "methodology": METHODOLOGY,
                "series_key": _series_key(contract["kind"], region),
                "kind": contract["kind"], "region": region,
                "tile_span": "1d", "tile_start": day_start,
                "tile_end": day_start + DAY_SECONDS, "lod": "native",
                "native_interval_seconds": 3600, "unit": "MW",
                "forecast_error_available": False,
                "forecast_error_unavailable_reason": FORECAST_ERROR_REASON,
                "source": {"vintage_key": publication[0], "issued_at": publication[1], "retrieved_at": publication[2]},
                "rows": rows,
            }
            version = "rg1-" + hashlib.sha256(canonical_json(payload).encode()).hexdigest()
            payload["content_version"] = version
            body = canonical_json(payload)
            conn.execute(
                "INSERT OR IGNORE INTO regional_geography_resources VALUES (?,?,?,?,?)",
                (payload["series_key"], version, day_start, body, current_ts),
            )
            conn.execute("""
                INSERT INTO regional_geography_current VALUES (?,?,?,?,?,?)
                ON CONFLICT(series_key,day_start) DO UPDATE SET
                  content_version=excluded.content_version,dataset_cutoff=excluded.dataset_cutoff,
                  issued_at=excluded.issued_at,document_id=excluded.document_id
                WHERE (excluded.issued_at,excluded.document_id) >
                      (regional_geography_current.issued_at,regional_geography_current.document_id)
            """, (payload["series_key"], day_start, version, publication[2], publication[1],
                  conn.execute("SELECT printf('%020d',CAST(document_id AS INTEGER)) FROM regional_renewable_publications WHERE id=?", (publication_id,)).fetchone()[0]))
            outputs.append({"series_key": payload["series_key"], "day_start": day_start, "content_version": version})
    return outputs


def ingest_regional_renewable_publication(conn, payload, current_ts=None):
    current = int(time.time()) if current_ts is None else int(current_ts)
    publication, rows, contract, content_hash, vintage_key = _publication(payload, current)
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            "SELECT id,content_hash,row_count FROM regional_renewable_publications WHERE source_id=? AND product_id=? AND publication_key=?",
            (contract["source_id"], publication["product_id"], publication["publication_key"]),
        ).fetchone()
        if existing:
            if existing[1] != content_hash or existing[2] != len(rows):
                raise ValueError("regional_publication_collision")
            conn.commit()
            return {"status": "unchanged", "vintage_key": vintage_key, "content_hash": content_hash, "row_count": len(rows), "resources": []}
        cursor = conn.execute("""
            INSERT INTO regional_renewable_publications
            (source_id,product_id,kind,publication_key,vintage_key,issued_at,raw_publish_datetime,
             document_id,constructed_name,artifact_href,retrieved_at,schema_fingerprint,
             parser_schema_version,declared_unit,content_hash,row_count,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            contract["source_id"], publication["product_id"], contract["kind"], publication["publication_key"],
            vintage_key, publication["issued_at"], publication["raw_publish_datetime"], publication["document_id"],
            publication["constructed_name"], publication["artifact_href"], publication["retrieved_at"],
            publication["schema_fingerprint"], publication["parser_schema_version"], "MW", content_hash, len(rows), current,
        ))
        publication_id = cursor.lastrowid
        conn.executemany(
            "INSERT INTO regional_renewable_hourly_rows VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(publication_id, row["target_ts"], row["delivery_date"], row["hour_ending"], int(row["dst_flag"]),
              row["raw_delivery_date"], row["raw_hour_ending"], row["raw_dst_flag"],
              canonical_json(row["system"]), canonical_json(row["regions"])) for row in rows],
        )
        resources = _materialize_publication(conn, publication_id, contract, current)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"status": "inserted", "vintage_key": vintage_key, "content_hash": content_hash, "row_count": len(rows), "resources": resources}


def regional_geography_manifest(conn, now=None):
    current = int(time.time()) if now is None else int(now)
    links = []
    for row in conn.execute("""
        SELECT c.series_key,c.day_start,c.content_version FROM regional_geography_current c
        WHERE c.day_start >= ? AND c.day_start <= ? ORDER BY c.series_key,c.day_start
    """, ((current // DAY_SECONDS - 35) * DAY_SECONDS, (current // DAY_SECONDS + 8) * DAY_SECONDS)):
        is_load_forecast = row[0].startswith("regional.load.") and row[0].endswith(".forecast")
        policy_cutoff = row[1] - 3600 if is_load_forecast else None
        links.append({
            "series_key": row[0], "tile_start": row[1], "content_version": row[2],
            "lod": "native", "url": f"/api/v2/regional/{row[0]}/v1/{row[2]}/1d/{row[1]}/native",
            "policy_cutoff": policy_cutoff,
            "effective_as_of": min(policy_cutoff, current) if policy_cutoff is not None else None,
            "finalized": current >= policy_cutoff if policy_cutoff is not None else True,
        })
    return {
        "schema_version": 1, "kind": "regional_geography_manifest",
        "methodology": METHODOLOGY,
        "title": "ERCOT region schematic — not geographic boundaries",
        "taxonomies": {"load": list(LOAD_REGIONS), "wind": list(CONTRACTS["NP4-742-CD"]["regions"]), "solar": list(CONTRACTS["NP4-745-CD"]["regions"])},
        "deferred_products": ["NP4-743-CD", "NP4-746-CD"],
        "current": {
            "load": _load_current_snapshot(conn, current),
            "wind": _renewable_current_snapshot(conn, "NP4-742-CD", current),
            "solar": _renewable_current_snapshot(conn, "NP4-745-CD", current),
        },
        "source_health": _source_health(conn, current),
        "materialization_health": regional_materialization_health(conn),
        "resources": links,
    }


def _source_health(conn, current):
    source_ids = (
        "ercot_public_np3_565_weather_zone_forecast",
        "ercot_public_np6_345_weather_zone_actual_load",
        "ercot_mis_np4_742",
        "ercot_mis_np4_745",
    )
    placeholders = ",".join("?" for _ in source_ids)
    try:
        rows = conn.execute(f"""
            SELECT source_id,expected_interval_seconds,last_success_ts,data_timestamp_ts,
                   consecutive_failures,availability_status
            FROM collector_sources WHERE source_id IN ({placeholders}) ORDER BY source_id
        """, source_ids).fetchall()
    except Exception:
        return []
    return [{
        "source_id": row[0], "expected_interval_seconds": row[1],
        "last_success_ts": row[2], "data_timestamp_ts": row[3],
        "data_age_seconds": None if row[3] is None else max(0, current - row[3]),
        "consecutive_failures": row[4], "availability_status": row[5],
        "state": (
            "failed" if row[4] else
            "stale" if row[3] is None or current - row[3] > max(3600, row[1] * 3) else
            "healthy"
        ),
    } for row in rows]


def _renewable_current_snapshot(conn, product_id, current):
    contract = CONTRACTS[product_id]
    publication = conn.execute("""
        SELECT id,vintage_key,issued_at,retrieved_at FROM regional_renewable_publications
        WHERE product_id=? AND issued_at<=? ORDER BY issued_at DESC,CAST(document_id AS INTEGER) DESC LIMIT 1
    """, (product_id, current)).fetchone()
    if publication is None:
        return {"availability": "unavailable", "unavailable_reason": "no_data", "regions": []}
    candidates = conn.execute("""
        SELECT target_ts,system_json,regions_json FROM regional_renewable_hourly_rows
        WHERE publication_id=? ORDER BY target_ts
    """, (publication[0],)).fetchall()
    historical = [row for row in candidates if row[0] <= current and json.loads(row[1])["gen_mw"] is not None]
    current_row = historical[-1] if historical else None
    previous_row = historical[-2] if len(historical) > 1 and historical[-1][0] - historical[-2][0] == 3600 else None
    future = [row for row in candidates if current < row[0] <= current + DAY_SECONDS]
    result = []
    for region in contract["regions"]:
        current_value = None if current_row is None else json.loads(current_row[2])[region]
        previous_value = None if previous_row is None else json.loads(previous_row[2])[region]
        peak = None
        for row in future:
            value = json.loads(row[2])[region]["forecast_mw"]
            if peak is None or value > peak["forecast_mw"]:
                peak = {"target_ts": row[0], "forecast_mw": value}
        system = None if current_row is None else json.loads(current_row[1])
        result.append({
            "region": region,
            "current_target_ts": None if current_row is None else current_row[0],
            "current_mw": None if current_value is None else current_value["gen_mw"],
            "share_percent": (
                None if current_value is None or current_value["gen_mw"] is None or not system["gen_mw"]
                else 100 * current_value["gen_mw"] / system["gen_mw"]
            ),
            "change_1h_mw": (
                None if current_value is None or previous_value is None
                else current_value["gen_mw"] - previous_value["gen_mw"]
            ),
            "next_24h_forecast_peak": peak,
            "forecast_error_available": False,
            "forecast_error_unavailable_reason": FORECAST_ERROR_REASON,
        })
    return {
        "availability": "available" if current_row is not None else "forecast_only",
        "source": {"vintage_key": publication[1], "issued_at": publication[2], "retrieved_at": publication[3]},
        "next_24h_forecast_coverage": {
            "observed_targets": len(future),
            "expected_targets": 24,
            "partial": len(future) < 24,
            "window": "(now,now+24h]",
        },
        "regions": result,
    }


def _load_current_snapshot(conn, current):
    actual = conn.execute("""
        SELECT r.target_ts,r.coast,r.east,r.far_west,r.north,r.north_c,r.south_c,r.southern,r.west,r.total,
               p.vintage_key,p.retrieved_at
        FROM forecast_np6_345_rows r JOIN forecast_publications p ON p.id=r.publication_id
        WHERE r.target_ts<=? AND p.retrieved_at<=? ORDER BY r.target_ts DESC,p.retrieved_at DESC,p.id DESC LIMIT 1
    """, (current, current)).fetchone()
    if actual is None:
        return {"availability": "unavailable", "unavailable_reason": "no_data", "regions": []}
    target = int(actual[0])
    previous = conn.execute("""
        SELECT r.coast,r.east,r.far_west,r.north,r.north_c,r.south_c,r.southern,r.west
        FROM forecast_np6_345_rows r JOIN forecast_publications p ON p.id=r.publication_id
        WHERE r.target_ts=? AND p.retrieved_at<=? ORDER BY p.retrieved_at DESC,p.id DESC LIMIT 1
    """, (target - 3600, current)).fetchone()
    forecast = conn.execute("""
        SELECT r.coast,r.east,r.far_west,r.north,r.north_central,r.south_central,r.southern,r.west,r.system_total,
               p.vintage_key,p.issued_at,p.retrieved_at
        FROM forecast_np3_565_rows r JOIN forecast_publications p ON p.id=r.publication_id
        WHERE r.target_ts=? AND r.in_use_flag=1 AND p.issued_at<=? AND p.issued_at>? AND p.retrieved_at<=?
        GROUP BY p.id,r.target_ts HAVING COUNT(*)=1
        ORDER BY p.issued_at DESC,p.id DESC LIMIT 1
    """, (target, target - 3600, target - 7200, current)).fetchone()
    actual_values = dict(zip(LOAD_REGIONS, actual[1:9]))
    if abs(sum(actual_values.values()) - actual[9]) > 0.1:
        return {"availability": "unavailable", "unavailable_reason": "source_parity", "target_ts": target, "regions": []}
    previous_values = {} if previous is None else dict(zip(LOAD_REGIONS, previous))
    forecast_values = {} if forecast is None else dict(zip(LOAD_REGIONS, forecast[:8]))
    if forecast is not None and abs(sum(forecast_values.values()) - forecast[8]) > 0.1:
        forecast = None
        forecast_values = {}
    return {
        "availability": "available", "target_ts": target,
        "source": {"actual_vintage_key": actual[10], "actual_retrieved_at": actual[11],
                   "forecast_vintage_key": None if forecast is None else forecast[9],
                   "forecast_issued_at": None if forecast is None else forecast[10],
                   "forecast_retrieved_at": None if forecast is None else forecast[11]},
        "regions": [{
            "region": region, "current_target_ts": target, "current_mw": actual_values[region],
            "share_percent": None if not actual[9] else 100 * actual_values[region] / actual[9],
            "change_1h_mw": None if region not in previous_values else actual_values[region] - previous_values[region],
            "forecast_mw": forecast_values.get(region),
            "forecast_error_mw": None if region not in forecast_values else actual_values[region] - forecast_values[region],
            "forecast_horizon_seconds": 3600,
        } for region in LOAD_REGIONS],
    }


def regional_geography_resource(conn, series_key, methodology, content_version, day_start, lod):
    if methodology != METHODOLOGY or lod != "native" or day_start % DAY_SECONDS:
        raise ValueError("invalid_regional_resource_identity")
    row = conn.execute(
        "SELECT payload_json FROM regional_geography_resources WHERE series_key=? AND content_version=? AND day_start=?",
        (series_key, content_version, day_start),
    ).fetchone()
    return None if row is None else json.loads(row[0])


def prune_regional_publications(conn, now=None, batch_size=100):
    current = int(time.time()) if now is None else int(now)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or not 1 <= batch_size <= 500:
        raise ValueError("invalid_regional_prune_batch")
    cutoff = current - 35 * DAY_SECONDS
    ids = [row[0] for row in conn.execute("""
        SELECT p.id FROM regional_renewable_publications p
        WHERE p.retrieved_at < ? AND NOT EXISTS (
          SELECT 1 FROM regional_renewable_hourly_rows r
          WHERE r.publication_id=p.id AND NOT EXISTS (
            SELECT 1 FROM regional_geography_current c
            WHERE c.day_start=(r.target_ts / 86400) * 86400
          )
        ) ORDER BY p.retrieved_at,p.id LIMIT ?
    """, (cutoff, batch_size))]
    if ids:
        placeholders = ",".join("?" for _ in ids)
        conn.execute(f"DELETE FROM regional_renewable_hourly_rows WHERE publication_id IN ({placeholders})", ids)
        conn.execute(f"DELETE FROM regional_renewable_publications WHERE id IN ({placeholders})", ids)
    stale_resources = [row for row in conn.execute("""
        SELECT r.series_key,r.content_version,r.day_start
        FROM regional_geography_resources r
        WHERE r.created_at < ? AND NOT EXISTS (
          SELECT 1 FROM regional_geography_current c
          WHERE c.series_key=r.series_key AND c.day_start=r.day_start
            AND c.content_version=r.content_version
        ) ORDER BY r.created_at,r.series_key,r.day_start LIMIT ?
    """, (cutoff, batch_size))]
    conn.executemany(
        "DELETE FROM regional_geography_resources WHERE series_key=? AND content_version=? AND day_start=?",
        stale_resources,
    )
    conn.commit()
    return len(ids) + len(stale_resources)
