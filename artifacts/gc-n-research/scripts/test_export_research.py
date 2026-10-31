import datetime as dt
import unittest
from export_research import aggregate, bounds, payloads, session_date

UTC = dt.timezone.utc


def ns(iso):
    return int(dt.datetime.fromisoformat(iso).timestamp()) * 1_000_000_000


class ExportTest(unittest.TestCase):
    def test_session_and_dst(self):
        self.assertEqual(session_date(ns('2026-10-01T21:59:59+00:00')), '2026-10-01')
        self.assertEqual(session_date(ns('2026-10-01T22:00:00+00:00')), '2026-10-02')
        self.assertEqual(session_date(ns('2026-11-02T22:59:59+00:00')), '2026-11-02')
        self.assertEqual(session_date(ns('2026-11-02T23:00:00+00:00')), '2026-11-03')
        self.assertEqual(bounds('2026-11-01')[1]-bounds('2026-11-01')[0], 25*3600*1000)

    def test_ohlc_all_sides_no_dedup_no_fill(self):
        start = ns('2026-10-01T13:00:00+00:00')
        s = aggregate([
            (start, 42000, 2, 'B'),
            (start, 42000, 2, 'B'),  # legitimate identical separate trade
            (start+1, 42003, 3, 'N'),
            (start+2, 41999, 1, 'A'),
            (start+120_000_000_000, 42001, 4, 'N'),
        ])['2026-10-01']
        bars = list(s['candles'].values())
        self.assertEqual(len(bars), 2)  # no invented 13:01 candle
        self.assertEqual([bars[0][k] for k in ('openTicks','highTicks','lowTicks','closeTicks','quantity','count')],
                         [42000,42003,41999,41999,8,4])
        self.assertEqual(s['summary'], {'tradeCount':5,'quantity':12,'nCount':2,'nQuantity':7})
        self.assertEqual(sum(x['quantity'] for x in s['profile'].values()),7)

    def test_previous_actual_session_and_no_lookahead(self):
        s = aggregate([
            (ns('2026-10-02T13:00:00+00:00'), 42000, 5, 'N'),
            (ns('2026-10-05T13:00:00+00:00'), 43000, 9999, 'N'),
        ])
        p = payloads(s)
        self.assertIsNone(p['2026-10-02']['previousSession'])
        self.assertEqual(p['2026-10-02']['profile'], [])
        self.assertEqual(p['2026-10-05']['previousSession'], '2026-10-02')
        self.assertEqual(p['2026-10-05']['profile'], [{'priceTicks':42000,'quantity':5,'count':1}])

    def test_invalid_not_silently_dropped(self):
        with self.assertRaises(ValueError):
            aggregate([(ns('2026-10-01T00:00:00+00:00'),42000,1,'?')])


if __name__ == '__main__':
    unittest.main()
