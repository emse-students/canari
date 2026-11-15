#!/usr/bin/env bash
# THE LOCAL HALF OF CI: what runs at COMMIT, what runs at PUSH, and what stays in CI ONLY.
#
# THE OWNER'S DECISION (2026-11-15): *"tout ce qui est verifie a la PR devrait etre verifie au
# commit, la fusion de PR devrait etre une formalite"*. Three tiers follow from it:
#   commit   fast checks scoped to the STAGED files - doc links, the plan, the private-data guard,
#            the native-log guard, the controls ratchet, the touched module's own unit tests.
#   push     everything that CAN run on a workstation, scoped exactly as CI scopes it (the same
#            `ci-scopes.sh`), after merging the latest origin/main so the run tests what CI tests.
#   ci-only  what a Windows workstation cannot run: listed in JOB_TIERS below with the reason.
# Every command a check runs is `checks.sh`'s or a Make target's - this file decides WHEN, never
# HOW. The inventory, with measured durations, is docs/wiki/cicd.md
# ("Checks at commit, at push, and in CI only").
#
# Usage:
#   local-ci.sh commit             called by .husky/pre-commit, after the fixers
#   local-ci.sh push <remote>      called by .husky/pre-push, the pushed refs on stdin
#   local-ci.sh all                every local check, whatever changed (`make run-ci`)
#   local-ci.sh tiers              print JOB_TIERS (read by local-ci.test.sh)
# LOCAL_CI_DRY_RUN=1 prints `PLAN <check>: <command>` for each check instead of running it, and counts it
# passed - how the self-test exercises the decisions without paying for the checks.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# A HOOK INHERITS GIT_DIR (and GIT_INDEX_FILE at commit), AND EVERY CHECK BELOW INHERITS THE HOOK.
# A self-test that builds a scratch repository with `git -C "$dir" ...` then writes into THIS
# repository instead: on 2026-11-15 the push tier's run of local-ci.test.sh committed "base" twice
# on the branch being pushed and wrote a test identity, with signing off, into the shared
# .git/config. CI never sets them, so no check was written to survive them. Git finds this
# repository from the working directory, so they carry nothing a check needs - except the index a
# partial commit (`git commit <path>`) stages into, kept here for the one read of what is staged.
COMMIT_INDEX="${GIT_INDEX_FILE:-${LOCAL_CI_COMMIT_INDEX:-}}"
export LOCAL_CI_COMMIT_INDEX="$COMMIT_INDEX" # the helper modes below run as child processes
# shellcheck disable=SC2046 # one variable name per word, by construction
unset $(git rev-parse --local-env-vars)
# What this commit stages, read from the index git is committing.
staged_paths() { # <diff-filter> [-- <pathspec>...]
  local filter="$1"
  shift
  if [ -n "$COMMIT_INDEX" ]; then
    GIT_INDEX_FILE="$COMMIT_INDEX" git diff --cached --name-only --diff-filter="$filter" "$@"
  else
    git diff --cached --name-only --diff-filter="$filter" "$@"
  fi
}

