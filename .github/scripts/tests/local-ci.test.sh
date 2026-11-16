#!/usr/bin/env bash
# DO THE LOCAL TIERS DECIDE WHAT THEY CLAIM - and can a CI job arrive without a local tier?
#
# `.github/scripts/local-ci.sh` is what the pre-commit and pre-push hooks run (owner, 2026-11-15:
# what a pull request checks is checked before the push). Its decisions fail SILENTLY when wrong:
# a commit rule that matches nothing runs no check and says nothing, a push that does not merge
# origin/main tests a tree CI never sees, a conflict left half-merged leaves the branch broken. So
# this runs the script's own decisions in dry-run mode (`LOCAL_CI_DRY_RUN=1`: the plan is printed,
# nothing is executed) against scratch repositories, and pins:
#   1. every job of ci.yml has a tier in JOB_TIERS, and every tier names a job that exists;
#   2. the inventory in docs/wiki/cicd.md names every job (it is the one copy of the table);
#   3. the commit rules plan the right checks for the staged paths, and nothing for a clean index;
#   4. the push merges origin/main, refuses on a conflict with the branch left as it was, refuses a
#      dirty tree and a ref that is not HEAD, and passes at once on a commit it already verified;
#   5. the tracked hooks call this script, and `make run-ci` runs the same plan.
#
# Usage: bash .github/scripts/tests/local-ci.test.sh   (no arguments, no network)
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
# Run from a hook, GIT_DIR names the REAL repository and every `git -C "$scratch"` below would write
# into it (2026-11-15: two "base" commits and a test identity in the shared config). Dropped first.
# shellcheck disable=SC2046 # one variable name per word, by construction
unset $(git rev-parse --local-env-vars)
fail=0
# AND THE REAL REPOSITORY'S CONFIG IS THE SAME AFTER THE RUN. The leak above wrote user.*,
# commit.gpgsign, core.hooksPath and core.autocrlf (what `configure` sets) and core.bare (what
# `git init` re-initialising a work-tree-less GIT_DIR writes) into the shared .git/config, and the
# main checkout stopped working. Those keys are read before and compared after, byte for byte.
guarded_config() {
  git -C "$repo_root" config --local --list | grep -E '^(core\.bare|core\.hooksPath|user\.|commit\.gpgsign)=' || true
}
config_before=$(guarded_config)
ok() { echo "  ok    $1"; }
bad() {
  echo "  FAIL  $1"
  fail=1
}
# check <said when it holds> <said when it does not> <command...>
check() {
  local good="$1" wrong="$2"
  shift 2
  if "$@"; then ok "$good"; else bad "$wrong"; fi
}
has() { grep -qF -- "$1" <<<"$2"; }

# ── 1. every CI job has a tier ──────────────────────────────────────────────────────────────────
echo "every job of ci.yml has a local tier:"
ci_jobs=$(sed -n '/^jobs:/,$p' "$repo_root/.github/workflows/ci.yml" | grep -E '^  [a-z0-9-]+:$' | sed 's/^  //; s/:$//' | sort)
tiers=$(bash "$repo_root/.github/scripts/local-ci.sh" tiers)
tier_jobs=$(awk 'NF {print $1}' <<<"$tiers" | sort)
[ -n "$ci_jobs" ] || bad "read no job out of ci.yml - the parse is wrong, not the workflow"
missing=$(comm -23 <(echo "$ci_jobs") <(echo "$tier_jobs"))
stale=$(comm -13 <(echo "$ci_jobs") <(echo "$tier_jobs"))
check "$(grep -c . <<<"$ci_jobs") jobs, each with a tier" "jobs with no tier in JOB_TIERS: $(echo "$missing" | tr '\n' ' ')" test -z "$missing"
check "every tier names a job that exists" "JOB_TIERS names jobs ci.yml no longer has: $(echo "$stale" | tr '\n' ' ')" test -z "$stale"
bad_tiers=$(awk 'NF && $2 !~ /^(push|ci-only|split)$/ {print $1}' <<<"$tiers")
check "every tier is push, ci-only or split" "unknown tier for: $bad_tiers" test -z "$bad_tiers"

# ── 2. the inventory names every job ────────────────────────────────────────────────────────────
echo "docs/wiki/cicd.md's inventory names every job:"
inventory=$(sed -n '/^## Checks at commit, at push, and in CI only/,/^## [^C]/p' "$repo_root/docs/wiki/cicd.md")
unnamed=""
while IFS= read -r job; do
  has "\`$job\`" "$inventory" || unnamed="$unnamed $job"
