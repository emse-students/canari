#!/usr/bin/env bash
#
# Asserts `infrastructure/dev/version-gap.yml` - the file declaring which major versions the dev
# environment runs ahead of production, and what each of those gaps has actually PROVEN.
#
# WHY THIS EXISTS, AND WHY IT IS NOT AN EQUALITY CHECK. Dev is deliberately allowed to run a stateful
# image one major ahead of prod; that is the only place this repository can rehearse an upgrade before
# Dependabot proposes it. So the naive gate - assert dev and prod pin the same major - would fire on
# the very difference the environment exists to carry, and would be deleted the first time it did.
# What is asserted instead is that the gap is DECLARED, that the declaration matches both compose
# files, and that the EVIDENCE claimed for it answers the question the ceiling actually asks.
#
# THE ROW SET IS DERIVED, because its failure mode is an absence. A stateful service added to
# production next month is one whose major nobody has thought about, and a hand-written list here
# would stay green while saying nothing about it - the exact shape of the 2026-09-01 outage, where
# `postgres` had simply never been written into the ceiling table. The rows are therefore required to
# be exactly the third-party images production mounts a named volume for, read out of
# `docker-compose.prod.yml` by the parser the ceiling itself uses.
#
# Run by `make test-ci-scripts` and by CI.

set -uo pipefail

# `set -e` is deliberately NOT used: every assertion below reports and continues, so the run says
# everything that is wrong rather than only the first thing. That makes this `cd` the one command
# whose failure has to be handled by hand - without it the paths below would resolve against
# whatever directory the caller happened to be in.
cd "$(dirname "$0")/../../.." || exit 1

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/ceiling.sh
. "$(dirname "$0")/../lib/ceiling.sh"

readonly GAP=infrastructure/dev/version-gap.yml
readonly PROD=infrastructure/docker-compose.prod.yml
readonly DEV=infrastructure/docker-compose.dev.yml
readonly ALLOWED_EVIDENCE="none fresh_cluster logical_restore in_place_upgrade"

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

for f in "$GAP" "$PROD" "$DEV"; do
  if [ ! -f "$f" ]; then
    printf 'FAIL %s is missing\n' "$f"
    exit 1
  fi
done

