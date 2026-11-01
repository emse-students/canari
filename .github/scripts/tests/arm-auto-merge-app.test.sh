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
  "pr view") [ "${FAKE_VIEW_FAIL:-}" = 1 ] && { echo "HTTP 502" >&2; exit 1; }; serve "$FIX/armed.json" ;;
  "pr merge") ;;
esac
SH
chmod +x "$work/bin/gh"
# The runner's jq writes LF. A Windows jq writes CRLF, and the step would read every commit id as
# `<sha>\r` - a test-host artefact, so the shim gives the step the runner's line endings.
real_jq="$(command -v jq)"
printf '#!/usr/bin/env bash\nset -o pipefail\n"%s" "$@" | tr -d '"'"'\\r'"'"'\n' "$real_jq" >"$work/bin/jq"
chmod +x "$work/bin/jq"

DEP_EMAIL='49699333+dependabot[bot]@users.noreply.github.com'
APP='canari-auto-merge[bot]'
REF='deps/lock-refresh/cargo/dependabot-12'
MSG=$'chore(deps): bump serde\n\n---\nupdated-dependencies:\n- dependency-name: serde\n  dependency-version: 1.0.5\n...\n'

# A commit as the API answers it: login (or null), address, committer login, signature verdict.
commit() { # <sha> <author login|null> <address> <committer login> <verified> <message>
  jq -n --arg s "$1" --arg a "$2" --arg e "$3" --arg c "$4" --argjson v "$5" --arg m "$6" \
    '{sha: $s, author: (if $a == "null" then null else {login: $a} end), committer: {login: $c},
      commit: {message: $m, author: {email: $e}, verification: {verified: $v}}}'
}

O1="$(printf 'a%.0s' {1..40})"
M1="$(printf 'b%.0s' {1..40})"
M2="$(printf 'c%.0s' {1..40})"
CRATES='source = \"registry+https://github.com/rust-lang/crates.io-index\"'
# Dependabot's manifest change, as one commit carries it and as a cherry-pick onto a newer main
# carries it (other line numbers, other context, the same changed lines).
TOML_ORIG='@@ -3,2 +3,2 @@\n [dependencies]\n-serde = \"1.0.0\"\n+serde = \"1.0.5\"'
TOML_PICK='@@ -7,3 +7,3 @@\n [dependencies]\n-serde = \"1.0.0\"\n+serde = \"1.0.5\"\n tokio = \"1\"'
LOCK_WASM="@@ -10,3 +10,3 @@\n name = \\\"serde\\\"\n-version = \\\"1.0.0\\\"\n+version = \\\"1.0.5\\\"\n $CRATES"
LOCK_TAURI="@@ -10,3 +10,7 @@\n name = \\\"serde\\\"\n-version = \\\"1.0.0\\\"\n+version = \\\"1.0.5\\\"\n $CRATES\n+\n+[[package]]\n+name = \\\"itoa\\\"\n+version = \\\"1.0.0\\\"\n+$CRATES"

