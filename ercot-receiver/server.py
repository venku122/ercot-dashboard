#!/usr/bin/env python3
import json
import math
import mimetypes
import os
import sqlite3
import threading
import time
from collections import OrderedDict, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from typing import cast

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "metrics.db")
WEB_DIR = os.path.join(BASE_DIR, "web")
API_KEY = os.environ.get("METRICS_API_KEY")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "10"))
CACHE_MAX_ENTRIES = int(os.environ.get("CACHE_MAX_ENTRIES", "512"))
CACHE_CONTROL_MAX_AGE = int(os.environ.get("CACHE_CONTROL_MAX_AGE", "30"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(512 * 1024)))
MAX_BATCH_QUERIES = int(os.environ.get("MAX_BATCH_QUERIES", "100"))
MAX_POINTS_HARD = int(os.environ.get("MAX_POINTS_HARD", "5000"))
MAX_TAGS = int(os.environ.get("MAX_TAGS", "20"))
MAX_RAW_SPAN_SECONDS = int(os.environ.get("MAX_RAW_SPAN_SECONDS", str(31 * 86400)))
MAX_EVENTS = int(os.environ.get("MAX_EVENTS", "1000"))
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
if CORS_ORIGINS_EXTRA:
    for origin in CORS_ORIGINS_EXTRA.split(","):
        origin = origin.strip()
        if origin:
            ALLOWED_ORIGINS.add(origin)
DB_LOCAL = threading.local()


