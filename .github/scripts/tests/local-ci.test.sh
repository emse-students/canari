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
fail=0
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
  cp "$repo_root/.github/scripts/local-ci.sh" "$repo_root/.github/scripts/ci-scopes.sh" "$dir/.github/scripts/"
  echo "name: CI" >"$dir/.github/workflows/ci.yml"
  echo "export const a = 1;" >"$dir/frontend/src/lib/x/mod.ts"
  echo "test" >"$dir/frontend/src/lib/x/mod.test.ts"
  echo "test" >"$dir/frontend/src/lib/x/mod.edge.test.ts"
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
git init -q --bare "$origin"
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
  test "$rc" -eq 0 -a -n "$(grep -F 'PLAN test-ci-scripts:' <<<"$out" || true)"
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
check "the checks ran on the merged result" "the merge was not checked: $out" has "PLAN test-ci-scripts:" "$out"
rc=0
out=$(push_hook "$merged_head") || rc=$?
check "the second push sends the verified merge at once" "the second push did not pass (rc=$rc): $out" \
  test "$rc" -eq 0 -a -n "$(grep -F 'already passed' <<<"$out" || true)"

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
for wrong in .husky/_ ""; do
  if [ -n "$wrong" ]; then git -C "$h" config core.hooksPath "$wrong"; else git -C "$h" config --unset core.hooksPath; fi
  rc=0
  out=$(cd "$h" && echo x >>shared.txt && git add shared.txt && LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh commit 2>&1) || rc=$?
  check "commit refuses core.hooksPath='${wrong:-<unset>}'" "commit ran with core.hooksPath='${wrong:-<unset>}'" \
    test "$rc" -ne 0 -a -n "$(grep -F 'git config core.hooksPath .husky' <<<"$out" || true)"
  rc=0
  out=$(cd "$h" && git reset -q --hard && printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$ZERO" |
    LOCAL_CI_DRY_RUN=1 bash .github/scripts/local-ci.sh push origin 2>&1) || rc=$?
  check "push refuses core.hooksPath='${wrong:-<unset>}'" "push ran with core.hooksPath='${wrong:-<unset>}'" \
    test "$rc" -ne 0 -a -n "$(grep -F 'git config core.hooksPath .husky' <<<"$out" || true)"
done

# The commit tier lints only the staged scripts, and only those of the set CI lints.
narrowed=$(make -s -n -C "$repo_root" lint-ci-scripts FILES=".github/scripts/local-ci.sh frontend/not-linted.sh")
check "FILES narrows shellcheck to the staged scripts CI lints" "FILES does not narrow the shellcheck run" \
  test -n "$(grep -F 'set -- .github/scripts/local-ci.sh;' <<<"$narrowed" || true)"
everything=$(make -s -n -C "$repo_root" lint-ci-scripts)
check "without FILES, shellcheck lints the whole set" "without FILES, the set is not linted whole" \
  has "scripts/*.sh" "$everything"

exit "$fail"
