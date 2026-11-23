#!/usr/bin/env bash
# THE LOCAL HALF OF CI: what runs at COMMIT, what runs at PUSH, and what stays in CI ONLY.
#
# THE OWNER'S DECISION (2026-11-15): *"tout ce qui est verifie a la PR devrait etre verifie au
# commit, la fusion de PR devrait etre une formalite"*. Three tiers follow from it:
#   commit   fast checks scoped to the STAGED files - doc links, the plan, the private-data guard,
#            the native-log guard, the controls ratchet, the touched module's own unit tests.
#   push     what the pushed files touch (owner, 2026-11-16): the jobs `ci-scopes.sh` - CI's own
#            filters - plans for the diff since the last verified commit, after merging the latest
#            origin/main into a feature branch so the run tests what CI tests. The full suites are
#            CI's.
#   ci-only  what a Windows workstation cannot run: listed in JOB_TIERS below with the reason.
# Every command a check runs is `checks.sh`'s or a Make target's - this file decides WHEN, never
# HOW. The inventory, with measured durations, is docs/wiki/cicd.md
# ("Checks at commit, at push, and in CI only").
#
# Usage:
#   local-ci.sh commit             called by .husky/pre-commit, after the fixers
#   local-ci.sh push <remote>      called by .husky/pre-push, the pushed refs on stdin
#   local-ci.sh all                every local check, whatever changed (`make run-ci`)
#   local-ci.sh push-plan <base>   print the push plan for <base>..HEAD, run nothing (the self-test)
#   local-ci.sh tiers              print JOB_TIERS (read by local-ci.test.sh)
# LOCAL_CI_DRY_RUN=1 makes the COMMIT tier print `PLAN <check>: <command>` instead of running it. The
# push tier refuses it: a dry push that passed would send unchecked commits, and it writes no stamp.
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
# git, against the index this commit is built from.
commit_git() {
  if [ -n "$COMMIT_INDEX" ]; then GIT_INDEX_FILE="$COMMIT_INDEX" git "$@"; else git "$@"; fi
}
# What this commit stages, read from the index git is committing.
staged_paths() { # <diff-filter> [-- <pathspec>...]
  local filter="$1"
  shift
  commit_git diff --cached --name-only --diff-filter="$filter" "$@"
}

# EVERY JOB OF ci.yml, AND WHERE IT RUNS BEFORE THE PULL REQUEST. `local-ci.test.sh` fails when a
# job of ci.yml is missing here, so a new CI job cannot arrive without deciding its local tier, and
# when a job named here is not in ci.yml any more, so the table cannot rot.
#   job                              tier      what runs locally, or why nothing can
JOB_TIERS='
changes                            push      ci-scopes.sh, the script the CI job calls
test-rust                          ci-only   cargo test and clippy per crate: minutes per crate here (owner, 2026-11-16: the push is the fastest it can be)
boot-nest-apps                     ci-only   boots each service on PostgreSQL, Redis and an S3 endpoint
test-social-integration            ci-only   integration specs on PostgreSQL and Redis
test-chat-delivery-integration     ci-only   integration specs on PostgreSQL
test-typescript-backend            split     tsc --noEmit (typecheck, specs included) per service at push; lint, build and the jest suites in CI only
test-frontend                      split     frontend-prepare and frontend-lint at push; dead-code and frontend-build in CI only
test-frontend-shards               split     checks.sh frontend-test-related at push: the tests the range reaches; the whole suite in CI only
test-android                       ci-only   android-unit-tests.sh: a Gradle run
compile-android-app                ci-only   needs the Android SDK and NDK
compile-ios-app                    ci-only   needs macOS and Xcode
test-call-service-e2e              ci-only   coturn and five headless browsers on a Linux runner
test-harness                       ci-only   make test-harness
test-ci-scripts                    split     its whole-tree scans and the path rules at push; make test-ci-scripts (1-2 h here) in CI only
dependency-ceiling                 ci-only   decides on a Dependabot pull request only
security                           split     the lockfile guards at push; CodeQL and the secret scan in CI only
dependency-audit                   ci-only   a verdict on the advisory databases, not on the commit; ~5 min per tree
mls-forward-compat                 ci-only   mls-forward-compat.sh: a WASM build
test-miconnect-blueprints          ci-only   a full Authentik pair in Docker, twice
upstream-monitor-freshness         ci-only   a push to main only; reads GitHub
ci-passed                          ci-only   the aggregation of the jobs above
'

