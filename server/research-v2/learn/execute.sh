#!/usr/bin/env bash
set -euo pipefail
# Run from project root. Existing receiver workflows are never touched.
PYTHON=/nix/store/iizfzmqjdfvbyx82gqw92glb5zl6m4my-python3-3.12.12/bin/python3
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
export PYTHONPATH="$PWD/data/research-v2/learn-01/python-site"
export OMP_NUM_THREADS=2 OMP_THREAD_LIMIT=2 OPENBLAS_NUM_THREADS=2
export MKL_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2 HIGHS_THREADS=2
case "${1-}" in
  test) shift; exec nice -n 19 timeout --signal=TERM --kill-after=10s 1790s prlimit --as=3221225472 -- "$PYTHON" -m unittest discover -s server/research-v2/learn -p 'test_*.py' -v "$@" ;;
  run) shift; exec nice -n 19 timeout --signal=TERM --kill-after=10s 1790s "$PYTHON" server/research-v2/learn/run.py "$@" ;;
  *) echo 'usage: bash server/research-v2/learn/execute.sh test|run --out NEW_PRIVATE_PATH' >&2; exit 2 ;;
esac
