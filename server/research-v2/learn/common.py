"""Standard-library I/O and resource guards; safe to use before ML dependencies exist."""
import csv
import hashlib
import json
import os
import resource
import signal
import sys
import time
from datetime import datetime, time as daytime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from config import MEMORY_BYTES, WALL_SECONDS


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def id_hash(ids):
    return hashlib.sha256("".join(i + "\n" for i in sorted(ids)).encode()).hexdigest()


def write_json(path, value):
    with open(path, "x", encoding="utf8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write("\n")


def rows(path):
    with open(path, newline="", encoding="utf8") as f:
        yield from csv.DictReader(f)


def write_csv(path, header, values):
    with open(path, "x", newline="", encoding="utf8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(values)


def ct_start(us):
    dt = datetime.fromtimestamp(us // 1_000_000, timezone.utc).astimezone(ZoneInfo("America/Chicago"))
    date = dt.date() if dt.time() >= daytime(17) else dt.date() - timedelta(days=1)
    start = datetime.combine(date, daytime(17), ZoneInfo("America/Chicago"))
    return int(start.timestamp()) * 1_000_000, str(date)


def purge(training, eval_start):
    kept = [r for r in training if int(r["target_end_us"]) <= eval_start]
    assert all(int(r["target_end_us"]) <= eval_start for r in kept)
    return kept, len(training) - len(kept)


def guard(out):
    """Apply limits before importing native ML libraries; always record process resources."""
    os.umask(0o077)
    if os.getpriority(os.PRIO_PROCESS, 0) != 19:
        os.setpriority(os.PRIO_PROCESS, 0, 19)
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_SELF)

    def stop(_signum, _frame):
        raise TimeoutError("30-minute/termination limit reached; no success marker")

    signal.signal(signal.SIGALRM, stop)
    signal.signal(signal.SIGTERM, stop)
    signal.alarm(WALL_SECONDS)

    def finish(error=None):
        signal.alarm(0)
        usage = resource.getrusage(resource.RUSAGE_SELF)
        write_json(out / "resources.json", {
            "success": error is None, "error": None if error is None else str(error),
            "pid": os.getpid(), "python": sys.version, "nice": os.getpriority(os.PRIO_PROCESS, 0),
            "limit_address_space_bytes": MEMORY_BYTES, "wall_limit_seconds": WALL_SECONDS,
            "elapsed_seconds": time.monotonic() - started,
            "cpu_user_seconds": usage.ru_utime - before.ru_utime,
            "cpu_system_seconds": usage.ru_stime - before.ru_stime,
            "peak_rss_kib": usage.ru_maxrss,
        })
    return finish