def init_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            ts INTEGER NOT NULL,
            value REAL NOT NULL,
            interval INTEGER,
            metric_type TEXT,
            tags TEXT
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
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_dedupe_key
        ON metrics(dedupe_key) WHERE dedupe_key IS NOT NULL
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
            last_payload_hash TEXT,
            last_row_count INTEGER,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at INTEGER NOT NULL
        )
        """
    )
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
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
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


def ingest_metrics(conn, payload, current_ts=None):
    inserted = 0
    duplicate = 0
    invalid = 0
    dependencies = set()
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
                    point_dedupe = point.get("dedupe_key")
                elif isinstance(point, (list, tuple)) and len(point) >= 2:
                    ts = parse_timestamp(point[0])
                    value = point[1]
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
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO metrics
                    (metric_name, ts, value, interval, metric_type, tags, dedupe_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        metric_name,
                        int(ts),
                        numeric_value,
                        interval,
                        metric_type,
                        json.dumps(tags),
                        dedupe_key,
                    ),
                )
                if cur.rowcount == 0:
                    duplicate += 1
                    continue
                metric_id = cur.lastrowid
                if tags:
                    conn.executemany(
                        "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
                        [(metric_id, tag) for tag in tags],
                    )
                inserted += 1
                dependencies.add(metric_name)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {
        "inserted": inserted,
        "duplicate": duplicate,
        "invalid": invalid,
        "dependencies": dependencies,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ),
    )
    conn.commit()


def source_state(row, current_ts=None):
    now = current_ts if current_ts is not None else now_ts()
    interval = max(1, int(row[2]))
    last_success = row[4]
    source_ts = row[5]
    failures = int(row[8] or 0)
    freshness_ts = source_ts or last_success
    age = None if freshness_ts is None else max(0, now - int(freshness_ts))
    if last_success is None or failures >= 3:
        state = "failed"
    elif age is None or age > interval * 4:
        state = "stale"
    elif failures > 0 or age > interval * 2:
        state = "delayed"
    else:
        state = "healthy"
    return state, age


def list_source_health(conn, current_ts=None):
    rows = conn.execute(
        """
        SELECT source_id, display_name, expected_interval_seconds,
               last_attempt_ts, last_success_ts, source_timestamp_ts,
               last_payload_hash, last_row_count, consecutive_failures,
               last_error, updated_at
        FROM collector_sources ORDER BY display_name
        """
    ).fetchall()
    output = []
    for row in rows:
        state, age = source_state(row, current_ts)
        output.append(
            {
                "source_id": row[0],
                "display_name": row[1],
                "expected_interval_seconds": row[2],
                "last_attempt_ts": row[3],
                "last_success_ts": row[4],
                "source_timestamp_ts": row[5],
                "last_payload_hash": row[6],
                "last_row_count": row[7],
                "consecutive_failures": row[8],
                "last_error": row[9],
                "updated_at": row[10],
                "state": state,
                "age_seconds": age,
            }
        )
    return output


def tags_filter_clause(tags):
    if not tags:
        return "", []
    placeholders = ",".join("?" for _ in tags)
    clause = f"AND m.id IN (SELECT metric_id FROM metric_tags WHERE tag IN ({placeholders}) GROUP BY metric_id HAVING COUNT(DISTINCT tag) = {len(tags)})"
    return clause, tags


def series_filter_sql(tags):
    if len(tags) == 1:
        return (
            "metrics m JOIN metric_tags mt ON mt.metric_id = m.id",
            ["m.metric_name = ?", "mt.tag = ?"],
            lambda metric: [metric, tags[0]],
        )
    return "metrics m", ["m.metric_name = ?"], lambda metric: [metric]


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

    def get(self, key):
        now = time.time()
        with self.lock:
            entry = self.data.get(key)
            if not entry:
                self.misses += 1
                return None
            expires_at, value, _dependencies = entry
            if expires_at < now:
                del self.data[key]
                self.misses += 1
                return None
            self.data.move_to_end(key)
            self.hits += 1
            return value

    def set(self, key, value, dependencies=None):
        expires_at = time.time() + self.ttl
        with self.lock:
            self.data[key] = (expires_at, value, frozenset(dependencies or []))
            self.data.move_to_end(key)
            while len(self.data) > self.max_entries:
                self.data.popitem(last=False)

    def invalidate(self, dependencies):
        targets = set(dependencies)
        if not targets:
            return
        with self.lock:
            keys = [
                key
                for key, (_expires, _value, entry_dependencies) in self.data.items()
                if targets.intersection(entry_dependencies)
            ]
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
            }


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


class Handler(BaseHTTPRequestHandler):
    server_version = "ERCOTReceiver/0.2"

    def _app_server(self) -> "Server":
        return cast("Server", self.server)

    def _send_json(self, status, payload, cache_control=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        if self.path.startswith("/api/"):
            self._set_cors_headers()
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
        self, conn, metric, since, until, tags, bucket_seconds=None, aggregation="average"
    ):
        source, clauses, params_for_metric = series_filter_sql(tags)
        clauses = list(clauses)
        params = params_for_metric(metric)
        if since is not None:
            clauses.append("m.ts >= ?")
            params.append(int(since))
        if until is not None:
            clauses.append("m.ts <= ?")
            params.append(int(until))
        tag_clause = ""
        tag_params = []
        if len(tags) > 1:
            tag_clause, tag_params = tags_filter_clause(tags)

        if bucket_seconds is not None:
            bucket_seconds = int(bucket_seconds)
            if aggregation == "minmax":
                query = (
                    "SELECT ts, value FROM ("
                    "SELECT m.ts AS ts, m.value AS value, "
                    "ROW_NUMBER() OVER (PARTITION BY (m.ts / ?) ORDER BY m.value ASC, m.ts ASC) AS min_rank, "
                    "ROW_NUMBER() OVER (PARTITION BY (m.ts / ?) ORDER BY m.value DESC, m.ts ASC) AS max_rank "
                    f"FROM {source} WHERE "
                    + " AND ".join(clauses)
                    + " "
                    + tag_clause
                    + ") WHERE min_rank = 1 OR max_rank = 1 ORDER BY ts"
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

        query = (
            f"SELECT m.ts, m.value FROM {source} WHERE "
            + " AND ".join(clauses)
            + " "
            + tag_clause
            + " ORDER BY m.ts"
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
        source, clauses, params_for_metric = series_filter_sql(tags)
        params = params_for_metric(metric)
        tag_clause = ""
        tag_params = []
        if len(tags) > 1:
            tag_clause, tag_params = tags_filter_clause(tags)
        row = conn.execute(
            "SELECT m.ts, m.value, m.tags FROM "
            + source
            + " WHERE "
            + " AND ".join(clauses)
            + " "
            + tag_clause
            + " ORDER BY m.ts DESC LIMIT 1",
            [*params, *tag_params],
        ).fetchone()
        if not row:
            return None
        return {"ts": row[0], "value": row[1], "tags": json.loads(row[2] or "[]")}

    def _cache_key(self, label, payload):
        return label + ":" + json.dumps(payload, sort_keys=True)

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
            self._app_server().cache.invalidate(dependencies)
            conn.execute("PRAGMA optimize")
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
                until = parse_timestamp(entry.get("until"))
                dependencies.add(metric)
                try:
                    aggregation = entry.get("aggregation") or "average"
                    if aggregation not in ("average", "minmax"):
                        raise ValueError("invalid_aggregation")
                    max_points = validate_max_points(entry.get("max_points"))
                    bucket_seconds, seasonal_period = self._series_params(entry)
                    validate_query_window(since, until, max_points, bucket_seconds)
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
        if parsed.path == "/api/status":
            if not self._rate_limit("status", RATE_LIMIT_STATUS_RPM):
                return
            conn = get_db()
            total = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
            self._send_json(
                200,
                {"rows": total, "cache": self._app_server().cache.stats()},
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
            try:
                if aggregation not in ("average", "minmax"):
                    raise ValueError("invalid_aggregation")
                max_points = validate_max_points(max_points_raw)
                bucket_seconds, seasonal_period = self._series_params(
                    {"bucket_seconds": bucket_raw, "seasonal_period": seasonal_raw}
                )
                validate_query_window(since, until, max_points, bucket_seconds)
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
            payload_out = {
                "metric": metric,
                "points": points,
                "meta": {
                    "since": since,
                    "until": until,
                    "max_points": max_points,
                    "bucket_seconds": query_bucket_seconds,
                    "aggregation": aggregation,
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
        conn.close()
        self.cache = Cache(CACHE_TTL_SECONDS, CACHE_MAX_ENTRIES)
        self.limiter = RateLimiter()


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    server = Server((host, port))
    print(f"Receiver listening on http://{host}:{port}")
    server.serve_forever()
