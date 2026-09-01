#!/usr/bin/env bash
#
# THE ONE QUESTION THAT DECIDES WHETHER AN OLD GREEN CHECK SUITE IS STILL EVIDENCE.
#
# A check suite describes the workflow definitions that produced it, not the ones `main` carries
# today. PR #272 was `CLEAN` with every check green and no `Boot the real AppModule` run at all,
# because that job was written after its CI last ran: the gate built to catch that exact pull
# request would have been walked straight past by the automation built to respect it.
#
# What invalidates a suite is therefore a change to what BUILDS it - `.github/workflows/` and
# `.github/scripts/`, which decide both which jobs run and what each asserts - and NOT any movement
# of `main`. Asking the wider question is what made the queue undrainable: every merge moved `main`,
# so every remaining pull request went stale in the same instant and the only exit was a rebuild
# nothing in CI is allowed to perform.
#
# Kept apart from its caller so it can be exercised on inputs GitHub will not produce on demand -
# a truncated compare, a malformed payload - which is the half that fails closed and the half a
# live run therefore never reaches. Tested by `.github/scripts/tests/gate-moves.test.sh`.

# Classifies a `GET /repos/{repo}/compare/{base}...{head}` payload rendered as: the changed-file
# COUNT on the first line, then one filename per line.
#
# Prints exactly one verdict line, and always exits 0 - the caller switches on the first word:
#   undecidable <why>    the payload is not evidence about anything; treat the gates as moved
#   moved <path>...      a gate definition changed between the two commits
#   settled <count>      `main` moved, and nothing that moved defines a gate
#
# UNDECIDABLE IS NOT AN ERROR PATH, IT IS A VERDICT. The compare API truncates its file list at 300
# and says so nowhere in the list itself, so a 300-entry answer is indistinguishable from a complete
# one by inspection - and a caller that read it as "no gate among these" would merge on a suite it
# never checked. The count is what settles it, and it is the first thing read.
classify_gate_moves() {
  local payload count moves
  payload=$(cat)

  count=$(printf '%s\n' "$payload" | head -n 1)
  case "$count" in
    '' | *[!0-9]*)
      echo "undecidable the changed-file count is '${count:-empty}', not a number"
      return 0
      ;;
  esac

  if [ "$count" -ge 300 ]; then
    echo "undecidable $count files changed and the compare API truncates its list at 300"
    return 0
  fi

  moves=$(printf '%s\n' "$payload" | tail -n +2 | grep -E '^[.]github/(workflows|scripts)/' || true)
  if [ -n "$moves" ]; then
    echo "moved $(printf '%s\n' "$moves" | tr '\n' ' ' | sed 's/ $//')"
  else
    echo "settled $count"
  fi
}