# fixtures: the well-formed case, which each case below then breaks in exactly one place.
fixtures() {
  rm -rf "$work/fix"
  mkdir -p "$work/fix"
  F="$work/fix"
  echo '{"user": {"login": "dependabot[bot]"}, "head": {"ref": "dependabot/cargo/frontend/mls-core/serde-1.0.5"}}' >"$F/pulls_12.json"
  commit "$O1" 'dependabot[bot]' "$DEP_EMAIL" web-flow true "$MSG" | jq -s . >"$F/pulls_12_commits_per_page_100.json"
  {
    commit "$M1" 'dependabot[bot]' "$DEP_EMAIL" "$APP" false "$MSG"
    commit "$M2" "$APP" '323531864+canari-auto-merge[bot]@users.noreply.github.com' "$APP" false 'chore(deps): refresh the committed lockfiles for #12'
  } | jq -s . >"$F/pulls_5_commits_per_page_100.json"
  echo "{\"files\": [{\"filename\": \"frontend/mls-core/Cargo.toml\", \"patch\": \"$TOML_ORIG\"}]}" >"$F/commits_$O1.json"
  echo "{\"files\": [{\"filename\": \"frontend/mls-core/Cargo.toml\", \"patch\": \"$TOML_PICK\"}]}" >"$F/commits_$M1.json"
  echo "{\"files\": [{\"filename\": \"frontend/mls-wasm/Cargo.lock\", \"patch\": \"$LOCK_WASM\"}, {\"filename\": \"frontend/src-tauri/Cargo.lock\", \"patch\": \"$LOCK_TAURI\"}]}" >"$F/commits_$M2.json"
  echo "[{\"filename\": \"frontend/mls-core/Cargo.toml\", \"patch\": \"$TOML_ORIG\"}]" >"$F/pulls_12_files_per_page_100.json"
  echo "[{\"filename\": \"frontend/mls-core/Cargo.toml\", \"patch\": \"$TOML_PICK\"},
         {\"filename\": \"frontend/mls-wasm/Cargo.lock\", \"patch\": \"$LOCK_WASM\"},
         {\"filename\": \"frontend/src-tauri/Cargo.lock\", \"patch\": \"$LOCK_TAURI\"}]" >"$F/pulls_5_files_per_page_100.json"
  for j in "$F"/*.json; do jq -e . "$j" >/dev/null || echo "FIXTURE BROKEN: $j"; done
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
    HEAD_SHA="${CASE_HEAD:-$M2}" EVENT_ACTION="${CASE_ACTION:-synchronize}" FIX="$work/fix" FAKE_GH_LOG="$work/gh.log" bash "$work/step.sh" 2>&1)"
  st=$?
}
# Armed: by the shared step (`armable=true`), or - the App's path - by the step itself, bound to the
# event's head commit.
armed() { grep -qx 'armable=true' "$work/output" || grep -q -- '^pr merge 5 --auto' "$work/gh.log"; }
app_armed_on_head() { grep -qxF "pr merge 5 --auto --squash --match-head-commit $M2 --repo o/r" "$work/gh.log" && ! grep -qx 'armable=true' "$work/output"; }
not_armed() { # <name>
  if [ "$st" = 0 ] && ! armed; then pass "$1"; else fail "$1 (exit $st)" "$out"; fi
}

# ── B1: the one thing that IS armed ───────────────────────────────────────────────────────────────
fixtures
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && app_armed_on_head; then pass "B1 the App's lockfile refresh of a signed Dependabot pull request is armed, on the event's head commit only"; else fail "B1 the well-formed refresh was not armed on its head commit" "$out" "$(cat "$work/gh.log")"; fi

# ── B2-B3: the branch ─────────────────────────────────────────────────────────────────────────────
fixtures
run_case false "$APP" 'feat/anything'
not_armed "B2 the App from any other branch is not armed"
# shellcheck disable=SC2016 # the dollar sign is the payload, kept literal on purpose
for ref in 'deps/lock-refresh/cargo/dependabot-12;touch PWNED' 'deps/lock-refresh/cargo/dependabot-$(touch PWNED)' \
  $'deps/lock-refresh/cargo/dependabot-12\nx' 'deps/lock-refresh/cargo/dependabot-012' 'deps/lock-refresh/npm/dependabot-12'; do
  run_case false "$APP" "$ref"
  # The ONE call before the branch is read is the owner's-files check, by pull request number only
  # (B32); nothing derived from the branch name reaches the API.
  if [ "$st" = 0 ] && ! armed && [ ! -e "$work/PWNED" ] && ! grep '^api' "$work/gh.log" | grep -vqxF 'api repos/o/r/pulls/5/files?per_page=100 --paginate --jq .[] | [.filename, (.previous_filename // "")] | @tsv'; then
    pass "B3 a hostile or foreign refresh branch is refused before any API call it names: $(printf '%q' "$ref")"
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
edit pulls_12_commits_per_page_100 '. += [{sha: ("e" * 40), author: {login: "github-actions[bot]"}, committer: {login: "web-flow"}, commit: {message: "Merge branch main", author: {email: "41898282+github-actions[bot]@users.noreply.github.com"}, verification: {verified: true}}}]'
echo '{"files": []}' >"$work/fix/commits_$(printf 'e%.0s' {1..40}).json"
run_case false "$APP" "$REF"
not_armed "B8 the real #296 shape - a signed github-actions merge commit on the original - is not armed"

# ── B9-B12: this pull request must be the original's commits plus the App's one ───────────────────
fixtures
edit pulls_5_commits_per_page_100 '. += [{sha: ("d" * 40), author: {login: "a-person"}, committer: {login: "a-person"}, commit: {message: "tweak", author: {email: "p@x"}, verification: {verified: false}}}]'
echo '{"files": []}' >"$work/fix/commits_$(printf 'd%.0s' {1..40}).json"
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

# ── B21-B27: the review of #2135 ──────────────────────────────────────────────────────────────────
# F2: an answer that cannot be read on a `synchronize` must not leave the old arming standing.
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
FAKE_API_FAIL=1 run_case false "$APP" "$REF"
if [ "$st" != 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B21 an unreadable API answer DISARMS (best effort) and fails the run"
else
  fail "B21 an unreadable answer left the arming standing (exit $st)" "$out" "$(cat "$work/gh.log")"
fi
fixtures
edit pulls_5_files_per_page_100 '. += [{filename: "frontend/src/app.ts"}]'
FAKE_VIEW_FAIL=1 run_case false "$APP" "$REF"
if ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B22 a refusal whose arming state cannot be read disarms anyway"
else
  fail "B22 a refusal with an unreadable arming state did not disarm (exit $st)" "$out" "$(cat "$work/gh.log")"
fi

# F3: a carried commit is compared by PATCH with the original, not by message.
fixtures
jq '.files[0].patch = "@@ -7,3 +7,3 @@\n-serde = \"1.0.0\"\n+serde = \"1.0.9\""' "$work/fix/commits_$M1.json" >"$work/fix/tmp" && mv "$work/fix/tmp" "$work/fix/commits_$M1.json"
run_case false "$APP" "$REF"
not_armed "B23 a carried commit with the original's MESSAGE but another patch is not armed"
fixtures
edit pulls_5_files_per_page_100 '.[2].patch += "\n+source = \"git+https://example.invalid/evil#abc\""'
run_case false "$APP" "$REF"
not_armed "B24 a lockfile gaining a git source is not armed"
fixtures
edit pulls_5_files_per_page_100 '.[2].patch += "\n+source = \"registry+https://example.invalid/index\""'
run_case false "$APP" "$REF"
not_armed "B24b a lockfile gaining another registry is not armed"
fixtures
edit pulls_5_files_per_page_100 '.[1].patch = "@@ -40,3 +40,3 @@\n name = \"tauri\"\n-version = \"2.11.1\"\n+version = \"2.99.0\""'
run_case false "$APP" "$REF"
not_armed "B25 a lockfile moving tauri is not armed"
fixtures
edit pulls_5_files_per_page_100 '.[2].patch += "\n+[[package]]\n+name = \"wry\"\n+version = \"0.50.0\""'
run_case false "$APP" "$REF"
not_armed "B25b a lockfile adding wry is not armed"
fixtures
edit pulls_5_files_per_page_100 'del(.[2].patch)'
run_case false "$APP" "$REF"
not_armed "B26 a lockfile diff the API will not show is not armed"
fixtures
edit pulls_5_commits_per_page_100 '.[1].commit.author.email = "somebody@else.example"'
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && app_armed_on_head; then
  pass "B27 the App commit's ADDRESS is not what is relied on: its content is (armed on content alone)"
else
  fail "B27 the arming depended on an address after all (exit $st)" "$out"
fi

# ── B28-B31: the second review of #2135 ───────────────────────────────────────────────────────────
# H2: the evaluation is of ONE head commit. An event whose head is not the one the commit list ends
# on (the branch moved between the event and the reads) is refused - the run for the new head decides.
fixtures
CASE_HEAD="$(printf 'f%.0s' {1..40})" run_case false "$APP" "$REF"
not_armed "B28 a head commit other than the event's is not armed"
fixtures
CASE_HEAD='not-a-sha' run_case false "$APP" "$REF"
not_armed "B28b an event without a well-formed head commit id is not armed"
# A commit list longer than this check reads is refused, not truncated.
fixtures
# shellcheck disable=SC2016 # `$i` is a jq variable, not a shell one
edit pulls_5_commits_per_page_100 '[range(19) as $i | .[0] | .sha = ("1" * 39 + ($i | tostring | .[-1:]))] + .'
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && ! armed && grep -q 'longer than this check reads' <<<"$out"; then
  pass "B29 21 commits on the refresh is refused before any per-commit read"
else
  fail "B29 21 commits were not refused as too long (exit $st)" "$out"
fi
# The sparse index is crates.io too.
fixtures
edit pulls_5_files_per_page_100 '.[2].patch += "\n+\n+[[package]]\n+name = \"ryu\"\n+version = \"1.0.0\"\n+source = \"sparse+https://index.crates.io/\""'
run_case false "$APP" "$REF"
if [ "$st" = 0 ] && app_armed_on_head; then pass "B30 a lockfile gaining the SPARSE crates.io index is armed"; else fail "B30 the sparse crates.io index was refused (exit $st)" "$out"; fi
# H1: a TOML key is a key whatever its spacing or quoting.
for line in '+source=\"git+https://example.invalid/evil#abc\"' '+ source = \"git+https://example.invalid/evil#abc\"' \
  '+\"source\" = \"git+https://example.invalid/evil#abc\"'; do
  fixtures
  edit pulls_5_files_per_page_100 ".[2].patch += \"\\n$line\""
  run_case false "$APP" "$REF"
  if [ "$st" = 0 ] && ! armed && grep -q 'not crates.io' <<<"$out"; then
    pass "B31 a foreign source spelled $line is refused as one"
  else
    fail "B31 the foreign source $line was not refused as one (exit $st)" "$out"
  fi
done
for line in '+name=\"tauri\"' '+ name = \"wry\"' "+'name' = 'tao'"; do
  fixtures
  edit pulls_5_files_per_page_100 ".[2].patch += \"\\n+[[package]]\\n$line\\n+version = \\\"9.0.0\\\"\""
  run_case false "$APP" "$REF"
  if [ "$st" = 0 ] && ! armed && grep -q 'Tauri runtime' <<<"$out"; then
    pass "B31b a runtime crate spelled $line is refused as one"
  else
    fail "B31b the runtime crate $line was not refused as one (exit $st)" "$out"
  fi
done

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

# ── B32: a pull request that approves a held migration is merged by the owner's hand, never armed ─
# infrastructure/migration-approvals.txt is the owner's yes to a migration the deploy would otherwise
# refuse; armed, it would merge itself on a green CI and the yes would be anybody's (review of #2873).
APPROVALS='infrastructure/migration-approvals.txt'
fixtures
edit pulls_5_files_per_page_100 ". += [{filename: \"$APPROVALS\"}]"
run_case true 'dependabot[bot]' 'dependabot/cargo/x'
if [ "$st" = 0 ] && ! armed && grep -q 'merged by the OWNER' <<<"$out"; then pass "B32 Dependabot touching the approvals file is not armed, and the run says why"; else fail "B32 Dependabot touching the approvals file was armed (exit $st)" "$out"; fi
fixtures
edit pulls_5_files_per_page_100 ". += [{filename: \"$APPROVALS\"}]"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=admin run_case false 'an-admin' 'chore/approve-042'
not_armed "B32 even an admin's pull request touching the approvals file is not armed"
fixtures
edit pulls_5_files_per_page_100 ". += [{filename: \"$APPROVALS\"}]"
run_case false "$APP" "$REF"
not_armed "B32 the App's refresh touching the approvals file is not armed"
fixtures
edit pulls_5_files_per_page_100 ". += [{filename: \"elsewhere.txt\", previous_filename: \"$APPROVALS\"}]"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
not_armed "B32 a pull request that RENAMES the approvals file away is not armed either"
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
edit pulls_5_files_per_page_100 ". += [{filename: \"$APPROVALS\"}]"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" = 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B32 a push that adds the approvals file to an ARMED pull request DISARMS it"
else
  fail "B32 an armed pull request kept its arming after the approvals file was added (exit $st)" "$out" "$(cat "$work/gh.log")"
fi
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_API_FAIL=1 FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" != 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B32 an unreadable file list fails the run, arms nothing and disarms"
else
  fail "B32 an unreadable file list armed or passed (exit $st)" "$out"
fi

# The judge and everything that decides what an approval means are the owner's files too (second
# review of #2873): a pull request weakening the classifier would otherwise merge itself.
for owned in infrastructure/lib/migration-hold.sh infrastructure/lib/migrations.sh .github/workflows/arm-auto-merge.yml .github/CODEOWNERS; do
  fixtures
  edit pulls_5_files_per_page_100 ". += [{filename: \"$owned\"}]"
  # shellcheck disable=SC2209 # a per-call variable for a shell function
  FAKE_PERMISSION=admin run_case false 'an-admin' 'fix/x'
  if [ "$st" = 0 ] && ! armed && grep -qF "changes $owned" <<<"$out"; then pass "B32 a pull request touching $owned is not armed"; else fail "B32 a pull request touching $owned was armed (exit $st)" "$out"; fi
done
# AN ARMING MADE BY HAND is an event now (auto_merge_enabled): on the owner's files it is undone,
# anywhere else it is left alone and not repeated.
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
edit pulls_5_files_per_page_100 ". += [{filename: \"$APPROVALS\"}]"
# shellcheck disable=SC2209 # a per-call variable for a shell function
CASE_ACTION=auto_merge_enabled FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" = 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log"; then
  pass "B32 a hand-made arming (auto_merge_enabled) of a pull request touching the approvals file is DISARMED"
else
  fail "B32 a hand-made arming of an approvals pull request stayed (exit $st)" "$out" "$(cat "$work/gh.log")"
fi
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
# shellcheck disable=SC2209 # a per-call variable for a shell function
CASE_ACTION=auto_merge_enabled FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" = 0 ] && ! armed && ! grep -q '^pr merge' "$work/gh.log" && ! grep -q 'permission' "$work/gh.log"; then
  pass "B32 a hand-made arming elsewhere is neither undone nor repeated, and asks nothing more"
else
  fail "B32 auto_merge_enabled on an ordinary pull request did something (exit $st)" "$out" "$(cat "$work/gh.log")"
fi
# GITHUB LISTS AT MOST 3000 FILES: a list at the cap may have cut the owner's file off.
fixtures
echo '{"autoMergeRequest": {"mergeMethod": "SQUASH"}}' >"$work/fix/armed.json"
jq -n '[range(3000) | {filename: "f\(.).txt"}]' >"$work/fix/pulls_5_files_per_page_100.json"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" != 0 ] && ! armed && grep -q '^pr merge 5 --disable-auto' "$work/gh.log" && grep -q 'its cap' <<<"$out"; then
  pass "B32 a file list at GitHub's 3000 cap refuses, arms nothing and disarms"
else
  fail "B32 a file list at the cap was trusted (exit $st)" "$out"
fi
fixtures
jq -n '[range(2999) | {filename: "f\(.).txt"}]' >"$work/fix/pulls_5_files_per_page_100.json"
# shellcheck disable=SC2209 # a per-call variable for a shell function
FAKE_PERMISSION=write run_case false 'a-collaborator' 'fix/x'
if [ "$st" = 0 ] && armed; then pass "B32 2999 files, none the owner's, is armed as before"; else fail "B32 a 2999-file pull request was not armed (exit $st)" "$out"; fi
# THE TWO LISTS ARE ONE: the workflow's and .github/CODEOWNERS', line for line.
wf_list="$(awk -v q="'" '$0 ~ "^owner_files=" q { inside = 1; sub("^owner_files=" q, "") } inside { line = $0; done = sub(q "$", "", line); sub(/^[ \t]+/, "", line); print line; if (done) exit }' "$work/step.raw" | sort)"
co_list="$(grep -vE '^[[:space:]]*(#|$)' "$here/../../CODEOWNERS" | awk '{ sub(/^\//, "", $1); print $1 }' | sort)"
co_owners="$(grep -vE '^[[:space:]]*(#|$)' "$here/../../CODEOWNERS" | awk '{ $1 = ""; print }' | sort -u)"
if [ -n "$wf_list" ] && [ "$wf_list" = "$co_list" ] && [ "$co_owners" = ' @DeMASKe' ]; then
  pass "B32 the workflow's owner files and .github/CODEOWNERS are the same $(grep -c . <<<"$wf_list") paths, all the owner's"
else
  fail "B32 the workflow's owner files and .github/CODEOWNERS differ" "workflow: $wf_list" "CODEOWNERS: $co_list ($co_owners)"
fi
if grep -qE '^ +types: \[[a-z_, ]*auto_merge_enabled\]' "$wf"; then
  pass "B32 the workflow listens to auto_merge_enabled, so an arming made by hand is judged too"
else
  fail "B32 arm-auto-merge.yml does not listen to auto_merge_enabled"
fi

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
