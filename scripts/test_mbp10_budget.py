"""No real credentials or paid requests are used."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mbp10_fetch", Path(__file__).with_name("fetch_mbp10_check.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BudgetTests(unittest.TestCase):
    def test_above_budget_never_downloads(self):
        rows = [{"label": name, "start": start, "end": end, "columns": 3000}
                for name, start, end in [
                    ("us", "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z"),
                    ("asia", "2026-11-03T05:00:00Z", "2026-11-03T06:00:00Z"),
                    ("session-open", "2026-11-03T23:00:00Z", "2026-11-04T00:00:00Z")]]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "windows.json").write_text(json.dumps(rows))
            def quote(endpoint, params, auth, post=False):
                self.assertEqual(endpoint, "metadata.get_cost")
                self.assertFalse(post)
                return io.BytesIO(b"0.75")
            with patch.object(module, "ROOT", root), patch.object(module, "request", side_effect=quote) as request, \
                    patch.dict(module.os.environ, {"DATABENTO_API_KEY": "unit-fixture-only"}), \
                    patch.object(module.sys, "argv", ["fetch", "--download"]), patch("sys.stdout", io.StringIO()):
                module.main()
            self.assertEqual(request.call_count, 3)
            self.assertFalse((root / "raw").exists())
            self.assertFalse(json.loads((root / "cost.json").read_text())["withinBudget"])

    def test_does_not_follow_authenticated_redirect(self):
        self.assertIsNone(module.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.invalid"))


if __name__ == "__main__":
    unittest.main()
