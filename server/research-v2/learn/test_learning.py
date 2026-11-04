import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from common import ct_start, purge, write_csv
from config import ALLOWLIST
from prepare import Series, eligible_reasons, non_test_rows, past_baselines, read_splits


class SafetyTests(unittest.TestCase):
    def test_ledger_independent_of_y(self):
        sample = {"symbol": "GC", "contract": "GCZ26", "reference_price_ticks": "42000"}
        split = {"status": "assigned"}
        for y in ("999999", "-999999", "NaN", "THIS_MUST_NOT_BE_PARSED"):
            for key in ("endpoint_change_ticks", "upward_excursion_ticks", "downward_excursion_ticks"):
                changed = {**sample, key: y}
                self.assertEqual(eligible_reasons(changed, split, "", True), [])
                self.assertEqual(eligible_reasons(changed, split, "coverage_missing", True),
                                 ["target_coverage_missing"])
        self.assertEqual(eligible_reasons(sample, split, "", False), ["history_1800_incomplete"])

    def test_test_ids_not_retained_in_allowed(self):
        with tempfile.TemporaryDirectory(prefix="learn-test-") as temp:
            root = Path(temp)
            write_csv(root / "splits.csv", ["sample_id", "fold", "status", "reason"],
                      [("safe", "train", "assigned", ""), ("secret", "test", "assigned", "")])
            allowed, sealed = read_splits(root)
            self.assertEqual(set(allowed), {"safe"})
            self.assertEqual(sealed, {"secret"})
            class SealedRow:
                def __getitem__(self, key):
                    if key != "sample_id":
                        raise AssertionError("test field read: " + key)
                    return "secret"
            with patch("prepare.rows", return_value=iter([SealedRow(), {"sample_id": "safe", "y": "2"}])):
                self.assertEqual(list(non_test_rows(root / "targets.csv", allowed, sealed)),
                                 [{"sample_id": "safe", "y": "2"}])

    def test_target_end_purge(self):
        training = [{"target_end_us": 99}, {"target_end_us": 100}, {"target_end_us": 101}]
        kept, excluded = purge(training, 100)
        self.assertEqual([r["target_end_us"] for r in kept], [99, 100])
        self.assertEqual(excluded, 1)

    def test_past_baseline_excludes_asof_and_future(self):
        s = Series()
        for second in range(0, 602):
            price = 100 if second < 300 else 110
            if second >= 600:
                price = 999999  # forbidden future must never affect baseline
            s.add({"from_us": str(second * 1_000_000), "to_us": str((second + 1) * 1_000_000),
                   "coverage_mask": "1", "contract_mask": "1", "close": str(price),
                   "high": str(price + 2), "low": str(price - 1)})
        sample = {"as_of_us": "600000000", "history_ranges": json.dumps([
            {"series_id": "s", "from_us": "0", "to_us": "600000000"}])}
        self.assertEqual(past_baselines(sample, {"s": s}), (10, 3))
        # as_of boundary excluded even if future row is already present in storage.
        s.close[-2], s.high[-2], s.low[-2] = -999999, 9999999, -9999999
        self.assertEqual(past_baselines(sample, {"s": s}), (10, 3))

    def test_full_second_masks_and_missing_second(self):
        s = Series()
        for i in (0, 1, 3):
            s.add({"from_us": str(i * 1_000_000), "to_us": str((i + 1) * 1_000_000),
                   "coverage_mask": "1", "contract_mask": "1", "close": "", "high": "", "low": ""})
        self.assertTrue(s.window(0, 2_000_000)[2])
        self.assertFalse(s.window(0, 4_000_000)[2])

    def test_ct17_dst(self):
        from datetime import datetime
        before = int(datetime.fromisoformat("2026-10-30T22:00:00+00:00").timestamp()) * 1_000_000
        after = int(datetime.fromisoformat("2026-11-02T23:00:00+00:00").timestamp()) * 1_000_000
        self.assertEqual(ct_start(before), (before, "2026-10-30"))
        self.assertEqual(ct_start(after), (after, "2026-11-02"))

    def test_preprocessing_fit_train_only(self):
        from models import TrainTransform
        from math import isnan
        def row(sid, value, category, board=""):
            r = {k: "" for k in ALLOWLIST}
            r.update(sample_id=sid, rv_5m=value, session=category, near_size=board)
            return r
        training = [row("t1", "1", "night"), row("t2", "3", "day"), row("t3", "", "day")]
        future = [row("e", "1000000", "NEW_EVAL_ONLY", "12345")]
        transformer = TrainTransform().fit(training)
        self.assertEqual(transformer.fit_ids, {"t1", "t2", "t3"})
        self.assertEqual(transformer.vocabulary, ["day", "night"])
        self.assertEqual(transformer.medians.tolist(), [2.0])
        self.assertIn("near_size", transformer.dropped)
        original = transformer.medians.copy()
        linear = transformer.transform(future, linear=True)
        native = transformer.transform([row("e2", "", "night")], linear=False)
        self.assertTrue(isnan(native[0, 0]))  # GBDT NaN is not replaced
        self.assertEqual(linear[0, -1], 1)  # unknown category, not vocabulary refit
        self.assertEqual(transformer.medians.tolist(), original.tolist())

    def test_quantile_and_range_metrics_hand_calculation(self):
        import numpy as np
        from models import TrainTransform, train_models
        from evaluate import metrics
        training = []
        for i in range(8):
            r = {k: "" for k in ALLOWLIST}
            r.update(sample_id=str(i), rv_5m=str(i), session="day", y=str(2 * i + 1))
            training.append(r)
        transform = TrainTransform().fit(training)
        name, model = train_models("range300")[0]
        self.assertEqual(name, "quantile")
        model.fit(transform.transform(training, True), np.array([float(r["y"]) for r in training]))
        p = model.predict(transform.transform(training, True))
        np.testing.assert_allclose(p, np.arange(8) * 2 + 1, atol=1e-7)
        value, losses = metrics("range300", np.array([1., 4.]), np.array([2., 2.]))
        self.assertEqual(value["mae"], 1.5)
        np.testing.assert_allclose(losses, [1, 2])


if __name__ == "__main__":
    unittest.main()
