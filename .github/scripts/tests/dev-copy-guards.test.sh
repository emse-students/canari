#!/usr/bin/env bash
#
# Asserts the guards on `infrastructure/dev/copy-prod-to-dev.sh` - the script that copies
# PRODUCTION's database into the dev environment.
#
# WHY THIS EXISTS. That script reads production and destroys a database. Two of its properties cannot
# be verified by running it, because running it requires a dev environment that does not exist yet,
# and the failure it protects against is one nobody gets to see twice:
#
#   1. THE DIRECTION CANNOT INVERT. The two compose projects are hardcoded constants, so there is no
#      argument a caller can pass to point the destructive half at production, and every write goes
#      through one function that re-checks the target's project label.
#   2. THE STRIP LIST IS COMPLETE. Its failure mode is an ABSENCE: a payment column added to an
#      entity next month is a live identifier that the copy would carry into a publicly-resolvable
#      environment, and nothing would say so. So the list is DERIVED from the entity declarations
#      here and checked against the script, the same shape as `ceiling.test.sh` and for the same
#      reason - a hand-written list fails silently by omission.
#
# Run by `make test-ci-scripts` and by CI.

set -euo pipefail

cd "$(dirname "$0")/../../.."

readonly SCRIPT=infrastructure/dev/copy-prod-to-dev.sh
# There are TWO copies of production since 2026-09-02, when development moved local. The strip list
# lives in one file that both source, so the derivation below covers both by construction rather
# than by a second hand-written list that would drift on the first change.
readonly STRIPS=infrastructure/lib/copy-strips.sh
readonly LOCAL_SCRIPT=infrastructure/local/restore-into-local.sh

failures=0
checks=0

fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

ok() {
  printf '  ok   %s\n' "$1"
  checks=$((checks + 1))
}

# A script's executable lines: comments and blanks removed. Several assertions below search for a
# command or an SQL keyword, and these files EXPLAIN themselves at length - `pg_dump`, `TRUNCATE`
# and the rest all appear in prose. A check that cannot tell an invocation from an explanation
# punishes the explanation, so it is stripped here rather than in each pattern.
code_lines() {
  grep -vE '^[[:space:]]*#' "$1" | grep -vE '^[[:space:]]*$'
}

printf 'Guards on %s\n' "$SCRIPT"

if [ ! -f "$SCRIPT" ]; then
  fail "$SCRIPT is missing"
  printf '\nFAILED\n'
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. The direction cannot invert
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe direction is fixed:\n'

prod_project=$(awk -F'"' '/^readonly PROD_PROJECT=/ { print $2; exit }' "$SCRIPT")
dev_project=$(awk -F'"' '/^readonly DEV_PROJECT=/ { print $2; exit }' "$SCRIPT")

if [ -n "$prod_project" ] && [ -n "$dev_project" ]; then
  ok "both projects are declared as readonly literals ($prod_project, $dev_project)"
else
  fail "PROD_PROJECT and DEV_PROJECT must both be 'readonly NAME=\"literal\"'"
fi

if [ "$prod_project" != "$dev_project" ]; then
  ok "the source and target projects are different names"
else
  fail "the source and target projects are the same name"
fi

# No write may name the production container. `PROD_PG` appearing in a `psql` without -tAX (the
# read-only shape) or in any statement that writes would be the inversion this guards against.
# `[$]` rather than a backslash: the dollar is a literal being searched for, and writing it escaped
# inside single quotes reads as a failed attempt at expansion.
if grep -nE '[$]PROD_PG' "$SCRIPT" | grep -qiE 'TRUNCATE|UPDATE |DELETE |DROP |CREATE DATABASE|INSERT '; then
  fail "a write statement names the production container"
else
  ok "no write statement names the production container"
fi

# Every destructive statement must go through dev_sql(), which re-checks the label.
destructive=$(grep -nE 'TRUNCATE|DROP DATABASE|CREATE DATABASE|^dev_sql "UPDATE|UPDATE [a-z_]+ SET' "$SCRIPT" |
  grep -vE '^\s*[0-9]+:\s*#' | grep -vE '^[0-9]+:#')
