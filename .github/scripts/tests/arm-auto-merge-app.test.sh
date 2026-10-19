#!/usr/bin/env bash
#
# Self-tests for the ONE pull request from the `canari-auto-merge` App that `arm-auto-merge.yml`
# arms: the lockfile refresh `cargo-lock-refresh.sh` opens (WP-RUST-LOCK-AUTOMERGE, 2026-10-18).
#
# WHAT THIS PINS IS THE ALLOWLIST'S EDGES, because the workflow arms a merge nobody reads: an App
# pull request from any other branch, touching any other file, carrying any commit that is not the
# original's signed Dependabot commit re-committed by the App (or the App's own lock commit), or
# whose manifest change is not the one Dependabot signed, must NOT be armed - and one that WAS armed
# is disarmed. Everything that was armed before (Dependabot, a collaborator) still is.
#
# The workflow checks nothing out, so its logic cannot be a script in the tree. This test therefore
# EXTRACTS the `run:` block of the `Decide whether this author may be armed` step from the YAML and
# runs that very text against a fake `gh` serving JSON fixtures shaped like the real API answers
# (read off #296, 2026-08-31), with every `--jq` the step passes run by the real jq. What is tested
# is what ships, not a copy of it.
#
# Usage: .github/scripts/tests/arm-auto-merge-app.test.sh   (no arguments, no network)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wf="$here/../../workflows/arm-auto-merge.yml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
passes=0

command -v jq >/dev/null 2>&1 || {
  echo "FAIL jq is required by the arming step and by this test"
  exit 1
}

pass() {
  echo "ok   $1"
  passes=$((passes + 1))
}
fail() {
  echo "FAIL $1"
  shift
  [ $# -gt 0 ] && printf '%s\n' "$*" | sed 's/^/     /'
  failures=$((failures + 1))
}

# The step's script: lines after its `- name:` ... `run: |`, up to the next step, de-indented.
awk '
  /^      - name: Decide whether this author may be armed/ { inside = 1; next }
  inside && /^      - name:/ { exit }
  inside && /^        run: \|/ { inrun = 1; next }
  inside && inrun { sub(/^          /, ""); print }
' "$wf" >"$work/step.raw"

if ! grep -q 'canari-auto-merge\[bot\]' "$work/step.raw"; then
  fail "the authz step's run block could not be extracted - the test and the workflow disagree"
  exit 1
fi

# `${{ ... == 'dependabot[bot]' }}` is a GitHub expression; the run replaces it with its value.
make_script() { # <true|false>
  sed "s/\${{ github.event.pull_request.user.login == 'dependabot\[bot\]' }}/$1/" "$work/step.raw" >"$work/step.sh"
}

mkdir -p "$work/bin"
cat >"$work/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_GH_LOG"
[ "${FAKE_API_FAIL:-}" = 1 ] && [ "$1" = api ] && { echo "HTTP 500" >&2; exit 1; }
jqexpr=''
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = --jq ] && jqexpr="${args[$((i + 1))]}"
done
serve() { if [ -n "$jqexpr" ]; then jq -r "$jqexpr" "$1"; else cat "$1"; fi; }
case "$1 ${2:-}" in
  api*/permission) echo "${FAKE_PERMISSION:-read}" ;;
  api*)
    key="$(printf '%s' "$2" | sed 's#^repos/o/r/##; s#[/?=&]#_#g')"
    [ -f "$FIX/$key.json" ] || { echo "HTTP 404 $2" >&2; exit 1; }
    serve "$FIX/$key.json"
    ;;
  "pr view") serve "$FIX/armed.json" ;;
  "pr merge") ;;
esac
SH
chmod +x "$work/bin/gh"

DEP_EMAIL='49699333+dependabot[bot]@users.noreply.github.com'
APP='canari-auto-merge[bot]'
REF='deps/lock-refresh/cargo/dependabot-12'
MSG=$'chore(deps): bump serde\n\n---\nupdated-dependencies:\n- dependency-name: serde\n  dependency-version: 1.0.5\n...\n'

# A commit as the API answers it: login (or null), address, committer login, signature verdict.
commit() { # <author login|null> <address> <committer login> <verified> <message>
  jq -n --arg a "$1" --arg e "$2" --arg c "$3" --argjson v "$4" --arg m "$5" \
    '{author: (if $a == "null" then null else {login: $a} end), committer: {login: $c},
      commit: {message: $m, author: {email: $e}, verification: {verified: $v}}}'
}