STATE_DIR="$(git rev-parse --git-path canari-local-ci)"
mkdir -p "$STATE_DIR"
# The commit a push run verified, per worktree. It answers ONE question - "did every local check
# pass on exactly this commit" - and a commit is immutable, so it cannot go stale.
STAMP="$STATE_DIR/verified-head"
# The merge commit THIS hook made, verified, and asked to be pushed again. It answers a different
# question from the stamp - "is this the push I asked for" - so it is its own file: a stamped
# commit that fell behind main is merged again, the commit this hook asked for is sent as it is.
RESEND="$STATE_DIR/resend-head"
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
# that can see it, so both tiers refuse a value that is neither of the two below. The value is HOOKS_PATH in
# frontend/scripts/hooks-path.js; local-ci.test.sh asserts the two agree.
# THE SHELLCHECK CI PINS, OR NONE. Versions name findings differently (0.11's SC2329 is 0.10's
# SC2317), so a local pass at another version proves nothing: #3623 went red in CI that way.
# Prints nothing when the installed one is `.shellcheck-version`'s, else a phrase for a refusal.
shellcheck_version_problem() {
  local want have
  want="$(tr -d '[:space:]' <.shellcheck-version)"
  have="v$(shellcheck --version | sed -n 's/^version: //p' | tr -d '[:space:]')"
  [ "$have" = "$want" ] || printf ' shellcheck %s (this machine has %s; CI lints with %s, and the finding codes differ between versions - https://github.com/koalaman/shellcheck/releases/tag/%s)' "$want" "$have" "$want" "$want"
}

HOOKS_PATH=.husky
# The value a branch without this script's install writes, on every `bun install` (husky's wrappers,
# which call the same tracked hooks where they exist). Shared by every worktree, so it is left to
# the install script of whatever branch ran last - never written here - and said, not refused:
# until every branch carries the new install, it is the expected state, and the hook running at all
# proves this checkout has the wrappers.
HUSKY_WRAPPERS_PATH=.husky/_
assert_hooks_path() {
  local value
  value="$(git config core.hooksPath || true)"
  case "$value" in
    "$HOOKS_PATH") return 0 ;;
    "$HUSKY_WRAPPERS_PATH")
      say "local-ci: core.hooksPath is $HUSKY_WRAPPERS_PATH (written by an older branch's bun install) - a fresh worktree runs no hook until a bun install on a branch with frontend/scripts/install-husky.js writes $HOOKS_PATH"
      return 0
      ;;
  esac
  refuse "core.hooksPath is '${value:-<unset>}', neither '$HOOKS_PATH' (the tracked hooks) nor '$HUSKY_WRAPPERS_PATH' (an older install's wrappers). Every worktree shares it, so any other value leaves some checkout with no hook and no message. Run bun install in frontend/ - its install script writes '$HOOKS_PATH' - rather than editing the shared config by hand."
}

# ── Running one check ────────────────────────────────────────────────────────────────────────────
CHECK_INDEX=0
CHECK_TOTAL=0
TIER=""
MERGED_NOTE=""

# THE CHECKS THAT USE EVERY CORE RUN ONE AT A TIME ON THIS MACHINE, whichever checkout runs them.
# Several sessions push at once, and each vitest sizes its pool from the cores alone: on 2026-11-22
# five pushes were verifying at once on 16 cores (run queue 69-92, paging), and tests costing 16 ms
# of CPU failed vitest's 5 s wall-clock deadline - the victims random, the machine the cause. The
# slot is a listening socket (`machine-slot.mjs`), so a holder that dies releases it with no stale
# state, and a waiter wakes on the holder's close, not on a clock. There is no queue (the first
# waiter to bind wins) and no clock ends a hold: a waiter names the holder's pid, `kill` frees it.
# The measurements: docs/wiki/test-suite-reform.md, the sixth load reading.
# The commit tier's checks are not here: they run the touched modules' few files, wait for nobody,
# and a commit must not queue behind a push's suite.
# GUARD: a check listed here must never run_check another listed check - it would wait for itself.
uses_every_core() { # <check name>
  case "$1" in
    frontend-generated | frontend-lint | frontend-test) return 0 ;;
  esac
  return 1
}

