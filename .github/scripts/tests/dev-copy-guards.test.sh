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
    # Matched as a FIXED string on the exact bytes the script contains: the column names appear
    # escaped inside double-quoted shell strings, so the file really holds `\"stripeCustomerId\"`.
    # Restricting to `dev_sql` lines is what stops the comment block above them from satisfying this.
    if grep 'dev_sql' "$SCRIPT" | grep -qF "\\\"$col\\\""; then
      ok "$col is stripped"
    else
      fail "$col is declared by an entity and NOT stripped by the copy - a live identifier would reach dev"
    fi
  done
fi

# Push tokens are the other thing a copy must not carry, and for two independent reasons (a shared
# sender reaching a real phone, and a rejected token logged per send).
if grep -q 'TRUNCATE TABLE push_token' "$SCRIPT"; then
  ok "push_token is truncated"
else
  fail "push_token is not truncated - copied tokens belong to production's FCM sender"
fi

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

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
