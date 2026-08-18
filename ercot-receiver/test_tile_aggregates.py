#!/usr/bin/env python3

import importlib.util
import json
import math
from pathlib import Path
import random
import sys
import unittest


MODULE_PATH = Path(__file__).with_name("tile_aggregates.py")
SPEC = importlib.util.spec_from_file_location("tile_aggregates", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
aggregates = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = aggregates
SPEC.loader.exec_module(aggregates)


class AggregateAlgebraTests(unittest.TestCase):
    def assert_aggregate_close(self, left, right):
        self.assertEqual(left.count, right.count)
        for field in (
            "minimum_ts",
            "maximum_ts",
            "first_ts",
            "first_ordinal",
            "last_ts",
            "last_ordinal",
        ):
            self.assertEqual(getattr(left, field), getattr(right, field), field)
        for field in (
            "value_sum",
            "minimum",
            "maximum",
            "first_value",
            "last_value",
            "integral_value_seconds",
        ):
            actual = getattr(left, field)
            expected = getattr(right, field)
            if actual is None or expected is None:
                self.assertIs(actual, expected, field)
            else:
                self.assertTrue(
                    math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9),
                    f"{field}: {actual!r} != {expected!r}",
                )

    def test_stepwise_irregular_negative_and_energy(self):
        state = aggregates.aggregate_points([(0, -2), (7, 4), (10, 1)])
        generic = aggregates.finalize_aggregate(state)
        self.assertNotIn("energy_mwh", generic)
        result = aggregates.finalize_aggregate(state, power=True)
        self.assertEqual(-2 * 7 + 4 * 3, result["integral_value_seconds"])
        self.assertEqual((-2 * 7 + 4 * 3) / 3600, result["energy_mwh"])
        self.assertEqual({"ts": 0, "value": -2.0}, result["first"])
        self.assertEqual({"ts": 10, "value": 1.0}, result["last"])

    def test_missing_empty_extrema_and_equal_timestamp_ties(self):
        empty = aggregates.aggregate_points([None, (1, None)])
        self.assertEqual(0, empty.count)
        self.assertIsNone(aggregates.finalize_aggregate(empty, power=True)["energy_mwh"])
        singleton = aggregates.aggregate_points([(1, 9)])
        self.assertIsNone(
            aggregates.finalize_aggregate(singleton, power=True)["energy_mwh"]
        )
        state = aggregates.aggregate_points(
            [(20, 8), (10, 8), (10, 2), (10, 5), (30, 2)]
        )
        self.assertEqual((10, 8.0), (state.first_ts, state.first_value))
        self.assertEqual((30, 2.0), (state.last_ts, state.last_value))
        self.assertEqual(10, state.minimum_ts)
        self.assertEqual(10, state.maximum_ts)
        self.assertEqual(5 * 10 + 8 * 10, state.integral_value_seconds)

    def test_equal_timestamp_order_preserves_db_order_and_left_step_bridge(self):
        state = aggregates.aggregate_points([(10, 8), (10, 2), (20, 4)])

        self.assertEqual((10, 8.0), (state.first_ts, state.first_value))
        self.assertEqual((20, 4.0), (state.last_ts, state.last_value))
        self.assertEqual((0, 0), (state.first_ordinal, state.last_ordinal))
        self.assertEqual(20.0, state.integral_value_seconds)

    def test_boundary_bridge_and_reversed_fragment_arguments(self):
        left = aggregates.aggregate_points([(0, 3), (5, 4)])
        right = aggregates.aggregate_points([(9, -1), (12, 2)])
        direct = aggregates.aggregate_points([(0, 3), (5, 4), (9, -1), (12, 2)])
        self.assert_aggregate_close(direct, aggregates.merge_aggregates(left, right))
        self.assert_aggregate_close(direct, aggregates.merge_aggregates(right, left))
        self.assertEqual(4 * (9 - 5), direct.integral_value_seconds - 3 * 5 - (-1) * 3)

    def test_overlap_is_rejected(self):
        left = aggregates.aggregate_points([(0, 1), (10, 2)])
        overlapping = aggregates.aggregate_points([(5, 3), (15, 4)])
        with self.assertRaisesRegex(ValueError, "overlap or interleave"):
            aggregates.merge_aggregates(left, overlapping)

    def test_serialization_is_deterministic_and_round_trips(self):
        state = aggregates.aggregate_points([(4, -1.5), (9, 3.25)])
        encoded = aggregates.serialize_aggregate(state)
        self.assertEqual(encoded, aggregates.serialize_aggregate(state))
        self.assert_aggregate_close(state, aggregates.deserialize_aggregate(encoded))
        self.assertTrue(encoded.startswith('{"count":2,'))
        self.assertNotIn("energy_mwh", encoded)

    def test_serialization_canonicalizes_signed_zero(self):
        state = aggregates.aggregate_points([(4, -0.0)])
        self.assertEqual(1.0, math.copysign(1.0, state.first_value))
        encoded = aggregates.serialize_aggregate(state)
        self.assertNotIn("-0.0", encoded)
        restored = aggregates.deserialize_aggregate(
            encoded.replace('"value_sum":0.0', '"value_sum":-0.0').replace(
                '"integral_value_seconds":0.0', '"integral_value_seconds":-0.0'
            )
        )
        self.assertNotIn("-0.0", aggregates.serialize_aggregate(restored))

    def test_serialization_rejects_missing_or_invalid_tie_ordinals(self):
        payload = json.loads(
            aggregates.serialize_aggregate(aggregates.aggregate_points([(1, 2)]))
        )
        del payload["first_ordinal"]
        with self.assertRaises(KeyError):
            aggregates.deserialize_aggregate(payload)
        payload = json.loads(
            aggregates.serialize_aggregate(aggregates.aggregate_points([(1, 2)]))
        )
        payload["last_ordinal"] = -1
        with self.assertRaisesRegex(ValueError, "ordinal"):
            aggregates.deserialize_aggregate(payload)
        for invalid in (True, 1.5, "1"):
            payload = json.loads(
                aggregates.serialize_aggregate(aggregates.aggregate_points([(1, 2)]))
            )
            payload["first_ordinal"] = invalid
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "ordinal"):
                    aggregates.deserialize_aggregate(payload)

    def test_duplicate_explicit_timestamp_ordinal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate point"):
            aggregates.aggregate_points([(10, 8, 0), (10, 2, 0)])

    def test_randomized_direct_merge_and_associativity(self):
        # Floating reductions may regroup operands. The tolerance is 1e-12
        # relative / 1e-9 absolute; all discrete fields remain exact.
        generator = random.Random(0xEAC05)
        for _case in range(300):
            count = generator.randint(1, 80)
            timestamp = generator.randint(-10_000, 10_000)
            points = []
            for ordinal in range(count):
                timestamp += generator.choice((0, 1, 2, 7, 60, 300))
                value = generator.uniform(-20_000, 20_000)
                points.append((timestamp, value, ordinal))
            cut_a = generator.randint(0, count)
            cut_b = generator.randint(cut_a, count)
            parts = [
                aggregates.aggregate_points(points[:cut_a]),
                aggregates.aggregate_points(points[cut_a:cut_b]),
                aggregates.aggregate_points(points[cut_b:]),
            ]
            direct = aggregates.aggregate_points(points)
            merged = aggregates.merge_aggregates(*parts)
            left_associative = aggregates.merge_aggregates(
                aggregates.merge_aggregates(parts[0], parts[1]), parts[2]
            )
            right_associative = aggregates.merge_aggregates(
                parts[0], aggregates.merge_aggregates(parts[1], parts[2])
            )
            self.assert_aggregate_close(direct, merged)
            self.assert_aggregate_close(direct, left_associative)
            self.assert_aggregate_close(direct, right_associative)
            direct_energy = aggregates.finalize_aggregate(direct, power=True)["energy_mwh"]
            merged_energy = aggregates.finalize_aggregate(merged, power=True)["energy_mwh"]
            if direct_energy is None:
                self.assertIsNone(merged_energy)
            else:
                self.assertTrue(
                    math.isclose(
                        direct_energy,
                        merged_energy,
                        rel_tol=1e-12,
                        abs_tol=1e-12,
                    )
                )


if __name__ == "__main__":
    unittest.main()
