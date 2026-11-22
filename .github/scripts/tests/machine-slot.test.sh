#!/usr/bin/env bash
# THE MACHINE SLOT GRANTS ONE HOLDER AT A TIME, AND A DEAD HOLDER RELEASES IT.
#
# `local-ci.sh` runs the checks that use every core inside `machine-slot.mjs` so that concurrent
# pushes on one machine queue instead of overloading it (docs/wiki/test-suite-reform.md, the sixth
# load reading). Two properties carry that: a second holder is granted only once the first has
# released, and a holder killed outright (no release ever written) frees the slot by dying - there
# is no stale lock for anything to time out. The order is read from events, never from a clock.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# A private slot, so this test neither waits for nor blocks a real push on the same machine.
export CANARI_MACHINE_SLOT_NAME="canari-machine-slot-selftest-$$"
SLOT_TOOL=.github/scripts/machine-slot.mjs
fail=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else
    echo "FAIL $1: expected '$2', got '$3'"
    fail=1
  fi
}

# 1. A holds; B asks; B is granted only after A releases.
events="$(mktemp)"
waits="$(mktemp)"
coproc A { exec bun "$SLOT_TOOL" A; }
holder_a=$A_PID
a_in=${A[0]}
a_out=${A[1]}
read -r granted <&"$a_in"
check "the first holder is granted at once" granted "$granted"
echo "A granted" >>"$events"
(
  # The holder's pipe must not leak into the waiter: a copy of its write end would keep A from
  # ever seeing the end of its stdin.
  exec {a_out}>&- {a_in}<&-
  coproc B { exec bun "$SLOT_TOOL" B; }
  b_out=${B[1]}
  read -r g <&"${B[0]}"
  echo "B $g" >>"$events"
  exec {b_out}>&-
  wait
) 2>"$waits" &
b_runner=$!
# Released only once B has said it waits for A, so the order below proves B was REFUSED while A
# held - not merely that B started late. The loop ends on that line, never on a count of looks.
# It also ends, loudly, if B's runner dies without ever saying it waits.
until grep -q "B waits for A" "$waits"; do
  if ! kill -0 "$b_runner" 2>/dev/null; then
    echo "FAIL the waiter exited without waiting for A; what it said:"
    sed 's/^/    /' "$waits"
    exit 1
  fi
  sleep 0.1
done
echo "A released" >>"$events"
exec {a_out}>&- {a_in}<&-
wait "$holder_a" || true
wait "$b_runner"
check "the second holder is granted only after the first released" \
  "A granted|A released|B granted" "$(paste -sd'|' "$events")"

# 2. A holder killed outright releases the slot: the next one is granted.
coproc C { exec bun "$SLOT_TOOL" C; }
holder_c=$C_PID
read -r granted <&"${C[0]}"
check "a third holder is granted on a free slot" granted "$granted"
kill -9 "$holder_c" 2>/dev/null || true
wait "$holder_c" 2>/dev/null || true
coproc D { exec bun "$SLOT_TOOL" D; }
holder_d=$D_PID
d_out=${D[1]}
read -r granted <&"${D[0]}"
check "a holder killed outright leaves the slot free" granted "$granted"
exec {d_out}>&-
wait "$holder_d" || true

rm -f "$events" "$waits"
exit "$fail"
