#!/usr/bin/env python3
"""Disposable loopback receiver with a year of native five-minute balance data."""
import argparse
import math
import json
import sqlite3
import tempfile
import time
from pathlib import Path

from benchmark_receiver import load_server

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4314)
    args = parser.parse_args()
    receiver = load_server(ROOT / "ercot-receiver/server.py")
    with tempfile.TemporaryDirectory(prefix="ercot-performance-") as directory:
        receiver.DB_PATH = str(Path(directory) / "metrics.db")
        conn = sqlite3.connect(receiver.DB_PATH)
        receiver.init_db(conn)
        end = int(time.time()) // 300 * 300
        count = 365 * 24 * 12 + 1
        identities = [
            ("ercot.supply_demand.demand_mw", ["source:supply_demand"], 71000),
            ("ercot.supply_demand.available_capacity_mw", ["source:supply_demand"], 90100),
            ("ercot.supply_demand.forecast_demand_mw", ["source:supply_demand"], 72000),
        ]
        total = 0
        for metric, tags, base in identities:
            series_id = receiver.resolve_series_id(conn, metric, tags)
            conn.executemany(
                "INSERT INTO metrics (metric_name,ts,value,interval,metric_type,tags,series_id) VALUES (?,?,?,?,?,?,?)",
                ((metric, end - index * 300, base + math.sin(index / 5) * 2000,
                  300, "gauge", json.dumps(tags), series_id) for index in range(count)),
            )
            for tag in tags:
                conn.execute("INSERT INTO metric_tags (metric_id,tag) SELECT id,? FROM metrics WHERE series_id=?", (tag, series_id))
            total += count
        metric = "ercot.Frequency.Current_Frequency"
        series_id = receiver.resolve_series_id(conn, metric, [])
        frequency_count = 86400 // 4 + 1
        conn.executemany(
            "INSERT INTO metrics (metric_name,ts,value,interval,metric_type,tags,series_id) VALUES (?,?,?,?,?,?,?)",
            ((metric, end - index * 4, 60 + math.sin(index / 5) * 0.01,
              4, "gauge", "[]", series_id) for index in range(frequency_count)),
        )
        conn.commit()
        conn.close()
        original_handler = receiver.Handler

        class FixtureHandler(original_handler):
            def do_GET(self):
                if self.path == "/performance-fixture.json":
                    self._send_json(200, {"end": end, "rows": total + frequency_count}, cache_control="no-store")
                    return
                super().do_GET()

        receiver.Handler = FixtureHandler
        server = receiver.Server(("127.0.0.1", args.port))
        print(f"Disposable receiver http://127.0.0.1:{args.port}; rows={total + frequency_count}; balance_cadence=300s; frequency_cadence=4s; last={end}", flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
