#!/usr/bin/env python3
"""Serve built candidate assets and a disposable, explicitly synthetic SQLite fixture.

No collector runs, network fetches, production databases, or API substitutions.
The receiver handles all data requests normally. Stop with Ctrl-C to delete data.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from benchmark_receiver import load_server

ROOT = Path(__file__).resolve().parents[1]


def seed_review_data(receiver, conn, end, days):
    """Seed real receiver tables; all values are artificial review examples."""
    start = end - days * 86400
    definitions = [dict(item) for item in receiver.TILE_SERIES_CATALOG
                   if item.get("match") == "exact"]
    definitions += [{"key": "prc", "metric": "ercot_ancillary.prc", "tags": [],
                     "native_interval_seconds": 300, "unit": "MW",
                     "source": "ercot_ancillary"}]
    bases = {"supply-demand.demand": 57000, "supply-demand.available-capacity": 79000,
             "supply-demand.forecast-demand": 58000, "prc": 8500,
             "fuel-mix.wind": 16000, "fuel-mix.solar": 11000,
             "fuel-mix.natural-gas": 22000, "fuel-mix.coal-and-lignite": 5500,
             "fuel-mix.nuclear": 5100, "fuel-mix.power-storage": 900,
             "storage.charging": -800, "storage.discharging": 1000,
             "storage.net-output": 200}
    def value_at(key, ts, unit):
        # The supported storage source reports all three values at the same epoch.
        # Preserve its signed balance even though these review values are artificial.
        if key == "storage.net-output":
            return value_at("storage.charging", ts, "MW") + value_at("storage.discharging", ts, "MW")
        base = bases.get(key, 8000 if unit == "MW" else 38)
        if unit == "Hz":
            base, amplitude = 60, 0.025
        else:
            amplitude = abs(base) * 0.1
        phase = int(hashlib.sha256(key.encode()).hexdigest()[:4], 16) / 65535
        return base + amplitude * math.sin((ts - start) / 43200 * math.pi + phase)

    rows = 0
    sources = {}
    for item in definitions:
        cadence = item["native_interval_seconds"]
        last = end // cadence * cadence
        first = start // cadence * cadence
        metric, tags = item["metric"], item["tags"]
        series_id = receiver.resolve_series_id(conn, metric, tags)
        values = [(metric, ts, value_at(item["key"], ts, item["unit"]),
                   cadence, "gauge", json.dumps(tags), series_id)
                  for ts in range(first, last + 1, cadence)]
        conn.executemany("INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags,series_id) VALUES(?,?,?,?,?,?,?)", values)
        for tag in tags:
            conn.execute("INSERT INTO metric_tags(metric_id,tag) SELECT id,? FROM metrics WHERE series_id=?", (tag, series_id))
        rows += len(values)
        source = sources.setdefault(item["source"], {
            "cadence": cadence, "rows": 0, "last_ts": last,
        })
        source["cadence"] = min(cadence, source["cadence"])
        source["rows"] += len(values)
        source["last_ts"] = max(last, source["last_ts"])
    conn.commit()
    for source, evidence in sources.items():
        receiver.update_source_health(conn, {
            "source_id": source, "display_name": f"SYNTHETIC REVIEW: {source}",
            "expected_interval_seconds": evidence["cadence"], "attempted_at": end,
            "success": True, "source_timestamp_ts": evidence["last_ts"],
            "data_timestamp_ts": evidence["last_ts"], "row_count": evidence["rows"],
            "provenance": {"mode": "synthetic_local_review", "production": False},
            "availability_status": "available",
        }, current_ts=end)
    first_raw, last_raw = conn.execute("SELECT min(ts),max(ts) FROM metrics").fetchone()
    return {"mode": "synthetic_local_review", "production": False,
            "first_ts": first_raw, "last_ts": last_raw,
            "requested_start_ts": start, "requested_end_ts": end, "days": days, "metric_rows": rows,
            "physical_series": len(definitions),
            "optional_domains": "not collected; genuine empty/unavailable receiver states",
            "database": "disposable process-owned SQLite; deleted on shutdown"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4315)
    parser.add_argument("--days", type=int, choices=range(7, 32), default=7)
    args = parser.parse_args()
    receiver = load_server(ROOT / "ercot-receiver/server.py")
    if not (Path(receiver.WEB_DIR) / "assets").is_dir():
        parser.error("Build candidate assets first: pnpm run build")
    with tempfile.TemporaryDirectory(prefix="ercot-local-review-") as directory:
        frozen_web = Path(directory) / "web"
        shutil.copytree(receiver.WEB_DIR, frozen_web)
        receiver.WEB_DIR = str(frozen_web)
        receiver.DB_PATH = str(Path(directory) / "metrics.db")
        conn = sqlite3.connect(receiver.DB_PATH)
        receiver.init_db(conn)
        end = int(time.time()) // 300 * 300
        manifest = seed_review_data(receiver, conn, end, args.days)
        manifest["seeded_at_utc"] = datetime.fromtimestamp(end, timezone.utc).isoformat()
        manifest["candidate_sha"] = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        build_revision = re.search(
            r'<meta name="ercot-build-revision" content="([^"]+)"',
            (frozen_web / "index.html").read_text(),
        )
        manifest["frontend_build_revision"] = build_revision.group(1) if build_revision else "UNKNOWN"
        manifest["frontend_build_matches_candidate"] = manifest["frontend_build_revision"] == manifest["candidate_sha"]
        manifest["receiver_revision"] = manifest["candidate_sha"]
        manifest["index_sha256"] = hashlib.sha256((frozen_web / "index.html").read_bytes()).hexdigest()
        manifest["collector_revision"] = None
        manifest["collector_state"] = "not running; local synthetic fixture only"
        conn.close()
        original_handler = receiver.Handler

        class ReviewHandler(original_handler):
            def do_GET(self):
                path = urlsplit(self.path).path
                if path == "/review-fixture.json":
                    self._send_json(200, manifest, cache_control="no-store")
                    return
                if path in ("/", "/index.html"):
                    html = (Path(receiver.WEB_DIR) / "index.html").read_text()
                    banner = '<div role="note" style="padding:8px 16px;background:#382b00;color:#fff;font:14px system-ui">Local candidate review · SYNTHETIC data · no production feeds · <a href="/review-fixture.json" style="color:#fff">fixture details</a></div>'
                    data = html.replace("<body>", "<body>" + banner).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                super().do_GET()

        receiver.Handler = ReviewHandler
        server = receiver.Server(("127.0.0.1", args.port))
        print(json.dumps({"url": f"http://127.0.0.1:{args.port}", **manifest}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
