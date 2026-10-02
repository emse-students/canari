#!/usr/bin/env bash
# THE LANDING OF A STABLE'S CHANGELOG, on real git repositories (a bare `origin` and a clone).
#
# What must hold: only the fragments the SHIPPED commit carried are folded (a later one stays for the
# next release), no manifest version moves, a second run is a no-op, and a push that loses a race to
# a merge starts again from the new head instead of failing.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare -b main "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
cd "$TMP/work" || exit 1
git checkout -q -b main

# A miniature repo the landing runs in: the script, the bump script it calls, a changelog.
mkdir -p scripts .github/scripts changelog.d
cp "$REPO_ROOT/scripts/bump-app-version.sh" scripts/
cp "$REPO_ROOT/.github/scripts/land-release-changelog.sh" .github/scripts/
printf '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n\n- old\n' > CHANGELOG.md
printf 'readme\n' > changelog.d/README.md
printf -- '- shipped fix\n' > changelog.d/shipped.md
git add -A && git commit -q -m base && git push -q origin main 2>/dev/null
SHIPPED="$(git rev-parse HEAD)"

# `main` moves on: a fragment the shipped commit never had.
printf -- '- later fix\n' > changelog.d/later.md
git add -A && git commit -q -m later && git push -q origin main 2>/dev/null

printf '\nthe landing folds the shipped fragments and only those\n'
out="$(bash .github/scripts/land-release-changelog.sh 1.0.0 "$SHIPPED" 2>&1)" || { fail "landing failed: $out"; }
git fetch -q origin main
git checkout -q -B check origin/main
grep -q '^## \[1.0.0\]' CHANGELOG.md && pass 'main carries the [1.0.0] section' || fail 'no [1.0.0] section on main'
grep -q 'shipped fix' CHANGELOG.md && pass 'the shipped entry is in it' || fail 'the shipped entry is missing'
grep -q 'later fix' CHANGELOG.md && fail 'a later entry was folded into the release' || pass 'the later entry was NOT folded'
[ ! -e changelog.d/shipped.md ] && pass 'the folded fragment is deleted' || fail 'the folded fragment is still there'
[ -e changelog.d/later.md ] && pass 'the later fragment is kept for the next release' || fail 'the later fragment was deleted'

printf '\na second run changes nothing\n'
before="$(git rev-parse origin/main)"
bash .github/scripts/land-release-changelog.sh 1.0.0 "$SHIPPED" >/dev/null 2>&1
git fetch -q origin main
[ "$(git rev-parse origin/main)" = "$before" ] && pass 'no new commit' || fail 'a second landing pushed again'

printf '\na lost race is retried from the new head\n'
# The first push is refused by a hook after another commit slips onto origin in the meantime.
git reset -q --hard origin/main
printf -- '- second shipped\n' > changelog.d/second.md
git add -A && git commit -q -m second && git push -q origin main 2>/dev/null
SECOND="$(git rev-parse HEAD)"
cat > "$TMP/origin.git/hooks/pre-receive" <<HOOK
#!/bin/sh
if [ ! -e "$TMP/refused-once" ]; then
  touch "$TMP/refused-once"
  echo "simulated race" >&2
  exit 1
fi
HOOK
chmod +x "$TMP/origin.git/hooks/pre-receive"
out="$(ATTEMPTS=3 bash .github/scripts/land-release-changelog.sh 1.0.1 "$SECOND" 2>&1)"
echo "$out" | grep -q 'starting again' && pass 'the first push lost and the landing started again' || fail "no retry: $out"
git fetch -q origin main
git show origin/main:CHANGELOG.md | grep -q '^## \[1.0.1\]' && pass 'and landed on the second attempt' || fail 'never landed'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
