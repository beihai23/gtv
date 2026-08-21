#!/usr/bin/env bash
# Tier-1: gtv must open repositories whose .git/config carries
# extensions.relativeWorktrees (written by git >= 2.48 `git worktree add
# --relative-paths`). Fix carrier: libgit2 >= 1.9.4 (PR libgit2#7254),
# bundled via libgit2-sys >= 0.18.5+1.9.4.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

# 1) Cargo.lock must bundle libgit2 >= 1.9.4 (extension recognition).
ver=$(grep -A1 'name = "libgit2-sys"' Cargo.lock | grep -oE '[0-9.]+\+1\.9\.[0-9]+' | head -1)
echo "bundled libgit2-sys: ${ver}"
mid=$(echo "$ver" | cut -d+ -f2 | cut -d. -f2)
pat=$(echo "$ver" | cut -d+ -f2 | cut -d. -f3)
if [ "${mid}" != "9" ] || [ "${pat}" -lt 4 ]; then
  echo "FAIL: bundled libgit2 must be >= 1.9.4, got 1.${mid}.${pat}"
  exit 1
fi

# 2) Regression test on the plan's own fixture contract.
cargo test --test relative_worktrees_ext
