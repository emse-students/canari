#!/usr/bin/env bash
#
# Asserts the strip list of `infrastructure/lib/copy-strips.sh` - what a copy of production must not
# carry - stays COMPLETE. The local copy of production was removed on 2026-10-24 (owner decision:
# production data is never copied to a workstation); the strips remain because the dev reset
# (`infrastructure/dev/reset-dev-to-seed.sh`) still reads the media-residue question they own.
#
# THE STRIP LIST IS COMPLETE. Its failure mode is an ABSENCE: a payment column added to an entity
# next month is a live identifier a copy would carry, and nothing would say so. So the list is
# DERIVED from the entity declarations here and checked against the strips, the same shape as
# `ceiling.test.sh` and for the same reason.
#
# Run by `make test-ci-scripts` and by CI.

set -euo pipefail

cd "$(dirname "$0")/../../.."

readonly STRIPS=infrastructure/lib/copy-strips.sh

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

printf 'Guards on the copy strips\n'

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
    if grep '"\$sql"' "$STRIPS" | grep -F "\\\"$col\\\"" >/dev/null; then
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
    if grep '"\$sql"' "$STRIPS" | grep -F "\\\"$col\\\"" >/dev/null; then
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


printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