done <<<"$ci_jobs"
check "the section exists" "no '## Checks at commit, at push, and in CI only' section in docs/wiki/cicd.md" test -n "$inventory"
check "every job appears in the inventory" "jobs the inventory does not name:$unnamed" test -z "$unnamed"

# ── scratch repositories ────────────────────────────────────────────────────────────────────────
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
ZERO=0000000000000000000000000000000000000000

# A repository carrying the scripts under test and the files the rules look for. Its own config
# names an identity and disables signing and hooks, because the push tier MERGES in it.
make_repo() {
  local dir="$1"
  mkdir -p "$dir/.github/scripts" "$dir/.github/workflows" "$dir/frontend/src/lib/x" "$dir/docs/wiki/backlog.d" \
    "$dir/apps/core-service/src/a"
  cp "$repo_root/.github/scripts/local-ci.sh" "$repo_root/.github/scripts/ci-scopes.sh" \
    "$repo_root/.github/scripts/checks.sh" "$dir/.github/scripts/"
  echo "name: CI" >"$dir/.github/workflows/ci.yml"
  echo "export const a = 1;" >"$dir/frontend/src/lib/x/mod.ts"
  echo "test" >"$dir/frontend/src/lib/x/mod.test.ts"
  echo "test" >"$dir/frontend/src/lib/x/mod.edge.test.ts"
  # A scan of the source tree, and a test that reads a file's text: the import graph sees neither.
  echo "import { sourceFiles } from '../../test/sourceTree';" >"$dir/frontend/src/lib/scan.test.ts"
  echo "readFileSync('x/mod.ts');" >"$dir/frontend/src/lib/reads.test.ts"
  echo "readFileSync('other.ts');" >"$dir/frontend/src/lib/unrelated.test.ts"
  echo "export const b = 1;" >"$dir/apps/core-service/src/a/svc.ts"
  echo "spec" >"$dir/apps/core-service/src/a/svc.spec.ts"
  echo "spec" >"$dir/apps/core-service/src/a/svc.integration.spec.ts"
  echo "# Page" >"$dir/docs/wiki/page.md"
  printf 'a\n' >"$dir/shared.txt"
  git -C "$dir" init -q -b main .
  configure "$dir"
  git -C "$dir" add -A
  git -C "$dir" commit -qm base
}
configure() {
  git -C "$1" config user.name t
  git -C "$1" config user.email t@t.invalid
  git -C "$1" config commit.gpgsign false
  # The value local-ci.sh insists on; a scratch repository has no `.husky/`, so git runs nothing.
  git -C "$1" config core.hooksPath .husky
  git -C "$1" config core.autocrlf false
}

# ── 3. the commit rules ─────────────────────────────────────────────────────────────────────────
echo "the commit tier plans what the staged paths answer to:"
c="$scratch/commit"
make_repo "$c"
plan_for() { (cd "$c" && LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh commit); }
reset_c() {
  git -C "$c" reset -q
  git -C "$c" checkout -q -- .
}

out=$(plan_for)
check "a clean index plans nothing" "a clean index planned: $out" test -z "$out"

echo "more" >>"$c/docs/wiki/page.md"
git -C "$c" add docs/wiki/page.md
out=$(plan_for)
check "a staged page -> wiki-links" "a staged page does not plan wiki-links: $out" has "PLAN wiki-links:" "$out"
check "a staged page -> docs-private-guard" "a staged page does not plan docs-private-guard" has "PLAN docs-private-guard:" "$out"
check "a staged page runs no vitest" "a staged page planned vitest" test -z "$(grep -F 'PLAN vitest' <<<"$out" || true)"
# A hook's GIT_DIR never reaches the checks: here it names a decoy, as a hook's names the real one.
decoy="$scratch/decoy"
git init -q "$decoy"
out=$(cd "$c" && GIT_DIR="$decoy/.git" LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh commit 2>&1) || true
check "an inherited GIT_DIR is dropped: the plan reads the repository it runs in" \
  "an inherited GIT_DIR steered local-ci.sh to another repository: $out" has "PLAN wiki-links:" "$out"
reset_c

git -C "$c" rm -q shared.txt
out=$(plan_for)
check "a deleted file (a link may point at it) -> wiki-links" "a deletion does not plan wiki-links: $out" has "PLAN wiki-links:" "$out"
reset_c

