"""Three authorized GCZ26 hours only. No packages, config edits, or key output."""
import base64
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "data/research-v2/mbp10-check-01"
HOST = "https://hist.databento.com/v0/"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Refuse rather than forward an Authorization header to a different host.
        return None


def parameters(row):
    return dict(dataset="GLBX.MDP3", symbols="GCZ6", stype_in="raw_symbol",
                schema="mbp-10", start=row["start"], end=row["end"])


def request(endpoint, params, auth, post=False):
    encoded = urllib.parse.urlencode(params)
    url = HOST + endpoint + ("" if post else "?" + encoded)
    req = urllib.request.Request(url, data=encoded.encode() if post else None,
                                 headers={"Authorization": auth, "Accept-Encoding": "identity"})
    return urllib.request.build_opener(NoRedirect()).open(req, timeout=120)


def main():
    rows = json.loads((ROOT / "windows.json").read_text())
    expected = {"us": "2026-11-03T14:00:00Z", "asia": "2026-11-03T05:00:00Z",
                "session-open": "2026-11-03T23:00:00Z"}
    if len(rows) != 3 or {r["label"]: r["start"] for r in rows} != expected:
        raise ValueError("unexpected windows")
    if any(r["columns"] < 1800 for r in rows):
        raise ValueError("insufficient saved app columns")
    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        raise ValueError("DATABENTO_API_KEY Secret unavailable")
    auth = "Basic " + base64.b64encode((key + ":").encode()).decode()
    quotes = []
    for row in rows:
        with request("metadata.get_cost", parameters(row), auth) as response:
            value = json.loads(response.read(1024 * 1024), parse_float=Decimal)
        cost = Decimal(str(value))
        if not cost.is_finite() or cost < 0:
            raise ValueError("invalid quote")
        quotes.append(dict(label=row["label"], parameters=parameters(row), costUsd=str(cost)))
    total = sum(Decimal(q["costUsd"]) for q in quotes)
    estimate = dict(quotedAtUtc=__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
                    quotes=quotes, totalUsd=str(total), budgetUsd="2", withinBudget=total <= 2)
    (ROOT / "cost.json").write_text(json.dumps(estimate, indent=2))
    print(json.dumps(estimate))
    if total > 2 or "--download" not in sys.argv:
        return
    raw = ROOT / "raw"
    raw.mkdir(exist_ok=True)
    manifest = []
    for row, quote in zip(rows, quotes):
        file = raw / f'GCZ26-{row["start"][0:13].replace(":", "-")}.mbp10.dbn.zst'
        if file.exists() or file.with_suffix(".partial").exists():
            raise ValueError("existing raw preserved; no repeated paid download")
        digest = hashlib.sha256()
        size = 0
        with request("timeseries.get_range", {**parameters(row), "stype_out": "instrument_id",
                     "encoding": "dbn", "compression": "zstd"}, auth, post=True) as response:
            with file.with_suffix(".partial").open("xb") as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk); digest.update(chunk); size += len(chunk)
                out.flush(); os.fsync(out.fileno())
        if not size:
            raise ValueError("empty download preserved")
        file.with_suffix(".partial").rename(file)
        manifest.append(dict(label=row["label"], parameters=parameters(row), quotedCostUsd=quote["costUsd"],
                             file=str(file.relative_to(ROOT)), bytes=size, sha256=digest.hexdigest()))
        (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(json.dumps(manifest[-1]))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print(json.dumps({"error": "Databento HTTP request failed", "status": error.code}))
        sys.exit(1)
    except Exception:
        # Transport/request exceptions can contain credentials or response bodies.
        print(json.dumps({"error": "MBP-10 operation stopped; raw/partial preserved, no retry"}))
        sys.exit(1)
