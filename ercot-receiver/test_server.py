import importlib.util
from pathlib import Path
import unittest

SERVER_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("ercot_receiver_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SERVER_PATH}")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)

bucket_average = server.bucket_average
seasonal_average = server.seasonal_average
transform_series = server.transform_series


class SeriesTransformTests(unittest.TestCase):
    def test_bucket_average_groups_points_by_bucket(self):
        points = [[0, 10.0], [59, 14.0], [60, 20.0], [119, 28.0]]

        self.assertEqual(bucket_average(points, 60), [[0, 12.0], [60, 24.0]])

    def test_seasonal_average_repeats_average_profile(self):
        points = [
            [0, 10.0],
            [60, 20.0],
            [120, 30.0],
            [180, 40.0],
        ]

        self.assertEqual(
            seasonal_average(points, 120, 60),
            [[0, 20.0], [60, 30.0], [120, 20.0], [180, 30.0]],
        )

    def test_transform_series_prefers_seasonal_bucketing_when_requested(self):
        points = [
            [0, 10.0],
            [60, 20.0],
            [120, 30.0],
            [180, 40.0],
        ]

        self.assertEqual(
            transform_series(points, seasonal_period=120),
            [[0, 20.0], [60, 30.0], [120, 20.0], [180, 30.0]],
        )

    def test_seasonal_average_rejects_invalid_bucket_size(self):
        with self.assertRaises(ValueError):
            seasonal_average([[0, 1.0]], 60, 120)


if __name__ == "__main__":
    _ = unittest.main()