# Takes the slot for <name>, or refuses: a check that could not take it would run on the very
# machine the slot exists to bound. Sets the caller's slot_in, slot_out and slot_holder.
take_machine_slot() { # <check name>
  local granted=""
  coproc SLOT { exec bun "$ROOT/.github/scripts/machine-slot.mjs" "$1 in $(basename "$ROOT")"; }
  slot_holder=$SLOT_PID
  slot_in=${SLOT[0]}
  slot_out=${SLOT[1]}
  read -r granted <&"$slot_in" || true
  [ "$granted" = granted ] ||
    refuse "$1: the machine slot could not be taken (machine-slot.mjs said why, above). Running anyway would load the machine the slot bounds."
}

# Ends the slot's stdin, which is what releases it, and waits for the holder to be gone.
release_machine_slot() {
  exec {slot_out}>&- {slot_in}<&-
  wait "$slot_holder" || say "local-ci: the machine slot holder exited with $? after its release"
}

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
  local status=0 slot_in="" slot_out="" slot_holder=""
  if uses_every_core "$name"; then
    take_machine_slot "$name"
    # The slot's pipe is closed for the check itself: a process the check leaves behind must not
    # keep the slot once the check is over.
    "$@" >"$log" 2>&1 {slot_in}<&- {slot_out}>&- || status=$?
    release_machine_slot
  else
    "$@" >"$log" 2>&1 || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    say "[$TIER $CHECK_INDEX/$CHECK_TOTAL] $name ok ($((SECONDS - start))s)"
  else
    say "[$TIER $CHECK_INDEX/$CHECK_TOTAL] $name FAILED ($((SECONDS - start))s) - the end of $log:"
    tail -n 40 "$log" | sed 's/^/    /'
    [ -z "${MERGED_NOTE:-}" ] || say "$MERGED_NOTE"
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
  # The install's `prepare` runs install-husky.js, which writes core.hooksPath into the config every
  # worktree shares. A check never writes that config (lead, 2026-11-15): the value follows the
  # checkout a HUMAN ran `bun install` in. So the install is told not to, at the source.
  CANARI_KEEP_HOOKS_PATH=1 bash .github/scripts/checks.sh frontend-prepare
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
  # THE PUSH RUNS ONLY WHAT TAKES SECONDS TO MINUTES HERE (owner, 2026-11-16: "Je veux que notre
  # workflow soit le plus rapide possible"). The suites that cost 20 min to 2 h on a workstation -
  # make test-ci-scripts, a service's whole jest suite, a crate's cargo test, the whole vitest suite,
  # dead-code, the frontend build, the harness, the Android and MLS compat jobs - run in CI on every
  # pull request, and each is named on stderr so the reader knows what the push did not prove.
  echo "CI only: test-ci-scripts beyond its whole-tree scans and the path rules" >&2
  echo "raw-controls-ratchet|bun .github/scripts/ratchet-not-raised.mjs ${base:-origin/main}"
  echo "lockfile-version|bash .github/scripts/checks.sh lockfile-version"
  echo "tauri-parity|bash .github/scripts/checks.sh tauri-parity"
  [ "$(scope harness)" = "true" ] && echo "CI only: test-harness" >&2
  if [ "$(scope frontend)" = "true" ]; then
    echo "frontend-generated|bash .github/scripts/local-ci.sh generated"
    echo "frontend-lint|bash .github/scripts/checks.sh frontend-lint"
    if [ -n "$base" ]; then
      echo "frontend-test|bash .github/scripts/checks.sh frontend-test-related $base"
    else
      echo "CI only: frontend-test (the whole suite)" >&2
    fi
    echo "CI only: dead-code, frontend-build" >&2
  fi
  # A TYPE ERROR IN A SERVICE, SPECS INCLUDED, FAILS HERE (2026-11-23, #3989). Jest runs ts-jest with
  # `isolatedModules`, which transpiles without types, so no spec run ever sees one; only `tsc --noEmit`
  # does (3-12 s per service, incremental). The services come from the scope CI's matrix uses.
  local svc
  while read -r svc; do
    echo "typecheck-${svc#apps/}|bash .github/scripts/checks.sh ts $svc install typecheck"
  done < <(grep -o 'apps/[a-z-]*' <<<"$(scope ts)" || true)
  [ "$(scope ts)" != "[]" ] && echo "CI only: the services' jest suites, lint, build, boot-nest-apps, the PostgreSQL integration suites" >&2
  grep -q '"path":"' <<<"$(scope rust)" && echo "CI only: the Rust crates' cargo test and clippy" >&2
  [ "$(scope android)" = "true" ] && echo "CI only: android-unit" >&2
  [ "$(scope mls_compat)" = "true" ] && echo "CI only: mls-forward-compat" >&2
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
  case "$plan" in *frontend-generated*) need cargo ;; esac
  case "$plan" in *shellcheck*) need shellcheck ;; esac
  if [[ "$plan" == *shellcheck* ]] && command -v shellcheck >/dev/null 2>&1; then
    missing="$missing$(shellcheck_version_problem)"
  fi
  [ -z "$missing" ] || refuse "missing on this machine:$missing. CI has them; install them (docs/wiki/development.md) - a check that cannot run here is not a check that passed."
  # Said before a run of minutes, not three minutes into it: docs-private-guard refuses an unset one.
  if [ -z "${DOCS_PRIVATE_DENYLIST_FILE:-}" ]; then
    refuse "DOCS_PRIVATE_DENYLIST_FILE is not set. Point it at the out-of-repo denylist, or set it to 'none' to declare this machine has none (CI does) - docs/wiki/cicd.md#checks-at-commit-at-push-and-in-ci-only"
  fi
}

