#!/usr/bin/env python3
import json
import os
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "metrics.db")
WEB_DIR = os.path.join(BASE_DIR, "web")
API_KEY = os.environ.get("METRICS_API_KEY")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "10"))
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metrics(metric_name, ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metric_tags_tag ON metric_tags(tag)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metric_tags_metric ON metric_tags(metric_id)")
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


def normalize_tags(tags):
    if not tags:
        return []
    if isinstance(tags, list):
        return [str(t) for t in tags]
    return [str(tags)]


def tags_filter_clause(tags):
    if not tags:
        return "", []
    placeholders = ",".join("?" for _ in tags)
    clause = f"AND m.id IN (SELECT metric_id FROM metric_tags WHERE tag IN ({placeholders}) GROUP BY metric_id HAVING COUNT(DISTINCT tag) = {len(tags)})"
    return clause, tags


class Cache:
    def __init__(self, ttl_seconds: int):
        self.ttl = ttl_seconds
        self.data = {}
        self.lock = threading.Lock()

    def get(self, key):
        now = time.time()
        with self.lock:
            entry = self.data.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if expires_at < now:
                del self.data[key]
                return None
            return value

    def set(self, key, value):
        expires_at = time.time() + self.ttl
        with self.lock:
            self.data[key] = (expires_at, value)

    def clear(self):
        with self.lock:
            self.data.clear()


class Handler(BaseHTTPRequestHandler):
    server_version = "ERCOTReceiver/0.2"

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status, body, content_type="text/plain; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def _require_api_key(self):
        if not API_KEY:
            return True
        provided = self.headers.get("X-API-Key")
        if provided != API_KEY:
            self._send_json(401, {"error": "unauthorized"})
            return False
        return True

    def _series_query(self, conn, metric, since, until, tags):
        clauses = ["m.metric_name = ?"]
        params = [metric]
        if since is not None:
            clauses.append("m.ts >= ?")
            params.append(int(since))
        if until is not None:
            clauses.append("m.ts <= ?")
            params.append(int(until))
        tag_clause, tag_params = tags_filter_clause(tags)
        query = "SELECT m.ts, m.value FROM metrics m WHERE " + " AND ".join(clauses) + " " + tag_clause + " ORDER BY m.ts"
        rows = conn.execute(query, params + tag_params).fetchall()
        return [[r[0], r[1]] for r in rows]

    def _latest_query(self, conn, metric, tags):
        tag_clause, tag_params = tags_filter_clause(tags)
        row = conn.execute(
            "SELECT m.ts, m.value, m.tags FROM metrics m WHERE m.metric_name = ? " + tag_clause + " ORDER BY m.ts DESC LIMIT 1",
            [metric, *tag_params],
        ).fetchone()
        if not row:
            return None
        return {"ts": row[0], "value": row[1], "tags": json.loads(row[2] or "[]")}

    def _cache_key(self, label, payload):
        return label + ":" + json.dumps(payload, sort_keys=True)

    def do_POST(self):
        if self.path == "/api/ingest":
            if not self._require_api_key():
                return
            try:
                payload = self._read_json()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid_json"})
                return
            if not isinstance(payload, list):
                self._send_json(400, {"error": "expected_list"})
                return

            conn = get_db()
            inserted = 0
            ts_now = now_ts()
            for item in payload:
                if not isinstance(item, dict):
                    continue
                metric_name = item.get("metric_name") or item.get("metric")
                if not metric_name:
                    continue
                tags = normalize_tags(item.get("tags") or [])
                interval = item.get("interval")
                metric_type = item.get("metric_type")
                points = item.get("points") or []
                for point in points:
                    ts = None
                    value = None
                    if isinstance(point, dict):
                        value = point.get("value")
                        ts = parse_timestamp(point.get("timestamp"))
                    elif isinstance(point, (list, tuple)) and len(point) >= 2:
                        ts = parse_timestamp(point[0])
                        value = point[1]
                    if value is None:
                        continue
                    if ts is None:
                        ts = ts_now
                    cur = conn.execute(
                        """
                        INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (metric_name, int(ts), float(value), interval, metric_type, json.dumps(tags)),
                    )
                    metric_id = cur.lastrowid
                    if tags:
                        conn.executemany(
                            "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
                            [(metric_id, tag) for tag in tags],
                        )
                    inserted += 1
            conn.commit()
            self.server.cache.clear()
            self._send_json(200, {"inserted": inserted})
            return

        if self.path == "/api/series/batch":
            # Public read endpoint for dashboard
            try:
                payload = self._read_json()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid_json"})
                return
            if not isinstance(payload, dict) or "queries" not in payload:
                self._send_json(400, {"error": "expected_queries"})
                return
            cache_key = self._cache_key("series_batch", payload)
            cached = self.server.cache.get(cache_key)
            if cached is not None:
                self._send_json(200, cached)
                return

            conn = get_db()
            result = []
            for entry in payload.get("queries", []):
                metric = entry.get("metric")
                if not metric:
                    result.append({"id": entry.get("id"), "error": "missing_metric"})
                    continue
                tags = normalize_tags(entry.get("tags") or [])
                since = parse_timestamp(entry.get("since"))
                until = parse_timestamp(entry.get("until"))
                points = self._series_query(conn, metric, since, until, tags)
                result.append({"id": entry.get("id"), "metric": metric, "points": points})
            payload_out = {"series": result}
            self.server.cache.set(cache_key, payload_out)
            self._send_json(200, payload_out)
            return

        if self.path == "/api/latest/batch":
            # Public read endpoint for dashboard
            try:
                payload = self._read_json()
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid_json"})
                return
            if not isinstance(payload, dict) or "queries" not in payload:
                self._send_json(400, {"error": "expected_queries"})
                return
            cache_key = self._cache_key("latest_batch", payload)
            cached = self.server.cache.get(cache_key)
            if cached is not None:
                self._send_json(200, cached)
                return

            conn = get_db()
            result = []
            for entry in payload.get("queries", []):
                metric = entry.get("metric")
                if not metric:
                    result.append({"id": entry.get("id"), "error": "missing_metric"})
                    continue
                tags = normalize_tags(entry.get("tags") or [])
                point = self._latest_query(conn, metric, tags)
                result.append({"id": entry.get("id"), "metric": metric, "point": point})
            payload_out = {"latest": result}
            self.server.cache.set(cache_key, payload_out)
            self._send_json(200, payload_out)
            return

        self._send_json(404, {"error": "not_found"})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            conn = get_db()
            total = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
            self._send_json(200, {"rows": total})
            return
        if parsed.path == "/api/metrics":
            conn = get_db()
            rows = conn.execute("SELECT DISTINCT metric_name FROM metrics ORDER BY metric_name").fetchall()
            self._send_json(200, {"metrics": [r[0] for r in rows]})
            return
        if parsed.path == "/api/latest":
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            if not metric:
                self._send_json(400, {"error": "missing_metric"})
                return
            tags = normalize_tags(qs.get("tag", []))
            cache_key = self._cache_key("latest", {"metric": metric, "tags": tags})
            cached = self.server.cache.get(cache_key)
            if cached is not None:
                self._send_json(200, cached)
                return
            conn = get_db()
            point = self._latest_query(conn, metric, tags)
            payload_out = {"metric": metric, "point": point}
            self.server.cache.set(cache_key, payload_out)
            self._send_json(200, payload_out)
            return
        if parsed.path == "/api/series":
            qs = parse_qs(parsed.query)
            metric = (qs.get("metric") or [None])[0]
            if not metric:
                self._send_json(400, {"error": "missing_metric"})
                return
            since = parse_timestamp((qs.get("since") or [None])[0])
            until = parse_timestamp((qs.get("until") or [None])[0])
            tags = normalize_tags(qs.get("tag", []))
            cache_key = self._cache_key("series", {"metric": metric, "since": since, "until": until, "tags": tags})
            cached = self.server.cache.get(cache_key)
            if cached is not None:
                self._send_json(200, cached)
                return
            conn = get_db()
            points = self._series_query(conn, metric, since, until, tags)
            payload_out = {"metric": metric, "points": points}
            self.server.cache.set(cache_key, payload_out)
            self._send_json(200, payload_out)
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
        content_type = "text/plain; charset=utf-8"
        if fs_path.endswith(".html"):
            content_type = "text/html; charset=utf-8"
        elif fs_path.endswith(".css"):
            content_type = "text/css; charset=utf-8"
        elif fs_path.endswith(".js"):
            content_type = "application/javascript; charset=utf-8"
        with open(fs_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    def __init__(self, addr):
        super().__init__(addr, Handler)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        init_db(conn)
        conn.close()
        self.cache = Cache(CACHE_TTL_SECONDS)


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    server = Server((host, port))
    print(f"Receiver listening on http://{host}:{port}")
    server.serve_forever()
