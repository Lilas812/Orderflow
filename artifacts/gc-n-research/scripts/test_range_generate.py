import unittest
from range_generate import Builder, session, missing_intervals, scheduled


class RangeTests(unittest.TestCase):
    def build(self, prices, width=4, coverage=None, times=None, seqs=None):
        coverage = coverage or [(1_000_000, 30_000_000)]
        b = Builder(width, 4, coverage)
        for i, p in enumerate(prices):
            ts = times[i] if times else (i + 1) * 1_000_000
            seq = seqs[i] if seqs else i
            t = dict(tsUs=ts, seq=seq, price=p, size=i + 1, side=["buy", "sell", "unknown"][i % 3])
            b.add(t, dict(tsUs=ts, seq=seq, priceTicks=p, file="fixture", line=i + 1, source={}))
        b.finish()
        return b

    def test_exact_width_and_next_trade(self):
        b = self.build([10, 12, 14, 13])
        self.assertEqual([(x["open"], x["close"], x["count"], x["partial"]) for x in b.bars], [(10, 14, 3, False), (13, 13, 1, True)])
        self.assertEqual(b.totals, dict(count=4, buy=5, sell=2, unknown=3))

    def test_jump_no_synthetic_intermediate(self):
        b = self.build([10, 100, 90])
        self.assertEqual(len(b.bars), 2)
        self.assertEqual(b.bars[0]["high"], 100)
        self.assertEqual(b.bars[1]["open"], 90)

    def test_coverage_gap_and_quiet_certified_time(self):
        b = self.build([10, 11, 12], coverage=[(1_000_000, 3_000_000), (5_000_000, 20_000_000)], times=[1_000_000, 2_000_000, 8_000_000])
        self.assertEqual(len(b.bars), 2)
        self.assertEqual(b.bars[0]["reason"], "coverage")
        quiet = self.build([10, 11], times=[1_000_000, 19_000_000])
        self.assertEqual(len(quiet.bars), 1)
        with self.assertRaises(ValueError):
            self.build([10], coverage=[(2_000_000, 4_000_000)])

    def test_equal_timestamp_sequence_and_duplicate_real_trade_retained(self):
        b = self.build([10, 10, 14], times=[1_000_000] * 3, seqs=[1, 1, 2])
        self.assertEqual(b.bars[0]["count"], 3)
        self.assertEqual(b.bars[0]["lowRef"]["line"], 1)
        with self.assertRaises(ValueError):
            self.build([10, 11], times=[1_000_000, 1_000_000], seqs=[2, 1])

    def test_extreme_first_occurrence_and_input_partial(self):
        b = self.build([10, 12, 12, 11], width=20)
        self.assertEqual(b.bars[0]["highRef"]["tsUs"], 2_000_000)
        self.assertEqual(b.bars[0]["highRef"]["line"], 2)
        self.assertEqual(b.bars[0]["reason"], "input-end")
        self.assertEqual(b.candidates[-1]["confirmedUs"], None)

    def test_session_boundary_ct_end_date_and_dst(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        zone = ZoneInfo("America/Chicago")
        a = int(datetime(2026, 10, 1, 16, 59, tzinfo=zone).timestamp() * 1e6)
        z = int(datetime(2026, 10, 1, 17, tzinfo=zone).timestamp() * 1e6)
        self.assertEqual(session(a)[0], "2026-10-01")
        self.assertEqual(session(z)[0], "2026-10-02")
        b = self.build([10, 11], coverage=[(a, z + 60_000_000)], times=[a, z])
        self.assertEqual(len(b.bars), 2)
        self.assertEqual(b.bars[0]["reason"], "session")
        fall = int(datetime(2026, 11, 1, 10, tzinfo=zone).timestamp() * 1e6)
        self.assertEqual(session(fall)[3] - session(fall)[2], 25 * 3_600_000_000)
        self.assertTrue(scheduled(a))

    def test_raw_candidate_order_equal_boundary_and_final(self):
        b = self.build([10, 14, 14, 10, 6, 10], width=100)
        confirmed = [x for x in b.candidates if x["confirmedUs"] is not None]
        self.assertEqual([(x["kind"], x["ref"]["priceTicks"]) for x in confirmed], [("bottom", 10), ("top", 14), ("bottom", 6)])
        self.assertEqual(confirmed[1]["ref"]["tsUs"], 2_000_000)
        self.assertIsNone(b.candidates[-1]["confirmedUs"])

    def test_invalid_parameters_and_no_cross_gap_candidate(self):
        with self.assertRaises(ValueError):
            Builder(0, 1, [])
        b = self.build([10, 20], coverage=[(1_000_000, 2_000_000), (3_000_000, 5_000_000)], times=[1_000_000, 3_000_000])
        self.assertTrue(all(x["confirmedUs"] is None for x in b.candidates))
        self.assertEqual(len(missing_intervals([(2_000_000, 3_000_000)], 1_000_000, 4_000_000)), 2)


if __name__ == "__main__":
    unittest.main()
