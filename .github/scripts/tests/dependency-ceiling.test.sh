#!/usr/bin/env bash
#
# Self-tests for `dependency-ceiling.sh`'s INPUT - which commits it reads the update out of.
#
# `ceiling.test.sh` beside this one covers the TABLE: given a dependency name and version, is there
# a gate. This covers the step before it, and that step had a defect the table could never show.
#
# WHAT IT COST. The script read `commits/$HEAD_SHA` alone, so it saw the head commit's message and
# nothing else. Dependabot writes its `updated-dependencies` block there, which works exactly as
# long as nobody touches the branch - and some of its pull requests REQUIRE that someone does.
# #423 was one: Dependabot moves the JS half of a Tauri plugin and cannot move the Rust crate
# beside it, so `Guard the Tauri JS/Rust version parity` fails until a maintainer pushes the
# `cargo update`. The moment that commit landed it became the head, carried no block, and the
# ceiling answered "nothing here can tell what it changes" (2026-09-10). A gate that refuses the
# FIX for the failure it reported has stopped measuring the dependency.
#
# It reads every commit on the pull request now, and these hold that.
#
# Usage: .github/scripts/tests/dependency-ceiling.test.sh   (no arguments, no network)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../dependency-ceiling.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0

# A `gh` that answers from a fixture instead of the network. It is deliberately strict about the
# path: a future refactor pointing back at `commits/<sha>` gets a hard failure here rather than an
# empty answer that reads as "this pull request changes nothing".
cat > "$work/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"/pulls/"*"/commits"*) cat "$GH_FIXTURE" ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$work/gh"

run_ceiling() {
  GH_FIXTURE="$1" PATH="$work:$PATH" REPO="owner/repo" PR="423" HEAD_SHA="deadbeefdeadbeef" \
    bash "$script" 2>&1
}

# `sed 's/^/  /'` is the obvious way and shellcheck refuses it (SC2001); this is the same thing
# without spawning a process per failure.
indent() {
  while IFS= read -r line; do printf '     %s\n' "$line"; done <<< "$1"
}

check() {
  local name="$1" expected_status="$2" fixture="$3" expected_text="$4"
  local out status
  out="$(run_ceiling "$fixture")"
  status=$?
  if [ "$status" != "$expected_status" ]; then
    echo "FAIL $name: exit $status, expected $expected_status"
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

# ── The #423 shape: a maintainer's repair sits ON TOP of Dependabot's commit ────────────────────
# The block is in the SECOND message, which is not the head. Ordered the way the API returns them,
# oldest first, so the head really is the one without a block.
cat > "$work/repaired.json" <<'FIXTURE'
chore(deps): bump @tauri-apps/plugin-http from 2.5.9 to 2.6.0

updated-dependencies:
- dependency-name: "@tauri-apps/plugin-http"
  dependency-version: 2.6.0
  dependency-type: direct:production
  update-type: version-update:semver-minor
chore(deps): move the Rust half of plugin-http, which the JS bump left behind
FIXTURE
check "a repair commit on top does not blind the ceiling" 0 "$work/repaired.json" \
  "@tauri-apps/plugin-http -> 2.6.0"

# ── Nothing on the branch describes an update ───────────────────────────────────────────────────
# The refusal must survive, and it must name the PULL REQUEST rather than "this commit": with every
# commit read, "this commit carries no block" would send a reader to look at the wrong thing.
cat > "$work/no-block.json" <<'FIXTURE'
fix: something a human wrote
docs: and another
FIXTURE
check "refuses a branch where no commit carries a block" 1 "$work/no-block.json" \
  "No commit on #423 carries an updated-dependencies block"

# ── An update the table refuses is still refused, reading every commit ──────────────────────────
# The widened read must not become a way past the ceiling: postgres crossing its production major
# is the update that cost 33 minutes of production, and it stays refused with its test named.
cat > "$work/postgres.json" <<'FIXTURE'
chore(deps): bump postgres from 15-alpine to 18-alpine

updated-dependencies:
- dependency-name: postgres
  dependency-version: 18-alpine
  dependency-type: direct:production
  update-type: version-update:semver-major
chore: a maintainer commit on top, with no block of its own
FIXTURE
check "still refuses a datastore crossing its major" 1 "$work/postgres.json" \
  "No gate would see this fail"

# ── An unreadable answer is not permission ──────────────────────────────────────────────────────
: > "$work/empty.json"
check "refuses when the commits cannot be read at all" 1 "$work/empty.json" \
  "Could not read the commits of #423"

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "OK: the ceiling reads the whole pull request, and refuses what it refused before."
