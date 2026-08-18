import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SCRIPT = ROOT / "scripts" / "benchmark_v2_tiles.py"
SERVER = ROOT / "ercot-receiver" / "server.py"


def load_module():
    spec = importlib.util.spec_from_file_location("benchmark_v2_tiles_test_module", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load benchmark module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = load_module()


class V2TileBenchmarkTests(unittest.TestCase):
    def test_cardinality_plans_are_deterministic_and_v2_reuses_urls(self):
        server = benchmark.load_server(SERVER)
        end = benchmark.START + 367 * benchmark.DAY
        planned = benchmark.frontend_v2_plans(server, end)
        v1 = [url for _label, span in benchmark.WINDOWS for url in benchmark.v1_urls(end, span)]
        v2 = [url for label, _span in benchmark.WINDOWS for url in planned["windows"][label]]
        self.assertEqual(v1, [url for _label, span in benchmark.WINDOWS for url in benchmark.v1_urls(end, span)])
        self.assertEqual(planned, benchmark.frontend_v2_plans(server, end))
        self.assertEqual(
            planned["planner_module"], "frontend/src/dashboard/tile-planner.ts"
        )
        self.assertEqual(planned["correction_horizon_seconds"], benchmark.DAY)
        self.assertTrue(planned["default_matches_explicit_horizon"])
        self.assertEqual(
            planned["supported_lods"],
            server.TILE_CATALOG_BY_KEY[benchmark.SERIES_KEY]["supported_lods"],
        )
        self.assertLess(len(set(v2)), len(set(v1)))
        self.assertEqual((len(v1), len(set(v1))), (494, 494))
        self.assertEqual((len(v2), len(set(v2))), (500, 374))
        self.assertTrue(all(url.startswith("/api/v2/tiles/") and "?" not in url for url in v2))
        self.assertIn("resolution=504", "\n".join(v1))
        self.assertNotIn("resolution=504", "\n".join(v2))

    def test_real_handler_cold_warm_and_singleflight_evidence(self):
        evidence = benchmark.run(SERVER, days=2)
        self.assertTrue(
            evidence["contract"][
                "frontend_planner_default_matches_explicit_horizon"
            ]
        )
        self.assertEqual(
            evidence["cardinality"]["v1_contract"],
            "faithful independently frozen v1 baseline",
        )
        self.assertEqual(list(evidence["windows"]), ["6h", "24h"])
        for window in evidence["windows"].values():
            self.assertEqual(window["cold"]["cache_headers"], ["MISS"])
            self.assertEqual(window["warm"]["cache_headers"], ["HIT"])
            self.assertEqual(
                window["cold"]["tile_sqlite_generations_total"], window["requests"]
            )
            self.assertEqual(
                window["cold"]["tile_sqlite_generation_attempts_total"],
                window["requests"],
            )
            self.assertEqual(window["warm"]["tile_sqlite_generations_total"], 0)
            self.assertEqual(
                window["cold"]["tile_receiver_lru_misses_total"], window["requests"]
            )
            self.assertEqual(
                window["warm"]["tile_receiver_lru_hits_total"], window["requests"]
            )
            self.assertEqual(
                window["cold"]["tile_origin_requests_total"], window["requests"]
            )
            self.assertEqual(
                window["warm"]["tile_origin_requests_total"], window["requests"]
            )
            self.assertEqual(
                window["cold"]["tile_generation_latency_seconds_count"],
                window["requests"],
            )
            self.assertGreaterEqual(
                window["cold"]["tile_generation_latency_seconds_sum"], 0
            )
            self.assertGreaterEqual(
                window["cold"]["tile_generation_latency_seconds_max"], 0
            )
            self.assertEqual(
                window["cold"]["sqlite_execute_fetch_count"],
                window["requests"] * 3,
            )
            self.assertEqual(window["warm"]["sqlite_execute_fetch_count"], 0)
            self.assertGreater(window["response_bytes"]["cold"], 0)
            self.assertTrue(window["raw_bodies_equal"])
            self.assertEqual(
                window["response_bytes"]["cold"], window["response_bytes"]["warm"]
            )
            self.assertEqual(
                window["frontend_proxies"]["cold"]["checksum"],
                window["frontend_proxies"]["warm"]["checksum"],
            )
        self.assertEqual(evidence["singleflight"]["statuses"], [200])
        self.assertEqual(evidence["singleflight"]["clients"], 10)
        self.assertEqual(evidence["singleflight"]["tile_sqlite_generations_total"], 1)
        self.assertEqual(
            evidence["singleflight"]["tile_sqlite_generation_attempts_total"], 1
        )
        self.assertEqual(evidence["singleflight"]["leader_responses"], 1)
        self.assertEqual(evidence["singleflight"]["shared_responses"], 9)
        self.assertEqual(
            evidence["singleflight"]["tile_singleflight_waits_total"],
            evidence["singleflight"]["shared_responses"],
        )


if __name__ == "__main__":
    unittest.main()
