#!/usr/bin/env bash
# Acceptance fixture for M1.2: a repo with ~1000 branches where most are
# long-dead (merged or abandoned), ~25 are active, plus a release/* pile
# and protected env branches. Usage: gen_inactive_repo.sh <target-dir>
#
# Every commit and merge is explicitly dated (the merges too -- an undated
# merge would stamp main's history "now", keep the release/* refs that hang
# off the last merge commit fresh, and blow the <=30-lane acceptance).
set -euo pipefail
dir="${1:?usage: gen_inactive_repo.sh <target-dir>}"
mkdir -p "$dir" && cd "$dir"
git init -q -b main
git config user.email t@t && git config user.name t
old=$(date -v-400d +%s 2>/dev/null || date -d '400 days ago' +%s)
new=$(date +%s)
c() { GIT_AUTHOR_DATE="@$1" GIT_COMMITTER_DATE="@$1" git commit -q --allow-empty -m "$2"; }
m() { GIT_AUTHOR_DATE="@$1" GIT_COMMITTER_DATE="@$1" git merge -q --no-ff "$2" -m "merge $2"; }

# main + dev base
c "$old" "base" && git branch -q dev
# ~500 merged dead feature branches
for i in $(seq 1 500); do
  git checkout -q -b "feat/$i" main
  c "$((old + i))" "feat $i"
  git checkout -q main && m "$((old + i))" "feat/$i"
done
# ~450 abandoned (never merged) dead branches
for i in $(seq 1 450); do
  git checkout -q -b "wip/$i" main
  c "$((old + i))" "wip $i"
done
# a pile of old release/* (must NOT be name-protected: wildcards excluded)
for i in $(seq 1 100); do
  git branch -q "release/v1.$i" main
done
# protected env branches, quiet but load-bearing
git branch -q uat main && git branch -q staging main
# ~25 active branches on top of recent main
git checkout -q main && c "$new" "recent main"
for i in $(seq 1 25); do
  git checkout -q -b "now/$i" main && c "$new" "active $i"
done
git checkout -q main
echo "done: $(git branch | wc -l | tr -d ' ') branches in $dir"