# EVERY JOB OF ci.yml, AND WHERE IT RUNS BEFORE THE PULL REQUEST. `local-ci.test.sh` fails when a
# job of ci.yml is missing here, so a new CI job cannot arrive without deciding its local tier, and
# when a job named here is not in ci.yml any more, so the table cannot rot.
#   job                              tier      what runs locally, or why nothing can
JOB_TIERS='
changes                            push      ci-scopes.sh, the script the CI job calls
test-rust                          push      checks.sh rust, per crate in scope (the gateway Redis half: CI only)
boot-nest-apps                     ci-only   boots each service on PostgreSQL, Redis and an S3 endpoint
test-social-integration            ci-only   integration specs on PostgreSQL and Redis
test-chat-delivery-integration     ci-only   integration specs on PostgreSQL
test-typescript-backend            push      checks.sh ts, per service in scope
test-frontend                      push      frontend-prepare, frontend-lint, dead-code, frontend-build in scope
test-frontend-shards               push      checks.sh frontend-test, the whole suite in one run
test-android                       push      android-unit-tests.sh (a JDK)
compile-android-app                ci-only   needs the Android SDK and NDK
compile-ios-app                    ci-only   needs macOS and Xcode
test-call-service-e2e              ci-only   coturn and five headless browsers on a Linux runner
test-harness                       push      make test-harness
test-ci-scripts                    push      make test-ci-scripts when the range touches CI_SCRIPTS_PATHS; its whole-tree scans and the path rules always
dependency-ceiling                 ci-only   decides on a Dependabot pull request only
security                           split     the lockfile guards at push; CodeQL and the secret scan in CI only
dependency-audit                   ci-only   a verdict on the advisory databases, not on the commit; ~5 min per tree
mls-forward-compat                 push      mls-forward-compat.sh
test-miconnect-blueprints          ci-only   a full Authentik pair in Docker, twice
upstream-monitor-freshness         ci-only   a push to main only; reads GitHub
ci-passed                          ci-only   the aggregation of the jobs above
'

STATE_DIR="$(git rev-parse --git-path canari-local-ci)"
mkdir -p "$STATE_DIR"
# The commit a push run verified, per worktree. It answers ONE question - "did every local check
# pass on exactly this commit" - and a commit is immutable, so it cannot go stale.
STAMP="$STATE_DIR/verified-head"
ZERO=0000000000000000000000000000000000000000

say() { printf '%s\n' "$*"; }
refuse() {
  say ""
  say "REFUSED: $*"
  exit 1
}

# THE HOOKS ARE THE TRACKED `.husky/`, AND THIS IS WHERE THAT IS ASSERTED (2026-11-15).
# `core.hooksPath` lives in the git directory every worktree shares. Unset, or `.husky/_` (husky's
# generated wrappers, absent from a fresh worktree), it disarms the hooks of some checkouts with no
# message at all - both were found on this workstation that day. A hook that runs is the one place
# that can see it, so both tiers refuse until it is fixed. The value is HOOKS_PATH in
# frontend/scripts/hooks-path.js; local-ci.test.sh asserts the two agree.
HOOKS_PATH=.husky
assert_hooks_path() {
  local value
  value="$(git config core.hooksPath || true)"
  [ "$value" = "$HOOKS_PATH" ] && return 0
  refuse "core.hooksPath is '${value:-<unset>}', not '$HOOKS_PATH' (the tracked hooks). Every worktree shares it, and any other value leaves some checkout with no hook and no message. Fix it once: git config core.hooksPath $HOOKS_PATH  - an older branch's .husky/pre-commit runs from there too."
}

# ── Running one check ────────────────────────────────────────────────────────────────────────────
CHECK_INDEX=0
CHECK_TOTAL=0
TIER=""

# Runs one named check, its output into a log, a progress line before and after. Fails the run on
# the first red check (a push waits for every check, and the next ones would cost minutes to say
# nothing new), with the end of the log printed so the reason is on screen.
run_check() {
  local name="$1"
  shift
  CHECK_INDEX=$((CHECK_INDEX + 1))
  if [ "${LOCAL_CI_DRY_RUN:-}" = "1" ]; then
    say "PLAN $name: $*"
    return 0
  fi
  local log
  log="$STATE_DIR/$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '_').log"
  local start=$SECONDS
  say "[$TIER $CHECK_INDEX/$CHECK_TOTAL] $name ..."
  if "$@" >"$log" 2>&1; then
    say "[$TIER $CHECK_INDEX/$CHECK_TOTAL] $name ok ($((SECONDS - start))s)"
  else
    say "[$TIER $CHECK_INDEX/$CHECK_TOTAL] $name FAILED ($((SECONDS - start))s) - the end of $log:"
    tail -n 40 "$log" | sed 's/^/    /'
    refuse "$name failed. Fix the cause and run it again; the full output is in $log"
  fi
}

