#!/usr/bin/env python3
import json
import hashlib
import math
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
from collections import Counter, OrderedDict, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from typing import cast

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
from tile_aggregates import (
    aggregate_points,
    deserialize_aggregate,
    merge_aggregates,
    serialize_aggregate,
)

DB_PATH = os.path.join(BASE_DIR, "data", "metrics.db")
WEB_DIR = os.path.join(BASE_DIR, "web")
API_KEY = os.environ.get("METRICS_API_KEY")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "10"))
CACHE_MAX_ENTRIES = int(os.environ.get("CACHE_MAX_ENTRIES", "512"))
CACHE_CONTROL_MAX_AGE = int(os.environ.get("CACHE_CONTROL_MAX_AGE", "30"))
SEALED_HISTORY_AGE_SECONDS = int(os.environ.get("SEALED_HISTORY_AGE_SECONDS", "86400"))
SEALED_CACHE_TTL_SECONDS = int(os.environ.get("SEALED_CACHE_TTL_SECONDS", "86400"))
RECENT_CACHE_TTL_SECONDS = int(os.environ.get("RECENT_CACHE_TTL_SECONDS", "300"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(512 * 1024)))
MAX_BATCH_QUERIES = int(os.environ.get("MAX_BATCH_QUERIES", "100"))
MAX_POINTS_HARD = int(os.environ.get("MAX_POINTS_HARD", "5000"))
MAX_TAGS = int(os.environ.get("MAX_TAGS", "20"))
SERIES_BACKFILL_BATCH_SIZE = max(
    1, int(os.environ.get("SERIES_BACKFILL_BATCH_SIZE", "1000"))
)
SERIES_BACKFILL_MAX_BATCHES = max(
    0, int(os.environ.get("SERIES_BACKFILL_MAX_BATCHES", "10"))
)
MAX_RAW_SPAN_SECONDS = int(os.environ.get("MAX_RAW_SPAN_SECONDS", str(31 * 86400)))
MAX_EVENTS = int(os.environ.get("MAX_EVENTS", "1000"))
MAX_SOURCE_METADATA_BYTES = int(
    os.environ.get("MAX_SOURCE_METADATA_BYTES", str(16 * 1024))
)
MAX_SOURCE_METADATA_DEPTH = 5
MAX_SOURCE_METADATA_ITEMS = 50
MAX_SOURCE_METADATA_STRING = 500
CORS_ORIGINS_EXTRA = os.environ.get("CORS_ORIGINS_EXTRA", "")
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") in ("1", "true", "TRUE", "yes", "YES")
RATE_LIMIT_INGEST_RPM = int(os.environ.get("RATE_LIMIT_INGEST_RPM", "600"))
RATE_LIMIT_SERIES_RPM = int(os.environ.get("RATE_LIMIT_SERIES_RPM", "300"))
RATE_LIMIT_LATEST_RPM = int(os.environ.get("RATE_LIMIT_LATEST_RPM", "300"))
RATE_LIMIT_STATUS_RPM = int(os.environ.get("RATE_LIMIT_STATUS_RPM", "120"))
RATE_LIMIT_METRICS_RPM = int(os.environ.get("RATE_LIMIT_METRICS_RPM", "120"))
ALLOWED_ORIGINS = {
    "https://ercot.tarazevits.io",
}
DISABLED_SOURCE_IDS = {"poweroutages_us"}
if CORS_ORIGINS_EXTRA:
    for origin in CORS_ORIGINS_EXTRA.split(","):
        origin = origin.strip()
        if origin:
            ALLOWED_ORIGINS.add(origin)
DB_LOCAL = threading.local()

