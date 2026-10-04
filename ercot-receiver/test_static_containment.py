"""Raw HTTP requests prove static serving stays inside the actual web root."""

from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "ercot_static_containment_server", Path(__file__).with_name("server.py")
)
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class StaticContainmentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.web = root / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("LOCAL_INDEX")
        (self.web / "assets").mkdir()
        (self.web / "assets" / "app.js").write_text("LOCAL_ASSET")
        self.outside = root / "outside"
        self.outside.mkdir()
        (self.outside / "proof.txt").write_text("OUTSIDE_WEB_ROOT")
        self.sibling = root / "web-private"
        self.sibling.mkdir()
        (self.sibling / "proof.txt").write_text("SIBLING_PREFIX_SECRET")
        (self.web / "escape.txt").symlink_to(self.outside / "proof.txt")
        (self.web / "escape-dir").symlink_to(self.outside, target_is_directory=True)
        self.web_patch = mock.patch.object(server, "WEB_DIR", str(self.web))
        self.web_patch.start()
        self.app = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.thread = threading.Thread(
            target=lambda: self.app.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.thread.join(timeout=2)
        self.web_patch.stop()
        self.directory.cleanup()

    def get(self, raw_path):
        connection = HTTPConnection("127.0.0.1", self.app.server_port, timeout=2)
        try:
            # HTTPConnection preserves literal ../; browser URL normalization
            # must not erase the adversarial request before it reaches Handler.
            connection.request("GET", raw_path)
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def test_raw_parent_traversal_is_forbidden(self):
        status, body, _headers = self.get("/../outside/proof.txt")
        self.assertEqual(status, 403)
        self.assertNotIn(b"OUTSIDE_WEB_ROOT", body)

    def test_sibling_prefix_traversal_is_forbidden(self):
        for raw_path in ("/../web-private/proof.txt", "/..//web-private/proof.txt"):
            with self.subTest(raw_path=raw_path):
                status, body, _headers = self.get(raw_path)
                self.assertEqual(status, 403)
                self.assertNotIn(b"SIBLING_PREFIX_SECRET", body)

    def test_symlink_file_and_directory_escape_are_forbidden(self):
        for raw_path in ("/escape.txt", "/escape-dir/proof.txt"):
            with self.subTest(raw_path=raw_path):
                status, body, _headers = self.get(raw_path)
                self.assertEqual(status, 403)
                self.assertNotIn(b"OUTSIDE_WEB_ROOT", body)

    def test_root_and_assets_still_serve_with_existing_cache_semantics(self):
        for raw_path, expected, cache in (
            ("/", b"LOCAL_INDEX", "no-cache"),
            ("/assets/app.js", b"LOCAL_ASSET", "public, max-age=31536000, immutable"),
        ):
            with self.subTest(raw_path=raw_path):
                status, body, headers = self.get(raw_path)
                self.assertEqual((status, body), (200, expected))
                self.assertEqual(headers["Cache-Control"], cache)

    def test_symlinked_web_root_and_internal_asset_remain_supported(self):
        alias = Path(self.directory.name) / "web-alias"
        alias.symlink_to(self.web, target_is_directory=True)
        (self.web / "assets" / "internal.js").symlink_to(self.web / "assets" / "app.js")
        with mock.patch.object(server, "WEB_DIR", str(alias)):
            status, body, _headers = self.get("/assets/internal.js")
            self.assertEqual((status, body), (200, b"LOCAL_ASSET"))


if __name__ == "__main__":
    unittest.main()
