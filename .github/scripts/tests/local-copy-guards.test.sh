#!/usr/bin/env bash
#
# Asserts the guards on the LOCAL copy of production - `infrastructure/local/pull-prod-dump.sh`
# fetches a dump, `infrastructure/local/restore-into-local.sh` restores it into a developer's own
# stack, and `infrastructure/lib/copy-strips.sh` holds what a copy must not carry.
#
# IT WAS `dev-copy-guards.test.sh` UNTIL 2026-10-16, when the weekly copy of production into the
# dev.canari-emse.fr estate was deleted (owner, GDPR review) and dev moved to a fictional seed -
# whose own guards are `dev-reset-guards.test.sh`. The local copy is the one production copy left,
# kept for the owner to decide on, and these are the properties it still owes:
#
#   1. THE STRIP LIST IS COMPLETE. Its failure mode is an ABSENCE: a payment column added to an
#      entity next month is a live identifier the copy would carry onto a developer's laptop, and
#      nothing would say so. So the list is DERIVED from the entity declarations here and checked
#      against the strips, the same shape as `ceiling.test.sh` and for the same reason.
#   2. THE TARGET CANNOT INVERT. The local project is a readonly literal, every write goes through
#      one function that re-checks its label, and the restore half never reaches production.
#
# Run by `make test-ci-scripts` and by CI.

set -euo pipefail

cd "$(dirname "$0")/../../.."

readonly STRIPS=infrastructure/lib/copy-strips.sh
readonly LOCAL_SCRIPT=infrastructure/local/restore-into-local.sh
# Production's compose project, read from the file that declares it rather than typed: the local
# target must never be that name, and a typed copy would go stale the day production is renamed
# (it was `infrastructure` until 2026-09-24).
prod_project=$(sed -n 's/^name:[[:space:]]*//p' infrastructure/docker-compose.prod.yml | head -1)

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

printf 'Guards on the local copy of production\n'

if [ -z "$prod_project" ]; then
  fail "no 'name:' in infrastructure/docker-compose.prod.yml - production's project cannot be compared against"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. The strip list is complete, DERIVED from the entities
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
      fail "$col is declared by an entity and NOT stripped by the local copy - a live identifier would reach a developer's laptop"
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

# ─────────────────────────────────────────────────────────────────────────────
# 1b. The media strips are complete, DERIVED the same way and for a different reason
# ─────────────────────────────────────────────────────────────────────────────
# The payment columns are things a copy MUST NOT carry. These are things it CANNOT carry: the
# copy never fetches the object store, so every media id in the restored rows names a blob that lives only
# in production's Garage, and the product is then answered 404 for asking exactly the right question.
# The failure mode is the same absence - a media column added to an entity next month would dangle
# with nothing to say so - so the list is derived rather than written out.
#
# WHICH PROPERTIES COUNT IS A DECISION, exactly as "which payment providers exist" is one: any
# property whose name contains `media`, plus the three mirrors that carry a media reference without
# saying so in their name. `logoUrl` and `imageUrl` hold `/api/media/public/<uuid>` - `logoUrl` is
# the one `associationLogoCache` actually fetches, so clearing the id without it fixes nothing - and
# `attachments` is a jsonb array whose elements each carry a `mediaId`.
#
# THE COLUMN IS NOT ALWAYS THE PROPERTY, which is why the decorator is read and not just the name:
# `post.media` is declared `@Column('jsonb', { name: 'images' })`. A derivation reading property
# names alone would look for a column that does not exist, find no strip for it, and report a gap
# that is not there - or worse, be "fixed" by writing a strip against a column name Postgres has
# never had. `sprintf("%c", 39)` builds the quote character: a literal one inside this awk program
# inside a single-quoted shell string is four levels of escaping for one byte.
printf '\nthe media strips cover every media column an entity declares:\n'