unguarded=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  # Strip the line number, then ignore comment lines and this test's own description.
  body=${line#*:}
  case "$body" in
  \#* | *' #'*[Tt]RUNCATE*) continue ;;
  esac
  printf '%s' "$body" | grep -qE '^\s*#' && continue
  if ! printf '%s' "$body" | grep -q 'dev_sql'; then
    fail "a destructive statement does not go through dev_sql(): ${body# }"
    unguarded=$((unguarded + 1))
  fi
done <<EOF
$destructive
EOF
[ "$unguarded" -eq 0 ] && ok "every destructive statement goes through dev_sql()"

# dev_sql must verify the label on every call, not once at startup.
if awk '/^dev_sql\(\)/,/^}/' "$SCRIPT" | grep -q 'project_of'; then
  ok "dev_sql() re-reads the target project label per call"
else
  fail "dev_sql() does not re-read the target project label"
fi

if awk '/^dev_sql\(\)/,/^}/' "$SCRIPT" | grep -q 'DRY_RUN'; then
  ok "dev_sql() honours --dry-run"
else
  fail "dev_sql() ignores --dry-run, so the dry run is not dry"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. The strip list is complete, DERIVED from the entities
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe strip list covers every payment column an entity declares:\n'

# A property declaration, not a comment: leading whitespace, then the name, then a colon. The
# providers are named rather than pattern-matched because "which external payment providers exist"
# is a decision, and a new one should show up here as a deliberate edit.
payment_columns=$(grep -rhoE '^[[:space:]]+(stripe|lydia)[A-Za-z0-9]*[?!]?[[:space:]]*:' \
  --include='*.entity.ts' apps 2>/dev/null |
  sed -E 's/^[[:space:]]+//; s/[?!]?[[:space:]]*:$//' | sort -u)

if [ -z "$payment_columns" ]; then
  fail "no payment columns could be derived from the entities - the parser and the code have diverged"
else
  count=$(printf '%s\n' "$payment_columns" | wc -l | tr -d ' ')
  ok "derived $count payment column(s) from the entity declarations"
  for col in $payment_columns; do
    # Matched as a FIXED string on the exact bytes the file contains: the column names appear
    # escaped inside double-quoted shell strings, so it really holds `\"stripeCustomerId\"`.
    # Restricting to the lines that CALL the guarded function is what stops the comment block above
    # them from satisfying this.
    #
    # The single quotes are the point, not an oversight: this searches for the LITERAL two
    # characters `$sql` as they appear in the source file, and expanding them would search for the
    # value of a variable this script does not have.
    # shellcheck disable=SC2016
    if grep '"\$sql"' "$STRIPS" | grep -qF "\\\"$col\\\""; then
      ok "$col is stripped"
    else
      fail "$col is declared by an entity and NOT stripped by the copies - a live identifier would reach dev AND a developer's laptop"
    fi
  done
fi

# Push tokens are the other thing a copy must not carry, and for two independent reasons (a shared
# sender reaching a real phone, and a rejected token logged per send).
if grep -q 'TRUNCATE TABLE push_token' "$STRIPS"; then
  ok "push_token is truncated"
else
  fail "push_token is not truncated - copied tokens belong to production's FCM sender"
fi

# The shared file must never reach a database itself: it is handed the name of its caller's guarded
# function precisely so that the ALLOWLIST of writable targets stays in the script that owns one.
if grep -qE 'docker (exec|ps|inspect)|psql ' "$STRIPS"; then
  fail "$STRIPS talks to a container directly - it must only call the sql function it is passed"
else
  ok "$STRIPS writes only through the function its caller passes"
fi

# Both copies must actually USE it. A caller that stopped calling it would strip nothing at all,
# which is the silent failure this whole section exists for.
for caller in "$SCRIPT" "$LOCAL_SCRIPT"; do
  if [ ! -f "$caller" ]; then
    fail "$caller is missing"
  elif grep -q 'copy-strips.sh' "$caller" && grep -q 'apply_copy_strips' "$caller"; then
    ok "$caller sources the shared strips and applies them"
  else
    fail "$caller does not apply the shared strip list"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 3. The copy verifies rather than asserts
# ─────────────────────────────────────────────────────────────────────────────
printf '\nthe copy checks its own result:\n'

for probe in 'push_token' 'stripeCustomerId' 'FROM users'; do
  # Anchored on the text alone: the section rules are box-drawing characters, and a dot-per-char
  # regex counts bytes rather than characters under a C locale.
  if awk '/5\. Verify, do not assert/,0' "$SCRIPT" | grep -q "$probe"; then
    ok "the verification step reads $probe back"
  else
    fail "the verification step does not read $probe back"
  fi
done

if grep -q 'did not verify' "$SCRIPT"; then
  ok "a copy that does not verify is reported as untrustworthy"
else
  fail "a failed verification does not fail the script"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. The LOCAL copy, added 2026-09-02 - the same guards on a different target
# ─────────────────────────────────────────────────────────────────────────────
# It destroys a database on a developer's machine, and the machine it runs on also holds unrelated
# Docker projects: the one it was written on already had a project called `local` belonging to
# something else entirely. So the allowlist matters here for the same reason it matters in dev.
printf '\nthe local copy is guarded the same way:\n'

if [ ! -f "$LOCAL_SCRIPT" ]; then
  fail "$LOCAL_SCRIPT is missing"
else
  local_project=$(awk -F'"' '/^readonly LOCAL_PROJECT=/ { print $2; exit }' "$LOCAL_SCRIPT")
  if [ -n "$local_project" ]; then
    ok "the target project is a readonly literal ($local_project)"
  else
    fail "LOCAL_PROJECT must be 'readonly LOCAL_PROJECT=\"literal\"'"
  fi

  # It must not be the production project name. Production's compose project is literally called
  # `infrastructure`, which is exactly the kind of name a path-derived project could collide with.
  if [ "$local_project" != "$prod_project" ]; then
    ok "the local target is not production's project name"
  else
    fail "the local target IS production's project name - a restore would destroy production"
  fi

  if awk '/^local_sql\(\)/,/^}/' "$LOCAL_SCRIPT" | grep -q 'project_of'; then
    ok "local_sql() re-reads the target project label per call"
  else
    fail "local_sql() does not re-read the target project label"
  fi

  if awk '/^local_sql\(\)/,/^}/' "$LOCAL_SCRIPT" | grep -q 'DRY_RUN'; then
    ok "local_sql() honours --dry-run"
  else
    fail "local_sql() ignores --dry-run, so the dry run is not dry"
  fi

  # The whole point of the split: this script has no production access, so it cannot invert.
  # Comments are stripped first - the header explains what `pg_dump` does and why, and a test that
  # cannot tell prose from an invocation would force the explanation out of the file.
  if code_lines "$LOCAL_SCRIPT" | grep -qE '(^|[^-[:alnum:]_])(ssh|scp|pg_dump)([[:space:]]|$)'; then
    fail "the local restore INVOKES ssh, scp or pg_dump - fetching is pull-prod-dump.sh's job"
  else
    ok "the local restore never reaches production (no ssh, scp or pg_dump invocation)"
  fi

  for probe in 'push_token' 'stripeCustomerId' 'FROM users'; do
    if awk '/5\. Verify, do not assert/,0' "$LOCAL_SCRIPT" | grep -q "$probe"; then
      ok "the local verification reads $probe back"
    else
      fail "the local verification does not read $probe back"
    fi
  done

  if grep -q 'is NOT trustworthy' "$LOCAL_SCRIPT"; then
    ok "a local restore that does not verify is reported as untrustworthy"
  else
    fail "a failed local verification does not fail the script"
  fi
fi

# The fetch half must stay read-only, and must never put a dump of every member's PII where
# `git add -A` could reach it.
readonly PULL_SCRIPT=infrastructure/local/pull-prod-dump.sh
printf '\nthe fetch half only reads:\n'
if [ ! -f "$PULL_SCRIPT" ]; then
  fail "$PULL_SCRIPT is missing"
else
  # CASE-SENSITIVE and anchored on a following space, deliberately. `-i` made this fail on the word
  # "truncated" in a legitimate error message about a truncated transfer, which is the failure this
  # script exists to report: a test that cannot tell `TRUNCATE TABLE` from English prose would push
  # the prose out.
  if code_lines "$PULL_SCRIPT" | grep -qE 'TRUNCATE[[:space:]]+TABLE|DROP DATABASE|CREATE DATABASE|UPDATE [a-z_]+ SET|DELETE FROM'; then
    fail "$PULL_SCRIPT contains a write statement - it is meant to read production, nothing else"
  else
    ok "no write statement anywhere in the fetch script"
  fi
  if grep -q 'refusing to write a production dump inside the repository' "$PULL_SCRIPT"; then
    ok "it refuses to write a dump inside the work tree"
  else
    fail "nothing stops a production dump from landing inside the repository"
  fi
  if grep -q 'gunzip -t' "$PULL_SCRIPT"; then
    ok "the transfer is checked for truncation, not just for size"
  else
    fail "a truncated dump would pass as valid"
  fi
fi

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
