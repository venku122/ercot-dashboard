"""Reproduce the authored missing-value fixture through normal ingest and HTTP."""
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.request import urlopen

from benchmark_receiver import load_server

ROOT = Path(__file__).resolve().parents[1]


class MissingForecastFixtureTests(unittest.TestCase):
    def test_normal_ingest_and_http_preserve_null_with_honest_coverage(self):
        fixture = json.loads((ROOT / "frontend/test-fixtures/forecast/valid-missing-hour.json").read_text())
        receiver = load_server(ROOT / "ercot-receiver/server.py")
        with tempfile.TemporaryDirectory(prefix="ercot-null-contract-") as directory:
            receiver.DB_PATH = str(Path(directory) / "metrics.db")
            conn = sqlite3.connect(receiver.DB_PATH)
            receiver.init_db(conn)
            receiver.ingest_forecast_publication(conn, fixture["normal_ingest_payload"], current_ts=fixture["selected_time"]["end"] + 60)
            self.assertEqual((1,), conn.execute("SELECT count(*) FROM forecast_np3_565_rows WHERE system_total IS NULL").fetchone())
            conn.close()
            server = receiver.Server(("127.0.0.1", 0))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with urlopen(f"http://127.0.0.1:{server.server_port}" + fixture["api_path"]) as response:
                    self.assertEqual(200, response.status)
                    body = json.load(response)
                self.assertEqual(fixture["response"], body)
                self.assertIsNone(body["rows"][0]["value"])
                self.assertEqual(0, body["coverage"]["available_value_count"])
                self.assertEqual(1, body["coverage"]["selected_target_count"])
                self.assertFalse(body["coverage"]["truncated"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