echo "// x" >>"$c/frontend/src/lib/x/mod.ts"
git -C "$c" add frontend/src/lib/x/mod.ts
out=$(plan_for)
check "a staged module runs its own tests, named and dotted (mod.test.ts, mod.edge.test.ts)" \
  "a staged module does not plan mod.test.ts and mod.edge.test.ts: $out" \
  grep -q 'PLAN vitest (touched modules):.*src/lib/x/mod.edge.test.ts src/lib/x/mod.test.ts' <<<"$out"
check "a staged module generates (or refuses) the artefacts first" "no frontend-artefacts step: $out" has "PLAN frontend-artefacts:" "$out"
check "a staged module runs the duplicates allowlists" "no duplicates step: $out" has "PLAN duplicates:" "$out"
reset_c

echo "// y" >>"$c/apps/core-service/src/a/svc.ts"
git -C "$c" add apps/core-service/src/a/svc.ts
out=$(plan_for)
check "a staged service file runs its unit spec" "a staged service file does not plan svc.spec.ts: $out" \
  grep -q 'PLAN jest apps/core-service (touched modules):.*src/a/svc.spec.ts' <<<"$out"
check "and never its integration spec (PostgreSQL is CI's)" "the integration spec was planned: $out" \
  test -z "$(grep -F 'integration.spec' <<<"$out" || true)"
reset_c

echo "# entry" >"$c/docs/wiki/backlog.d/new.md"
git -C "$c" add docs/wiki/backlog.d/new.md
out=$(plan_for)
check "a new backlog entry -> backlog-plan" "a new backlog entry does not plan backlog-plan: $out" has "PLAN backlog-plan:" "$out"
git -C "$c" reset -q
rm -f "$c/docs/wiki/backlog.d/new.md"

# ── 4. the push ─────────────────────────────────────────────────────────────────────────────────
echo "the push tier merges origin/main, and refuses what it cannot vouch for:"
origin="$scratch/origin.git"
git init -q --bare -b main "$origin"
p="$scratch/push"
other="$scratch/other"
make_repo "$p"
git -C "$p" remote add origin "$origin"
git -C "$p" push -q origin main
git -C "$p" switch -q -c feature
git clone -q "$origin" "$other"
configure "$other"

push_hook() {
  (cd "$p" && printf 'refs/heads/feature %s refs/heads/feature %s\n' "$1" "$ZERO" |
    LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1)
}

echo "feature" >"$p/feature.txt"
git -C "$p" add feature.txt
git -C "$p" commit -qm feature
head=$(git -C "$p" rev-parse HEAD)
rc=0
out=$(push_hook "$head") || rc=$?
check "a branch on top of origin/main runs the plan and passes" "a clean push was refused or ran nothing (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'PLAN control-characters:' <<<"$out" || true)"
rc=0
out=$(push_hook "$head") || rc=$?
check "the same commit pushed again is not re-checked (the stamp)" "a verified commit was checked again or refused (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'already passed every local check' <<<"$out" || true)" -a -z "$(grep -F PLAN <<<"$out" || true)"

echo "dirty" >>"$p/feature.txt"
rc=0
out=$(push_hook "$head") || rc=$?
check "a dirty tree is refused" "a dirty tree was not refused (rc=$rc): $out" test "$rc" -ne 0 -a -n "$(grep -F 'uncommitted changes' <<<"$out" || true)"
git -C "$p" checkout -q -- feature.txt

rc=0
out=$(push_hook "$(git -C "$p" rev-parse HEAD~1)") || rc=$?
check "a pushed ref that is not HEAD is refused" "a ref other than HEAD was not refused (rc=$rc): $out" \
  test "$rc" -ne 0 -a -n "$(grep -F 'not the checked-out commit' <<<"$out" || true)"

rc=0
out=$(cd "$p" && printf 'refs/heads/gone %s refs/heads/gone %s\n' "$ZERO" "$head" |
  LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1) || rc=$?
check "a deletion-only push passes without checks" "a deletion-only push (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'nothing but deletions' <<<"$out" || true)"

# origin/main moves without conflict: the hook merges, checks the merge, and asks for one more push.
echo "main side" >"$other/main-side.txt"
git -C "$other" add main-side.txt
git -C "$other" commit -qm main-side
git -C "$other" push -q origin main
rc=0
out=$(push_hook "$head") || rc=$?
merged_head=$(git -C "$p" rev-parse HEAD)
check "origin/main moved: the push is refused once, asking for the same push again" \
  "a push behind origin/main was let through, or refused for another reason (rc=$rc): $out" \
  test "$rc" -ne 0 -a -n "$(grep -F 'Run the same git push again' <<<"$out" || true)"
