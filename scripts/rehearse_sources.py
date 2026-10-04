"""Run reviewed one-shot public collectors against a disposable local receiver.

Requires prebuilt ercot-receiver:local and ercot-collector:local images. The receiver
mounts candidate code read-only and stores data only in tmpfs. No production env
or container is read/modified. Only each newly named resource is cleaned up.
"""
import argparse
import json
import os
import secrets
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ("nws", "planning", "egrid", "renewables", "regional", "market", "geography")
PATHS = ("source-health", "predictive-weather", "texas-grid", "external-context",
         "net-load", "regional-geography", "market-mechanics", "market-geography")


def get_json(origin, path):
    with urllib.request.urlopen(origin + path, timeout=10) as response:
        body = response.read(16 * 1024 * 1024 + 1)
        if len(body) > 16 * 1024 * 1024:
            raise ValueError("rehearsal_response_too_large")
        return json.loads(body)


def resource_paths(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "url" and isinstance(child, str) and child.startswith("/api/v2/"):
                yield child
            else:
                yield from resource_paths(child)
    elif isinstance(value, list):
        for child in value:
            yield from resource_paths(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", action="append", choices=FAMILIES)
    parser.add_argument("--port", type=int, default=4308)
    parser.add_argument("--browser", action="store_true", help="Run exact live-publication browser checks before cleanup")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("local unprivileged port required")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", args.port))
    output = ROOT / "artifacts/post-release/source-rehearsal"
    output.mkdir(parents=True, exist_ok=True)
    suffix = secrets.token_hex(5)
    network = "ercot-rehearsal-" + suffix
    receiver = network + "-receiver"
    collector = network + "-collector"
    key = secrets.token_urlsafe(32)
    origin = "http://127.0.0.1:" + str(args.port)
    records, responses = [], {}
    subprocess.run(["docker", "network", "create", network], check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run([
            "docker", "run", "-d", "--name", receiver, "--network", network,
            "--network-alias", "receiver", "-p", f"127.0.0.1:{args.port}:8080",
            "-v", str(ROOT / "ercot-receiver") + ":/app:ro", "--tmpfs", "/app/data",
            "-e", "METRICS_API_KEY", "-e", "HOST=0.0.0.0", "ercot-receiver:local",
        ], check=True, env={**os.environ, "METRICS_API_KEY": key}, stdout=subprocess.DEVNULL)
        for _ in range(30):
            try:
                get_json(origin, "/api/status")
                break
            except (OSError, ValueError):
                time.sleep(.2)
        else:
            raise RuntimeError("local_receiver_not_ready")
        for family in args.family or FAMILIES:
            started = time.monotonic()
            command = [
                "docker", "run", "--rm", "--name", collector, "--network", network,
                "--dns", "1.1.1.1", "--entrypoint", "deno",
                "-v", str(ROOT / "ercot-collector") + ":/src/app:ro",
                "-e", "REHEARSAL_RECEIVER_ORIGIN=http://receiver:8080",
                "-e", "REHEARSAL_RECEIVER_KEY", "ercot-collector:local", "run",
                "--allow-net", "--allow-env", "--cached-only", "--no-check",
                "/src/app/rehearse_sources.ts", family,
            ]
            try:
                result = subprocess.run(command, env={**os.environ, "REHEARSAL_RECEIVER_KEY": key},
                                        capture_output=True, text=True, timeout=120)
                (output / f"source-{family}.log").write_text(result.stdout + result.stderr)
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                exit_code = "bounded_timeout"
            finally:
                subprocess.run(["docker", "rm", "-f", collector], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            record = {"family": family, "exit_code": exit_code,
                      "elapsed_seconds": round(time.monotonic() - started, 3),
                      "mode": "ISOLATED_LOCAL_LIVE_SOURCE", "receiver": "loopback/new-tmpfs-db",
                      "production_delivery": False}
            records.append(record)
            print(json.dumps(record), flush=True)
        for family in PATHS:
            path = "/api/v1/" + family
            responses[path] = get_json(origin, path)
        paths = list(dict.fromkeys(path for value in responses.values() for path in resource_paths(value)))
        capture_deadline = time.monotonic() + 60
        captured = 0
        for path in paths[:64]:
            if time.monotonic() >= capture_deadline:
                break
            responses[path] = get_json(origin, path)
            captured += 1
        (output / "capture-budget.json").write_text(json.dumps({"max_immutable_resources": 64, "request_start_window_seconds": 60, "individual_read_timeout_seconds": 10, "captured": captured, "available": len(paths), "truncated": captured < len(paths)}) + "\n")
        (output / "responses.json").write_text(json.dumps(responses, indent=2) + "\n")
        (output / "source-rehearsals.json").write_text(json.dumps(records, indent=2) + "\n")
        if args.browser:
            subprocess.run(["pnpm", "exec", "playwright", "test", "e2e/source-rehearsal.spec.ts", "--project=chromium"],
                           cwd=ROOT, check=True, env={**os.environ, "SOURCE_REHEARSAL_ORIGIN": origin,
                                                     "PLAYWRIGHT_PORT": "4310"})
        if any(row["exit_code"] != 0 for row in records):
            raise RuntimeError("one_or_more_source_rehearsals_failed; see sanitized evidence")
    finally:
        for name in (collector, receiver):
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", network], check=True, stdout=subprocess.DEVNULL)
        print("Created rehearsal resources removed; no background pollers.", flush=True)


if __name__ == "__main__":
    main()
