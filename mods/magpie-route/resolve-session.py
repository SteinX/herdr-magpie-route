#!/usr/bin/env python3
"""Resolve one local terminal to the session its foreground OMP has open."""

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


HC = shutil.which("hc") or Path.home() / ".local/bin/hc"
SESSION_ROOT = Path.home() / ".omp/agent/sessions"
HEADER_BYTES = 16 * 1024
HEADER_LINES = 4
CALL_TIMEOUT = 1.2
TOTAL_TIMEOUT = 4.2


class Unavailable(Exception):
    def __init__(self, reason, diagnostic):
        super().__init__(diagnostic)
        self.reason = reason
        self.diagnostic = diagnostic


def run(command, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise Unavailable("system.lookupTimedOut", "lookup timed out")
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=min(CALL_TIMEOUT, remaining),
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        raise Unavailable("system.lookupTimedOut", "lookup timed out") from None
    except OSError:
        raise Unavailable("system.lookupUnavailable", "lookup command unavailable") from None
    return completed


def terminal_state(terminal, deadline):
    completed = run([str(HC), "get", "--json", terminal], deadline)
    if completed.returncode != 0:
        raise Unavailable("system.terminalUnavailable", "terminal unavailable")
    try:
        record = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise Unavailable("system.invalidTerminal", "invalid terminal response") from None
    if not isinstance(record, dict) or record.get("address") != terminal:
        raise Unavailable("system.noLocalTerminal", "terminal identity unavailable")
    return record


def pi_entry(argument):
    if not isinstance(argument, str) or not argument.startswith("/"):
        return False
    path = Path(argument)
    try:
        path = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return False
    return (
        "pi-coding-agent" in path.parts
        and path.name in {"cli.js", "cli.mjs", "cli.cjs", "cli.ts", "omp", "pi"}
    )


def foreground_is_omp(record):
    foreground = record.get("foreground")
    if record.get("state") != "live" or not isinstance(foreground, dict):
        return False
    pid = foreground.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    status = record.get("status")
    if isinstance(status, dict) and status.get("app") == "omp":
        return True
    argv = foreground.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        return False
    if pi_entry(argv[0]):
        return True
    interpreter = Path(argv[0]).name
    if interpreter not in {"node", "nodejs", "bun"}:
        return False
    arguments = iter(argv[1:])
    for argument in arguments:
        if argument == "--":
            return pi_entry(next(arguments, None))
        if argument in {"-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"}:
            return False
        if argument.startswith("-"):
            continue
        if interpreter == "bun" and argument == "run":
            return pi_entry(next(arguments, None))
        return pi_entry(argument)
    return False


def fingerprint(record):
    foreground = record.get("foreground") or {}
    return (
        record.get("address"),
        record.get("created_ms"),
        foreground.get("pid"),
        foreground.get("argv"),
    )


def open_sessions(lsof, pid, root, deadline):
    # This is an FD inventory for this exact foreground process, never a scan
    # of the session directory or a guess based on cwd, argv, or file age.
    completed = run([lsof, "-n", "-P", "-p", str(pid), "-Fn"], deadline)
    if completed.returncode not in (0, 1):
        raise Unavailable("system.openFilesUnavailable", "open files unavailable")
    if completed.returncode == 1 and completed.stdout.strip():
        raise Unavailable("system.openFilesUnavailable", "incomplete open file inventory")
    candidates = set()
    reported_pid = None
    for line in completed.stdout.splitlines():
        if line.startswith("p"):
            try:
                reported_pid = int(line[1:])
            except ValueError:
                reported_pid = None
        if reported_pid != pid or not line.startswith("n/"):
            continue
        path = Path(line[1:])
        if path.suffix != ".jsonl":
            continue
        try:
            path = path.resolve(strict=True)
            path.relative_to(root)
        except (OSError, RuntimeError, ValueError):
            continue
        if path.is_file():
            candidates.add(path)
    return candidates


def session_header(path):
    # OMP may reserve a title record before its session header. Only consume
    # bounded leading metadata, stopping at the header or any body record.
    remaining = HEADER_BYTES
    try:
        with path.open("rb", buffering=0) as stream:
            for _ in range(HEADER_LINES):
                line = stream.readline(remaining)
                remaining -= len(line)
                if not line or (remaining == 0 and not line.endswith(b"\n")):
                    break
                if not line.strip():
                    continue
                try:
                    header = json.loads(line)
                except (ValueError, UnicodeError):
                    break
                if not isinstance(header, dict):
                    break
                if header.get("type") == "session":
                    session = header.get("id")
                    if isinstance(session, str) and session and session == session.strip():
                        return header
                    break
                if header.get("type") != "title" or remaining == 0:
                    break
    except OSError:
        raise Unavailable("system.sessionHeaderUnavailable", "session header unavailable") from None
    return None


def root_sessions(paths):
    headers = {path: session_header(path) for path in paths}
    roots = dict(headers)
    for path, header in headers.items():
        parent = header.get("parentSession") if header is not None else None
        if not isinstance(parent, str) or not Path(parent).is_absolute():
            continue
        try:
            parent_path = Path(parent).resolve(strict=True)
            if parent_path not in headers or headers[parent_path] is None:
                continue
            # OMP task/executor.ts places task logs inside the parent session's
            # artifacts directory (session-manager.ts: JSONL without suffix).
            # A fork may also have parentSession, but is a sibling, not a child.
            path.relative_to(parent_path.with_suffix(""))
        except (OSError, RuntimeError, ValueError):
            continue
        del roots[path]
    return roots


def resolve(terminal, result, deadline):
    first = terminal_state(terminal, deadline)
    if not foreground_is_omp(first):
        result["reason"] = "system.noForegroundSession"
        return
    foreground = first["foreground"]
    result["pid"] = foreground["pid"]
    result["cwd"] = foreground.get("cwd") if isinstance(foreground.get("cwd"), str) else None
    lsof = shutil.which("lsof")
    if lsof is None:
        # GUI applications commonly have a smaller PATH than login shells.
        lsof = "/usr/sbin/lsof" if Path("/usr/sbin/lsof").is_file() else None
    if lsof is None:
        raise Unavailable("system.openFileToolUnavailable", "open file tool unavailable")
    try:
        root = SESSION_ROOT.resolve(strict=True)
    except (OSError, RuntimeError):
        raise Unavailable("system.awaitingRequest", "session root unavailable") from None
    candidates = root_sessions(open_sessions(lsof, foreground["pid"], root, deadline))
    session = None
    if not candidates:
        result["reason"] = "system.awaitingRequest"
    elif len(candidates) != 1:
        result["reason"] = "system.multipleSessions"
    else:
        header = next(iter(candidates.values()))
        session = header["id"] if header is not None else None
        if session is None:
            result["reason"] = "system.sessionUnconfirmed"
        elif root_sessions(open_sessions(lsof, foreground["pid"], root, deadline)) != candidates:
            session = None
            result["reason"] = "system.sessionSwitching"
    # Never publish an ID after a foreground replacement. Recheck both native
    # OMP identity and process metadata, as well as the open FD set above.
    last = terminal_state(terminal, deadline)
    if not foreground_is_omp(last) or fingerprint(last) != fingerprint(first):
        result.update(pid=None, cwd=None, reason="system.sessionSwitching")
        return
    result["session"] = session


def main():
    terminal = sys.argv[1] if len(sys.argv) > 1 else ""
    result = {"terminal": terminal, "session": None, "pid": None, "cwd": None}
    try:
        if len(sys.argv) != 2 or re.fullmatch(r"t[0-9a-z]+", terminal) is None:
            raise Unavailable("system.noLocalTerminal", "expected one local terminal ID")
        resolve(terminal, result, time.monotonic() + TOTAL_TIMEOUT)
    except Unavailable as error:
        result.update(session=None, pid=None, cwd=None, reason=error.reason)
        print("resolve-session: " + error.diagnostic, file=sys.stderr)
    except Exception:
        result.update(session=None, pid=None, cwd=None, reason="system.lookupUnavailable")
        print("resolve-session: lookup unavailable", file=sys.stderr)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