# Runs a planned list: one `name|command words...` entry per line.
run_plan() {
  local plan="$1"
  CHECK_INDEX=0
  CHECK_TOTAL=$(printf '%s\n' "$plan" | grep -c . || true)
  local started=$SECONDS line name
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%|*}"
    local words
    read -r -a words <<<"${line#*|}"
    run_check "$name" "${words[@]}"
  done <<<"$plan"
  [ "${LOCAL_CI_DRY_RUN:-}" = "1" ] || say "[$TIER] $CHECK_TOTAL check(s) green in $((SECONDS - started))s"
}

# ── Generated artefacts ──────────────────────────────────────────────────────────────────────────
# The WASM is rebuilt when its inputs changed, keyed exactly like the CI cache in
# `.github/actions/build-mls-wasm` (both crates and the toolchain file), plus the wasm-pack
# version. The key is written beside the artefact, in a directory nothing commits.
WASM_DIR=frontend/src/lib/wasm
WASM_KEY_FILE="$WASM_DIR/.canari-source-key"

wasm_key() {
  printf '%s %s %s %s\n' \
    "$(git rev-parse HEAD:frontend/mls-wasm)" "$(git rev-parse HEAD:frontend/mls-core)" \
    "$(git rev-parse HEAD:rust-toolchain.toml)" "$(wasm-pack --version 2>/dev/null || echo none)"
}

# The push-tier preparation of the frontend: dependencies, SvelteKit sync, protobuf (always - they
# are seconds), and the WASM when its key changed. The pinned wasm-pack is installed first, by the
# script CI uses; on Windows it has no prebuilt binary, refuses, and names the cargo command.
frontend_generated() {
  bash .github/scripts/checks.sh frontend-prepare
  if [ ! -s "$WASM_DIR/mls_wasm_bg.wasm" ] || [ "$(cat "$WASM_KEY_FILE" 2>/dev/null)" != "$(wasm_key)" ]; then
    echo "the MLS WASM is missing or was built from other sources: rebuilding it"
    bash ./scripts/install-wasm-pack.sh
    bash .github/scripts/checks.sh mls-wasm-build
    wasm_key >"$WASM_KEY_FILE"
  else
    echo "the MLS WASM was built from these sources ($(cat "$WASM_KEY_FILE"))"
  fi
  bash .github/scripts/checks.sh mls-wasm-verify
}

# What `make test-ci-scripts` tests: the CI scripts and workflows, the hooks, the Makefile, the
# deploy and infrastructure scripts, the shared libs and the pinned tool versions.
CI_SCRIPTS_PATHS='^(\.github/|\.husky/|Makefile$|scripts/|infrastructure/|libs/|\.[a-z-]+-version$)'