# One field of one row. A row header is a key at column zero; its fields are indented two spaces.
gap_field() {
  awk -v want="$1" -v key="$2" '
    /^[^[:space:]#][^:]*:[[:space:]]*$/ {
      k = $0; sub(/:[[:space:]]*$/, "", k); inrow = (k == want); next
    }
    !inrow { next }
    $1 == key":" {
      v = $0; sub(/^[[:space:]]*[^:]*:[[:space:]]*/, "", v); gsub(/"/, "", v); print v; exit
    }
  ' "$GAP"
}

# Every row header in the file, in order.
gap_rows() {
  awk '/^[^[:space:]#][^:]*:[[:space:]]*$/ { k = $0; sub(/:[[:space:]]*$/, "", k); print k }' "$GAP"
}

# The major a compose file pins for an image, using the parser the ceiling uses.
compose_major() {
  CEILING_PROD_COMPOSE="$1" prod_image_major "$2"
}

printf 'The declared dev/prod version gap: %s\n' "$GAP"

# -------------------------------------------------------------------------------------------------
# 1. The row set is exactly the stateful third-party images production runs
# -------------------------------------------------------------------------------------------------
printf '\nevery stateful image production runs declares a gap:\n'

expected=$(third_party_stateful_images "$PROD" | awk '{ print $1 }' | sort)
declared=$(gap_rows | sort)

if [ -z "$expected" ]; then
  fail "no stateful third-party image could be read from $PROD - the parse is broken, not the file"
else
  n=$(printf '%s\n' "$expected" | wc -l | tr -d ' ')
  # A parse that silently matched nothing would make everything below vacuously green.
  if [ "$n" -lt 3 ]; then
    fail "only $n stateful image(s) read from $PROD; production runs at least three"
  else
    ok "read $n stateful image(s) from $PROD"
  fi
fi

missing=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$declared"))
extra=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$declared"))

if [ -n "$missing" ]; then
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    fail "$m holds state in production and declares no gap - nobody has said which major dev runs for it"
  done <<EOF
$missing
EOF
else
  ok "no stateful production image is undeclared"
fi

if [ -n "$extra" ]; then
  while IFS= read -r e; do
    [ -n "$e" ] || continue
    fail "$e declares a gap but production runs no such stateful image - a row about nothing"
  done <<EOF
$extra
EOF
else
  ok "no row describes an image production does not run"
fi

# -------------------------------------------------------------------------------------------------
# 2. Each row agrees with the compose files, and its evidence answers the right question
# -------------------------------------------------------------------------------------------------
while IFS= read -r image; do
  [ -n "$image" ] || continue
  printf '\n%s:\n' "$image"

  prod_declared=$(gap_field "$image" prod_major)
  dev_declared=$(gap_field "$image" dev_major)
  evidence=$(gap_field "$image" evidence)
  proof=$(gap_field "$image" proof)
  lifts=$(gap_field "$image" lifts)

  prod_actual=$(compose_major "$PROD" "$image")
  dev_actual=$(compose_major "$DEV" "$image")

  # The declared majors are held against the files, so this file cannot go stale when a pin moves,
  # and cannot claim a gap that is not there.
  if [ -z "$prod_actual" ]; then
    fail "no major could be read for $image out of $PROD"
  elif [ "$prod_declared" = "$prod_actual" ]; then
    ok "prod_major $prod_declared matches $PROD"
  else
    fail "prod_major says [$prod_declared] but $PROD pins major [$prod_actual]"
  fi

  if [ -z "$dev_actual" ]; then
    fail "no major could be read for $image out of $DEV - dev must run this image, or the row is a lie"
  elif [ "$dev_declared" = "$dev_actual" ]; then
    ok "dev_major $dev_declared matches $DEV"
  else
    fail "dev_major says [$dev_declared] but $DEV pins major [$dev_actual]"
  fi

  case " $ALLOWED_EVIDENCE " in
  *" $evidence "*) ok "evidence [$evidence] is one of the declared kinds" ;;
  *) fail "evidence [$evidence] is not one of: $ALLOWED_EVIDENCE" ;;
  esac

  # No gap means no claim. A row asserting evidence while dev and prod run the same major is a claim
  # about an upgrade nobody performed, and it would lift a ceiling on nothing.
  if [ "$dev_declared" = "$prod_declared" ]; then
    if [ "$evidence" = "none" ] && [ -z "$proof" ] && [ -z "$lifts" ]; then
      ok "no gap, and nothing is claimed"
    else
      fail "dev and prod both run major $dev_declared, so evidence must be [none] with an empty proof and lifts (got [$evidence])"
    fi
  else
    if [ "$evidence" = "none" ]; then
      fail "dev runs major $dev_declared against production $prod_declared and declares no evidence - say what running it has demonstrated"
    else
      ok "the gap $prod_declared -> $dev_declared declares evidence [$evidence]"
    fi
    if [ -n "$proof" ]; then
      ok "the evidence names where it was observed"
    else
      fail "evidence [$evidence] is claimed with an empty proof - a claim nobody can check"
    fi
  fi

  # `lifts` is the ceiling business, and only ONE kind of evidence is about the question it asks.
  if [ -n "$lifts" ] && [ "$evidence" != "in_place_upgrade" ]; then
    fail "this row lifts a ceiling on evidence [$evidence]; only [in_place_upgrade] answers what the ceiling asks"
  else
    ok "nothing is lifted on the wrong kind of evidence"
  fi

  # THE INTEGRATION ASSERTION, and the reason these two files cannot drift apart: whatever this row
  # declares, the ceiling verdict on the major dev runs must AGREE with it.
  verdict=$(gate_for_dependency "$image" "$dev_declared")
  if [ "$dev_declared" = "$prod_declared" ]; then
    if [ -z "$verdict" ]; then
      ok "the ceiling allows major $dev_declared, which is the one production runs"
    else
      fail "the ceiling refuses major $dev_declared while production runs it"
    fi
  elif [ "$evidence" = "in_place_upgrade" ] && [ -n "$proof" ]; then
    if [ -z "$verdict" ]; then
      ok "the ceiling honours the proven gap and allows major $dev_declared"
    else
      fail "this row claims a proven in-place upgrade to $dev_declared and the ceiling still refuses it"
    fi
  else
    if [ -n "$verdict" ]; then
      ok "the ceiling still refuses major $dev_declared, evidence [$evidence] being about another question"
    else
      fail "the ceiling allows major $dev_declared on evidence [$evidence] - only [in_place_upgrade] may do that"
    fi
  fi
done <<EOF
$declared
EOF

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
