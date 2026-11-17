import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "session_titles", Path(__file__).resolve().parents[1] / "mods/magpie-route/session-titles.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class SessionTitlesTests(unittest.TestCase):
    def test_exact_read_only_lookup_and_bounded_titles(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "history.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT NOT NULL)")
                connection.executemany("INSERT INTO session_titles VALUES (?, ?)", [
                    ("wanted", "标题" * 400), ("other", "Must not appear"),
                    ("id' OR 1=1 --", "Exact quoted ID"),
                ])
            original = database.read_bytes()
            titles = helper.read_titles(["wanted", "id' OR 1=1 --", "missing"], database)
            self.assertEqual({row["session"] for row in titles}, {"wanted", "id' OR 1=1 --"})
            self.assertEqual(next(row["title"] for row in titles if row["session"] == "wanted"), ("标题" * 400)[:512])
            self.assertEqual(database.read_bytes(), original)

    def test_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "missing.db"
            self.assertEqual(helper.read_titles(["session"], database), [])
            self.assertFalse(database.exists())


if __name__ == "__main__":
    unittest.main()