parents=$(git -C "$p" rev-list --parents -n1 HEAD | wc -w | tr -d ' ')
check "the branch now carries a merge commit of origin/main" "no merge commit was made" test "$parents" -eq 3
check "the checks ran on the merged result" "the merge was not checked: $out" has "PLAN control-characters:" "$out"
# main moves again before the push the hook asked for: that push is still sent as it is, unfetched.
echo "main moves on" >"$other/main-later.txt"
git -C "$other" add main-later.txt
git -C "$other" commit -qm main-later
git -C "$other" push -q origin main
rc=0
out=$(push_hook "$merged_head") || rc=$?
check "the second push sends the verified merge at once, though main moved since" "the second push did not pass (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'merged by the last run' <<<"$out" || true)" -a -z "$(grep -F 'fetching origin/main' <<<"$out" || true)"
check "and nothing was merged for it" "the asked-for push merged main again" test "$(git -C "$p" rev-parse HEAD)" = "$merged_head"

# A conflict: aborted, the branch exactly as it was, and the files named.
echo "theirs" >"$other/shared.txt"
git -C "$other" commit -qam theirs
git -C "$other" push -q origin main
echo "ours" >"$p/shared.txt"
git -C "$p" commit -qam ours
before=$(git -C "$p" rev-parse HEAD)
rc=0
out=$(push_hook "$before") || rc=$?
check "a conflict is refused, naming the file" "conflict refusal unclear (rc=$rc): $out" \
  test "$rc" -ne 0 -a -n "$(grep -F 'conflicts with this branch' <<<"$out" || true)" -a -n "$(grep -F 'shared.txt' <<<"$out" || true)"
check "the branch is left exactly as it was" "the branch moved after a refused merge" test "$(git -C "$p" rev-parse HEAD)" = "$before"
check "no merge is left in progress" "a merge was left in progress" test ! -f "$(git -C "$p" rev-parse --git-path MERGE_HEAD)"
check "the working tree is clean" "the refused merge left changes behind" test -z "$(git -C "$p" status --porcelain)"

# ── 4b. the push runs what CI would run for its range, and nothing more ─────────────────────────
echo "the push plan follows the range, through the same scopes as CI:"
s_origin="$scratch/scope-origin.git"
git init -q --bare -b main "$s_origin"
s="$scratch/scope"
make_repo "$s"
git -C "$s" remote add origin "$s_origin"
git -C "$s" push -q origin main
git -C "$s" switch -q -c feature
scope_push() { # <message>: commit what is staged, and print the dry-run push plan
  git -C "$s" commit -qm "$1"
  (cd "$s" && printf 'refs/heads/feature %s refs/heads/feature %s\n' "$(git rev-parse HEAD)" "$ZERO" |
    LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1) || true
}
# shellcheck disable=SC2317,SC2329 # called through `check` (0.10 names it SC2317, 0.11 SC2329)
planned() { grep -F "PLAN $1:" <<<"$2" >/dev/null; }
echo "# Changed" >>"$s/docs/wiki/page.md"
git -C "$s" add docs/wiki/page.md
out=$(scope_push docs)
check "a docs-only push runs the docs gates" "a docs-only push planned no wiki-links: $out" planned wiki-links "$out"
check "a docs-only push runs no frontend suite" "a docs-only push planned the frontend suite" \
  test -z "$(grep -F 'PLAN frontend-test:' <<<"$out" || true)"
check "a docs-only push runs no Rust suite" "a docs-only push planned a Rust crate" \
  test -z "$(grep -F 'PLAN rust ' <<<"$out" || true)"
check "a docs-only push does not run make test-ci-scripts" "a docs-only push planned test-ci-scripts" \
  test -z "$(grep -F 'PLAN test-ci-scripts:' <<<"$out" || true)"
check "and says the rest of that suite is CI's" "a skipped test-ci-scripts was not named" \
  test -n "$(grep -F 'CI only for this range: test-ci-scripts' <<<"$out" || true)"
