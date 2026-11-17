#!/usr/bin/env python3
"""Read display titles by exact session ID without opening conversation records."""

import json
import sqlite3
import sys
from pathlib import Path

LIMIT = 256


def read_titles(sessions, database=None):
    if not isinstance(sessions, list) or len(sessions) > LIMIT or any(
        not isinstance(session, str) or not session or len(session) > 256 for session in sessions
    ):
        raise ValueError("invalid session list")
    sessions = list(dict.fromkeys(sessions))
    if not sessions:
        return []
    path = database or Path.home() / ".omp/agent/history.db"
    try:
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2) as connection:
            connection.execute("PRAGMA query_only = ON")
            rows = connection.execute(
                "SELECT session_id, substr(title, 1, 512) FROM session_titles WHERE session_id IN ("
                + ",".join("?" for _ in sessions) + ")", sessions
            ).fetchall()
    except sqlite3.Error:
        return []
    return [{"session": session, "title": " ".join(title.split())[:512]}
            for session, title in rows if isinstance(title, str) and title.strip()]


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError("expected session list")
        titles = read_titles(json.loads(sys.argv[1]))
    except (ValueError, TypeError):
        sys.exit(1)
    print(json.dumps({"titles": titles}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
