"""Scan ALL newly sent Git objects, never print matched secret contents.

Run from the approved clean worktree after committing, before a normal push.
Existing remote history is not newly sent; this never rewrites it.
"""
import json
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args])


base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
forbidden = [".replit", "scripts/mbo_dbn.mjs"]
commits = git("rev-list", f"{base}..HEAD").decode().splitlines()
findings = []
for commit in commits:
    paths = git("diff-tree", "--no-commit-id", "--name-only", "-r", commit).decode().splitlines()
    for p in paths:
        if p in forbidden or p.startswith(("data/", "artifacts/gc-n-research/public/research-data/")):
            findings.append({"commit": commit, "path": p, "reason": "forbidden changed path"})
objects = git("rev-list", "--objects", "HEAD", "--not", base).decode().splitlines()
patterns = [
    ("Databento credential shape", re.compile(rb"\bdb-[A-Za-z0-9]{12,}")),
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("common token shape", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{25,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b")),
    ("credential URL", re.compile(rb"[a-z]+://[^\s/:]{1,80}:[^\s/@]{8,}@")),
]
scanned = 0
for row in objects:
    oid = row.split(" ", 1)[0]
    kind = git("cat-file", "-t", oid).strip()
    if kind not in (b"blob", b"commit"):
        continue
    content = git("cat-file", "-p", oid)
    scanned += 1
    for name, pattern in patterns:
        if pattern.search(content):
            findings.append({"object": oid, "path": row.split(" ", 1)[1] if " " in row else "",
                             "reason": name})
# The unapproved local checkpoint must never become an ancestor of the sent tip.
blocked = "f4ef821"
if subprocess.run(["git", "merge-base", "--is-ancestor", blocked, "HEAD"], capture_output=True).returncode == 0:
    findings.append({"reason": "blocked local checkpoint is an ancestor"})
print(json.dumps({"base": base, "commits": len(commits), "newCommitAndBlobObjectsScanned": scanned,
                  "findings": findings}, ensure_ascii=False))
sys.exit(1 if findings else 0)
