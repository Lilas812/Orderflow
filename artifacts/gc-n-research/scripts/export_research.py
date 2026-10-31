"""Export only derived GCZ6 session profiles and minute candles, read-only.

Run from the workspace root:
  python artifacts/gc-n-research/scripts/export_research.py
The purchased archive, imported trades, product API and receiver are untouched.
"""
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'data/unknown-side-analysis/raw.sqlite'
OUTPUT = Path(__file__).resolve().parents[1] / 'public/research-data'
CT = ZoneInfo('America/Chicago')
UTC = dt.timezone.utc
NS_PER_MINUTE = 60_000_000_000
PURCHASE_START_MS = int(dt.datetime(2026, 9, 30, tzinfo=UTC).timestamp()) * 1000
PURCHASE_END_MS = int(dt.datetime(2026, 10, 30, tzinfo=UTC).timestamp()) * 1000


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def session_date(time_ns):
    """Label CT17:00-based session by its ending date; UTC handles DST."""
    ct = dt.datetime.fromtimestamp(time_ns // 1_000_000_000, UTC).astimezone(CT)
    return (ct.date() + dt.timedelta(days=ct.hour >= 17)).isoformat()


def bounds(date):
    day = dt.date.fromisoformat(date)
    start = dt.datetime.combine(day - dt.timedelta(days=1), dt.time(17), CT)
    end = dt.datetime.combine(day, dt.time(17), CT)
    return int(start.timestamp()) * 1000, int(end.timestamp()) * 1000


def aggregate(rows):
    """Rows are event-time ordered, preserving source ID order on exact ties.

    Input: (event_nanoseconds, price_ticks, quantity, aggressor_side).
    No deduplication and no synthetic candles or side inference.
    """
    sessions = {}
    cached_minute, cached_date = None, None
    for event_ns, price, quantity, side in rows:
        if side not in ('A', 'B', 'N') or quantity <= 0:
            raise ValueError('Invalid source trade: do not silently discard')
        minute = event_ns // NS_PER_MINUTE
        if minute != cached_minute:
            cached_date = session_date(event_ns)
            cached_minute = minute
        s = sessions.setdefault(cached_date, {
            'profile': {}, 'candles': {},
            'summary': {'tradeCount': 0, 'quantity': 0, 'nCount': 0, 'nQuantity': 0},
        })
        summary = s['summary']
        summary['tradeCount'] += 1
        summary['quantity'] += quantity
        if side == 'N':
            summary['nCount'] += 1
            summary['nQuantity'] += quantity
            profile = s['profile'].setdefault(price, {'priceTicks': price, 'quantity': 0, 'count': 0})
            profile['quantity'] += quantity
            profile['count'] += 1
        candle = s['candles'].setdefault(minute, {
            'timeMs': minute * 60_000,
            'openTicks': price, 'highTicks': price, 'lowTicks': price,
            'closeTicks': price, 'quantity': 0, 'count': 0,
        })
        candle['highTicks'] = max(candle['highTicks'], price)
        candle['lowTicks'] = min(candle['lowTicks'], price)
        candle['closeTicks'] = price
        candle['quantity'] += quantity
        candle['count'] += 1
    return sessions


def payloads(sessions):
    """A payload can only source its levels from the previous observed session."""
    result = {}
    dates = sorted(sessions)
    for i, day in enumerate(dates):
        previous = dates[i-1] if i else None
        start, end = bounds(day)
        pstart, pend = bounds(previous) if previous else (0, 0)
        prev = sessions.get(previous)
        result[day] = {
            'session': day, 'previousSession': previous,
            'ownProfile': sorted(sessions[day]['profile'].values(), key=lambda x: x['priceTicks']),
            'availableStartMs': max(start, PURCHASE_START_MS),
            'availableEndMs': min(end, PURCHASE_END_MS),
            'partial': start < PURCHASE_START_MS or end > PURCHASE_END_MS,
            'previousPartial': bool(previous and (pstart < PURCHASE_START_MS or pend > PURCHASE_END_MS)),
            'sessionStartMs': start, 'sessionEndMs': end,
            'profile': sorted(prev['profile'].values(), key=lambda x: x['priceTicks']) if prev else [],
            'candles': sorted(sessions[day]['candles'].values(), key=lambda x: x['timeMs']),
            'summary': {
                **sessions[day]['summary'],
                'previousNCount': prev['summary']['nCount'] if prev else 0,
                'previousNQuantity': prev['summary']['nQuantity'] if prev else 0,
            },
        }
    return result


def export():
    source_hash = sha256(SOURCE)
    db = sqlite3.connect(SOURCE.as_uri() + '?mode=ro', uri=True)
    # SQLite cursor iteration, never loads the purchased month of raw trades in RAM.
    sessions = aggregate(db.execute(
        "select te,p,sz,side from t where sym='GCZ6' order by te,id"))
    expected_count, expected_qty, expected_n_count, expected_n_qty = db.execute(
        "select count(*),sum(sz),sum(side='N'),"
        "sum(case when side='N' then sz else 0 end) from t where sym='GCZ6'").fetchone()
    totals = collections.Counter()
    for s in sessions.values():
        totals.update(s['summary'])
        assert sum(x['quantity'] for x in s['candles'].values()) == s['summary']['quantity']
        assert sum(x['quantity'] for x in s['profile'].values()) == s['summary']['nQuantity']
    assert [totals[k] for k in ('tradeCount', 'quantity', 'nCount', 'nQuantity')] == [
        expected_count, expected_qty, expected_n_count, expected_n_qty]
    # Independent prior session aggregates are reused as a second reconciliation.
    previous = json.loads((ROOT/'data/unknown-side-analysis/sessions.json').read_text())
    for row in previous['daily_profiles']:
        if row['sym'] == 'GCZ6':
            s = sessions[row['day']]['summary']
            assert (s['nCount'], s['nQuantity']) == (row['N_count'], row['N_qty'])
    db.close()
    assert sha256(SOURCE) == source_hash, 'Input changed during export'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    entries, hashes = [], {}
    for date, data in payloads(sessions).items():
        name = date + '.json'
        target = OUTPUT/name
        target.write_text(json.dumps(data, separators=(',', ':')))
        hashes[name] = sha256(target)
        entries.append({
            'date': date, 'previousDate': data['previousSession'],
            'partial': data['partial'], 'previousPartial': data['previousPartial'],
            'file': name, **sessions[date]['summary'],
        })
    index = {
        'instrument': 'GCZ6', 'tickSize': 0.1, 'timezone': 'America/Chicago',
        'source': 'Purchased Databento GC outrights',
        'sourceSha256': source_hash,
        'purchaseUtc': ['2026-09-30T00:00:00Z', '2026-10-30T00:00:00Z'],
        'sessions': entries,
    }
    (OUTPUT/'index.json').write_text(json.dumps(index, indent=2))
    validation = {
        'sourceSha256Before': source_hash, 'sourceSha256After': source_hash,
        'instrument': 'GCZ6', 'totals': dict(totals), 'sessionCount': len(entries),
        'candles': sum(len(s['candles']) for s in sessions.values()),
        'outputHashes': hashes, 'previousProfilesReconciled': True,
        'rawTradesNeverDeduplicated': True,
    }
    (OUTPUT/'validation.json').write_text(json.dumps(validation, indent=2))
    print(json.dumps({k:v for k,v in validation.items() if k != 'outputHashes'}, indent=2))


if __name__ == '__main__':
    export()
