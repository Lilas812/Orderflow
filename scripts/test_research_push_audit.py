"""Synthetic isolated repos; never read or change workspace credentials."""
import pathlib
import subprocess
import sys
import tempfile
import unittest

AUDITOR = pathlib.Path(__file__).resolve().parents[1] / "artifacts/gc-n-research/scripts/range-push-audit.py"


class AuditTests(unittest.TestCase):
    def check_change(self, suffix, allow=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], stderr=subprocess.DEVNULL)
            git("init", "-q")
            git("config", "user.email", "fixture@example.invalid")
            git("config", "user.name", "fixture")
            fake = "db-" + "Z" * 20
            old = '[userenv.shared]\nDATABENTO_API_KEY = "' + fake + '"\nOTHER = "keep"\n'
            (root / ".replit").write_text(old)
            git("add", ".replit"); git("commit", "-qm", "fixture base")
            git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD").decode().strip())
            (root / ".replit").write_text('[userenv.shared]\nOTHER = "keep"\n' + suffix)
            git("add", ".replit"); git("commit", "-qm", "fixture update")
            args = [sys.executable, str(AUDITOR), "origin/main"]
            if allow:
                args.append("--allow-revoked-key-removal")
            return subprocess.run(args, cwd=tmp, capture_output=True).returncode

    def test_exact_deletion_allowed(self):
        self.assertEqual(self.check_change(""), 0)

    def test_other_config_edit_rejected(self):
        self.assertNotEqual(self.check_change('NEW = "changed"\n'), 0)

    def test_deletion_requires_explicit_flag(self):
        self.assertNotEqual(self.check_change("", allow=False), 0)


if __name__ == "__main__":
    unittest.main()
