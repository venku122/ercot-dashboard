import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
RECEIVER = ROOT / "ercot-receiver"
BASE_BENCHMARK = ROOT / "scripts" / "benchmark_v2_tiles.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


def get(port: int, path: str):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        return response.status, dict(response.getheaders()), body
    finally:
        connection.close()


class ReceiverRestartNoPersistenceTests(unittest.TestCase):
    def test_fresh_process_regenerates_same_tile_from_authoritative_sqlite(self):
        base = load_module("restart_benchmark_base", BASE_BENCHMARK)
        server = base.load_server(RECEIVER / "server.py")
        with tempfile.TemporaryDirectory() as temporary_name:
            receiver_dir = Path(temporary_name) / "receiver"
            data_dir = receiver_dir / "data"
            data_dir.mkdir(parents=True)
            for source in RECEIVER.glob("*.py"):
                (receiver_dir / source.name).symlink_to(source)
            db_path = data_dir / "metrics.db"
            base.build_fixture(db_path, server, days=2)
            tile_path = "/api/v2/tiles/supply-demand.demand/1d/1735689600/native"

            observations = []
            for _run in range(2):
                port = free_port()
                env = {
                    **os.environ,
                    "HOST": "127.0.0.1",
                    "PORT": str(port),
                    "PYTHONDONTWRITEBYTECODE": "1",
                }
                process = subprocess.Popen(
                    [sys.executable, "-B", str(receiver_dir / "server.py")],
                    cwd=receiver_dir,
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    deadline = time.monotonic() + 10
                    while True:
                        try:
                            status, _headers, _body = get(port, "/api/status")
                            if status == 200:
                                break
                        except OSError:
                            pass
                        if time.monotonic() >= deadline:
                            raise RuntimeError("receiver subprocess did not start")
                        time.sleep(0.02)
                    status, headers, body = get(port, tile_path)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["X-ERCOT-Cache"], "MISS")
                    status, _headers, status_body = get(port, "/api/status")
                    self.assertEqual(status, 200)
                    metrics = json.loads(status_body)["cache_metrics"]
                    self.assertEqual(metrics["tile_sqlite_generations_total"], 1)
                    observations.append((body, headers["ETag"]))
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)

            self.assertEqual(observations[0], observations[1])
            conn = sqlite3.connect(db_path)
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_schema WHERE type = 'table'"
                )
            }
            conn.close()
            self.assertNotIn("tile_resources", tables)
            artifacts = {
                path.relative_to(receiver_dir).as_posix()
                for path in receiver_dir.rglob("*")
                if path.is_file() and not path.is_symlink()
            }
            self.assertEqual(artifacts, {"data/metrics.db"})


if __name__ == "__main__":
    unittest.main()