# ── push ─────────────────────────────────────────────────────────────────────────────────────────
# WHERE A PUSH GOES DECIDES WHETHER MAIN IS MERGED INTO IT. A feature branch becomes a pull request
# into main, so main is merged first and the run tests what CI will. A release branch or a tag is
# not headed for main - merging main into a release fix would ship main's unreleased work with it -
# so it is checked as it is, against its own base. main itself takes changes through a pull request
# only (ruleset 22152902), so a push to it is refused here, by name, before minutes of checks.
mode_push() {
  local head lref lsha rref rsha commit pushing=0 passthrough=0 ref_base=""
  if [ "${LOCAL_CI_DRY_RUN:-}" = "1" ]; then
    refuse "LOCAL_CI_DRY_RUN=1 is the commit tier's switch; a push it let through would send commits nothing checked. Unset it and push again (the self-test reads the plan with local-ci.sh push-plan)."
  fi
  assert_hooks_path
  head="$(git rev-parse HEAD)"
  while read -r lref lsha rref rsha; do
    [ -n "${lref:-}" ] || continue
    [ "$lsha" = "$ZERO" ] && continue # a deletion carries no code
    case "$rref" in
      refs/heads/main)
        refuse "this push goes to main ($rref). main takes changes through a pull request only: push a branch and open one (gh pr create)."
        ;;
      refs/heads/release/* | refs/tags/*) passthrough=1 ;;
      refs/heads/*) ;;
      *) passthrough=1 ;;
    esac
    # A tag names a tag object; what the checks can vouch for is the commit under it.
    commit="$(git rev-parse -q --verify "$lsha^{commit}" 2>/dev/null || echo "$lsha")"
    if [ "$commit" != "$head" ]; then
      refuse "this push sends $lref ($commit), which is not the checked-out commit ($head). The local checks run on the working tree, so they can only vouch for HEAD: check out $lref and push from there."
    fi
    # The base a passthrough ref is checked against: what the remote already has under that name.
    if [ -z "$ref_base" ] && [ "${rsha:-$ZERO}" != "$ZERO" ] && git rev-parse -q --verify "$rsha^{commit}" >/dev/null 2>&1; then
      ref_base="$(git rev-parse "$rsha^{commit}")"
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

  if [ "$passthrough" -eq 1 ]; then
    push_passthrough "$head" "$ref_base"
    return
  fi

  # THE PUSH THIS HOOK ASKED FOR IS SENT BEFORE ANY FETCH. Its merge of origin/main passed every
  # check, and CI tests the pull request merged onto the current main anyway; fetching again would
  # merge whatever main took during the run, and a branch whose plan outlasts main's merge rate
  # would never be sent (measured 2026-11-15: three runs in a row, main moved during each).
  if [ "$(cat "$RESEND" 2>/dev/null)" = "$head" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ]; then
    say "[push] ${head:0:12} already passed every local check here, merged by the last run - sending it; CI merges the current main"
    return 0
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
    # Said again under a failing check: the branch is no longer what was committed.
    MERGED_NOTE="HEAD now includes a merge of origin/main (${base:0:12}), as ${head:0:12}."
  fi

  if [ "$merged" -eq 0 ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ]; then
    say "[push] ${head:0:12} already passed every local check, on top of the current origin/main"
    return 0
  fi

  # What changed since a verified commit is what is checked: new commits, main's merges, any
  # resolution (stamp_base).
  verify_range "$head" "$(stamp_base "$base" "$head")"

  if [ "$merged" -eq 1 ]; then
    printf '%s\n' "$head" >"$RESEND"
    refuse "origin/main was merged into this branch as ${head:0:12} and every local check passed on it - but git had already chosen the commit to send before this hook ran, so this push would not carry the merge. Run the same git push again: it finds this commit verified and sends it at once."
  fi
  say "[push] every local check passed on ${head:0:12}"
}

# The base the plan starts from: <base>, or the verified commit (the stamp) when HEAD contains it -
# its tree passed every check its range owed, so the tree difference from it is exactly what came
# in since. Without it, a branch whose plan outlasts main's merge rate never converges (measured
# 2026-11-15: an hour-long plan, main moved twice meanwhile).
stamp_base() { # <base> <head>
  local stamped
  stamped="$(cat "$STAMP" 2>/dev/null || true)"
  if [ -n "$stamped" ] && [ "$stamped" != "$2" ] && git merge-base --is-ancestor "$stamped" "$2" 2>/dev/null; then
    say "[push] ${stamped:0:12} was verified; checking only what has come in since" >&2
    echo "$stamped"
  else
    echo "$1"
  fi
}

# Runs the push plan for <base>..HEAD and, when every check passed, stamps <head>. The ONLY writer
# of the stamp, and never reached by a dry run (mode_push refuses one).
verify_range() { # <head> <base>
  TIER=push
  local plan
  plan="$(push_plan "$2")"
  require_tools "$plan"
  run_plan "$plan"
  printf '%s\n' "$1" >"$STAMP"
}

# A release branch, a tag, or any ref that is not a feature branch: no merge. Its base is what the
# remote already holds under that name, or, for a new one, where it leaves origin/main.
push_passthrough() { # <head> <ref-base or empty>
  local head="$1" base="$2"
  if [ "$(cat "$STAMP" 2>/dev/null)" = "$head" ]; then
    say "[push] ${head:0:12} already passed every local check here - sending it, unmerged"
    return 0
  fi
  if [ -z "$base" ]; then
    say "[push] fetching origin/main, to find where this ref leaves it (nothing is merged)"
    git fetch --quiet origin main
    base="$(git merge-base HEAD origin/main)"
  fi
  say "[push] not a feature branch: checked as it is, against ${base:0:12}, with no merge of main"
  verify_range "$head" "$(stamp_base "$base" "$head")"
  say "[push] every local check passed on ${head:0:12}"
}

# The plan a push of HEAD would run for <base>..HEAD, printed, nothing run and nothing written.
mode_push_plan() { # <base>
  local base="${1:-}" line
  [ -n "$base" ] || refuse "push-plan: pass the base the range starts from"
  TIER=push
  while IFS= read -r line; do
    [ -n "$line" ] && say "PLAN ${line%%|*}: ${line#*|}"
  done < <(push_plan "$(git rev-parse "$base")")
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
# (the plan page is rewritten in the checkout at commit, its targets only verified at push).
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
  rule '^(docs/wiki/backlog\.d/|docs/wiki/backlog\.md$|tools/backlog-plan/)' "$all_changed" \
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
      echo "local-ci: concluding a merge - the module tests of its $(grep -c . <<<"$fe_sources") frontend file(s) are the push's to run, through vitest related over the merged range"
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
# The plan page is generated where it is read and never committed (docs/wiki/cicd.md, "The plan page
# is generated where it is read"): the commit rewrites this checkout's copy so it says what the
# entries now say, stages nothing, and checks the targets. The page's own line is discarded - a
# line every commit would print is noise.
mode_plan() {
  bun tools/backlog-plan/plan.mjs >/dev/null
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
  push-plan) mode_push_plan "$@" ;;
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
    problem="$(shellcheck_version_problem)"
    [ -z "$problem" ] || refuse "this machine needs$problem"
    make lint-ci-scripts FILES="$*"
    ;;
  *)
    echo "usage: local-ci.sh commit | push <remote> | push-plan <base> | all | tiers" >&2
    exit 2
    ;;
esac
