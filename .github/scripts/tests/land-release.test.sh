#!/usr/bin/env bash
# THE LANDING OF A RELEASE ON `main`, on real git repositories (a bare `origin` and a clone).
#
# What must hold, for a STABLE: only the fragments the SHIPPED commit carried are folded (a later
# one stays for the next release), no manifest version moves, a second run is a no-op, and a push
# that loses a race to a merge starts again from the new head instead of failing.
# And for a PRE-RELEASE: `main` takes its version on top of whatever merged since the cut, a second
# run is a no-op, and a landing re-run after a LATER release landed never moves `main` backwards.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
# `expect <description> <command...>`: pass when the command succeeds. An if/else, not `A && B || C`.
expect() { local d="$1"; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare -b main "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
cd "$TMP/work" || exit 1
git checkout -q -b main

# A miniature repo the landing runs in: the script, its library, the bump script it calls, a
# changelog, and the manifests a pre-release bump writes (the same set `bump-version.test.sh` builds).
mkdir -p scripts .github/scripts/lib changelog.d \
  frontend/src-tauri/gen/apple/canari.xcodeproj frontend/src-tauri/gen/apple/canari_iOS \
  frontend/mls-wasm frontend/mls-core
cp "$REPO_ROOT/scripts/bump-app-version.sh" scripts/
cp "$REPO_ROOT/.github/scripts/land-release.sh" .github/scripts/
cp "$REPO_ROOT/.github/scripts/lib/release-preconditions.sh" .github/scripts/lib/
printf '{\n  "name": "canari",\n  "version": "0.9.0"\n}\n' > frontend/package.json
printf '{\n  "version": "0.9.0",\n  "bundle": {\n    "active": true\n  }\n}\n' > frontend/src-tauri/tauri.conf.json
for crate in src-tauri mls-wasm mls-core; do
  printf '[package]\nname = "canari-%s"\nversion = "0.9.0"\n' "$crate" > "frontend/$crate/Cargo.toml"
done
printf 'MARKETING_VERSION = 0.9.0;\nCURRENT_PROJECT_VERSION = 900099;\n' \
  > frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj
printf '<plist><dict>\n  <key>CFBundleShortVersionString</key>\n  <string>0.9.0</string>\n  <key>CFBundleVersion</key>\n  <string>900099</string>\n</dict></plist>\n' \
  > frontend/src-tauri/gen/apple/canari_iOS/Info.plist
printf '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n\n- old\n' > CHANGELOG.md
printf 'readme\n' > changelog.d/README.md
printf -- '- shipped fix\n' > changelog.d/shipped.md
git add -A && git commit -q -m base && git push -q origin main 2>/dev/null
SHIPPED="$(git rev-parse HEAD)"

# `main` moves on: a fragment the shipped commit never had.
printf -- '- later fix\n' > changelog.d/later.md
git add -A && git commit -q -m later && git push -q origin main 2>/dev/null
LATER="$(git rev-parse HEAD)"

main_version() { git fetch -q origin main && git show origin/main:frontend/package.json | jq -r .version; }

printf '\na pre-release lands its version on a main that moved on after the cut\n'
out="$(bash .github/scripts/land-release.sh 1.0.0-alpha.2 "$SHIPPED" 2>&1)" || fail "landing failed: $out"
expect 'main names 1.0.0-alpha.2' test "$(main_version)" = '1.0.0-alpha.2'
expect 'on top of what merged after the cut' git merge-base --is-ancestor "$LATER" origin/main
expect 'and a pre-release folds no changelog' git cat-file -e origin/main:changelog.d/shipped.md

printf '\na second pre-release landing changes nothing\n'
before="$(git rev-parse origin/main)"
bash .github/scripts/land-release.sh 1.0.0-alpha.2 "$SHIPPED" >/dev/null 2>&1
git fetch -q origin main
expect 'no new commit' test "$(git rev-parse origin/main)" = "$before"

printf '\nan older landing re-run after a later one never moves main backwards\n'
bash .github/scripts/land-release.sh 1.0.0-alpha.3 "$SHIPPED" >/dev/null 2>&1
before="$(git rev-parse origin/main)"
out="$(bash .github/scripts/land-release.sh 1.0.0-alpha.2 "$SHIPPED" 2>&1)"
git fetch -q origin main
expect 'main still names 1.0.0-alpha.3' test "$(main_version)" = '1.0.0-alpha.3'
expect 'no new commit' test "$(git rev-parse origin/main)" = "$before"
expect 'and it says why' grep -q 'not moved backwards' <<<"$out"

printf '\nthe landing of a stable folds the shipped fragments and only those\n'
out="$(bash .github/scripts/land-release.sh 1.0.0 "$SHIPPED" 2>&1)" || { fail "landing failed: $out"; }
git fetch -q origin main
git checkout -q -B check origin/main
expect 'main carries the [1.0.0] section' grep -q '^## \[1.0.0\]' CHANGELOG.md
expect 'the shipped entry is in it' grep -q 'shipped fix' CHANGELOG.md
if grep -q 'later fix' CHANGELOG.md; then fail 'a later entry was folded into the release'; else pass 'the later entry was NOT folded'; fi
expect 'the folded fragment is deleted' test ! -e changelog.d/shipped.md
expect 'the later fragment is kept for the next release' test -e changelog.d/later.md
expect 'no manifest version moves' test "$(jq -r .version frontend/package.json)" = '1.0.0-alpha.3'

printf '\na second stable landing changes nothing\n'
before="$(git rev-parse origin/main)"
bash .github/scripts/land-release.sh 1.0.0 "$SHIPPED" >/dev/null 2>&1
git fetch -q origin main
expect 'no new commit' test "$(git rev-parse origin/main)" = "$before"

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
out="$(ATTEMPTS=3 bash .github/scripts/land-release.sh 1.0.1 "$SECOND" 2>&1)"
expect 'the first push lost and the landing started again' grep -q 'starting again' <<<"$out"
git fetch -q origin main
expect 'and landed on the second attempt' grep -q '^## \[1.0.1\]' <(git show origin/main:CHANGELOG.md)

printf '\na pre-release landing that loses the race is retried too\n'
# The pre-release landing is the one that runs on EVERY release, so it is the one that meets a merge
# most often. Re-arm the hook: the next push is refused once more.
rm -f "$TMP/refused-once"
out="$(ATTEMPTS=3 bash .github/scripts/land-release.sh 1.0.2-alpha.1 "$SECOND" 2>&1)"
expect 'the first push lost and the landing started again' grep -q 'starting again' <<<"$out"
expect 'and main names 1.0.2-alpha.1 after the second attempt' test "$(main_version)" = '1.0.2-alpha.1'
expect 'the changelog the stable landed is kept' grep -q '^## \[1.0.1\]' <(git show origin/main:CHANGELOG.md)

printf '\nanything that is not a version is refused before main is touched\n'
before="$(git rev-parse origin/main)"
if bash .github/scripts/land-release.sh not-a-version "$SECOND" >/dev/null 2>&1; then
  fail 'a non-version was landed'
else
  pass 'a non-version is refused'
fi
git fetch -q origin main
expect 'and main did not move' test "$(git rev-parse origin/main)" = "$before"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