# fixtures: the well-formed case, which each case below then breaks in exactly one place.
fixtures() {
  rm -rf "$work/fix"
  mkdir -p "$work/fix"
  F="$work/fix"
  echo '{"user": {"login": "dependabot[bot]"}, "head": {"ref": "dependabot/cargo/frontend/mls-core/serde-1.0.5"}}' >"$F/pulls_12.json"
  commit 'dependabot[bot]' "$DEP_EMAIL" web-flow true "$MSG" | jq -s . >"$F/pulls_12_commits_per_page_100.json"
  {
    commit 'dependabot[bot]' "$DEP_EMAIL" "$APP" false "$MSG"
    commit "$APP" '323531864+canari-auto-merge[bot]@users.noreply.github.com' "$APP" false 'chore(deps): refresh the committed lockfiles for #12'
  } | jq -s . >"$F/pulls_5_commits_per_page_100.json"
  jq -n '[{filename: "frontend/mls-core/Cargo.toml", patch: "@@ -3,2 +3,2 @@\n [dependencies]\n-serde = \"1.0.0\"\n+serde = \"1.0.5\""}]' \
    >"$F/pulls_12_files_per_page_100.json"
  # The same manifest change at another line, with other context - a cherry-pick onto a newer main.
  jq -n '[{filename: "frontend/mls-core/Cargo.toml", patch: "@@ -7,3 +7,3 @@\n [dependencies]\n-serde = \"1.0.0\"\n+serde = \"1.0.5\"\n tokio = \"1\""},
          {filename: "frontend/mls-wasm/Cargo.lock", patch: "@@ -1 +1 @@\n-version = \"1.0.0\"\n+version = \"1.0.5\""},
          {filename: "frontend/src-tauri/Cargo.lock"}]' >"$F/pulls_5_files_per_page_100.json"
  echo '{"autoMergeRequest": null}' >"$F/armed.json"
}
edit() { # <fixture> <jq filter> - break the well-formed case in one place
  jq "$2" "$work/fix/$1.json" >"$work/fix/tmp" && mv "$work/fix/tmp" "$work/fix/$1.json"
}

# run_case <dependabot expr> <author> <head ref>  (FAKE_* in the environment) -> sets $out, $st
run_case() {
  make_script "$1"
  : >"$work/output"
  : >"$work/gh.log"
  out="$(cd "$work" && PATH="$work/bin:$PATH" GITHUB_OUTPUT="$work/output" REPO=o/r PR=5 AUTHOR="$2" HEAD_REF="$3" GH_TOKEN=x \
    FIX="$work/fix" FAKE_GH_LOG="$work/gh.log" bash "$work/step.sh" 2>&1)"
  st=$?
}
armed() { grep -qx 'armable=true' "$work/output"; }
not_armed() { # <name>
  if [ "$st" = 0 ] && ! armed; then pass "$1"; else fail "$1 (exit $st)" "$out"; fi
}

# ── B1: the one thing that IS armed ───────────────────────────────────────────────────────────────
fixtures
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && armed; then pass "B1 the App's lockfile refresh of a signed Dependabot pull request is armed"; else fail "B1 the well-formed refresh was not armed" "$out"; fi

# ── B2-B3: the branch ─────────────────────────────────────────────────────────────────────────────
fixtures
run_case false "$APP" 'feat/anything'
not_armed "B2 the App from any other branch is not armed"
# shellcheck disable=SC2016 # the dollar sign is the payload, kept literal on purpose
for ref in 'deps/lock-refresh/cargo/dependabot-12;touch PWNED' 'deps/lock-refresh/cargo/dependabot-$(touch PWNED)' \
  $'deps/lock-refresh/cargo/dependabot-12\nx' 'deps/lock-refresh/cargo/dependabot-012' 'deps/lock-refresh/npm/dependabot-12'; do
  run_case false "$APP" "$ref"
  if [ "$st" = 0 ] && ! armed && [ ! -e "$work/PWNED" ] && ! grep -q '^api' "$work/gh.log"; then
    pass "B3 a hostile or foreign refresh branch is refused before any API call: $(printf '%q' "$ref")"
  else
    fail "B3 the branch $(printf '%q' "$ref") was not refused cleanly (exit $st)" "$out"
  fi
done

# ── B4-B8: the original must be Dependabot's, every commit signed ─────────────────────────────────
fixtures
edit pulls_12 '.user.login = "someone"'
run_case false "$APP" "$REF"
not_armed "B4 an original that is not Dependabot's pull request is not armed"
fixtures
edit pulls_12_commits_per_page_100 '.[0].commit.verification.verified = false'
run_case false "$APP" "$REF"
not_armed "B5 an original commit GitHub did not sign is not armed"
fixtures
edit pulls_12_commits_per_page_100 '.[0].author = null | .[0].commit.author.email = "dependabot@lookalike.example"'
run_case false "$APP" "$REF"
not_armed "B6 a lookalike - the name without Dependabot's address and login - is not armed"
fixtures
edit pulls_12_commits_per_page_100 '.[0].committer.login = "someone"'
run_case false "$APP" "$REF"
not_armed "B7 an original commit committed by someone other than web-flow is not armed"
fixtures
edit pulls_12_commits_per_page_100 '. += [{author: {login: "github-actions[bot]"}, committer: {login: "web-flow"}, commit: {message: "Merge branch main", author: {email: "41898282+github-actions[bot]@users.noreply.github.com"}, verification: {verified: true}}}]'
run_case false "$APP" "$REF"
not_armed "B8 the real #296 shape - a signed github-actions merge commit on the original - is not armed"

