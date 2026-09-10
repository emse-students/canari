#!/usr/bin/env bash
#
# Self-tests for `release-shipped.sh` - the check that refuses to call a release shipped when
# production never received it.
#
# THE CASES THAT MATTER ARE ONES A LIVE RELEASE NEVER PRODUCES, which is exactly why the logic is a
# script and not inline shell. A real release either works or is being fixed under pressure; the
# interesting inputs are a marker that did not move, a marker that cannot be read at all, and the
# one nobody expects - an estate job that reported SUCCESS while the marker stayed put, which is
# what a failed tag push after a green deploy looks like.
#
# WHAT IT COST. On v0.16.2 and v0.16.3 a store arm did not succeed, `Production estate` was
# skipped, and both releases reported themselves shipped. Production served v0.16.1 from
# 2026-09-03 until the next deploy broke.
#
# Usage: .github/scripts/tests/release-shipped.test.sh   (no arguments, no network)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../release-shipped.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0

# A `gh` that answers from the environment instead of the network. Strict about the path: a
# refactor that reads something other than the marker gets a hard failure here rather than an
# answer that happens to look right.
cat > "$work/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"/git/ref/tags/prod-released"*)
    if [ "${STUB_MARKER:-__unset__}" = "__unset__" ]; then exit 4; fi
    printf '%s\n' "$STUB_MARKER"
    ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$work/gh"

indent() {
  while IFS= read -r line; do printf '     %s\n' "$line"; done <<< "$1"
}

# $1 name, $2 expected exit, $3 released sha, $4 estate result, $5 marker (or the literal UNSET),
# $6 text the output must contain
check() {
  local name="$1" want="$2" released="$3" estate="$4" marker="$5" expected_text="$6"
  local out status
  if [ "$marker" = "UNSET" ]; then
    out="$(PATH="$work:$PATH" REPO="owner/repo" RELEASED_SHA="$released" VERSION="0.16.7" \
      ESTATE_RESULT="$estate" bash "$script" 2>&1)"
  else
    out="$(PATH="$work:$PATH" REPO="owner/repo" RELEASED_SHA="$released" VERSION="0.16.7" \
      ESTATE_RESULT="$estate" STUB_MARKER="$marker" bash "$script" 2>&1)"
  fi
  status=$?
  if [ "$status" != "$want" ]; then
    echo "FAIL $name: exit $status, expected $want"
    indent "$out"
    failures=$((failures + 1))
    return
  fi
  if ! grep -qF "$expected_text" <<< "$out"; then
    echo "FAIL $name: output does not mention '$expected_text'"
    indent "$out"
    failures=$((failures + 1))
    return
  fi
  echo "ok   $name"
}

SHA="4f3a1c9e8b2d7a6f5c4e3b2a1908f7e6d5c4b3a2"
OLD="0d84c54388f49633651d040f96aa90fb71b62ea0"

# The ordinary success: the deploy ran and wrote the marker.
check "a release production received passes" 0 "$SHA" success "$SHA" \
  "production serves 0.16.7"

# THE v0.16.2 SHAPE, and the whole reason this exists: the estate was skipped, the run was green.
check "refuses a stable whose estate was skipped" 1 "$SHA" skipped "$OLD" \
  "was published and did NOT reach production"

# The same, told to the reader in terms they can act on rather than as a bare mismatch.
check "names the recovery instead of only the symptom" 1 "$SHA" skipped "$OLD" \
  "Re-run failed jobs"

# THE ONE NOBODY EXPECTS. A green estate job whose tag push failed says "success" while production
# runs the old commit - the case that makes the MARKER the evidence rather than the job result.
check "refuses a SUCCESSFUL estate whose marker did not move" 1 "$SHA" success "$OLD" \
  "was published and did NOT reach production"

# An unreadable answer is not permission.
check "refuses when the marker cannot be read" 1 "$SHA" success UNSET \
  "Cannot tell whether 0.16.7 shipped"

# An empty answer is not permission either - `gh` exiting 0 with nothing is a different failure
# from `gh` exiting non-zero, and both mean the same thing here.
check "refuses an empty marker" 1 "$SHA" success "" \
  "Cannot tell whether 0.16.7 shipped"

# A missing input is a broken caller, not a pass.
# Checked directly rather than through $? (shellcheck SC2181), which also reads better: the
# claim is "running it without RELEASED_SHA must not succeed".
if out="$(PATH="$work:$PATH" REPO="owner/repo" VERSION="0.16.7" bash "$script" 2>&1)"; then
  echo "FAIL a missing RELEASED_SHA must not pass"
  indent "$out"
  failures=$((failures + 1))
else
  echo "ok   a missing RELEASED_SHA is refused rather than assumed"
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "OK: a release only counts as shipped when the marker production writes says so."