# ── The push plan, from the same scopes CI computes ──────────────────────────────────────────────
# Prints `name|command` lines, cheap checks first. CI-only jobs this change would trigger are
# named on stderr, so the reader knows what the push did NOT prove.
push_plan() {
  local base="$1" scopes
  scopes="$(CI_WORKFLOW=.github/workflows/ci.yml bash .github/scripts/ci-scopes.sh "$base" HEAD 2>"$STATE_DIR/scopes.log")"
  scope() { printf '%s\n' "$scopes" | sed -n "s/^$1=//p"; }

  # The path rules over the whole range: the docs, plan, private-name, duplicate and CI-definition
  # gates a docs-only push owes, in seconds.
  local range moved
  if [ -n "$base" ]; then
    range="$(git diff --name-only --diff-filter=ACMRD "$base" HEAD)"
    moved="$(git diff --name-only --diff-filter=DR "$base" HEAD)"
    commit_rules "$(git diff --name-only --diff-filter=ACMR "$base" HEAD)" "$range" "$moved" push
  fi
  # The whole-tree scans of `make test-ci-scripts`, seconds each, whatever the range touched.
  local t=.github/scripts/tests
  echo "control-characters|bun $t/control-characters.test.mjs"
  echo "no-nul-in-source|bun $t/no-nul-in-source.test.mjs"
  echo "line-endings|bun $t/line-endings.test.mjs"
  # THE SUITE ITSELF RUNS WHEN THE RANGE TOUCHES WHAT IT TESTS (owner's lead, 2026-11-15: a push is
  # gated like a pull request, not like a release). CI runs it on every pull request, 6 min on a
  # runner; here it is 43 min, so a push that touches none of these leaves its source guards (those
  # that read the frontend or services' sources) to CI - the one place the push proves less, said
  # by name on stderr.
  if [ -z "$base" ] || grep -qE "$CI_SCRIPTS_PATHS" <<<"$range"; then
    echo "test-ci-scripts|make test-ci-scripts"
  else
    echo "CI only for this range: test-ci-scripts beyond its whole-tree scans and the path rules" >&2
  fi
  echo "raw-controls-ratchet|bun .github/scripts/ratchet-not-raised.mjs ${base:-origin/main}"
  echo "lockfile-version|bash .github/scripts/checks.sh lockfile-version"
  echo "tauri-parity|bash .github/scripts/checks.sh tauri-parity"
  [ "$(scope harness)" = "true" ] && echo "test-harness|make test-harness"
  if [ "$(scope frontend)" = "true" ]; then
    echo "frontend-generated|bash .github/scripts/local-ci.sh generated"
    echo "frontend-lint|bash .github/scripts/checks.sh frontend-lint"
    echo "dead-code|bash .github/scripts/checks.sh dead-code"
    echo "frontend-test|bash .github/scripts/checks.sh frontend-test"
    [ "$(scope frontend_build)" = "true" ] && echo "frontend-build|bash .github/scripts/checks.sh frontend-build $(git rev-parse HEAD)"
  fi
  local svc crate
  for svc in $(scope ts | grep -o '"apps/[^"]*"' | tr -d '"'); do
    echo "ts $svc|bash .github/scripts/checks.sh ts $svc"
    case "$svc" in
      apps/social-service) echo "CI only: test-social-integration (PostgreSQL)" >&2 ;;
      apps/chat-delivery-service) echo "CI only: test-chat-delivery-integration (PostgreSQL)" >&2 ;;
    esac
  done
  [ "$(scope ts)" != "[]" ] && echo "CI only: boot-nest-apps (PostgreSQL, Redis, S3)" >&2
  for crate in $(scope rust | grep -o '"path":"[^"]*"' | sed 's/"path":"//; s/"$//'); do
    echo "rust $crate|bash .github/scripts/checks.sh rust $crate"
  done
  [ "$(scope android)" = "true" ] && echo "android-unit|bash .github/scripts/android-unit-tests.sh"
  [ "$(scope mls_compat)" = "true" ] && echo "mls-forward-compat|bash .github/scripts/mls-forward-compat.sh"
  [ "$(scope android_app)" = "true" ] && echo "CI only: compile-android-app (Android SDK and NDK)" >&2
  [ "$(scope ios_app)" = "true" ] && echo "CI only: compile-ios-app (macOS and Xcode)" >&2
  [ "$(scope call_e2e)" = "true" ] && echo "CI only: test-call-service-e2e (coturn and browsers on Linux)" >&2
  [ "$(scope miconnect)" = "true" ] && echo "CI only: test-miconnect-blueprints (Authentik in Docker)" >&2
  echo "CI only: security (CodeQL, secret scan), dependency-audit" >&2
  return 0
}

# Tools a planned check needs, refused up front by name rather than discovered by a check's log.
require_tools() {
  local plan="$1" missing=""
  # A dry run executes nothing, so it needs nothing - and the self-test runs where shellcheck is not.
  [ "${LOCAL_CI_DRY_RUN:-}" = "1" ] && return 0
  need() { command -v "$1" >/dev/null 2>&1 || missing="$missing $1"; }
  need bun
  need git
  case "$plan" in *test-ci-scripts*) need shellcheck ;; esac
  case "$plan" in *"rust "* | *frontend-generated* | *mls-forward-compat*) need cargo ;; esac
  case "$plan" in *"ts "*) need node ;; esac
  case "$plan" in *android-unit*) need java ;; esac
  [ -z "$missing" ] || refuse "missing on this machine:$missing. CI has them; install them (docs/wiki/development.md) - a check that cannot run here is not a check that passed."
  # Said before a run of minutes, not three minutes into it: docs-private-guard refuses an unset one.
  if [ -z "${DOCS_PRIVATE_DENYLIST_FILE:-}" ]; then
    refuse "DOCS_PRIVATE_DENYLIST_FILE is not set. Point it at the out-of-repo denylist, or set it to 'none' to declare this machine has none (CI does) - docs/wiki/cicd.md#checks-at-commit-at-push-and-in-ci-only"
  fi
}

