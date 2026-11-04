#!/usr/bin/env bash
set -euo pipefail
# Run from project root. Existing receiver workflows are never touched.
PYTHON=/nix/store/iizfzmqjdfvbyx82gqw92glb5zl6m4my-python3-3.12.12/bin/python3
export PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
export PYTHONPATH="$PWD/data/research-v2/learn-01/python-site"
export OMP_NUM_THREADS=2 OMP_THREAD_LIMIT=2 OPENBLAS_NUM_THREADS=2
export MKL_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2 HIGHS_THREADS=2
# Pip wheels need the already-installed C++/OpenMP runtime. Scope it to this process.
NATIVE=/nix/store/xc0ga87wdclrx54qjaryahkkmkmqi9qz-gcc-15.2.0-lib/lib
test -f "$NATIVE/libstdc++.so.6" && test -f "$NATIVE/libgomp.so.1"
export ORDERFLOW_LEARN_NATIVE_LIB="$NATIVE"
export LD_LIBRARY_PATH="$NATIVE${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
case "${1-}" in
  test) shift; exec nice -n 19 timeout --signal=TERM --kill-after=10s 1790s "$PYTHON" server/research-v2/learn/check.py "$@" ;;
  run) shift; exec nice -n 19 timeout --signal=TERM --kill-after=10s 1790s "$PYTHON" server/research-v2/learn/run.py "$@" ;;
  *) echo 'usage: bash server/research-v2/learn/execute.sh test|run --out NEW_PRIVATE_PATH' >&2; exit 2 ;;
esac
