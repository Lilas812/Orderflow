"""Record limits/resources for the standard unittest suite as well."""
import unittest
from common import guard
from config import ROOT

if __name__ == "__main__":
    finish = guard(ROOT / "unit-tests")
    try:
        suite = unittest.defaultTestLoader.discover("server/research-v2/learn", "test_*.py")
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if not result.wasSuccessful():
            raise AssertionError("research unittest failure")
    except BaseException as error:
        finish(error)
        raise
    else:
        finish()