# ── push ─────────────────────────────────────────────────────────────────────────────────────────
mode_push() {
  local head lref lsha pushing=0
  assert_hooks_path
  head="$(git rev-parse HEAD)"
  while read -r lref lsha _; do
    [ -n "${lref:-}" ] || continue
    [ "$lsha" = "$ZERO" ] && continue # a deletion carries no code
    if [ "$lsha" != "$head" ]; then
      refuse "this push sends $lref ($lsha), which is not the checked-out commit ($head). The local checks run on the working tree, so they can only vouch for HEAD: check out $lref and push from there."
    fi
    pushing=1
  done
  [ "$pushing" -eq 1 ] || {
    say "local-ci: nothing but deletions in this push - nothing to verify"
    return 0
  }

  if ! git diff --quiet || ! git diff --cached --quiet; then
    refuse "the working tree has uncommitted changes, and the checks would read them instead of the commit being pushed. Commit or stash them, then push."
  fi

  say "[push] fetching origin/main"
  git fetch --quiet origin main
  local base merged=0
  base="$(git rev-parse origin/main)"
  if ! git merge-base --is-ancestor "$base" HEAD; then
    say "[push] merging origin/main (${base:0:12}) into $(git rev-parse --abbrev-ref HEAD), so this run tests what CI will"
    if ! git merge --no-edit origin/main >"$STATE_DIR/merge.log" 2>&1; then
      local conflicted
      conflicted="$(git diff --name-only --diff-filter=U)"
      if git rev-parse -q --verify MERGE_HEAD >/dev/null; then git merge --abort; fi
      [ -n "$conflicted" ] && refuse "origin/main conflicts with this branch in:
$(printf '%s\n' "$conflicted" | sed 's/^/    /')
The merge was aborted and the branch is as it was. Merge by hand (git merge origin/main), resolve,
commit, and push again."
      sed 's/^/    /' "$STATE_DIR/merge.log"
      refuse "git merge origin/main failed without a conflict (output above); the branch is as it was."
    fi
    merged=1
    head="$(git rev-parse HEAD)"
  fi

  if [ "$merged" -eq 0 ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ]; then
    say "[push] ${head:0:12} already passed every local check, on top of the current origin/main"
    return 0
  fi

  TIER=push
  local plan
  plan="$(push_plan "$base")"
  require_tools "$plan"
  run_plan "$plan"
  printf '%s\n' "$head" >"$STAMP"

  if [ "$merged" -eq 1 ]; then
    refuse "origin/main was merged into this branch as ${head:0:12} and every local check passed on it - but git had already chosen the commit to send before this hook ran, so this push would not carry the merge. Run the same git push again: it finds this commit verified and sends it at once."
  fi
  say "[push] every local check passed on ${head:0:12}"
}

# ── all (make run-ci) ────────────────────────────────────────────────────────────────────────────
mode_all() {
  TIER=all
  local plan
  plan="$(push_plan "")"
  require_tools "$plan"
  run_plan "$plan"
}

# ── commit ───────────────────────────────────────────────────────────────────────────────────────
# Fast checks over what this commit stages, each named and timed. They read the WORKING TREE, as
# the fixers before them do; the push tier refuses a dirty tree, so it is exact where this is fast.

