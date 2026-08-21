#!/usr/bin/env python3

import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("series_migration.py")
SPEC = importlib.util.spec_from_file_location("series_migration", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def create_legacy(path: Path, count: int = 7) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        PRAGMA user_version=17;
        CREATE TABLE metrics(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          ts INTEGER NOT NULL,
          value REAL NOT NULL,
          interval INTEGER,
          metric_type TEXT,
          tags TEXT,
          dedupe_key TEXT);
        CREATE TABLE metric_tags(metric_id INTEGER NOT NULL,tag TEXT NOT NULL);
        CREATE TABLE preserved_fixture(value TEXT NOT NULL);
        INSERT INTO preserved_fixture VALUES('keep-me');
        """
    )
    for index in range(count):
        tags = ["source:fixture", f"zone:{index % 2}"]
        cursor = conn.execute(
            "INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags,dedupe_key) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                "ercot.fixture.mw",
                1_700_000_000 + index * 60,
                float(index) - 2.5,
                60,
                "gauge",
                json.dumps(list(reversed(tags))),
                f"fixture:{index}",
            ),
        )
        conn.executemany(
            "INSERT INTO metric_tags(metric_id,tag) VALUES(?,?)",
            [(cursor.lastrowid, tag) for tag in tags],
        )
    conn.commit()
    conn.close()


class OfflineSeriesMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="series-migration-")
        self.addCleanup(self.tempdir.cleanup)
        self.path = Path(self.tempdir.name) / "working-copy.db"
        create_legacy(self.path)
        self.server = migration._load_server(migration.DEFAULT_SERVER)

    def test_status_is_read_only_and_reports_remaining_work(self):
        before = file_hash(self.path)
        report = migration.status_report(self.path, self.server, batch_size=3)
        self.assertEqual(before, file_hash(self.path))
        self.assertTrue(report["read_only"])
        self.assertEqual(17, report["schema_version"])
        self.assertEqual(7, report["normalized_series"]["unassigned_series_id_rows"])
        self.assertEqual(3, report["normalized_series"]["estimated_remaining_batches"])
        self.assertFalse(report["normalized_series"]["ready"])

    def test_bounded_resume_then_complete_and_verify(self):
        first = migration.migrate(
            self.path,
            self.server,
            batch_size=2,
            complete=True,
            verify=False,
            max_batches=1,
        )
        self.assertEqual(2, first["migrated_rows"])
        partial = migration.status_report(self.path, self.server, batch_size=2)
        self.assertEqual(5, partial["normalized_series"]["unassigned_series_id_rows"])
        completed = migration.migrate(
            self.path,
            self.server,
            batch_size=2,
            complete=True,
            verify=True,
            max_batches=None,
        )
        self.assertEqual(5, completed["migrated_rows"])
        self.assertGreaterEqual(
            completed["peak_files"]["main"], completed["files_before"]["main"]
        )
        self.assertTrue(completed["verification"]["passed"])
        self.assertTrue(
            all(completed["verification"]["checks"].values()),
            completed["verification"],
        )
        conn = sqlite3.connect(self.path)
        try:
            self.assertEqual(
                "keep-me", conn.execute("SELECT value FROM preserved_fixture").fetchone()[0]
            )
            self.assertEqual(0, conn.execute("SELECT COUNT(*) FROM metrics WHERE series_id IS NULL").fetchone()[0])
        finally:
            conn.close()

    def test_complete_replay_is_idempotent(self):
        migration.migrate(
            self.path,
            self.server,
            batch_size=10,
            complete=True,
            verify=True,
            max_batches=None,
        )
        before = file_hash(self.path)
        replay = migration.migrate(
            self.path,
            self.server,
            batch_size=10,
            complete=True,
            verify=True,
            max_batches=None,
        )
        self.assertEqual(0, replay["migrated_rows"])
        self.assertEqual(before, file_hash(self.path))


if __name__ == "__main__":
    unittest.main()