echo "export const a = 2;" >"$s/frontend/src/lib/x/mod.ts"
git -C "$s" add frontend/src/lib/x/mod.ts
out=$(scope_push frontend)
check "a frontend change runs the frontend suite" "a frontend change planned no frontend-test: $out" planned frontend-test "$out"
check "a frontend change does not run make test-ci-scripts" "a frontend change planned test-ci-scripts" \
  test -z "$(grep -F 'PLAN test-ci-scripts:' <<<"$out" || true)"
check "and its vitest is the related run, not the whole suite" "the push planned the whole vitest suite: $out" \
  test -n "$(grep -F 'checks.sh frontend-test-related ' <<<"$out" || true)"
related() { (cd "$s" && CHECKS_DRY_RUN=1 bash .github/scripts/checks.sh frontend-test-related HEAD~1 2>&1) || true; }
out=$(related)
check "the related run takes the changed file" "the changed file was not handed to vitest related: $out" \
  test -n "$(grep -Fx 'related: src/lib/x/mod.ts' <<<"$out" || true)"
check "plus every scan of the source tree" "a source-tree scan was left out of the related run: $out" \
  test -n "$(grep -Fx 'related: src/lib/scan.test.ts' <<<"$out" || true)"
check "plus a test that reads the changed file's text" "a test reading the changed file was left out: $out" \
  test -n "$(grep -Fx 'related: src/lib/reads.test.ts' <<<"$out" || true)"
check "and not a test about another file" "a test unrelated to the change was planned: $out" \
  test -z "$(grep -F 'unrelated.test.ts' <<<"$out" || true)"
check "and it does not run the whole suite" "a source change ran the whole suite: $out" \
  test -z "$(grep -F 'the whole suite runs' <<<"$out" || true)"
echo "export default {};" >"$s/frontend/vitest.config.ts"
git -C "$s" add frontend/vitest.config.ts
git -C "$s" commit -qm vitest-config
out=$(related)
check "a change to the test setup runs the whole suite, by a named line" "a vitest config change did not run the whole suite: $out" \
  test -n "$(grep -F 'the test setup changed (vitest.config.ts) - the whole suite runs' <<<"$out" || true)"
printf '#!/usr/bin/env bash\necho hi\n' >"$s/.github/scripts/new.sh"
git -C "$s" add .github/scripts/new.sh
out=$(scope_push script)
check "a CI script change runs make test-ci-scripts" "a script change planned no test-ci-scripts: $out" planned test-ci-scripts "$out"
check "and lints the pushed script" "the pushed script was not handed to shellcheck" \
  test -n "$(grep -F 'shellcheck .github/scripts/new.sh' <<<"$out" || true)"
# The positive half of "a docs-only push runs no Rust suite": the fixture CAN plan one.
mkdir -p "$s/apps/call-service/src"
echo "fn main() {}" >"$s/apps/call-service/src/main.rs"
git -C "$s" add apps/call-service/src/main.rs
out=$(scope_push rust)
check "a crate change runs that crate's suite" "a call-service change planned no Rust job: $out" \
  test -n "$(grep -F 'PLAN rust apps/call-service:' <<<"$out" || true)"
check "and not the frontend suite" "a Rust change planned the frontend suite" \
  test -z "$(grep -F 'PLAN frontend-test:' <<<"$out" || true)"
# main moves with a page while the branch was verified: the merge is checked for what it brought.
s_other="$scratch/scope-other"
git clone -q "$s_origin" "$s_other"
configure "$s_other"
echo "# Main" >"$s_other/docs/wiki/main.md"
git -C "$s_other" add docs/wiki/main.md
git -C "$s_other" commit -qm main-page
git -C "$s_other" push -q origin main
out=$( (cd "$s" && printf 'refs/heads/feature %s refs/heads/feature %s\n' "$(git rev-parse HEAD)" "$ZERO" |
  LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1) || true)
check "a merge onto a verified commit is checked for what main brought" \
  "the merge onto a verified commit was not scoped to main's changes: $out" \
  test -n "$(grep -F 'checking only what has come in' <<<"$out" || true)" -a -n "$(grep -F 'PLAN wiki-links:' <<<"$out" || true)"
check "and not for the branch's own, already verified, work" "the verified branch work was planned again" \
  test -z "$(grep -F 'PLAN test-ci-scripts:' <<<"$out" || true)"

# ── 5. the hooks ────────────────────────────────────────────────────────────────────────────────
echo "the tracked hooks call the script:"
check ".husky/pre-commit runs the commit tier" ".husky/pre-commit does not run local-ci.sh commit" \
  grep -q 'local-ci.sh commit' "$repo_root/.husky/pre-commit"