TILE_SCHEMA_VERSION = 2
TILE_SPANS = {"1h": 3600, "1d": 86400}
TILE_LOD_SECONDS = {"native": None, "5m": 300, "15m": 900, "1h": 3600}
TILE_SERIES_CATALOG = (
    {
        "key": "supply-demand.demand",
        "metric": "ercot.supply_demand.demand_mw",
        "tags": ["source:supply_demand"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "5m", "15m", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "supply_demand",
        "match": "exact",
    },
    {
        "key": "supply-demand.available-capacity",
        "metric": "ercot.supply_demand.available_capacity_mw",
        "tags": ["source:supply_demand"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "5m", "15m", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "supply_demand",
        "match": "exact",
    },
    {
        "key": "storage.net-output",
        "metric": "ercot.storage.net_output_mw",
        "tags": ["source:energy_storage"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "5m", "15m", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "energy_storage",
        "match": "exact",
    },
    {
        "key": "fuel-mix.wind",
        "metric": "ercot.fuel_mix.generation_mw",
        "tags": ["fuel:wind", "source:fuel_mix"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "15m", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "fuel_mix",
        "match": "exact",
    },
    {
        "key": "fuel-mix.solar",
        "metric": "ercot.fuel_mix.generation_mw",
        "tags": ["fuel:solar", "source:fuel_mix"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "15m", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "fuel_mix",
        "match": "exact",
    },
    {
        "key": "fuel-mix.total",
        "metric": "ercot.fuel_mix.generation_mw",
        "tags": ["source:fuel_mix"],
        "native_interval_seconds": 300,
        "supported_lods": ["native", "15m", "1h"],
        "rollup": "sum",
        "unit": "MW",
        "statistic_policy": "power",
        "source": "fuel_mix",
        "match": "selector",
    },
    {
        "key": "renewables.wind-actual",
        "metric": "ercot.renewables.actual_mw",
        "tags": ["resource:wind", "source:wind_solar"],
        "native_interval_seconds": 3600,
        "supported_lods": ["native", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "wind_solar",
        "match": "exact",
    },
    {
        "key": "renewables.solar-actual",
        "metric": "ercot.renewables.actual_mw",
        "tags": ["resource:solar", "source:wind_solar"],
        "native_interval_seconds": 3600,
        "supported_lods": ["native", "1h"],
        "rollup": None,
        "unit": "MW",
        "statistic_policy": "power",
        "source": "wind_solar",
        "match": "exact",
    },
)

TILE_SERIES_CATALOG += tuple(
    {
        "key": key,
        "metric": metric,
        "tags": tags,
        "native_interval_seconds": native_interval,
        "supported_lods": lods,
        "rollup": None,
        "unit": unit,
        "statistic_policy": policy,
        "source": source,
        "match": "exact",
    }
    for key, metric, tags, native_interval, lods, unit, policy, source in (
        (
            "supply-demand.forecast-demand",
            "ercot.supply_demand.forecast_demand_mw",
            ["source:supply_demand"],
            3600,
            ["native", "1h"],
            "MW",
            "power",
            "supply_demand",
        ),
        (
            "frequency.system",
            "ercot.Frequency.Current_Frequency",
            [],
            60,
            ["native", "5m", "15m", "1h"],
            "Hz",
            "gauge",
            "ercot_realtime",
        ),
        *(
            (
                f"storage.{name}",
                f"ercot.storage.{metric_suffix}_mw",
                ["source:energy_storage"],
                300,
                ["native", "5m", "15m", "1h"],
                "MW",
                "power",
                "energy_storage",
            )
            for name, metric_suffix in (
                ("charging", "charging"),
                ("discharging", "discharging"),
            )
        ),
        *(
            (
                f"fuel-mix.{name}",
                "ercot.fuel_mix.generation_mw",
                [f"fuel:{tag}", "source:fuel_mix"],
                300,
                ["native", "15m", "1h"],
                "MW",
                "power",
                "fuel_mix",
            )
            for name, tag in (
                ("natural-gas", "natural_gas"),
                ("coal-and-lignite", "coal_and_lignite"),
                ("nuclear", "nuclear"),
                ("power-storage", "power_storage"),
            )
        ),
        *(
            (
                f"renewables.{resource}-{kind}",
                f"ercot.renewables.{metric_suffix}_mw",
                [f"resource:{resource}", "source:wind_solar"],
                3600,
                ["native", "1h"],
                "MW",
                "power",
                "wind_solar",
            )
            for resource, kind, metric_suffix in (
                ("wind", "forecast", "forecast"),
                ("wind", "hsl", "hsl"),
                ("solar", "forecast", "forecast"),
            )
        ),
        (
            "generation-outages.total",
            "ercot.generation_outages.total_mw",
            ["source:generation_outages"],
            300,
            ["native", "5m", "15m", "1h"],
            "MW",
            "power",
            "generation_outages",
        ),
        *(
            (
                f"generation-outages.{category}-{outage_type}",
                "ercot.generation_outages.mw",
                [
                    f"category:{category}",
                    f"outage_type:{outage_type}",
                    "source:generation_outages",
                ],
                300,
                ["native", "5m", "15m", "1h"],
                "MW",
                "power",
                "generation_outages",
            )
            for category, outage_type in (
                ("dispatchable", "unplanned"),
                ("dispatchable", "planned"),
                ("renewable", "unplanned"),
                ("renewable", "planned"),
            )
        ),
        *(
            (
                f"pricing.{name}",
                "ercot.pricing",
                [f"ercot_region:{tag}"],
                900,
                ["native", "15m", "1h"],
                "$/MWh",
                "gauge",
                "ercot_pricing",
            )
            for name, tag in (
                ("houston", "HB_HOUSTON"),
                ("north", "HB_NORTH"),
                ("west", "HB_WEST"),
            )
        ),
    )
)


def validate_tile_series_catalog(entries):
    validated = {}
    for raw in entries:
        entry = dict(raw)
        key = entry.get("key")
        if not isinstance(key, str) or not re.fullmatch(
            r"[a-z0-9]+(?:[.-][a-z0-9]+)*", key
        ):
            raise ValueError("invalid_tile_series_key")
        if key in validated:
            raise ValueError("duplicate_tile_series_key")
        metric = entry.get("metric")
        if not isinstance(metric, str) or not metric.strip():
            raise ValueError("invalid_tile_series_metric")
        tags = entry.get("tags")
        normalized_tags = (
            sorted(set(str(tag)[:200] for tag in tags[:MAX_TAGS]))
            if isinstance(tags, list)
            else None
        )
        if not isinstance(tags, list) or tags != normalized_tags:
            raise ValueError("invalid_tile_series_tags")
        native_interval = entry.get("native_interval_seconds")
        if not isinstance(native_interval, int) or native_interval <= 0:
            raise ValueError("invalid_tile_native_interval")
        lods = entry.get("supported_lods")
        if (
            not isinstance(lods, list)
            or not lods
            or "native" not in lods
            or len(lods) != len(set(lods))
            or any(lod not in TILE_LOD_SECONDS for lod in lods)
        ):
            raise ValueError("invalid_tile_supported_lods")
        for lod in lods:
            seconds = native_interval if lod == "native" else TILE_LOD_SECONDS[lod]
            if seconds < native_interval or any(
                span % seconds != 0 for span in TILE_SPANS.values()
            ):
                raise ValueError("invalid_tile_lod_cadence")
        if entry.get("match") not in ("exact", "selector"):
            raise ValueError("invalid_tile_match")
        if entry.get("rollup") not in (None, "sum"):
            raise ValueError("invalid_tile_rollup")
        if entry["match"] == "selector" and entry.get("rollup") != "sum":
            raise ValueError("tile_selector_requires_rollup")
        if entry["match"] == "exact" and entry.get("rollup") is not None:
            raise ValueError("tile_exact_disallows_rollup")
        if entry["match"] == "selector" and not tags:
            raise ValueError("tile_selector_requires_tags")
        if entry.get("statistic_policy") not in ("power", "gauge"):
            raise ValueError("invalid_tile_statistic_policy")
        for field in ("unit", "statistic_policy", "source"):
            if not isinstance(entry.get(field), str) or not entry[field]:
                raise ValueError(f"invalid_tile_{field}")
        validated[key] = entry
    return validated


TILE_CATALOG_BY_KEY = validate_tile_series_catalog(TILE_SERIES_CATALOG)


def series_identity_dependency(metric, tags):
    _tags_json, identity_hash = canonical_series_identity(metric, tags)
    return f"series-identity:{identity_hash}"


def selector_dependency(metric, tags):
    identity = json.dumps(
        ["selector", metric, normalize_tags(tags)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"series-selector:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"


def matching_selector_dependencies(metric, tags):
    normalized_tags = set(normalize_tags(tags))
    return {
        selector_dependency(definition["metric"], definition["tags"])
        for definition in TILE_CATALOG_BY_KEY.values()
        if definition["match"] == "selector"
        and definition["metric"] == metric
        and set(definition["tags"]).issubset(normalized_tags)
    }


def tile_catalog_payload():
    return {
        "schema": TILE_SCHEMA_VERSION,
        "tile_spans": dict(TILE_SPANS),
        "lod_seconds": dict(TILE_LOD_SECONDS),
        "boundary_policy": {
            "coarse_partial_clipping": False,
            "edge_lod": "native",
            "rule": "clients use native boundary tiles and coarse LOD only for aligned interiors",
        },
        "series": [dict(TILE_CATALOG_BY_KEY[key]) for key in sorted(TILE_CATALOG_BY_KEY)],
    }


def historical_cache_policy(end):
    current = now_ts()
    if end <= current - SEALED_HISTORY_AGE_SECONDS:
        return (
            "sealed",
            SEALED_CACHE_TTL_SECONDS,
            "public, max-age=3600, s-maxage=86400, immutable",
        )
    if end <= current - 300:
        return (
            "recent",
            RECENT_CACHE_TTL_SECONDS,
            "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
        )
    return (
        "live",
        CACHE_TTL_SECONDS,
        "public, max-age=5, s-maxage=15, stale-while-revalidate=30",
    )


def canonical_series_tags(tags) -> str:
    return json.dumps(
        normalize_tags(tags),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def canonical_series_identity(metric_name, tags) -> tuple[str, str]:
    normalized_metric = metric_name.strip()[:240]
    tags_json = canonical_series_tags(tags)
    identity = json.dumps(
        [normalized_metric, json.loads(tags_json)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return tags_json, hashlib.sha256(identity.encode("utf-8")).hexdigest()


def resolve_series_id(conn, metric_name, tags) -> int:
    tags_json, identity_hash = canonical_series_identity(metric_name, tags)
    normalized_metric = metric_name.strip()[:240]
    conn.execute(
        """
        INSERT OR IGNORE INTO series (metric_name, tags_json, identity_hash)
        VALUES (?, ?, ?)
        """,
        (normalized_metric, tags_json, identity_hash),
    )
    row = conn.execute(
        "SELECT id, identity_hash FROM series WHERE metric_name = ? AND tags_json = ?",
        (normalized_metric, tags_json),
    ).fetchone()
    if row is None or row[1] != identity_hash:
        raise sqlite3.IntegrityError("series identity hash collision")
    series_id = int(row[0])
    normalized_tags = json.loads(tags_json)
    if normalized_tags:
        conn.executemany(
            "INSERT OR IGNORE INTO series_tags (series_id, tag) VALUES (?, ?)",
            [(series_id, tag) for tag in normalized_tags],
        )
    return series_id


def backfill_metric_series(
    conn: sqlite3.Connection,
    *,
    batch_size: int = 1_000,
    commit_each_batch: bool = False,
    max_batches: int | None = None,
) -> int:
    """Associate legacy samples incrementally; safe to stop and resume."""
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    updated = 0
    batches = 0
    last_metric_id = 0
    while max_batches is None or batches < max_batches:
        rows = conn.execute(
            """
            SELECT id, metric_name, tags
            FROM metrics
            WHERE series_id IS NULL AND id > ?
            ORDER BY id
            LIMIT ?
            """,
            (last_metric_id, batch_size),
        ).fetchall()
        if not rows:
            break
        metric_ids = [int(row[0]) for row in rows]
        placeholders = ",".join("?" for _ in metric_ids)
        tags_by_metric = defaultdict(list)
        for metric_id, tag in conn.execute(
            f"""
            SELECT metric_id, tag FROM metric_tags
            WHERE metric_id IN ({placeholders})
            ORDER BY metric_id, tag
            """,
            metric_ids,
        ):
            tags_by_metric[int(metric_id)].append(tag)
        for metric_id, metric_name, raw_tags in rows:
            tags = tags_by_metric.get(int(metric_id))
            if not tags:
                try:
                    decoded_tags = json.loads(raw_tags or "[]")
                    tags = decoded_tags if isinstance(decoded_tags, list) else []
                except (json.JSONDecodeError, TypeError):
                    tags = []
            series_id = resolve_series_id(conn, metric_name, tags)
            conn.execute(
                "UPDATE metrics SET series_id = ? WHERE id = ? AND series_id IS NULL",
                (series_id, metric_id),
            )
            updated += 1
        last_metric_id = metric_ids[-1]
        batches += 1
        if commit_each_batch:
            conn.commit()
    return updated


def backfill_series_tags(conn: sqlite3.Connection) -> int:
    inserted = 0
    for series_id, tags_json in conn.execute(
        "SELECT id, tags_json FROM series ORDER BY id"
    ).fetchall():
        for tag in normalize_tags(json.loads(tags_json)):
            cursor = conn.execute(
                "INSERT OR IGNORE INTO series_tags (series_id, tag) VALUES (?, ?)",
                (series_id, tag),
            )
            inserted += cursor.rowcount
    return inserted


def audit_metric_tag_drift(conn: sqlite3.Connection, *, limit: int = 100):
    if limit < 1:
        raise ValueError("limit must be positive")
    rows = conn.execute(
        "SELECT id, tags FROM metrics ORDER BY id LIMIT ?", (limit,)
    ).fetchall()
    if not rows:
        return []
    metric_ids = [int(row[0]) for row in rows]
    placeholders = ",".join("?" for _ in metric_ids)
    tags_by_metric = defaultdict(list)
    for metric_id, tag in conn.execute(
        f"""
        SELECT metric_id, tag FROM metric_tags
        WHERE metric_id IN ({placeholders})
        ORDER BY metric_id, tag
        """,
        metric_ids,
    ):
        tags_by_metric[int(metric_id)].append(tag)
    drift = []
    for metric_id, raw_tags in rows:
        try:
            decoded = json.loads(raw_tags or "[]")
            compatibility_tags = normalize_tags(decoded if isinstance(decoded, list) else [])
        except (json.JSONDecodeError, TypeError):
            compatibility_tags = []
        lookup_tags = normalize_tags(tags_by_metric.get(int(metric_id), []))
        if compatibility_tags != lookup_tags:
            drift.append(
                {
                    "metric_id": int(metric_id),
                    "metric_tags": lookup_tags,
                    "tags_json": compatibility_tags,
                }
            )
    return drift


def normalized_series_readiness(conn: sqlite3.Connection):
    """Return bounded public-safe readiness without exposing internal IDs."""
    unassigned = int(
        conn.execute(
            "SELECT COUNT(*) FROM metrics WHERE series_id IS NULL"
        ).fetchone()[0]
    )
    blocked = []
    payload_builder = globals().get("tile_catalog_payload")
    if callable(payload_builder):
        required_metrics = sorted(
            {
                selector["metric"]
                for entry in payload_builder().get("series", [])
                if isinstance(entry, dict)
                and isinstance((selector := entry.get("selector")), dict)
                and isinstance(selector.get("metric"), str)
            }
        )
        for metric in required_metrics:
            count = int(
                conn.execute(
                    "SELECT COUNT(*) FROM metrics "
                    "WHERE metric_name=? AND series_id IS NULL",
                    (metric,),
                ).fetchone()[0]
            )
            if count:
                blocked.append({"metric": metric, "unassigned_rows": count})
    return {
        "ready": unassigned == 0 and not blocked,
        "unassigned_rows": unassigned,
        "blocked_tile_series": blocked,
    }


def init_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            ts INTEGER NOT NULL,
            value REAL NOT NULL,
            interval INTEGER,
            metric_type TEXT,
            tags TEXT,
            series_id INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metric_tags (
            metric_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            FOREIGN KEY(metric_id) REFERENCES metrics(id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(metric_name, ts)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metric_tags_tag ON metric_tags(tag)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_metric_tags_metric ON metric_tags(metric_id)"
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metric_tags_tag_metric
        ON metric_tags(tag, metric_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metrics_name_ts_value_id
        ON metrics(metric_name, ts, value, id)
        """
    )
    metric_columns = {row[1] for row in conn.execute("PRAGMA table_info(metrics)")}
    if "dedupe_key" not in metric_columns:
        conn.execute("ALTER TABLE metrics ADD COLUMN dedupe_key TEXT")
    if "series_id" not in metric_columns:
        conn.execute("ALTER TABLE metrics ADD COLUMN series_id INTEGER")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS series (
            id INTEGER PRIMARY KEY,
            metric_name TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            identity_hash TEXT NOT NULL UNIQUE,
            UNIQUE(metric_name, tags_json)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS series_tags (
            series_id INTEGER NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (series_id, tag),
            FOREIGN KEY(series_id) REFERENCES series(id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_series_tags_tag_series
        ON series_tags(tag, series_id)
        """
    )
    conn.commit()
    backfill_metric_series(
        conn,
        batch_size=SERIES_BACKFILL_BATCH_SIZE,
        commit_each_batch=True,
        max_batches=SERIES_BACKFILL_MAX_BATCHES,
    )
    # Build these once, after the bounded startup pass, so each partial index
    # contains only the rows needed by its corresponding read path.
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metrics_series_ts_id_value
        ON metrics(series_id, ts, id, value) WHERE series_id IS NOT NULL
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_metrics_unbackfilled_name
        ON metrics(metric_name) WHERE series_id IS NULL
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_dedupe_key
        ON metrics(dedupe_key) WHERE dedupe_key IS NOT NULL
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metric_correction_age (
            source_id TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            series_tags TEXT NOT NULL,
            age_bucket TEXT NOT NULL,
            correction_count INTEGER NOT NULL,
            last_observed_at INTEGER NOT NULL,
            PRIMARY KEY (source_id, metric_name, series_tags, age_bucket)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS collector_sources (
            source_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            expected_interval_seconds INTEGER NOT NULL,
            last_attempt_ts INTEGER,
            last_success_ts INTEGER,
            source_timestamp_ts INTEGER,
            data_timestamp_ts INTEGER,
            last_payload_hash TEXT,
            last_row_count INTEGER,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            publication_mode TEXT NOT NULL DEFAULT 'polling',
            publication_interval_seconds INTEGER,
            checkpoint_json TEXT,
            diagnostics_json TEXT,
            provenance_json TEXT,
            availability_status TEXT,
            updated_at INTEGER NOT NULL
        )
        """
    )
    source_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(collector_sources)")
    }
    if "publication_mode" not in source_columns:
        conn.execute(
            "ALTER TABLE collector_sources ADD COLUMN publication_mode TEXT NOT NULL DEFAULT 'polling'"
        )
    if "publication_interval_seconds" not in source_columns:
        conn.execute(
            "ALTER TABLE collector_sources ADD COLUMN publication_interval_seconds INTEGER"
        )
    if "checkpoint_json" not in source_columns:
        conn.execute("ALTER TABLE collector_sources ADD COLUMN checkpoint_json TEXT")
    if "data_timestamp_ts" not in source_columns:
        conn.execute("ALTER TABLE collector_sources ADD COLUMN data_timestamp_ts INTEGER")
    if "diagnostics_json" not in source_columns:
        conn.execute("ALTER TABLE collector_sources ADD COLUMN diagnostics_json TEXT")
    if "provenance_json" not in source_columns:
        conn.execute("ALTER TABLE collector_sources ADD COLUMN provenance_json TEXT")
    if "availability_status" not in source_columns:
        conn.execute("ALTER TABLE collector_sources ADD COLUMN availability_status TEXT")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dedupe_key TEXT NOT NULL UNIQUE,
            source_id TEXT NOT NULL,
            external_key TEXT,
            starts_at INTEGER NOT NULL,
            ends_at INTEGER,
            observed_at INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            status TEXT,
            severity TEXT,
            title TEXT NOT NULL,
            body TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            ingested_at INTEGER NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_type_status ON events(event_type, status)"
    )
    conn.commit()


def get_db() -> sqlite3.Connection:
    conn = getattr(DB_LOCAL, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        DB_LOCAL.conn = conn
    return conn


def now_ts() -> int:
    return int(time.time())


def parse_timestamp(value):
    if value is None:
        return None
    try:
        ts = int(float(value))
    except (TypeError, ValueError):
        return None
    if ts > 10**12:
        ts //= 1000
    return ts


def parse_int(value):
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_positive_int(value):
    parsed = parse_int(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


SENSITIVE_SOURCE_METADATA_KEYS = {
    "accesstoken",
    "apikey",
    "authorization",
    "bearertoken",
    "clientsecret",
    "cookie",
    "credentials",
    "idtoken",
    "password",
    "primarykey",
    "refreshtoken",
    "secondarykey",
    "secret",
    "subscriptionkey",
}


def sanitize_source_metadata_string(value):
    sanitized = re.sub(r"(?i)bearer\s+[^\s,;]+", "Bearer [redacted]", str(value))
    sanitized = re.sub(
        r"(?i)(subscription-key|api[_-]?key|access[_-]?token|bearer[_-]?token|"
        r"client[_-]?secret|id[_-]?token|password|primary[_-]?key|"
        r"refresh[_-]?token|secondary[_-]?key|subscription[_-]?key)=[^&\s]+",
        r"\1=[redacted]",
        sanitized,
    )
    sanitized = re.sub(
        r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        "[redacted-email]",
        sanitized,
    )
    if len(sanitized) > MAX_SOURCE_METADATA_STRING:
        return sanitized[:MAX_SOURCE_METADATA_STRING] + "...[truncated]"
    return sanitized


def sanitize_source_metadata(value, depth=0):
    if depth >= MAX_SOURCE_METADATA_DEPTH:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return sanitize_source_metadata_string(value)
    if isinstance(value, dict):
        output = {}
        items = list(value.items())
        for raw_key, item in items[:MAX_SOURCE_METADATA_ITEMS]:
            key = str(raw_key)[:120]
            normalized_key = re.sub(r"[^a-z0-9]", "", key.lower())
            if normalized_key in SENSITIVE_SOURCE_METADATA_KEYS:
                output[key] = "[redacted]"
            else:
                output[key] = sanitize_source_metadata(item, depth + 1)
        if len(items) > MAX_SOURCE_METADATA_ITEMS:
            output["_truncated_entries"] = len(items) - MAX_SOURCE_METADATA_ITEMS
        return output
    if isinstance(value, (list, tuple)):
        output = [
            sanitize_source_metadata(item, depth + 1)
            for item in value[:MAX_SOURCE_METADATA_ITEMS]
        ]
        if len(value) > MAX_SOURCE_METADATA_ITEMS:
            output.append(
                {"_truncated_entries": len(value) - MAX_SOURCE_METADATA_ITEMS}
            )
        return output
    return sanitize_source_metadata_string(value)


def bounded_source_metadata_json(value, field):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"invalid_{field}")
    sanitized = sanitize_source_metadata(value)
    encoded = json.dumps(sanitized, sort_keys=True, separators=(",", ":"))
    encoded_bytes = len(encoded.encode("utf-8"))
    if encoded_bytes <= MAX_SOURCE_METADATA_BYTES:
        return encoded
    return json.dumps(
        {
            "_original_sanitized_bytes": encoded_bytes,
            "_truncated": True,
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def parse_source_metadata_json(value):
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def normalize_tags(tags):
    if not tags:
        return []
    if isinstance(tags, list):
        output = [str(t)[:200] for t in tags[:MAX_TAGS]]
    else:
        output = [str(tags)[:200]]
    return sorted(set(output))


def validate_max_points(value):
    if value is None:
        return None
    parsed = parse_positive_int(value)
    if parsed is None:
        raise ValueError("invalid_max_points")
    if parsed > MAX_POINTS_HARD:
        raise ValueError("max_points_exceeds_limit")
    return parsed


def validate_query_window(since, until, max_points, bucket_seconds):
    if since is not None and until is not None and since > until:
        raise ValueError("invalid_time_range")
    end_ts = until if until is not None else now_ts()
    if (
        since is not None
        and max_points is None
        and bucket_seconds is None
        and end_ts - since > MAX_RAW_SPAN_SECONDS
    ):
        raise ValueError("raw_span_exceeds_limit")


def normalize_query_window(
    since, until, max_points=None, bucket_seconds=None, current_ts=None
):
    end_ts = until if until is not None else (
        current_ts if current_ts is not None else now_ts()
    )
    bounded_since = since
    if bounded_since is None:
        bounded_since = end_ts - MAX_RAW_SPAN_SECONDS
    validate_query_window(bounded_since, end_ts, max_points, bucket_seconds)
    return bounded_since, end_ts


CORRECTION_AGE_BUCKETS = (
    "future",
    "under_5m",
    "5m_to_1h",
    "1h_to_24h",
    "1d_to_7d",
    "7d_to_30d",
    "over_30d",
)


def correction_age_bucket(observed_at, data_timestamp):
    age = int(observed_at) - int(data_timestamp)
    if age < 0:
        return "future"
    if age < 300:
        return "under_5m"
    if age < 3600:
        return "5m_to_1h"
    if age < 86400:
        return "1h_to_24h"
    if age < 7 * 86400:
        return "1d_to_7d"
    if age < 30 * 86400:
        return "7d_to_30d"
    return "over_30d"


def correction_source_id(tags):
    sources = sorted(
        {
            tag.split(":", 1)[1]
            for tag in tags
            if tag.startswith("source:") and tag.split(":", 1)[1]
        }
    )
    if len(sources) == 1:
        return sources[0][:120]
    return "multiple" if sources else "unknown"


def list_metric_correction_age(conn):
    return [
        {
            "source_id": row[0],
            "metric_name": row[1],
            "tags": json.loads(row[2]),
            "age_bucket": row[3],
            "correction_count": row[4],
            "last_observed_at": row[5],
        }
        for row in conn.execute(
            """
            SELECT source_id, metric_name, series_tags, age_bucket,
                   correction_count, last_observed_at
            FROM metric_correction_age
            ORDER BY source_id, metric_name, series_tags, age_bucket
            """
        ).fetchall()
    ]


def ingest_metrics(conn, payload, current_ts=None):
    inserted = 0
    updated = 0
    unchanged = 0
    invalid = 0
    dependencies = set()
    changes = defaultdict(list)
    correction_age_buckets = {bucket: 0 for bucket in CORRECTION_AGE_BUCKETS}
    ts_now = current_ts if current_ts is not None else now_ts()
    conn.execute("BEGIN")
    try:
        for item in payload:
            if not isinstance(item, dict):
                invalid += 1
                continue
            metric_name = item.get("metric_name") or item.get("metric")
            if not isinstance(metric_name, str) or not metric_name.strip():
                invalid += 1
                continue
            metric_name = metric_name.strip()[:240]
            tags = normalize_tags(item.get("tags") or [])
            interval = parse_positive_int(item.get("interval"))
            metric_type = str(item.get("metric_type") or "gauge")[:40]
            points = item.get("points") or []
            if not isinstance(points, list):
                invalid += 1
                continue
            item_dedupe = item.get("dedupe_key")
            for point_index, point in enumerate(points):
                ts = None
                value = None
                point_dedupe = None
                if isinstance(point, dict):
                    value = point.get("value")
                    ts = parse_timestamp(point.get("timestamp"))
                    timestamp_was_provided = ts is not None
                    point_dedupe = point.get("dedupe_key")
                elif isinstance(point, (list, tuple)) and len(point) >= 2:
                    ts = parse_timestamp(point[0])
                    timestamp_was_provided = ts is not None
                    value = point[1]
                else:
                    timestamp_was_provided = False
                if ts is None:
                    ts = ts_now
                try:
                    numeric_value = float(value)
                except (TypeError, ValueError):
                    invalid += 1
                    continue
                if not math.isfinite(numeric_value):
                    invalid += 1
                    continue
                dedupe_key = point_dedupe or item_dedupe
                if dedupe_key and len(points) > 1 and not point_dedupe:
                    dedupe_key = f"{dedupe_key}:{point_index}"
                if dedupe_key is not None:
                    dedupe_key = str(dedupe_key)[:500]
                tags_json = json.dumps(tags)
                series_id = resolve_series_id(conn, metric_name, tags)
                existing = None
                if dedupe_key is not None:
                    existing = conn.execute(
                        """
                        SELECT id, metric_name, ts, value, interval, metric_type, tags,
                               series_id
                        FROM metrics WHERE dedupe_key = ?
                        """,
                        (dedupe_key,),
                    ).fetchone()
                values = (
                    metric_name,
                    int(ts),
                    numeric_value,
                    interval,
                    metric_type,
                    tags_json,
                )
                if existing is not None:
                    metric_id = existing[0]
                    if tuple(existing[1:7]) == values and existing[7] == series_id:
                        unchanged += 1
                        continue
                    conn.execute(
                        """
                        UPDATE metrics
                        SET metric_name = ?, ts = ?, value = ?, interval = ?,
                            metric_type = ?, tags = ?, series_id = ?
                        WHERE id = ?
                        """,
                        (*values, series_id, metric_id),
                    )
                    conn.execute("DELETE FROM metric_tags WHERE metric_id = ?", (metric_id,))
                    updated += 1
                    correction_timestamp = ts if timestamp_was_provided else existing[2]
                    age_bucket = correction_age_bucket(ts_now, correction_timestamp)
                    correction_age_buckets[age_bucket] += 1
                    source_id = correction_source_id(tags)
                    conn.execute(
                        """
                        INSERT INTO metric_correction_age (
                            source_id, metric_name, series_tags, age_bucket,
                            correction_count, last_observed_at
                        ) VALUES (?, ?, ?, ?, 1, ?)
                        ON CONFLICT(source_id, metric_name, series_tags, age_bucket) DO UPDATE SET
                            correction_count = metric_correction_age.correction_count + 1,
                            last_observed_at = excluded.last_observed_at
                        """,
                        (source_id, metric_name, tags_json, age_bucket, ts_now),
                    )
                    dependencies.add(existing[1])
                    changes[existing[1]].append((int(existing[2]), int(existing[2])))
                    try:
                        old_tags = json.loads(existing[6] or "[]")
                    except (json.JSONDecodeError, TypeError):
                        old_tags = []
                    old_internal_dependencies = {
                        series_identity_dependency(existing[1], old_tags),
                        *matching_selector_dependencies(existing[1], old_tags),
                    }
                    for dependency in old_internal_dependencies:
                        changes[dependency].append(
                            (int(existing[2]), int(existing[2]))
                        )
                    if existing[7] is not None:
                        changes[f"series:{int(existing[7])}"].append(
                            (int(existing[2]), int(existing[2]))
                        )
                else:
                    cur = conn.execute(
                        """
                        INSERT INTO metrics
                        (metric_name, ts, value, interval, metric_type, tags, dedupe_key,
                         series_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (*values, dedupe_key, series_id),
                    )
                    metric_id = cur.lastrowid
                    inserted += 1
                if tags:
                    conn.executemany(
                        "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
                        [(metric_id, tag) for tag in tags],
                    )
                dependencies.add(metric_name)
                changes[metric_name].append((int(ts), int(ts)))
                new_internal_dependencies = {
                    series_identity_dependency(metric_name, tags),
                    *matching_selector_dependencies(metric_name, tags),
                }
                for dependency in new_internal_dependencies:
                    changes[dependency].append((int(ts), int(ts)))
                changes[f"series:{series_id}"].append((int(ts), int(ts)))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "inserted": inserted,
        "updated": updated,
        "unchanged": unchanged,
        "invalid": invalid,
        "correction_age_buckets": correction_age_buckets,
        "dependencies": dependencies,
        "changes": dict(changes),
    }


def ingest_events(conn, payload, current_ts=None):
    inserted = 0
    updated = 0
    invalid = 0
    ingested_at = current_ts if current_ts is not None else now_ts()
    conn.execute("BEGIN")
    try:
        for event in payload:
            if not isinstance(event, dict):
                invalid += 1
                continue
            dedupe_key = event.get("dedupe_key")
            source_id = event.get("source_id")
            starts_at = parse_timestamp(event.get("starts_at"))
            observed_at = parse_timestamp(event.get("observed_at")) or ingested_at
            title = event.get("title")
            event_type = event.get("event_type")
            if not all((dedupe_key, source_id, starts_at, title, event_type)):
                invalid += 1
                continue
            existing = conn.execute(
                "SELECT id FROM events WHERE dedupe_key = ?", (str(dedupe_key),)
            ).fetchone()
            metadata = event.get("metadata") or {}
            conn.execute(
                """
                INSERT INTO events (
                    dedupe_key, source_id, external_key, starts_at, ends_at,
                    observed_at, event_type, status, severity, title, body,
                    metadata_json, ingested_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(dedupe_key) DO UPDATE SET
                    external_key = excluded.external_key,
                    starts_at = excluded.starts_at,
                    ends_at = excluded.ends_at,
                    observed_at = excluded.observed_at,
                    event_type = excluded.event_type,
                    status = excluded.status,
                    severity = excluded.severity,
                    title = excluded.title,
                    body = excluded.body,
                    metadata_json = excluded.metadata_json,
                    ingested_at = excluded.ingested_at
                """,
                (
                    str(dedupe_key)[:500],
                    str(source_id)[:120],
                    str(event.get("external_key"))[:240]
                    if event.get("external_key") is not None
                    else None,
                    starts_at,
                    parse_timestamp(event.get("ends_at")),
                    observed_at,
                    str(event_type)[:120],
                    str(event.get("status"))[:80]
                    if event.get("status") is not None
                    else None,
                    str(event.get("severity"))[:80]
                    if event.get("severity") is not None
                    else None,
                    str(title)[:500],
                    str(event.get("body"))[:10000]
                    if event.get("body") is not None
                    else None,
                    json.dumps(metadata, sort_keys=True),
                    ingested_at,
                ),
            )
            if existing:
                updated += 1
            else:
                inserted += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"inserted": inserted, "updated": updated, "invalid": invalid}


def update_source_health(conn, attempt, current_ts=None):
    source_id = attempt.get("source_id") if isinstance(attempt, dict) else None
    display_name = attempt.get("display_name") if isinstance(attempt, dict) else None
    interval = parse_positive_int(
        attempt.get("expected_interval_seconds") if isinstance(attempt, dict) else None
    )
    if not source_id or not display_name or interval is None:
        raise ValueError("invalid_source_attempt")
    attempted_at = parse_timestamp(attempt.get("attempted_at"))
    updated_at = current_ts if current_ts is not None else now_ts()
    attempted_at = attempted_at or updated_at
    success = attempt.get("success") is True
    publication_mode = str(attempt.get("publication_mode") or "polling")
    if publication_mode not in ("polling", "event"):
        raise ValueError("invalid_publication_mode")
    publication_interval = parse_positive_int(
        attempt.get("publication_interval_seconds")
    )
    checkpoint = attempt.get("checkpoint")
    checkpoint_json = None
    if checkpoint is not None:
        checkpoint_json = json.dumps(checkpoint, sort_keys=True, separators=(",", ":"))
        if len(checkpoint_json.encode("utf-8")) > MAX_BODY_BYTES:
            raise ValueError("checkpoint_too_large")
    diagnostics_json = bounded_source_metadata_json(
        attempt.get("diagnostics"), "source_diagnostics"
    )
    provenance_json = bounded_source_metadata_json(
        attempt.get("provenance"), "source_provenance"
    )
    availability_status = attempt.get("availability_status")
    if availability_status is not None:
        availability_status = str(availability_status)
        if availability_status not in ("available", "empty"):
            raise ValueError("invalid_availability_status")
    if not success:
        availability_status = None
    previous = conn.execute(
        "SELECT consecutive_failures, last_success_ts FROM collector_sources WHERE source_id = ?",
        (str(source_id),),
    ).fetchone()
    failures = 0 if success else ((previous[0] if previous else 0) + 1)
    last_success = attempted_at if success else (previous[1] if previous else None)
    conn.execute(
        """
        INSERT INTO collector_sources (
            source_id, display_name, expected_interval_seconds, last_attempt_ts,
            last_success_ts, source_timestamp_ts, last_payload_hash,
            last_row_count, consecutive_failures, last_error, updated_at
            , publication_mode, publication_interval_seconds, checkpoint_json,
            data_timestamp_ts, diagnostics_json, provenance_json, availability_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
            display_name = excluded.display_name,
            expected_interval_seconds = excluded.expected_interval_seconds,
            last_attempt_ts = excluded.last_attempt_ts,
            last_success_ts = excluded.last_success_ts,
            source_timestamp_ts = CASE
                WHEN excluded.source_timestamp_ts IS NULL
                THEN collector_sources.source_timestamp_ts
                ELSE excluded.source_timestamp_ts
            END,
            last_payload_hash = CASE
                WHEN excluded.last_payload_hash IS NULL
                THEN collector_sources.last_payload_hash
                ELSE excluded.last_payload_hash
            END,
            last_row_count = excluded.last_row_count,
            consecutive_failures = excluded.consecutive_failures,
            last_error = excluded.last_error,
            publication_mode = excluded.publication_mode,
            publication_interval_seconds = excluded.publication_interval_seconds,
            checkpoint_json = CASE
                WHEN excluded.checkpoint_json IS NULL
                THEN collector_sources.checkpoint_json
                ELSE excluded.checkpoint_json
            END,
            data_timestamp_ts = CASE
                WHEN excluded.availability_status = 'empty'
                THEN NULL
                WHEN excluded.data_timestamp_ts IS NULL
                THEN collector_sources.data_timestamp_ts
                ELSE excluded.data_timestamp_ts
            END,
            diagnostics_json = CASE
                WHEN excluded.diagnostics_json IS NULL
                THEN collector_sources.diagnostics_json
                ELSE excluded.diagnostics_json
            END,
            provenance_json = CASE
                WHEN excluded.provenance_json IS NULL
                THEN collector_sources.provenance_json
                ELSE excluded.provenance_json
            END,
            availability_status = CASE
                WHEN excluded.availability_status IS NULL
                THEN collector_sources.availability_status
                ELSE excluded.availability_status
            END,
            updated_at = excluded.updated_at
        """,
        (
            str(source_id)[:120],
            str(display_name)[:240],
            interval,
            attempted_at,
            last_success,
            parse_timestamp(attempt.get("source_timestamp_ts")),
            str(attempt.get("payload_hash"))[:128]
            if attempt.get("payload_hash") is not None
            else None,
            max(0, parse_int(attempt.get("row_count")) or 0),
            failures,
            None if success else str(attempt.get("error") or "unknown_error")[:2000],
            updated_at,
            publication_mode,
            publication_interval,
            checkpoint_json,
            parse_timestamp(attempt.get("data_timestamp_ts")),
            diagnostics_json,
            provenance_json,
            availability_status,
        ),
    )
    conn.commit()


def source_state(row, current_ts=None):
    now = current_ts if current_ts is not None else now_ts()
    interval = max(1, int(row[2]))
    last_success = row[4]
    source_ts = row[5]
    availability_status = row[17] if len(row) > 17 else None
    data_ts = row[14]
    if data_ts is None and availability_status != "empty":
        data_ts = source_ts
    failures = int(row[8] or 0)
    publication_mode = row[11] or "polling"
    publication_interval = row[12] or interval
    collection_age = None if last_success is None else max(0, now - int(last_success))
    source_age = None if source_ts is None else max(0, now - int(source_ts))
    data_age = None if data_ts is None else max(0, now - int(data_ts))
    if last_success is None or failures >= 3:
        collection_state = "failed"
    elif failures > 0 or collection_age is None or collection_age > interval * 2:
        collection_state = "delayed"
    else:
        collection_state = "healthy"
    if publication_mode == "event":
        freshness_state = "event_driven"
    elif data_age is None:
        freshness_state = "unknown"
    elif data_age > publication_interval * 4:
        freshness_state = "stale"
    elif data_age > publication_interval * 2:
        freshness_state = "delayed"
    else:
        freshness_state = "fresh"
    state = collection_state
    if collection_state != "failed" and freshness_state == "stale":
        state = "stale"
    elif collection_state == "healthy" and freshness_state in ("delayed", "unknown"):
        state = "delayed"
    return {
        "state": state,
        "collection_state": collection_state,
        "freshness_state": freshness_state,
        "collection_age_seconds": collection_age,
        "source_age_seconds": source_age,
        "data_age_seconds": data_age,
    }


def list_source_health(conn, current_ts=None):
    rows = conn.execute(
        """
        SELECT source_id, display_name, expected_interval_seconds,
               last_attempt_ts, last_success_ts, source_timestamp_ts,
               last_payload_hash, last_row_count, consecutive_failures,
               last_error, updated_at, publication_mode,
               publication_interval_seconds, checkpoint_json,
               data_timestamp_ts, diagnostics_json, provenance_json,
               availability_status
        FROM collector_sources ORDER BY display_name
        """
    ).fetchall()
    output = []
    for row in rows:
        if row[0] in DISABLED_SOURCE_IDS:
            continue
        states = source_state(row, current_ts)
        output.append(
            {
                "source_id": row[0],
                "display_name": row[1],
                "expected_interval_seconds": row[2],
                "last_attempt_ts": row[3],
                "last_success_ts": row[4],
                "source_timestamp_ts": row[5],
                "data_timestamp_ts": row[14],
                "last_payload_hash": row[6],
                "last_row_count": row[7],
                "consecutive_failures": row[8],
                "last_error": row[9],
                "updated_at": row[10],
                "publication_mode": row[11],
                "publication_interval_seconds": row[12],
                "state": states["state"],
                "age_seconds": states["data_age_seconds"],
                "collection_state": states["collection_state"],
                "freshness_state": states["freshness_state"],
                "collection_age_seconds": states["collection_age_seconds"],
                "source_age_seconds": states["source_age_seconds"],
                "data_age_seconds": states["data_age_seconds"],
                "diagnostics": parse_source_metadata_json(row[15]),
                "provenance": parse_source_metadata_json(row[16]),
                "availability_status": row[17],
            }
        )
    return output


def tags_filter_clause(tags):
    if not tags:
        return "", []
    placeholders = ",".join("?" for _ in tags)
    clause = f"AND m.id IN (SELECT metric_id FROM metric_tags WHERE tag IN ({placeholders}) GROUP BY metric_id HAVING COUNT(DISTINCT tag) = {len(tags)})"
    return clause, tags


def legacy_series_filter_sql(tags):
    if len(tags) == 1:
        return (
            "metrics m JOIN metric_tags mt ON mt.metric_id = m.id",
            ["m.metric_name = ?", "mt.tag = ?"],
            lambda metric: [metric, tags[0]],
        )
    return "metrics m", ["m.metric_name = ?"], lambda metric: [metric]


def normalized_series_selector_sql(metric, tags):
    normalized_tags = normalize_tags(tags)
    if not normalized_tags:
        return "SELECT id FROM series WHERE metric_name = ?", [metric]
    placeholders = ",".join("?" for _ in normalized_tags)
    return (
        f"""
        SELECT s.id
        FROM series s
        JOIN series_tags st ON st.series_id = s.id
        WHERE s.metric_name = ? AND st.tag IN ({placeholders})
        GROUP BY s.id
        HAVING COUNT(DISTINCT st.tag) = ?
        """,
        [metric, *normalized_tags, len(normalized_tags)],
    )


def normalized_series_ids(conn, metric, tags):
    selector_sql, params = normalized_series_selector_sql(metric, tags)
    return [int(row[0]) for row in conn.execute(selector_sql, params).fetchall()]


def series_filter_sql(conn, metric, tags):
    has_legacy_rows = conn.execute(
        """
        SELECT 1 FROM metrics
        WHERE metric_name = ? AND series_id IS NULL
        LIMIT 1
        """,
        (metric,),
    ).fetchone()
    if has_legacy_rows:
        source, clauses, params_for_metric = legacy_series_filter_sql(tags)
        return source, clauses, params_for_metric(metric), len(tags) > 1
    selector_sql, params = normalized_series_selector_sql(metric, tags)
    return (
        "metrics m",
        [f"m.series_id IN ({selector_sql})"],
        params,
        False,
    )


def downsample_minmax(points, max_points):
    if not points or not max_points or max_points <= 0:
        return points
    if len(points) <= max_points:
        return points
    if max_points == 1:
        return [points[-1]]
    start_ts = points[0][0]
    end_ts = points[-1][0]
    if end_ts <= start_ts:
        return points[-max_points:]
    target_buckets = max(1, max_points // 2)
    bucket_size = int((end_ts - start_ts) / target_buckets) + 1
    output = []
    bucket_start = start_ts
    bucket_end = bucket_start + bucket_size
    min_point = None
    max_point = None

    def flush_bucket():
        nonlocal min_point, max_point
        if min_point is None:
            return
        if max_point is None or max_point[0] == min_point[0]:
            output.append(min_point)
        else:
            if min_point[0] <= max_point[0]:
                output.append(min_point)
                output.append(max_point)
            else:
                output.append(max_point)
                output.append(min_point)
        min_point = None
        max_point = None

    for ts, value in points:
        while ts > bucket_end:
            flush_bucket()
            bucket_start = bucket_end
            bucket_end = bucket_start + bucket_size
        if min_point is None or value < min_point[1]:
            min_point = [ts, value]
        if max_point is None or value > max_point[1]:
            max_point = [ts, value]
    flush_bucket()
    return output[:max_points]


def series_statistics(points):
    if not points:
        return {
            "count": 0,
            "latest": None,
            "minimum": None,
            "maximum": None,
            "average": None,
            "energy_mwh": None,
        }
    values = [float(point[1]) for point in points]
    energy = 0.0
    for index in range(1, len(points)):
        previous_ts, previous_value = points[index - 1]
        ts, value = points[index]
        if ts <= previous_ts:
            continue
        energy += ((float(previous_value) + float(value)) / 2) * (
            (ts - previous_ts) / 3600
        )
    return {
        "count": len(points),
        "latest": values[-1],
        "minimum": min(values),
        "maximum": max(values),
        "average": sum(values) / len(values),
        "energy_mwh": energy if len(points) > 1 else None,
    }


def infer_bucket_seconds(points, seasonal_period):
    if not points:
        return seasonal_period
    min_delta = None
    prev_ts = None
    for ts, _value in points:
        if prev_ts is not None:
            delta = ts - prev_ts
            if delta > 0 and (min_delta is None or delta < min_delta):
                min_delta = delta
        prev_ts = ts
    if min_delta is None:
        return seasonal_period
    return min(min_delta, seasonal_period)


def bucket_average(points, bucket_seconds):
    if bucket_seconds <= 0:
        raise ValueError("bucket_seconds_must_be_positive")
    if not points:
        return []
    buckets = defaultdict(lambda: [0.0, 0])
    for ts, value in points:
        bucket_ts = (int(ts) // bucket_seconds) * bucket_seconds
        buckets[bucket_ts][0] += value
        buckets[bucket_ts][1] += 1
    output = []
    for bucket_ts in sorted(buckets):
        total, count = buckets[bucket_ts]
        output.append([bucket_ts, total / count])
    return output


def seasonal_average(points, seasonal_period, bucket_seconds):
    if seasonal_period <= 0:
        raise ValueError("seasonal_period_must_be_positive")
    if bucket_seconds <= 0:
        raise ValueError("bucket_seconds_must_be_positive")
    if bucket_seconds > seasonal_period:
        raise ValueError("bucket_seconds_exceeds_seasonal_period")
    if not points:
        return []

    bucketed = bucket_average(points, bucket_seconds)
    seasonal_buckets = defaultdict(lambda: [0.0, 0])
    for ts, value in bucketed:
        phase = ts % seasonal_period
        seasonal_buckets[phase][0] += value
        seasonal_buckets[phase][1] += 1

    seasonal_profile = {}
    for phase, (total, count) in seasonal_buckets.items():
        seasonal_profile[phase] = total / count

    return [[ts, seasonal_profile[ts % seasonal_period]] for ts, _value in bucketed]


def transform_series(points, bucket_seconds=None, seasonal_period=None):
    output = points
    if seasonal_period is not None:
        resolved_bucket_seconds = bucket_seconds or infer_bucket_seconds(
            points, seasonal_period
        )
        output = seasonal_average(output, seasonal_period, resolved_bucket_seconds)
    elif bucket_seconds is not None:
        output = bucket_average(output, bucket_seconds)
    return output


class Cache:
    def __init__(self, ttl_seconds: int, max_entries: int = CACHE_MAX_ENTRIES):
        self.ttl = ttl_seconds
        self.max_entries = max(1, max_entries)
        self.data = OrderedDict()
        self.lock = threading.Lock()
        self.hits = 0
        self.misses = 0
        self.generation = 0

    def get(self, key):
        now = time.time()
        with self.lock:
            entry = self.data.get(key)
            if not entry:
                self.misses += 1
                return None
            expires_at, value, _dependencies, _ranges, _category = entry
            if expires_at < now:
                del self.data[key]
                self.misses += 1
                return None
            self.data.move_to_end(key)
            self.hits += 1
            return value

    def set(
        self,
        key,
        value,
        dependencies=None,
        ranges=None,
        ttl_seconds=None,
        category="generic",
    ):
        expires_at = time.time() + (ttl_seconds if ttl_seconds is not None else self.ttl)
        with self.lock:
            self.data[key] = (
                expires_at,
                value,
                frozenset(dependencies or []),
                dict(ranges or {}),
                category,
            )
            self.data.move_to_end(key)
            while len(self.data) > self.max_entries:
                self.data.popitem(last=False)

    def snapshot_generation(self):
        with self.lock:
            return self.generation

    def set_if_generation(
        self,
        key,
        value,
        expected_generation,
        dependencies=None,
        ranges=None,
        ttl_seconds=None,
        category="generic",
    ):
        expires_at = time.time() + (ttl_seconds if ttl_seconds is not None else self.ttl)
        with self.lock:
            if self.generation != expected_generation:
                return False
            self.data[key] = (
                expires_at,
                value,
                frozenset(dependencies or []),
                dict(ranges or {}),
                category,
            )
            self.data.move_to_end(key)
            while len(self.data) > self.max_entries:
                self.data.popitem(last=False)
            return True

    def invalidate(self, dependencies):
        targets = set(dependencies)
        if not targets:
            return
        with self.lock:
            self.generation += 1
            keys = [
                key
                for key, (_expires, _value, entry_dependencies, _ranges, _category) in self.data.items()
                if targets.intersection(entry_dependencies)
            ]
            for key in keys:
                del self.data[key]

    def invalidate_changes(self, changes):
        if not changes:
            return
        with self.lock:
            self.generation += 1
            keys = []
            for key, (_expires, _value, dependencies, ranges, _category) in self.data.items():
                invalidate = False
                for metric, changed_ranges in changes.items():
                    if metric not in dependencies:
                        continue
                    cached_range = ranges.get(metric)
                    if cached_range is None:
                        invalidate = True
                        break
                    cached_start, cached_end = cached_range
                    if any(
                        changed_start <= cached_end and changed_end >= cached_start
                        for changed_start, changed_end in changed_ranges
                    ):
                        invalidate = True
                        break
                if invalidate:
                    keys.append(key)
            for key in keys:
                del self.data[key]

    def stats(self):
        with self.lock:
            total = self.hits + self.misses
            return {
                "entries": len(self.data),
                "max_entries": self.max_entries,
                "hits": self.hits,
                "misses": self.misses,
                "hit_ratio": self.hits / total if total else 0.0,
                "categories": dict(Counter(entry[4] for entry in self.data.values())),
                "generation": self.generation,
            }


class SingleFlight:
    class Flight:
        def __init__(self):
            self.event = threading.Event()
            self.result = None
            self.error = None

    def __init__(self):
        self.lock = threading.Lock()
        self.flights = {}

    def do(self, key, generate):
        with self.lock:
            flight = self.flights.get(key)
            if flight is None:
                flight = self.Flight()
                self.flights[key] = flight
                leader = True
            else:
                leader = False
        if not leader:
            flight.event.wait()
            if flight.error is not None:
                raise flight.error
            return flight.result, True
        try:
            flight.result = generate()
        except Exception as error:
            flight.error = error
        finally:
            with self.lock:
                if self.flights.get(key) is flight:
                    del self.flights[key]
            flight.event.set()
        if flight.error is not None:
            raise flight.error
        return flight.result, False

    def pending(self):
        with self.lock:
            return len(self.flights)


class RateLimiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.buckets = {}

    def allow(self, key: str, rpm: int) -> bool:
        now = time.time()
        capacity = max(1, rpm)
        refill_rate = capacity / 60.0
        with self.lock:
            tokens, last_ts = self.buckets.get(key, (capacity, now))
            elapsed = now - last_ts
            tokens = min(capacity, tokens + elapsed * refill_rate)
            if tokens < 1:
                self.buckets[key] = (tokens, now)
                return False
            self.buckets[key] = (tokens - 1, now)
            return True


class RequestTooLarge(ValueError):
    pass


class TileBackfillIncomplete(RuntimeError):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ERCOTReceiver/0.2"

    def _app_server(self) -> "Server":
        return cast("Server", self.server)

    def _send_json(self, status, payload, cache_control=None, etag=False, extra_headers=None):
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        resolved_etag = f'"{hashlib.sha256(body).hexdigest()}"' if etag else None
        not_modified = bool(
            resolved_etag and self.headers.get("If-None-Match") == resolved_etag
        )
        self.send_response(304 if not_modified else status)
        if resolved_etag:
            self.send_header("ETag", resolved_etag)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        if self.path.startswith("/api/"):
            self._set_cors_headers()
        if not_modified:
            if cache_control:
                self.send_header("Cache-Control", cache_control)
            self.end_headers()
            return
        self.send_header("Content-Type", "application/json")
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(
        self, status, body, content_type="text/plain; charset=utf-8", cache_control=None
    ):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        if self.path.startswith("/api/"):
            self._set_cors_headers()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _client_ip(self):
        if TRUST_PROXY:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def _get_origin(self):
        return self.headers.get("Origin")

    def _origin_allowed(self, origin):
        return origin in ALLOWED_ORIGINS

    def _set_cors_headers(self):
        origin = self._get_origin()
        if origin and self._origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _rate_limit(self, route_label, rpm):
        key = f"{self._client_ip()}:{route_label}"
        if not self._app_server().limiter.allow(key, rpm):
            self._send_json(429, {"error": "rate_limited"}, cache_control="no-store")
            return False
        return True

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid_content_length") from exc
        if length < 0:
            raise ValueError("invalid_content_length")
        if length > MAX_BODY_BYTES:
            raise RequestTooLarge("body_too_large")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def _read_json_or_error(self):
        try:
            return self._read_json()
        except RequestTooLarge:
            self._send_json(413, {"error": "body_too_large"}, cache_control="no-store")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid_json"}, cache_control="no-store")
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)}, cache_control="no-store")
        return None

    def _require_api_key(self):
        if not API_KEY:
            self._send_json(500, {"error": "missing_api_key"}, cache_control="no-store")
            return False
        provided = self.headers.get("X-API-Key")
        if provided != API_KEY:
            self._send_json(401, {"error": "unauthorized"}, cache_control="no-store")
            return False
        return True

    def _series_query(
        self,
        conn,
        metric,
        since,
        until,
        tags,
        bucket_seconds=None,
        aggregation="average",
        rollup=None,
    ):
        source, clauses, params, needs_multi_tag_filter = series_filter_sql(
            conn, metric, tags
        )
        if source is None:
            return []
        clauses = list(clauses)
        if since is not None:
            clauses.append("m.ts >= ?")
            params.append(int(since))
        if until is not None:
            clauses.append("m.ts <= ?")
            params.append(int(until))
        tag_clause = ""
        tag_params = []
        if needs_multi_tag_filter:
            tag_clause, tag_params = tags_filter_clause(tags)

        if rollup == "sum":
            query = (
                f"SELECT m.ts, SUM(m.value) FROM {source} WHERE "
                + " AND ".join(clauses)
                + " "
                + tag_clause
                + " GROUP BY m.ts ORDER BY m.ts"
            )
            raw = [
                [row[0], row[1]]
                for row in conn.execute(query, params + tag_params).fetchall()
            ]
            if bucket_seconds is None:
                return raw
            if aggregation == "minmax":
                return downsample_minmax(
                    raw,
                    max(1, math.ceil((until - since) / bucket_seconds) * 2),
                )
            return bucket_average(raw, int(bucket_seconds))

        if bucket_seconds is not None:
            bucket_seconds = int(bucket_seconds)
            if aggregation == "minmax":
                query = (
                    "SELECT ts, value FROM ("
                    "SELECT m.ts AS ts, m.value AS value, m.id AS metric_id, "
                    "ROW_NUMBER() OVER (PARTITION BY (m.ts / ?) "
                    "ORDER BY m.value ASC, m.ts ASC, m.id ASC) AS min_rank, "
                    "ROW_NUMBER() OVER (PARTITION BY (m.ts / ?) "
                    "ORDER BY m.value DESC, m.ts ASC, m.id ASC) AS max_rank "
                    f"FROM {source} WHERE "
                    + " AND ".join(clauses)
                    + " "
                    + tag_clause
                    + ") WHERE min_rank = 1 OR max_rank = 1 "
                    "ORDER BY ts, metric_id"
                )
                rows = conn.execute(
                    query, [bucket_seconds, bucket_seconds, *params, *tag_params]
                ).fetchall()
                return [[r[0], r[1]] for r in rows]
            query = (
                "SELECT (m.ts / ?) * ? AS bucket_ts, AVG(m.value) "
                f"FROM {source} WHERE "
                + " AND ".join(clauses)
                + " "
                + tag_clause
                + " GROUP BY bucket_ts ORDER BY bucket_ts"
            )
            rows = conn.execute(
                query, [bucket_seconds, bucket_seconds, *params, *tag_params]
            ).fetchall()
            return [[r[0], r[1]] for r in rows]

        # Stable sample ordering is timestamp then insertion identity. The hot
        # index uses the same prefix so equal-timestamp results do not change
        # when a metric moves from the legacy tag path to normalized series.
        query = (
            f"SELECT m.ts, m.value FROM {source} WHERE "
            + " AND ".join(clauses)
            + " "
            + tag_clause
            + " ORDER BY m.ts, m.id"
        )
        rows = conn.execute(query, params + tag_params).fetchall()
        return [[r[0], r[1]] for r in rows]

    def _query_bucket_seconds(
        self, since, until, max_points, bucket_seconds, aggregation="average"
    ):
        if bucket_seconds is not None:
            return bucket_seconds
        if not max_points or since is None:
            return None
        end_ts = until if until is not None else now_ts()
        span = int(end_ts) - int(since)
        if span <= 0:
            return None
        target_points = max(1, int(max_points) // 2) if aggregation == "minmax" else int(max_points)
        return max(1, int(span / target_points) + 1)

    def _series_statistics(self, conn, metric, since, until, tags, rollup=None):
        return series_statistics(
            self._series_query(conn, metric, since, until, tags, rollup=rollup)
        )

    def _series_params(self, payload):
        bucket_raw = payload.get("bucket_seconds")
        seasonal_raw = payload.get("seasonal_period")
        bucket_seconds = parse_positive_int(bucket_raw)
        seasonal_period = parse_positive_int(seasonal_raw)

        if bucket_raw is not None and bucket_seconds is None:
            raise ValueError("invalid_bucket_seconds")
        if seasonal_raw is not None and seasonal_period is None:
            raise ValueError("invalid_seasonal_period")
        if (
            bucket_seconds is not None
            and seasonal_period is not None
            and bucket_seconds > seasonal_period
        ):
            raise ValueError("bucket_seconds_exceeds_seasonal_period")

        return bucket_seconds, seasonal_period

    def _latest_query(self, conn, metric, tags):
        source, clauses, params, needs_multi_tag_filter = series_filter_sql(
            conn, metric, tags
        )
        if source is None:
            return None
        tag_clause = ""
        tag_params = []
        if needs_multi_tag_filter:
            tag_clause, tag_params = tags_filter_clause(tags)
        row = conn.execute(
            "SELECT m.ts, m.value, m.tags FROM "
            + source
            + " WHERE "
            + " AND ".join(clauses)
            + " "
            + tag_clause
            + " ORDER BY m.ts DESC, m.id DESC LIMIT 1",
            [*params, *tag_params],
        ).fetchone()
        if not row:
            return None
        return {"ts": row[0], "value": row[1], "tags": json.loads(row[2] or "[]")}

    def _latest_by_tag(self, conn, metric, tag_prefix, limit):
        rows = conn.execute(
            """
            SELECT tag, ts, value FROM (
                SELECT mt.tag AS tag, m.ts AS ts, m.value AS value,
                       ROW_NUMBER() OVER (
                           PARTITION BY mt.tag ORDER BY m.ts DESC, m.id DESC
                       ) AS latest_rank
                FROM metrics m
                JOIN metric_tags mt ON mt.metric_id = m.id
                WHERE m.metric_name = ? AND mt.tag LIKE ?
            ) WHERE latest_rank = 1
            ORDER BY value DESC LIMIT ?
            """,
            (metric, f"{tag_prefix}%", limit),
        ).fetchall()
        return [{"tag": row[0], "ts": row[1], "value": row[2]} for row in rows]

    def _cache_key(self, label, payload):
        return label + ":" + json.dumps(payload, sort_keys=True)

    def _tile_storage_points(self, conn, definition, start, end):
        metric = definition["metric"]
        if conn.execute(
            """
            SELECT 1 FROM metrics
            WHERE metric_name = ? AND series_id IS NULL
            LIMIT 1
            """,
            (metric,),
        ).fetchone():
            raise TileBackfillIncomplete("tile_series_backfill_incomplete")
        if definition["match"] == "exact":
            tags_json = canonical_series_tags(definition["tags"])
            row = conn.execute(
                "SELECT id FROM series WHERE metric_name = ? AND tags_json = ?",
                (metric, tags_json),
            ).fetchone()
            if row is None:
                return [], []
            series_ids = [int(row[0])]
            rows = conn.execute(
                """
                SELECT ts, value FROM metrics
                WHERE series_id = ? AND ts >= ? AND ts < ?
                ORDER BY ts, id
                """,
                (series_ids[0], start, end),
            ).fetchall()
            next_ordinal = defaultdict(int)
            points = []
            for timestamp, value in rows:
                points.append([timestamp, value, next_ordinal[timestamp]])
                next_ordinal[timestamp] += 1
            return points, series_ids
        series_ids = normalized_series_ids(conn, metric, definition["tags"])
        points = self._series_query(
            conn,
            metric,
            start,
            end - 1,
            definition["tags"],
            rollup=definition["rollup"],
        )
        points = [[point[0], point[1], 0] for point in points]
        return points, series_ids

    def _generate_tile(self, definition, tile_span, tile_start, lod):
        tile_seconds = TILE_SPANS[tile_span]
        tile_end = tile_start + tile_seconds
        points, series_ids = self._tile_storage_points(
            get_db(), definition, tile_start, tile_end
        )
        buckets = []
        if lod == "native":
            for point in points:
                state = aggregate_points([point])
                buckets.append(
                    {
                        "start": point[0],
                        "end": point[0],
                        "state": json.loads(serialize_aggregate(state)),
                    }
                )
        else:
            lod_seconds = TILE_LOD_SECONDS[lod]
            grouped = defaultdict(list)
            for point in points:
                bucket_start = (int(point[0]) // lod_seconds) * lod_seconds
                grouped[bucket_start].append(point)
            for bucket_start in sorted(grouped):
                state = aggregate_points(grouped[bucket_start])
                buckets.append(
                    {
                        "start": bucket_start,
                        "end": bucket_start + lod_seconds,
                        "state": json.loads(serialize_aggregate(state)),
                    }
                )
        payload = {
            "schema": TILE_SCHEMA_VERSION,
            "series_key": definition["key"],
            "tile_span": tile_span,
            "tile_start": tile_start,
            "tile_end": tile_end,
            "lod": lod,
            "native_interval_seconds": definition["native_interval_seconds"],
            "unit": definition["unit"],
            "statistic_policy": definition["statistic_policy"],
            "rollup": definition["rollup"],
            "boundary_policy": "native_edges_coarse_aligned_interiors",
            "buckets": buckets,
        }
        dependencies = {f"series:{series_id}" for series_id in series_ids}
        if definition["match"] == "exact":
            dependencies.add(
                series_identity_dependency(definition["metric"], definition["tags"])
            )
        else:
            dependencies.add(
                selector_dependency(definition["metric"], definition["tags"])
            )
        ranges = {
            dependency: (tile_start, tile_end - 1) for dependency in dependencies
        }
        return payload, dependencies, ranges

    def do_POST(self):
        if self.path == "/api/ingest":
            if not self._rate_limit("ingest", RATE_LIMIT_INGEST_RPM):
                return
            if not self._require_api_key():
                return
            payload = self._read_json_or_error()
            if payload is None:
                return
            if not isinstance(payload, list):
                self._send_json(
                    400, {"error": "expected_list"}, cache_control="no-store"
                )
                return
            conn = get_db()
            result = ingest_metrics(conn, payload)
            dependencies = result.pop("dependencies")
            changes = result.pop("changes")
            self._app_server().cache.invalidate_changes(changes)
            if result["updated"]:
                self._app_server().cache.invalidate({"correction-age"})
            self._send_json(200, result, cache_control="no-store")
            return

        if self.path == "/api/events/ingest":
            if not self._rate_limit("events_ingest", RATE_LIMIT_INGEST_RPM):
                return
            if not self._require_api_key():
                return
            payload = self._read_json_or_error()
            if payload is None:
                return
            if not isinstance(payload, list):
                self._send_json(400, {"error": "expected_list"}, cache_control="no-store")
                return
            result = ingest_events(get_db(), payload)
            self._app_server().cache.invalidate({"events", "overview"})
            self._send_json(200, result, cache_control="no-store")
            return

        if self.path == "/api/source-health":
            if not self._rate_limit("source_health_ingest", RATE_LIMIT_INGEST_RPM):
                return
            if not self._require_api_key():
                return
            payload = self._read_json_or_error()
            if payload is None:
                return
            attempts = payload if isinstance(payload, list) else [payload]
            if len(attempts) > MAX_BATCH_QUERIES:
                self._send_json(400, {"error": "too_many_attempts"}, cache_control="no-store")
                return
            try:
                for attempt in attempts:
                    update_source_health(get_db(), attempt)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)}, cache_control="no-store")
                return
            self._app_server().cache.invalidate({"source-health", "overview"})
            self._send_json(200, {"updated": len(attempts)}, cache_control="no-store")
            return

        if self.path == "/api/series/batch":
            # Public read endpoint for dashboard
            if not self._rate_limit("series_batch", RATE_LIMIT_SERIES_RPM):
                return
            payload = self._read_json_or_error()
            if payload is None:
                return
            if not isinstance(payload, dict) or "queries" not in payload:
                self._send_json(
                    400, {"error": "expected_queries"}, cache_control="no-store"
                )
                return
            queries = payload.get("queries")
            if not isinstance(queries, list):
                self._send_json(400, {"error": "expected_queries"}, cache_control="no-store")
                return
            if len(queries) > MAX_BATCH_QUERIES:
                self._send_json(400, {"error": "too_many_queries"}, cache_control="no-store")
                return
            cache_key = self._cache_key("series_batch", payload)
            cached = self._app_server().cache.get(cache_key)
            if cached is not None:
                self._send_json(
                    200,
                    cached,
                    cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
                )
                return

            conn = get_db()
            result = []
            dependencies = set()
            for entry in queries:
                if not isinstance(entry, dict):
                    result.append({"id": None, "error": "invalid_query"})
                    continue
                metric = entry.get("metric")
                if not metric:
                    result.append({"id": entry.get("id"), "error": "missing_metric"})
                    continue
                tags = normalize_tags(entry.get("tags") or [])
                since = parse_timestamp(entry.get("since"))
                stats_since = parse_timestamp(entry.get("stats_since"))
                until = parse_timestamp(entry.get("until"))
                dependencies.add(metric)
                try:
                    aggregation = entry.get("aggregation") or "average"
                    if aggregation not in ("average", "minmax"):
                        raise ValueError("invalid_aggregation")
                    rollup = entry.get("rollup")
                    if rollup not in (None, "sum"):
                        raise ValueError("invalid_rollup")
                    max_points = validate_max_points(entry.get("max_points"))
                    bucket_seconds, seasonal_period = self._series_params(entry)
                    since, until = normalize_query_window(
                        since, until, max_points, bucket_seconds
                    )
                    stats_since, _stats_until = normalize_query_window(
                        stats_since if stats_since is not None else since,
                        until,
                        max_points,
                        bucket_seconds,
                    )
                except ValueError as exc:
                    result.append(
                        {"id": entry.get("id"), "metric": metric, "error": str(exc)}
                    )
                    continue
                query_bucket_seconds = self._query_bucket_seconds(
                    since, until, max_points, bucket_seconds, aggregation
                )
                points = self._series_query(
                    conn,
                    metric,
                    since,
                    until,
                    tags,
                    query_bucket_seconds,
                    aggregation,
                    rollup,
                )
                points = transform_series(
                    points,
                    bucket_seconds=(
                        bucket_seconds
                        if query_bucket_seconds is None or seasonal_period is not None
                        else None
                    ),
                    seasonal_period=seasonal_period,
                )
                if max_points and query_bucket_seconds is None:
                    points = downsample_minmax(points, max_points)
                elif max_points and len(points) > max_points:
                    points = downsample_minmax(points, max_points)
                stats = self._series_statistics(
                    conn, metric, stats_since, until, tags, rollup
                )
                result.append(
                    {
                        "id": entry.get("id"),
                        "metric": metric,
                        "points": points,
                        "meta": {
                            "since": since,
                            "until": until,
                            "max_points": max_points,
                            "bucket_seconds": query_bucket_seconds,
                            "aggregation": aggregation,
                            "rollup": rollup,
                            "stats": stats,
                            "partial_current_bucket": bool(
                                query_bucket_seconds
                                and (
                                    until is None
                                    or until >= now_ts() - query_bucket_seconds
                                )
                            ),
                        },
                    }
                )
            payload_out = {"series": result}
            self._app_server().cache.set(cache_key, payload_out, dependencies)
            self._send_json(
                200,
                payload_out,
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return

        if self.path == "/api/latest/batch":
            # Public read endpoint for dashboard
            if not self._rate_limit("latest_batch", RATE_LIMIT_LATEST_RPM):
                return
            payload = self._read_json_or_error()
            if payload is None:
                return
            if not isinstance(payload, dict) or "queries" not in payload:
                self._send_json(
                    400, {"error": "expected_queries"}, cache_control="no-store"
                )
                return
            queries = payload.get("queries")
            if not isinstance(queries, list):
                self._send_json(400, {"error": "expected_queries"}, cache_control="no-store")
                return
            if len(queries) > MAX_BATCH_QUERIES:
                self._send_json(400, {"error": "too_many_queries"}, cache_control="no-store")
                return
            cache_key = self._cache_key("latest_batch", payload)
            cached = self._app_server().cache.get(cache_key)
            if cached is not None:
                self._send_json(
                    200,
                    cached,
                    cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
                )
                return

            conn = get_db()
            result = []
            dependencies = set()
            for entry in queries:
                if not isinstance(entry, dict):
                    result.append({"id": None, "error": "invalid_query"})
                    continue
                metric = entry.get("metric")
                if not metric:
                    result.append({"id": entry.get("id"), "error": "missing_metric"})
                    continue
                dependencies.add(metric)
                tags = normalize_tags(entry.get("tags") or [])
                point = self._latest_query(conn, metric, tags)
                result.append(
                    {
                        "id": entry.get("id"),
                        "metric": metric,
                        "point": point,
                        "meta": {
                            "age_seconds": max(0, now_ts() - point["ts"])
                            if point
                            else None
                        },
                    }
                )
            payload_out = {"latest": result}
            self._app_server().cache.set(cache_key, payload_out, dependencies)
            self._send_json(
                200,
                payload_out,
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return

        self._send_json(404, {"error": "not_found"}, cache_control="no-store")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/v2/tile-catalog":
            if parsed.query:
                self._send_json(
                    400, {"error": "invalid_tile_catalog_request"}, cache_control="no-store"
                )
                return
            self._send_json(
                200,
                tile_catalog_payload(),
                cache_control="public, max-age=3600, s-maxage=86400, immutable",
                etag=True,
            )
            return
        tile_match = re.fullmatch(
            r"/api/v2/tiles/([^/]+)/([^/]+)/([^/]+)/([^/]+)", parsed.path
        )
        if tile_match:
            if not self._rate_limit("series_tile_v2", RATE_LIMIT_SERIES_RPM):
                return
            series_key, tile_span, tile_start_raw, lod = tile_match.groups()
            definition = TILE_CATALOG_BY_KEY.get(series_key)
            if definition is None:
                self._send_json(
                    404, {"error": "unknown_tile_series"}, cache_control="no-store"
                )
                return
            try:
                tile_start = int(tile_start_raw)
            except ValueError:
                tile_start = -1
            tile_seconds = TILE_SPANS.get(tile_span)
            if (
                parsed.query
                or tile_seconds is None
                or tile_start < 0
                or str(tile_start) != tile_start_raw
                or tile_start % tile_seconds != 0
                or lod not in definition["supported_lods"]
            ):
                self._send_json(
                    400, {"error": "invalid_canonical_tile"}, cache_control="no-store"
                )
                return
            identity = {
                "schema": TILE_SCHEMA_VERSION,
                "series_key": series_key,
                "tile_span": tile_span,
                "tile_start": tile_start,
                "lod": lod,
            }
            cache_key = self._cache_key("tile:v2", identity)
            tile_end = tile_start + tile_seconds
            category, ttl_seconds, cache_control = historical_cache_policy(tile_end)
            app = self._app_server()
            cached = app.cache.get(cache_key)
            if cached is not None:
                metrics = getattr(app, "cache_metrics", None)
                if metrics is not None:
                    metrics["tile_lru_hits"] += 1
                self._send_json(
                    200,
                    cached,
                    cache_control=cache_control,
                    etag=True,
                    extra_headers={
                        "X-ERCOT-Cache": "HIT",
                        "X-ERCOT-Cache-Class": category,
                    },
                )
                return

            request_generation = app.cache.snapshot_generation()

            def generate():
                cached_after_election = app.cache.get(cache_key)
                if cached_after_election is not None:
                    return cached_after_election, True, False
                started = time.perf_counter()
                payload_out, dependencies, ranges = self._generate_tile(
                    definition, tile_span, tile_start, lod
                )
                stored = app.cache.set_if_generation(
                    cache_key,
                    payload_out,
                    request_generation,
                    dependencies,
                    ranges=ranges,
                    ttl_seconds=ttl_seconds,
                    category=f"tile:{category}",
                )
                metrics = getattr(app, "cache_metrics", None)
                if metrics is not None:
                    metrics["tile_generations"] += 1
                    metrics["tile_generation_seconds"] += time.perf_counter() - started
                    if not stored:
                        metrics["tile_generation_store_races"] += 1
                return payload_out, stored, True

            try:
                (payload_out, stored, generated), shared = app.singleflight.do(
                    (cache_key, request_generation), generate
                )
            except TileBackfillIncomplete:
                self._send_json(
                    503,
                    {"error": "tile_series_backfill_incomplete"},
                    cache_control="no-store",
                )
                return
            except Exception:
                self._send_json(
                    500, {"error": "tile_generation_failed"}, cache_control="no-store"
                )
                return
            metrics = getattr(app, "cache_metrics", None)
            if metrics is not None:
                metrics["tile_lru_misses"] += 1
                if shared:
                    metrics["tile_singleflight_waits"] += 1
                if not generated:
                    metrics["tile_lru_race_hits"] += 1
            self._send_json(
                200,
                payload_out,
                cache_control=cache_control,
                etag=True,
                extra_headers={
                    "X-ERCOT-Cache": "MISS" if generated else "HIT",
                    "X-ERCOT-Cache-Class": category,
                    "X-ERCOT-Singleflight": "SHARED" if shared else "LEADER",
                    "X-ERCOT-Cache-Store": "STORED" if stored else "SKIPPED_RACE",
                },
            )
            return
        if parsed.path.startswith("/api/v2/tiles/"):
            self._send_json(
                400, {"error": "invalid_canonical_tile"}, cache_control="no-store"
            )
            return
        if parsed.path == "/api/v1/correction-age":
            if not self._rate_limit("correction_age", RATE_LIMIT_LATEST_RPM):
                return
            cache_key = "correction-age"
            cached = self._app_server().cache.get(cache_key)
            if cached is None:
                cached = {"corrections": list_metric_correction_age(get_db())}
                self._app_server().cache.set(cache_key, cached, {"correction-age"})
            self._send_json(
                200,
                cached,
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return
        if parsed.path == "/api/v1/series/chunk":
            if not self._rate_limit("series_chunk", RATE_LIMIT_SERIES_RPM):
                return
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            start = parse_timestamp((qs.get("start") or [None])[0])
            end = parse_timestamp((qs.get("end") or [None])[0])
            chunk_seconds = parse_positive_int((qs.get("chunk_seconds") or [None])[0])
            resolution = parse_positive_int((qs.get("resolution") or [None])[0])
            tags = normalize_tags(qs.get("tag", []))
            aggregation = (qs.get("aggregation") or ["average"])[0]
            rollup = (qs.get("rollup") or [None])[0]
            if (
                not metric
                or start is None
                or end is None
                or chunk_seconds not in (3600, 86400)
                or start % chunk_seconds != 0
                or end != start + chunk_seconds
                or resolution is None
                or resolution > chunk_seconds
                or aggregation not in ("average", "minmax")
                or rollup not in (None, "sum")
            ):
                self._send_json(
                    400, {"error": "invalid_canonical_chunk"}, cache_control="no-store"
                )
                return
            identity = {
                "schema": 1,
                "metric": metric,
                "tags": tags,
                "start": start,
                "end": end,
                "chunk_seconds": chunk_seconds,
                "resolution": resolution,
                "aggregation": aggregation,
                "rollup": rollup,
            }
            cache_key = self._cache_key("series_chunk", identity)
            cached = self._app_server().cache.get(cache_key)
            current = now_ts()
            if end <= current - SEALED_HISTORY_AGE_SECONDS:
                category = "sealed"
                ttl_seconds = SEALED_CACHE_TTL_SECONDS
                cache_control = "public, max-age=3600, s-maxage=86400, immutable"
            elif end <= current - 300:
                category = "recent"
                ttl_seconds = RECENT_CACHE_TTL_SECONDS
                cache_control = "public, max-age=60, s-maxage=300, stale-while-revalidate=60"
            else:
                category = "live"
                ttl_seconds = CACHE_TTL_SECONDS
                cache_control = "public, max-age=5, s-maxage=15, stale-while-revalidate=30"
            if cached is not None:
                metrics = getattr(self._app_server(), "cache_metrics", None)
                if metrics is not None:
                    metrics["historical_chunk_hits"] += 1
                self._send_json(
                    200,
                    cached,
                    cache_control=cache_control,
                    etag=True,
                    extra_headers={"X-ERCOT-Cache": "HIT", "X-ERCOT-Cache-Class": category},
                )
                return
            started = time.perf_counter()
            points = self._series_query(
                get_db(),
                metric,
                start,
                end - 1,
                tags,
                resolution,
                aggregation,
                rollup,
            )
            payload_out = {**identity, "points": points}
            self._app_server().cache.set(
                cache_key,
                payload_out,
                {metric},
                ranges={metric: (start, end - 1)},
                ttl_seconds=ttl_seconds,
                category=category,
            )
            metrics = getattr(self._app_server(), "cache_metrics", None)
            if metrics is not None:
                metrics["historical_chunk_misses"] += 1
                metrics["query_executions"] += 1
                metrics["query_seconds"] += time.perf_counter() - started
            self._send_json(
                200,
                payload_out,
                cache_control=cache_control,
                etag=True,
                extra_headers={"X-ERCOT-Cache": "MISS", "X-ERCOT-Cache-Class": category},
            )
            return
        if parsed.path == "/api/source-checkpoint":
            if not self._rate_limit("source_checkpoint", RATE_LIMIT_STATUS_RPM):
                return
            if not self._require_api_key():
                return
            source_id = (parse_qs(parsed.query).get("source_id") or [None])[0]
            if not source_id:
                self._send_json(
                    400, {"error": "missing_source_id"}, cache_control="no-store"
                )
                return
            row = get_db().execute(
                """
                SELECT last_payload_hash, source_timestamp_ts, checkpoint_json
                FROM collector_sources WHERE source_id = ?
                """,
                (source_id,),
            ).fetchone()
            self._send_json(
                200,
                {
                    "source_id": source_id,
                    "payload_hash": row[0] if row else None,
                    "source_timestamp_ts": row[1] if row else None,
                    "checkpoint": json.loads(row[2]) if row and row[2] else None,
                },
                cache_control="no-store",
            )
            return
        if parsed.path == "/api/v1/source-health":
            if not self._rate_limit("source_health", RATE_LIMIT_STATUS_RPM):
                return
            cache_key = "source-health"
            cached = self._app_server().cache.get(cache_key)
            if cached is None:
                sources = list_source_health(get_db())
                states = defaultdict(int)
                for source in sources:
                    states[source["state"]] += 1
                cached = {"sources": sources, "summary": dict(states), "as_of": now_ts()}
                self._app_server().cache.set(cache_key, cached, {"source-health"})
            self._send_json(
                200, cached, cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}"
            )
            return
        if parsed.path == "/api/v1/events":
            if not self._rate_limit("events", RATE_LIMIT_STATUS_RPM):
                return
            qs = parse_qs(parsed.query)
            since = parse_timestamp((qs.get("since") or [None])[0])
            until = parse_timestamp((qs.get("until") or [None])[0])
            limit = parse_positive_int((qs.get("limit") or [None])[0]) or 250
            limit = min(limit, MAX_EVENTS)
            if since is not None and until is not None and since > until:
                self._send_json(400, {"error": "invalid_time_range"}, cache_control="no-store")
                return
            clauses = ["1 = 1"]
            params = []
            if since is not None:
                clauses.append("starts_at >= ?")
                params.append(since)
            if until is not None:
                clauses.append("starts_at <= ?")
                params.append(until)
            event_type = (qs.get("type") or [None])[0]
            status = (qs.get("status") or [None])[0]
            if event_type:
                clauses.append("event_type = ?")
                params.append(event_type)
            if status:
                clauses.append("status = ?")
                params.append(status)
            rows = get_db().execute(
                """
                SELECT dedupe_key, source_id, external_key, starts_at, ends_at,
                       observed_at, event_type, status, severity, title, body,
                       metadata_json, ingested_at
                FROM events WHERE
                """
                + " AND ".join(clauses)
                + " ORDER BY starts_at DESC LIMIT ?",
                [*params, limit],
            ).fetchall()
            events = [
                {
                    "dedupe_key": row[0],
                    "source_id": row[1],
                    "external_key": row[2],
                    "starts_at": row[3],
                    "ends_at": row[4],
                    "observed_at": row[5],
                    "event_type": row[6],
                    "status": row[7],
                    "severity": row[8],
                    "title": row[9],
                    "body": row[10],
                    "metadata": json.loads(row[11] or "{}"),
                    "ingested_at": row[12],
                }
                for row in rows
            ]
            self._send_json(
                200,
                {"events": events, "count": len(events), "limit": limit},
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return
        if parsed.path == "/api/v1/overview":
            if not self._rate_limit("overview", RATE_LIMIT_STATUS_RPM):
                return
            cache_key = "overview"
            cached = self._app_server().cache.get(cache_key)
            if cached is None:
                conn = get_db()
                overview_metrics = [
                    "ercot.Real_Time_Data.Actual_System_Demand",
                    "ercot.Real_Time_Data.Total_System_Capacity",
                    "ercot.Frequency.Current_Frequency",
                    "ercot.storage.net_output_mw",
                    "ercot.generation_outages.total_mw",
                    "ercot.pricing",
                ]
                metrics = {}
                for metric in overview_metrics:
                    metrics[metric] = self._latest_query(conn, metric, [])
                recent_events = conn.execute(
                    """
                    SELECT starts_at, status, severity, title
                    FROM events ORDER BY starts_at DESC LIMIT 5
                    """
                ).fetchall()
                cached = {
                    "as_of": now_ts(),
                    "metrics": metrics,
                    "sources": list_source_health(conn),
                    "events": [
                        {
                            "starts_at": row[0],
                            "status": row[1],
                            "severity": row[2],
                            "title": row[3],
                        }
                        for row in recent_events
                    ],
                }
                self._app_server().cache.set(
                    cache_key,
                    cached,
                    {"overview", "source-health", "events", *overview_metrics},
                )
            self._send_json(
                200, cached, cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}"
            )
            return
        if parsed.path == "/api/v1/ranking":
            if not self._rate_limit("ranking", RATE_LIMIT_LATEST_RPM):
                return
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            tag_prefix = (qs.get("tag_prefix") or [None])[0]
            limit = min(
                parse_positive_int((qs.get("limit") or [None])[0]) or 10,
                100,
            )
            if not metric or not tag_prefix:
                self._send_json(
                    400, {"error": "missing_metric_or_tag_prefix"}, cache_control="no-store"
                )
                return
            cache_key = self._cache_key(
                "ranking",
                {"metric": metric, "tag_prefix": tag_prefix, "limit": limit},
            )
            cached = self._app_server().cache.get(cache_key)
            if cached is None:
                rows = self._latest_by_tag(get_db(), metric, tag_prefix, limit)
                cached = {"metric": metric, "rows": rows, "as_of": now_ts()}
                self._app_server().cache.set(cache_key, cached, {metric})
            self._send_json(
                200, cached, cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}"
            )
            return
        if parsed.path == "/api/status":
            if not self._rate_limit("status", RATE_LIMIT_STATUS_RPM):
                return
            conn = get_db()
            total = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
            self._send_json(
                200,
                {
                    "rows": total,
                    "normalized_series": normalized_series_readiness(conn),
                    "cache": self._app_server().cache.stats(),
                    "cache_metrics": dict(
                        getattr(self._app_server(), "cache_metrics", {})
                    ),
                },
                cache_control="no-store",
            )
            return
        if parsed.path == "/api/metrics":
            if not self._rate_limit("metrics", RATE_LIMIT_METRICS_RPM):
                return
            conn = get_db()
            rows = conn.execute(
                "SELECT DISTINCT metric_name FROM metrics ORDER BY metric_name"
            ).fetchall()
            self._send_json(
                200, {"metrics": [r[0] for r in rows]}, cache_control="no-store"
            )
            return
        if parsed.path == "/api/latest":
            if not self._rate_limit("latest", RATE_LIMIT_LATEST_RPM):
                return
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            if not metric:
                self._send_json(
                    400, {"error": "missing_metric"}, cache_control="no-store"
                )
                return
            tags = normalize_tags(qs.get("tag", []))
            cache_key = self._cache_key("latest", {"metric": metric, "tags": tags})
            cached = self._app_server().cache.get(cache_key)
            if cached is not None:
                self._send_json(
                    200,
                    cached,
                    cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
                )
                return
            conn = get_db()
            point = self._latest_query(conn, metric, tags)
            payload_out = {"metric": metric, "point": point}
            self._app_server().cache.set(cache_key, payload_out, {metric})
            self._send_json(
                200,
                payload_out,
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return
        if parsed.path == "/api/series":
            if not self._rate_limit("series", RATE_LIMIT_SERIES_RPM):
                return
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            if not metric:
                self._send_json(
                    400, {"error": "missing_metric"}, cache_control="no-store"
                )
                return
            since = parse_timestamp((qs.get("since") or [None])[0])
            until = parse_timestamp((qs.get("until") or [None])[0])
            tags = normalize_tags(qs.get("tag", []))
            max_points_raw = (qs.get("max_points") or [None])[0]
            bucket_raw = (qs.get("bucket_seconds") or [None])[0]
            seasonal_raw = (qs.get("seasonal_period") or [None])[0]
            aggregation = (qs.get("aggregation") or ["average"])[0]
            rollup = (qs.get("rollup") or [None])[0]
            try:
                if aggregation not in ("average", "minmax"):
                    raise ValueError("invalid_aggregation")
                if rollup not in (None, "sum"):
                    raise ValueError("invalid_rollup")
                max_points = validate_max_points(max_points_raw)
                bucket_seconds, seasonal_period = self._series_params(
                    {"bucket_seconds": bucket_raw, "seasonal_period": seasonal_raw}
                )
                since, until = normalize_query_window(
                    since, until, max_points, bucket_seconds
                )
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)}, cache_control="no-store")
                return
            cache_key = self._cache_key(
                "series",
                {
                    "metric": metric,
                    "since": since,
                    "until": until,
                    "tags": tags,
                    "max_points": max_points,
                    "bucket_seconds": bucket_seconds,
                    "seasonal_period": seasonal_period,
                    "aggregation": aggregation,
                    "rollup": rollup,
                },
            )
            cached = self._app_server().cache.get(cache_key)
            if cached is not None:
                self._send_json(
                    200,
                    cached,
                    cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
                )
                return
            conn = get_db()
            query_bucket_seconds = self._query_bucket_seconds(
                since, until, max_points, bucket_seconds, aggregation
            )
            points = self._series_query(
                conn,
                metric,
                since,
                until,
                tags,
                query_bucket_seconds,
                aggregation,
                rollup,
            )
            points = transform_series(
                points,
                bucket_seconds=(
                    bucket_seconds
                    if query_bucket_seconds is None or seasonal_period is not None
                    else None
                ),
                seasonal_period=seasonal_period,
            )
            if max_points and query_bucket_seconds is None:
                points = downsample_minmax(points, max_points)
            elif max_points and len(points) > max_points:
                points = downsample_minmax(points, max_points)
            stats = self._series_statistics(conn, metric, since, until, tags, rollup)
            payload_out = {
                "metric": metric,
                "points": points,
                "meta": {
                    "since": since,
                    "until": until,
                    "max_points": max_points,
                    "bucket_seconds": query_bucket_seconds,
                    "aggregation": aggregation,
                    "rollup": rollup,
                    "stats": stats,
                    "partial_current_bucket": bool(
                        query_bucket_seconds
                        and (until is None or until >= now_ts() - query_bucket_seconds)
                    ),
                },
            }
            self._app_server().cache.set(cache_key, payload_out, {metric})
            self._send_json(
                200,
                payload_out,
                cache_control=f"public, max-age={CACHE_CONTROL_MAX_AGE}",
            )
            return

        path = parsed.path
        if path == "/":
            path = "/index.html"
        fs_path = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not fs_path.startswith(WEB_DIR):
            self._send_text(403, "forbidden")
            return
        if not os.path.exists(fs_path) or os.path.isdir(fs_path):
            self._send_text(404, "not_found")
            return
        content_type, _encoding = mimetypes.guess_type(fs_path)
        if content_type is None:
            content_type = "text/plain; charset=utf-8"
        elif content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
            "image/svg+xml",
        }:
            content_type = f"{content_type}; charset=utf-8"
        with open(fs_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if path.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif path == "/index.html":
            self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.path.startswith("/api/"):
            self._send_text(404, "not_found", cache_control="no-store")
            return
        origin = self._get_origin()
        if origin and not self._origin_allowed(origin):
            self._send_text(403, "forbidden", cache_control="no-store")
            return
        self.send_response(204)
        self._set_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()


class Server(ThreadingHTTPServer):
    def __init__(self, addr):
        super().__init__(addr, Handler)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        init_db(conn)
        conn.execute("PRAGMA optimize")
        conn.close()
        self.cache = Cache(CACHE_TTL_SECONDS, CACHE_MAX_ENTRIES)
        self.cache_metrics = defaultdict(float)
        self.limiter = RateLimiter()
        self.singleflight = SingleFlight()


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    server = Server((host, port))
    print(f"Receiver listening on http://{host}:{port}")
    server.serve_forever()