# The frontend artefacts a vitest run needs. Each is generated when it is missing or when this
# commit stages its source, and the line says so; the WASM takes minutes, so it is refused instead.
commit_artefacts() {
  local staged="$1"
  if [ ! -d frontend/.svelte-kit ] || grep -qE '^frontend/(src/routes/|svelte\.config)' <<<"$staged"; then
    echo "generating: SvelteKit sync (missing, or this commit stages routes)"
    (cd frontend && bun run sync)
  fi
  if [ ! -d frontend/.paraglide-test ] || [ ! -d frontend/src/lib/paraglide ] || grep -qE '^frontend/(messages/|project\.inlang/)' <<<"$staged"; then
    echo "generating: Paraglide messages (missing, or this commit stages messages)"
    (cd frontend && bun run paraglide:compile && bun run paraglide:compile:test)
  fi
  if [ ! -s frontend/src/lib/proto/canari.js ] || grep -qE '^libs/proto/' <<<"$staged"; then
    echo "generating: protobuf bindings (missing, or this commit stages libs/proto)"
    (cd frontend && bun run proto:gen)
  fi
  if [ ! -s "$WASM_DIR/mls_wasm_bg.wasm" ]; then
    echo "the MLS WASM is missing, and a test importing it would fail on a module error that names nothing."
    echo "Build it once: cd frontend && bun run wasm:build   (about 2 minutes; the push rebuilds it when its sources change)"
    return 1
  fi
}