# shellcheck disable=SC2016
media_columns=$(find apps -name '*.entity.ts' -print0 2>/dev/null | xargs -0 -r awk '
  BEGIN { q = sprintf("%c", 39) }
  FNR == 1 { col = "" }
  /@Column\(/ {
    col = "";
    n = index($0, "name:");
    if (n > 0) {
      rest = substr($0, n);
      a = index(rest, q);
      if (a > 0) {
        rest = substr(rest, a + 1);
        b = index(rest, q);
        if (b > 1) col = substr(rest, 1, b - 1);
      }
    }
    next
  }
  /^[ \t]+[A-Za-z0-9_]+[?!]?[ \t]*:/ {
    name = $0;
    sub(/^[ \t]+/, "", name);
    sub(/[?!]?[ \t]*:.*$/, "", name);
    low = tolower(name);
    if (index(low, "media") > 0 || name == "logoUrl" || name == "imageUrl" || name == "attachments")
      print (col != "" ? col : name);
    col = "";
  }
' | sort -u)

if [ -z "$media_columns" ]; then
  fail "no media columns could be derived from the entities - the parser and the code have diverged"
else
  count=$(printf '%s\n' "$media_columns" | wc -l | tr -d ' ')
  ok "derived $count media column(s) from the entity declarations"
  for col in $media_columns; do
    # shellcheck disable=SC2016
    if grep '"\$sql"' "$STRIPS" | grep -qF "\\\"$col\\\""; then
      ok "$col is cleared"
    else
      fail "$col is declared by an entity and NOT cleared by the local copy - it would reference objects it never received, and every render of them is a 404"
    fi
  done
fi

# The shared file must never reach a database itself: it is handed the name of its caller's guarded
# function precisely so that the ALLOWLIST of writable targets stays in the script that owns one.
if grep -qE 'docker (exec|ps|inspect)|psql ' "$STRIPS"; then
  fail "$STRIPS talks to a container directly - it must only call the sql function it is passed"
else
  ok "$STRIPS writes only through the function its caller passes"
fi

# The copy must actually USE it. A caller that stopped calling it would strip nothing at all, which
# is the silent failure this whole section exists for.
if [ ! -f "$LOCAL_SCRIPT" ]; then
  fail "$LOCAL_SCRIPT is missing"
elif grep -q 'copy-strips.sh' "$LOCAL_SCRIPT" && grep -q 'apply_copy_strips' "$LOCAL_SCRIPT"; then
  ok "$LOCAL_SCRIPT sources the shared strips and applies them"
else
  fail "$LOCAL_SCRIPT does not apply the shared strip list"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. The LOCAL copy, added 2026-09-02 - the target cannot invert
# ─────────────────────────────────────────────────────────────────────────────
# It destroys a database on a developer's machine, and the machine it runs on also holds unrelated
# Docker projects: the one it was written on already had a project called `local` belonging to
# something else entirely. So the allowlist matters here as it does on any shared daemon.
printf '\nthe local copy cannot be aimed elsewhere:\n'

if [ ! -f "$LOCAL_SCRIPT" ]; then
  fail "$LOCAL_SCRIPT is missing"
else
  local_project=$(awk -F'"' '/^readonly LOCAL_PROJECT=/ { print $2; exit }' "$LOCAL_SCRIPT")
  if [ -n "$local_project" ]; then
    ok "the target project is a readonly literal ($local_project)"
  else
    fail "LOCAL_PROJECT must be 'readonly LOCAL_PROJECT=\"literal\"'"
  fi

  # It must not be the production project name. Production's compose project was literally called
  # `infrastructure` until 2026-09-24, exactly the kind of name a path-derived project could collide
  # with, which is why the comparison reads the name from production's compose file.
  if [ -n "$prod_project" ] && [ "$local_project" != "$prod_project" ]; then
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

  for probe in 'push_token' 'stripeCustomerId' 'FROM users' 'COPY_STRIPS_MEDIA_RESIDUE_SQL'; do
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
