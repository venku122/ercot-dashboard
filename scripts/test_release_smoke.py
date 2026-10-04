import unittest
from release_smoke import read_url_allowed


class ReleaseSmokeSafety(unittest.TestCase):
    def test_public_read_paths_are_explicit(self):
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/status', production=True))
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/v1/source-health', production=True))
        self.assertTrue(read_url_allowed('https://ercot.tarazevits.io/api/series?metric=ercot.pricing&since=1&until=2&max_points=3', production=True))

    def test_no_writes_unknown_hosts_credentials_or_ambiguous_paths(self):
        for url in ['https://ercot.tarazevits.io/ingest', 'https://ercot.tarazevits.io/api/admin', 'https://other.example/api/status', 'http://ercot.tarazevits.io/api/status', 'https://x:y@ercot.tarazevits.io/api/status', 'https://ercot.tarazevits.io/api/%73tatus', 'https://ercot.tarazevits.io/api/status?reset=1', 'https://ercot.tarazevits.io:444/api/status']:
            with self.subTest(url=url):
                self.assertFalse(read_url_allowed(url, production=True))

    def test_local_fixture_mode_rejects_remote_hosts(self):
        self.assertTrue(read_url_allowed('http://127.0.0.1:4303/api/status', production=False))
        self.assertFalse(read_url_allowed('http://192.168.1.1/api/status', production=False))

    def test_history_is_bounded_before_network(self):
        for query in ['metric=ercot.pricing', 'metric=x&since=1&until=9999999999&max_points=3', 'metric=x&since=2&until=1&max_points=3', 'metric=x&since=1&until=2&max_points=99999', 'metric=x&since=1&until=2&max_points=3&unknown=1']:
            self.assertFalse(read_url_allowed('https://ercot.tarazevits.io/api/series?'+query, production=True))
