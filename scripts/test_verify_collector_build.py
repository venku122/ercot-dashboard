import pathlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("verify_collector_build.py")
IMAGE = "ghcr.io/venku122/ercot-collector"


class CollectorBuildGateTests(unittest.TestCase):
    def run_gate(self, result, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--result", result, *args],
            capture_output=True,
            text=True,
        )

    def test_successful_architecture_matrix_passes_gate(self):
        result = self.run_gate("success")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_failed_cancelled_or_skipped_matrix_blocks_release(self):
        for state in ("failure", "cancelled", "skipped", "", "unknown"):
            with self.subTest(state=state):
                result = self.run_gate(state)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Both native architecture builds must succeed", result.stderr)

    def test_manifest_inputs_require_both_valid_architecture_digests(self):
        with tempfile.TemporaryDirectory() as directory:
            digests = pathlib.Path(directory)
            (digests / "amd64.txt").write_text("sha256:" + "a" * 64 + "\n")
            (digests / "arm64.txt").write_text("sha256:" + "b" * 64 + "\n")
            result = self.run_gate("success", "--digests", directory, "--image", IMAGE)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                result.stdout.splitlines(),
                [IMAGE + "@sha256:" + "a" * 64, IMAGE + "@sha256:" + "b" * 64],
            )

    def test_missing_architecture_never_produces_manifest_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            (pathlib.Path(directory) / "amd64.txt").write_text("sha256:" + "a" * 64)
            result = self.run_gate("success", "--digests", directory, "--image", IMAGE)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_malformed_digest_never_produces_partial_manifest_inputs(self):
        for bad_digest in ("", "sha256:short", "sha256:" + "B" * 64, "sha256:" + "b" * 64 + "\nother"):
            with self.subTest(digest=bad_digest), tempfile.TemporaryDirectory() as directory:
                digests = pathlib.Path(directory)
                (digests / "amd64.txt").write_text("sha256:" + "a" * 64)
                (digests / "arm64.txt").write_text(bad_digest)
                result = self.run_gate("success", "--digests", directory, "--image", IMAGE)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_failed_matrix_cannot_publish_even_with_valid_digests(self):
        with tempfile.TemporaryDirectory() as directory:
            digests = pathlib.Path(directory)
            for arch in ("amd64", "arm64"):
                (digests / f"{arch}.txt").write_text("sha256:" + "a" * 64)
            result = self.run_gate("failure", "--digests", directory, "--image", IMAGE)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")

    def test_missing_image_rejects_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_gate("success", "--digests", directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
