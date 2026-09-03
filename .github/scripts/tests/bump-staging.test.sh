#!/usr/bin/env bash
# =================================================================================================
# DOES THE BUMP COMMIT EVERYTHING THE BUMP WROTE?
#
# WHY THIS EXISTS. Publishing a release is the only thing that deploys anything here, and
# `bump-version.yml` is the first link: it runs `bump-app-version.sh`, commits, pushes to `main`, and
# CD plus the two store workflows start from its COMPLETION and read the files it wrote. A file the
# script bumps but the commit leaves behind does not fail anything - it ships a release whose
# components disagree with each other, and the disagreement surfaces at a store upload or in a crate
# version nobody looks at.
#
# That step used to stage an ELEVEN-LINE ENUMERATION of paths, which was a second and silent
# statement of which files carry a version: the script wrote them, the list had to remember them, and
# nothing compared the two. It now stages `git add -u`, which asks git instead of a human. These
# assertions are what makes that safe rather than merely shorter:
#
#   * `-u` covers every TRACKED file the script modifies (otherwise the commit is still partial).
#   * The script creates NO new file (or `-u`, which ignores untracked paths, would miss it).
#   * A bump leaves NO tracked manifest carrying the previous version - the completeness check, and
#     the one that catches a script that stopped half-way. It really can: piping its output into
#     `head` killed it after six lines on 2026-09-03 (SIGPIPE under `set -o pipefail`), leaving the
#     package.json files bumped and every Cargo.toml behind. The workflow does not pipe it, so that
#     exact arm cannot fire there - but "the script exited early" must be a caught state, not a
#     trusted impossibility.
#
# HOW. A detached `git worktree` at HEAD, so the real tree is never touched and the run cannot leave
# a dirty checkout behind if an assertion fails.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORKFLOW="$REPO/.github/workflows/bump-version.yml"
SCRIPT="$REPO/scripts/bump-app-version.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

[ -r "$WORKFLOW" ] || { printf 'cannot read %s\n' "$WORKFLOW"; exit 1; }
[ -r "$SCRIPT" ]   || { printf 'cannot read %s\n' "$SCRIPT"; exit 1; }

# A version no manifest can already hold, so "still carries the old value" is unambiguous.
TARGET="9.87.65"

WT="$(mktemp -d)"
cleanup() {
  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1
  rm -rf "$WT" >/dev/null 2>&1
}
trap cleanup EXIT

printf '\nthe step stages what the script wrote, rather than a list of paths\n'
# ═════════════════════════════════════════════════════════════════════════════
# Read the intent off the workflow, so this cannot pass against a step that quietly went back to an
# enumeration. `-A` is called out separately: it would also stage untracked artefacts, which is a
# behaviour change rather than a simplification.
if grep -qE '^\s*git add -u\s*$' "$WORKFLOW"; then
  pass "bump-version.yml stages with 'git add -u'"
else
  fail "bump-version.yml no longer stages with 'git add -u' - a path list drifts from the script"
fi

if grep -qE '^\s*git add -A' "$WORKFLOW"; then
  fail "'git add -A' would stage untracked artefacts - frontend/mls-core/Cargo.lock is gitignored on purpose"
else
  pass "'git add -A' is not used, so an untracked artefact cannot ride along"
fi

printf '\nwhat the script really does to a clean tree\n'
# ═════════════════════════════════════════════════════════════════════════════
if ! git -C "$REPO" worktree add -q --detach "$WT" HEAD 2>/dev/null; then
  printf '  cannot create a worktree at HEAD - skipping the behavioural half\n'
  printf '\n%s of %s assertions passed (behavioural half skipped)\n' "$PASS" "$((PASS + FAIL))"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

PREV="$(grep -m1 '"version"' "$WT/frontend/package.json" | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/')"

# NOT piped anywhere: this suite exists partly because a pipe killed this script once.
( cd "$WT" && bash scripts/bump-app-version.sh "$TARGET" ) > "$WT/.bump.log" 2>&1
RC=$?

if [ "$RC" -eq 0 ]; then
  pass "the script exits 0 on a clean tree (bumping $PREV -> $TARGET)"
else
  fail "the script exited $RC - the rest of this file measures a half-finished bump"
fi

# Untracked additions: `-u` would silently miss any, so there must be none that matter.
UNTRACKED="$(cd "$WT" && git status --porcelain --untracked-files=normal | awk '$1 == "??" {print $2}')"
if [ -z "$UNTRACKED" ]; then
  pass "the script creates no untracked file, so 'git add -u' cannot miss one"
else
  fail "the script created untracked paths that 'git add -u' would drop: $UNTRACKED"
fi

MODIFIED="$(cd "$WT" && git diff --name-only)"
COUNT="$(printf '%s\n' "$MODIFIED" | grep -c . )"
if [ "$COUNT" -ge 10 ]; then
  pass "it modifies $COUNT tracked files, and every one of them is staged by '-u'"
else
  fail "only $COUNT tracked files changed - the script bumped almost nothing, or stopped early"
fi

printf '\nno tracked manifest is left carrying the previous version\n'
# ═════════════════════════════════════════════════════════════════════════════
# THE COMPLETENESS ASSERTION. Checked on the version-bearing line of each manifest rather than by
# grepping whole files: a Cargo.lock legitimately names other crates' versions, and one of them
# equalling the previous app version would make a whole-file grep cry wolf.
STALE=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    */package.json|package.json)
      line="$(grep -m1 '"version"' "$WT/$f" 2>/dev/null)" ;;
    */Cargo.toml)
      line="$(grep -m1 '^version' "$WT/$f" 2>/dev/null)" ;;
    *)
      continue ;;
  esac
  case "$line" in
    *"\"$PREV\""*|*"= \"$PREV\""*) STALE="$STALE $f" ;;
  esac
done <<< "$(cd "$WT" && git ls-files '*package.json' '*Cargo.toml')"

if [ -z "$STALE" ]; then
  pass "every tracked package.json and Cargo.toml moved off $PREV"
else
  fail "left at $PREV:$STALE - the release would ship components that disagree"
fi

# And the store numbers, which are the values a half-bump loses most expensively: a versionCode that
# did not move is refused by Play outright ("Version code N has already been used").
CODE_LINE="$(grep -o '"versionCode": [0-9]*' "$WT/frontend/src-tauri/tauri.conf.json" 2>/dev/null | head -1)"
PLIST_LINE="$(grep -A1 CFBundleVersion "$WT/frontend/src-tauri/gen/apple/canari_iOS/Info.plist" 2>/dev/null | grep -o '[0-9]\{4,\}' | head -1)"
# 9.87.65 -> (9*1e6 + 87*1e3 + 65) * 100 + 99, the band with a stable's rank.
EXPECTED_CODE=$(( (9 * 1000000 + 87 * 1000 + 65) * 100 + 99 ))

if [ "$CODE_LINE" = "\"versionCode\": $EXPECTED_CODE" ]; then
  pass "tauri.conf.json carries the banded versionCode $EXPECTED_CODE"
else
  fail "tauri.conf.json versionCode is '$CODE_LINE', expected $EXPECTED_CODE - Play refuses a code it has seen"
fi

if [ "$PLIST_LINE" = "$EXPECTED_CODE" ]; then
  pass "Info.plist carries the same CFBundleVersion $EXPECTED_CODE"
else
  fail "Info.plist CFBundleVersion is '$PLIST_LINE', expected $EXPECTED_CODE - TestFlight refuses a repeat"
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