# The unit tests of the touched modules: a staged test file, and the tests named after a staged
# source (`x.ts` -> `x.test.ts`, `x.*.test.ts`; `x.svelte.ts` and `x.svelte` likewise). Prints
# paths relative to the package root given as $1.
module_tests() {
  local pkg="$1" suffix="$2" staged="$3" f dir base t
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      "$pkg"/*.test.ts | "$pkg"/*.spec.ts)
        [ -f "$f" ] && echo "${f#"$pkg"/}"
        continue
        ;;
    esac
    dir="$(dirname "$f")"
    base="$(basename "$f")"
    base="${base%.ts}"
    base="${base%.js}"
    base="${base%.svelte}"
    for t in "$dir/$base.$suffix.ts" "$dir/$base".*."$suffix.ts"; do
      [ -f "$t" ] && echo "${t#"$pkg"/}"
    done
  done <<<"$staged"
  return 0
}

# The path-scoped rules: a check is planned when a path this commit stages (or deletes, for the
# rules reading `$all_changed`) matches its pattern. Each test named here is one the push tier runs
# anyway inside `make test-ci-scripts`; at commit it runs alone, in a fraction of a second to a few
# seconds (measured in docs/wiki/cicd.md). Whole-tree scans that take longer - control characters,
# NUL bytes, line endings - are the push's.
# THE PATH RULES, shared by both tiers: at commit over what is staged, at push over the whole pushed
# range (merge base to HEAD) - the range CI's `changes` job reads, so a push re-proves what each of
# its commits was checked for. <moved> lists the deleted or renamed paths; <tier> is commit or push
# (the plan is regenerated and staged at commit, only verified at push).
commit_rules() {
  local staged="$1" all_changed="$2" moved="$3" tier="$4" t=.github/scripts/tests
  rule() {
    local regex="$1" input="$2" name="$3"
    shift 3
    if grep -qE "$regex" <<<"$input"; then echo "$name|$*"; fi
  }
  # A page, or a deleted or renamed file, can break a link anywhere.
  rule '\.md$' "$staged" wiki-links bun "$t/wiki-links.test.mjs"
  if [ -n "$moved" ] && ! grep -qE '\.md$' <<<"$staged"; then
    echo "wiki-links|bun $t/wiki-links.test.mjs"
  fi
  rule '\.md$' "$all_changed" docs-merge-artefacts bun "$t/docs-merge-artefacts.test.mjs"
  local backlog_check="bash .github/scripts/local-ci.sh plan"
  [ "$tier" = commit ] || backlog_check="bun $t/backlog-plan.test.mjs"
  # shellcheck disable=SC2086 # the command is words by construction
  rule '^(docs/wiki/backlog\.d/|docs/wiki/backlog\.md$|docs/wiki/plan\.md$|tools/backlog-plan/)' "$all_changed" \
    backlog-plan $backlog_check
  rule '^docs/wiki/backlog' "$all_changed" backlog-fragments bun "$t/backlog-fragments.test.mjs"
  rule '^docs/wiki/backlog' "$all_changed" backlog-closed bun "$t/backlog-closed.test.mjs"
  rule '^CLAUDE\.md$' "$staged" claude-md-cap bun "$t/claude-md-cap.test.mjs"
  rule '(\.md|\.sh|\.ya?ml|\.ts|\.mjs|\.env\.example)$' "$staged" docs-private-guard bun "$t/docs-private-guard.test.mjs"
  rule '(\.sh$|^\.husky/)' "$staged" executable-bit bun "$t/executable-bit.test.mjs"
  rule '(\.sh|\.ya?ml)$|^Makefile$|^\.husky/' "$staged" pipefail-early-reader bun "$t/pipefail-early-reader.test.mjs"
  # shellcheck disable=SC2046 # one path per word: the repository's script paths carry no spaces
  rule '\.sh$' "$staged" shellcheck bash .github/scripts/local-ci.sh shellcheck $(grep -E '\.sh$' <<<"$staged" || true)
  rule '^(\.github/|Makefile$)' "$all_changed" ci-definition bash .github/scripts/local-ci.sh ci-definition
  rule '^(frontend/src|apps/[^/]+/src)/.*\.ts$' "$staged" duplicates bash .github/scripts/local-ci.sh duplicates
  rule '^apps/[^/]+/src/migrations/' "$all_changed" migration-numbers bun "$t/migration-numbers.test.mjs"
  rule '^infrastructure/|Dockerfile' "$staged" image-scan-allowlist bun "$t/image-scan-allowlist.test.mjs"
  rule '^frontend/src/lib/styles/rawControlsRatchet\.json$' "$staged" raw-controls-ratchet \
    bun .github/scripts/ratchet-not-raised.mjs
  return 0
}

mode_commit() {
  local staged all_changed plan merging=0
  assert_hooks_path
  staged="$(staged_paths ACMR)"
  all_changed="$(staged_paths ACMRD)"
  [ -n "$all_changed" ] || return 0
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then merging=1; fi
  plan="$(commit_rules "$staged" "$all_changed" "$(staged_paths DR)" commit)"$'\n'

  # The vitest files: the guards a native or a markup change answers to, and the touched modules'.
  local vitest=""
  if grep -qE '^frontend/src-tauri/.*\.(kt|swift|m|mm|h|rs)$' <<<"$staged"; then
    vitest+="src/lib/mobile/nativeLogContent.test.ts"$'\n'
  fi
  if grep -qE '^frontend/src/.*\.svelte$|^frontend/src/lib/styles/rawControlsRatchet\.json$' <<<"$staged"; then
    vitest+="src/lib/styles/controlsGuard.test.ts"$'\n'
  fi
  local fe_sources svc svc_sources specs
  fe_sources="$(grep -E '^frontend/src/.*\.(ts|js|svelte)$' <<<"$staged" || true)"
  if [ -n "$fe_sources" ]; then
    if [ "$merging" -eq 1 ]; then
      echo "local-ci: concluding a merge - the module tests of its $(grep -c . <<<"$fe_sources") frontend file(s) are the push's to run, which runs the whole suite"
    else
      vitest+="$(module_tests frontend test "$fe_sources")"$'\n'
    fi
  fi
  vitest="$(printf '%s' "$vitest" | grep . | sort -u | tr '\n' ' ' || true)"
  if [ -n "${vitest// /}" ]; then
    plan+="frontend-artefacts|bash .github/scripts/local-ci.sh artefacts"$'\n'
    plan+="vitest (touched modules)|bash .github/scripts/local-ci.sh vitest $vitest"$'\n'
  fi
  if [ "$merging" -eq 0 ]; then
    for svc in apps/core-service apps/social-service apps/media-service apps/chat-delivery-service; do
      svc_sources="$(grep -E "^$svc/src/.*\.ts$" <<<"$staged" || true)"
      [ -n "$svc_sources" ] || continue
      specs="$(module_tests "$svc" spec "$svc_sources" | grep -v '\.integration\.spec\.ts$' | sort -u | tr '\n' ' ' || true)"
      if [ -n "${specs// /}" ]; then
        plan+="jest $svc (touched modules)|bash .github/scripts/local-ci.sh jest $svc $specs"$'\n'
      fi
    done
  fi

  plan="$(printf '%s' "$plan" | grep . || true)"
  [ -n "$plan" ] || return 0
  TIER=commit
  run_plan "$plan"
}

# ── helpers the plans call back into (so one plan line is one command) ──────────────────────────
mode_plan() {
  if ! git diff --quiet -- docs/wiki/backlog.d || [ -n "$(git ls-files --others --exclude-standard -- docs/wiki/backlog.d)" ]; then
    echo "docs/wiki/backlog.d has changes this commit does not stage, and the plan would be derived from them. Stage or stash them first."
    return 1
  fi
  bun tools/backlog-plan/plan.mjs
  if ! git diff --quiet -- docs/wiki/plan.md; then
    git add -- docs/wiki/plan.md
    echo "docs/wiki/plan.md regenerated from the staged entries, and staged with them"
  fi
  bun .github/scripts/tests/backlog-plan.test.mjs
}

mode_artefacts() {
  commit_artefacts "$(staged_paths ACMR)"
}

mode_vitest() {
  (cd frontend && bunx vitest run "$@")
}

# One jest run over the named specs; `--` hands them to jest as path patterns, exactly as
# `node --run test` would run them in CI, on node for the reason checks.sh gives.
mode_jest() {
  local svc="$1"
  shift
  (cd "$svc" && node --run test -- "$@")
}

# The self-tests that read the CI DEFINITION (ci.yml, the scripts it calls, the Makefile) - each
# under a second or two, and the ones a change to that definition breaks: an output `run_all`
# forgets, a job `ci-passed` does not need, an unpinned action, a job with no local tier.
mode_ci_definition() {
  local t=.github/scripts/tests
  bun "$t/changes-outputs.test.mjs"
  bun "$t/ios-compile-job.test.mjs"
  bun "$t/ci-passed-gate.test.mjs"
  bun "$t/action-pins.test.mjs"
  bun "$t/secret-levels.test.mjs"
  bun "$t/codeql-category.test.mjs"
  bun "$t/shellcheck-scope.test.mjs"
  bun "$t/recipe-covers-tests.test.mjs"
  bash "$t/workflow-expressions.test.sh"
  # local-ci.test.sh (40 s of scratch repositories) is the push's, inside `make test-ci-scripts`.
}

# The duplicate allowlists: a copy of a function across files is declared, or it is new.
mode_duplicates() {
  bun .github/scripts/tests/declared-duplicates.test.mjs
  bun .github/scripts/tests/undeclared-duplicates.test.mjs
}

mode="${1:-}"
[ $# -gt 0 ] && shift
case "$mode" in
  commit) mode_commit ;;
  push) mode_push ;;
  all) mode_all ;;
  tiers) printf '%s' "$JOB_TIERS" ;;
  generated) frontend_generated ;;
  plan) mode_plan ;;
  artefacts) mode_artefacts ;;
  vitest) mode_vitest "$@" ;;
  jest) mode_jest "$@" ;;
  ci-definition) mode_ci_definition ;;
  duplicates) mode_duplicates ;;
  # The named scripts (staged at commit, in the range at push) that are in the set CI lints,
  # through the one recipe that names that set. The recipe only WARNS when the linter is absent (a contributor's `make test`
  # must not need it); a hook that lints must.
  shellcheck)
    command -v shellcheck >/dev/null 2>&1 || {
      echo "shellcheck is not installed, and this commit stages a shell script CI lints with it: winget install koalaman.shellcheck (or your package manager)"
      exit 1
    }
    make lint-ci-scripts FILES="$*"
    ;;
  *)
    echo "usage: local-ci.sh commit | push <remote> | all | tiers" >&2
    exit 2
    ;;
esac