check ".husky/pre-push runs the push tier" ".husky/pre-push does not run local-ci.sh push" \
  grep -q 'local-ci.sh push' "$repo_root/.husky/pre-push"
run_ci=$(sed -n '/^run-ci:/,/^$/p' "$repo_root/Makefile")
check "make run-ci runs the same plan" "make run-ci does not call local-ci.sh all" has "local-ci.sh all" "$run_ci"
# core.hooksPath: the shell and the JS copies agree, and a wrong value refuses both tiers.
js_path=$(sed -n "s/^export const HOOKS_PATH = '\(.*\)';$/\1/p" "$repo_root/frontend/scripts/hooks-path.js")
sh_path=$(sed -n 's/^HOOKS_PATH=//p' "$repo_root/.github/scripts/local-ci.sh")
check "local-ci.sh and hooks-path.js name the same hooks path ($sh_path)" \
  "local-ci.sh says '$sh_path', hooks-path.js says '$js_path'" test -n "$sh_path" -a "$sh_path" = "$js_path"
h="$scratch/hooks"
make_repo "$h"
for wrong in /abs/hooks ""; do
  if [ -n "$wrong" ]; then git -C "$h" config core.hooksPath "$wrong"; else git -C "$h" config --unset core.hooksPath; fi
  rc=0
  out=$(cd "$h" && echo x >>shared.txt && git add shared.txt && LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh commit 2>&1) || rc=$?
  check "commit refuses core.hooksPath='${wrong:-<unset>}'" "commit ran with core.hooksPath='${wrong:-<unset>}'" \
    test "$rc" -ne 0 -a -n "$(grep -F 'Run bun install in frontend/' <<<"$out" || true)"
  rc=0
  out=$(cd "$h" && git reset -q --hard && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO" |
    LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1) || rc=$?
  check "push refuses core.hooksPath='${wrong:-<unset>}'" "push ran with core.hooksPath='${wrong:-<unset>}'" \
    test "$rc" -ne 0 -a -n "$(grep -F 'Run bun install in frontend/' <<<"$out" || true)"
done
# An older branch's install writes `.husky/_` into the shared config: said, not refused.
git -C "$h" config core.hooksPath .husky/_
git -C "$h" reset -q --hard
rc=0
out=$(cd "$h" && echo y >>shared.txt && git add shared.txt && LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh commit 2>&1) || rc=$?
check "core.hooksPath='.husky/_' (an older install) runs the commit tier, saying so" \
  "core.hooksPath='.husky/_' was refused or not named (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'written by an older branch' <<<"$out" || true)"
git -C "$h" reset -q --hard

# The commit tier lints only the staged scripts, and only those of the set CI lints.
narrowed=$(make -s -n -C "$repo_root" lint-ci-scripts FILES=".github/scripts/local-ci.sh frontend/not-linted.sh")
check "FILES narrows shellcheck to the staged scripts CI lints" "FILES does not narrow the shellcheck run" \
  test -n "$(grep -F 'set -- .github/scripts/local-ci.sh;' <<<"$narrowed" || true)"
everything=$(make -s -n -C "$repo_root" lint-ci-scripts)
check "without FILES, shellcheck lints the whole set" "without FILES, the set is not linted whole" \
  has "scripts/*.sh" "$everything"

# A shellcheck other than the pinned one is refused, naming both versions.
fake_bin="$scratch/fake-bin"
mkdir -p "$fake_bin"
printf '#!/bin/sh\necho "ShellCheck - shell script analysis tool"\necho "version: 9.9.9"\n' >"$fake_bin/shellcheck"
chmod +x "$fake_bin/shellcheck"
out=$(cd "$repo_root" && PATH="$fake_bin:$PATH" bash .github/scripts/local-ci.sh shellcheck .github/scripts/local-ci.sh 2>&1) || true
check "a shellcheck at another version than .shellcheck-version is refused" \
  "a shellcheck at another version was used: $out" \
  test -n "$(grep -F 'this machine has v9.9.9' <<<"$out" || true)"

echo "the real repository is untouched:"
config_after=$(guarded_config)
check "core.bare, core.hooksPath, user.* and commit.gpgsign are as before the run" \
  "this run changed the real repository's config: before [$config_before] after [$config_after]" \
  test "$config_before" = "$config_after"

exit "$fail"
