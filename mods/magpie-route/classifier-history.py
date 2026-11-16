#!/usr/bin/env python3
"""Reduce bounded Magpie routing history to classifier metadata, never chat history."""

import gzip
import json
import math
import re
import sys
import time
from datetime import datetime
from pathlib import Path

MAX_BYTES = 32 * 1024 * 1024
MAX_LINE = 1024 * 1024
MAX_FILES = 32
MAX_RECORDS = 256
BLOCK = 64 * 1024
DAY_FILE = re.compile(r"(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl(\.gz)?\Z")


class LimitReached(Exception):
    pass


class Budget:
    def __init__(self):
        self.left = MAX_BYTES
        self.deadline = time.monotonic() + 4
        self.partial = False

    def size(self, wanted):
        if self.left <= 0 or time.monotonic() >= self.deadline:
            self.partial = True
            raise LimitReached()
        return min(wanted, self.left)


def reverse_lines(path, budget):
    # Read plain files from the tail, including numbered parts of a busy day.
    with path.open("rb") as source:
        source.seek(0, 2)
        position = source.tell()
        pending = b""
        dropping = False
        while position:
            size = budget.size(min(BLOCK, position))
            position -= size
            source.seek(position)
            block = source.read(size)
            budget.left -= len(block)
            lines = (block + pending).split(b"\n")
            pending = lines[0]
            for line in reversed(lines[1:]):
                if dropping:
                    dropping = False
                elif len(line) <= MAX_LINE:
                    yield line
                else:
                    budget.partial = True
            if len(pending) > MAX_LINE:
                pending = b""
                dropping = True
                budget.partial = True
        if pending and not dropping:
            yield pending


def compressed_lines(path, budget):
    # Cap decompressed bytes as well: a compressed day may be very large.
    with gzip.open(path, "rb") as source:
        dropping = False
        while True:
            size = budget.size(MAX_LINE + 1)
            line = source.readline(size)
            budget.left -= len(line)
            if not line:
                return
            complete = line.endswith(b"\n") or len(line) < size
            if dropping or len(line) > MAX_LINE or not complete:
                budget.partial = True
                dropping = not complete
                continue
            yield line


def text(value):
    return value if isinstance(value, str) else ""


def group_of(route):
    asked = text(route.get("model")).strip()
    if asked.startswith(("group/", "auto/")):
        return asked
    group = route.get("group")
    if not isinstance(group, dict):
        return ""
    value = next((text(group.get(key)).strip() for key in ("ref", "id", "name") if text(group.get(key)).strip()), "")
    return value if not value or value.startswith(("group/", "auto/")) else "group/" + value


def classifier_record(line, scope, session, group):
    if b'"classified"' not in line:
        return None
    route = json.loads(line)
    if not isinstance(route, dict):
        return None
    owner = text(route.get("session"))
    route_group = group_of(route)
    if not owner or not route_group or scope == "session" and owner != session or group != "all" and route_group != group:
        return None
    rule = route.get("rule")
    if not isinstance(rule, dict) or rule.get("held") or rule.get("waits"):
        return None
    classified = rule.get("classified")
    if not isinstance(classified, dict) or classified.get("error"):
        return None
    route_id = route.get("id")
    if not isinstance(route_id, int) or isinstance(route_id, bool) or not 0 <= route_id <= 9007199254740991:
        return None
    started = text(route.get("time"))
    stamp = datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp()
    if not math.isfinite(stamp):
        return None
    metadata = {key: text(classified.get(key))[:256] for key in (
        "by", "intent", "after", "effort", "above", "fallback", "afterEffort"
    )}
    intents = classified.get("intents")
    metadata["intents"] = [value[:256] for value in intents[:32] if isinstance(value, str)] if isinstance(intents, list) else []
    for key, maximum in (("score", 3), ("sure", 1), ("ms", float("inf"))):
        value = classified.get(key)
        metadata[key] = value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= maximum else None
    metadata.update(cached=classified.get("cached") is True, failed=False)
    return stamp, {"id": route_id, "time": started, "session": owner, "group": route_group, "classifier": metadata}


def collect(scope, session, group, result):
    # The same config path as main.js; Magpie data move leaves this path as a symlink.
    root = Path.home() / ".config" / "magpie" / "routing"
    budget = Budget()
    files = []
    try:
        for index, path in enumerate(root.iterdir()):
            if index >= 4096:
                budget.partial = True
                break
            match = DAY_FILE.fullmatch(path.name)
            if match and not path.is_symlink() and path.is_file():
                files.append(((match[1], int(match[2] or 0), bool(match[3])), path))
    except OSError:
        result["unavailable"] = True
        return
    files.sort(reverse=True)
    if len(files) > MAX_FILES:
        budget.partial = True
    records = {}
    for _, path in files[:MAX_FILES]:
        try:
            lines = compressed_lines(path, budget) if path.suffix == ".gz" else reverse_lines(path, budget)
            for line in lines:
                if time.monotonic() >= budget.deadline:
                    raise LimitReached()
                try:
                    record = classifier_record(line, scope, session, group)
                except (ValueError, TypeError, OverflowError, RecursionError):
                    budget.partial = True
                    continue
                if record is not None:
                    stamp, value = record
                    identity = (value["session"], value["group"], value["time"], value["id"])
                    records[identity] = (stamp, value)
                    if len(records) > MAX_RECORDS * 2:
                        records = dict(sorted(records.items(), key=lambda item: (item[1][0], item[1][1]["id"]), reverse=True)[:MAX_RECORDS])
        except LimitReached:
            budget.partial = True
            break
        except (OSError, EOFError):
            budget.partial = True
    result["records"] = [value for _, value in sorted(records.values(), key=lambda item: (item[0], item[1]["id"]), reverse=True)[:MAX_RECORDS]]
    result["partial"] = budget.partial


def main():
    scope, session, group = sys.argv[1:] if len(sys.argv) == 4 else ("", "", "")
    result = {"scope": scope, "session": session, "group": group, "records": [], "partial": False, "unavailable": False}
    try:
        if scope not in {"session", "all"} or scope == "session" and not session or not group:
            raise ValueError()
        collect(scope, session, group, result)
    except Exception:
        result["unavailable"] = True
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