# ── B9-B12: this pull request must be the original's commits plus the App's one ───────────────────
fixtures
edit pulls_5_commits_per_page_100 '. += [{author: {login: "a-person"}, committer: {login: "a-person"}, commit: {message: "tweak", author: {email: "p@x"}, verification: {verified: false}}}]'
run_case false "$APP" "$REF"
not_armed "B9 a person's commit pushed onto the refresh is not armed"
fixtures
edit pulls_5_commits_per_page_100 '.[0].commit.message = "chore(deps): bump serde, honest"'
run_case false "$APP" "$REF"
not_armed "B10 a carried commit whose message is not the original's is not armed"
fixtures
edit pulls_5_commits_per_page_100 '.[0].committer.login = "a-person"'
run_case false "$APP" "$REF"
not_armed "B11 a carried commit re-committed by anyone but the App is not armed"
fixtures
edit pulls_5_commits_per_page_100 '.[1].author = {login: "dependabot[bot]"}'
run_case false "$APP" "$REF"
not_armed "B12 a last commit that is not the App's own is not armed"

# ── B13-B16: the files ────────────────────────────────────────────────────────────────────────────
for f in 'frontend/src/app.ts' 'Cargo.lockx' 'notCargo.toml' 'frontend/Cargo.toml.bak' '.github/workflows/ci.yml' 'frontend/mls-core/build.rs'; do
  fixtures
  edit pulls_5_files_per_page_100 ". += [{filename: \"$f\"}]"
  run_case false "$APP" "$REF"
  not_armed "B13 '$f' is not a dependency file"
done
fixtures
edit pulls_5_files_per_page_100 '.[0].patch = "@@ -7,3 +7,3 @@\n-serde = \"1.0.0\"\n+serde = \"1.0.9\""'
run_case false "$APP" "$REF"
not_armed "B14 a manifest change that is not the one Dependabot signed is not armed"
fixtures
edit pulls_5_files_per_page_100 '. += [{filename: "apps/chat-gateway/Cargo.toml", patch: "@@ -1 +1 @@\n+evil = { git = \"https://example.invalid/x\" }"}]'
run_case false "$APP" "$REF"
not_armed "B15 a manifest the original never touched is not armed"
fixtures
edit pulls_5_files_per_page_100 'del(.[0].patch)'
run_case false "$APP" "$REF"
not_armed "B16 a manifest diff the API will not show is not armed (unknown is not equal)"

# ── B17-B18: an unreadable answer, and a refusal after the arming ─────────────────────────────────
fixtures
FAKE_API_FAIL=1 run_case false "$APP" "$REF"
if [ "$st" != 0 ] && ! armed; then pass "B17 an unreadable API answer FAILS the run and arms nothing"; else fail "B17 an API failure armed or passed (exit $st)" "$out"; fi
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
edit pulls_5_files_per_page_100 '. += [{filename: "frontend/src/app.ts"}]'
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B18 an ARMED refresh that no longer satisfies the allowlist is DISARMED"
else
  fail "B18 an armed refresh that fails the allowlist kept its arming (exit $st)" "$out" "$(cat "$work/gh.log")"
fi

# ── B19: everything that was armed before still is, and nothing else new is ───────────────────────
fixtures
run_case true 'dependabot[bot]' 'dependabot/cargo/x'
if [ "$st" = 0 ] && armed; then pass "B19 Dependabot is still armed"; else fail "B19 Dependabot is no longer armed" "$out"; fi
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" = 0 ] && armed; then pass "B19 a collaborator with write access is still armed"; else fail "B19 a collaborator is no longer armed" "$out"; fi
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=read run_case false 'a-stranger' 'fix/x'
not_armed "B19 a login without write access is not armed"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=read run_case false 'some-other-app[bot]' "$REF"
not_armed "B19 another bot on the refresh branch name is not armed"

# ── B20: `pull_request_target` runs with the base repository's secrets: it never checks out ───────
if grep -qE '^\s*-?\s*uses:\s*actions/checkout' "$wf"; then
  fail "B20 arm-auto-merge.yml checks out code under pull_request_target"
else
  pass "B20 arm-auto-merge.yml still checks nothing out"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures of $((passes + failures)) arm-auto-merge App assertion(s) FAILED"
  exit 1
fi
echo "all $passes arm-auto-merge App assertions passed"
