#!/usr/bin/env bash
#
# Self-tests for `cargo-blocked-update-report.sh` - the named trigger for the cargo directories
# Dependabot cannot reach.
#
# WHAT THESE EXIST TO PIN, and it is not "does it open an issue". The interesting failures are the
# ones that look like health:
#
#   - `gh` refusing the issue list must FAIL, never read as "no issue is open" - which would open a
#     second issue every week, the pile this mechanism exists to avoid.
#   - `cargo` failing must FAIL, never read as "nothing to update" - that is precisely the defect
#     the backlog entry accuses `cargo audit` of.
#   - a creation that fails while updates are pending must FAIL, because otherwise the run is green
#     and NOTHING anywhere records the updates.
#   - deriving no blocked directory must FAIL, because a broken parse reads exactly like a repo
#     where the blockage was fixed.
#
# Everything runs against a FAKE tree, a FAKE cargo and a FAKE gh: the real ones need a network, and
# the cases above are ones a real run does not produce on demand.
#
# Usage: .github/scripts/tests/cargo-blocked-update-report.test.sh   (no arguments, no network)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../cargo-blocked-update-report.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
bin="$work/bin"
mkdir -p "$bin"
PATH="$bin:$PATH"
export PATH

# ── the fake tree: two declared cargo directories, one of them blocked by a `links` manifest ──────
root="$work/repo"
make_tree() {
  rm -rf "$root"
  mkdir -p "$root/.github/scripts/lib" "$root/frontend/src-tauri/plugins/plug" "$root/apps/clean"
  cp "$here/../lib/cargo-dirs.sh" "$root/.github/scripts/lib/cargo-dirs.sh"
  cat >"$root/.github/dependabot.yml" <<'YML'
version: 2
updates:
  - package-ecosystem: "cargo"
    directories:
      - "/frontend/src-tauri"
      - "/apps/clean"
    schedule:
      interval: "weekly"
YML
  cat >"$root/frontend/src-tauri/Cargo.toml" <<'TOML'
[package]
name = "app"
[dependencies]
plug = { path = "plugins/plug" }
TOML
  cat >"$root/frontend/src-tauri/plugins/plug/Cargo.toml" <<'TOML'
[package]
name = "plug"
links = "plug"
TOML
  cat >"$root/apps/clean/Cargo.toml" <<'TOML'
[package]
name = "clean"
TOML
}

# ── the fakes, driven by CARGO_MODE / GH_MODE ─────────────────────────────────────────────────────
cat >"$bin/fakecargo" <<'SH'
#!/usr/bin/env bash
case "${CARGO_MODE:-behind}" in
  behind)
    echo "    Updating serde v1.0.1 -> v1.0.2"
    echo "    Updating tokio v1.40.0 -> v1.41.0"
    ;;
  level) echo "note: pass \`--verbose\` to see 35 unchanged dependencies behind latest" ;;
  broken) echo "error: failed to parse manifest" >&2; exit 101 ;;
esac
SH
chmod +x "$bin/fakecargo"

cat >"$bin/fakegh" <<'SH'
#!/usr/bin/env bash
# $1 is always `issue`; $2 the verb.
case "${GH_MODE:-none}" in
  refuse) echo "HTTP 403: Resource not accessible" >&2; exit 1 ;;
esac
case "$2" in
  # An empty list is a SUCCESSFUL answer meaning "no issue open" - it must exit 0, or the script
  # cannot tell it from the refusal below. Getting this wrong in the FAKE is the same confusion the
  # script is being tested for, so it is spelt out rather than written as `[ ... ] && echo`.
  list)
    if [ "${GH_MODE:-none}" = "existing" ]; then echo "77"; fi
    exit 0
    ;;
  create) [ "${GH_MODE:-none}" = "createfails" ] && { echo "could not create" >&2; exit 1; }; echo "https://example/issues/78" ;;
  edit|comment|close) echo "ok" ;;
esac
SH
chmod +x "$bin/fakegh"

run() {
  CARGO_MODE="$1" GH_MODE="$2" REPO_ROOT="$root" REPO="o/r" CARGO="${3:-fakecargo}" GH=fakegh \
    bash "$script" 2>&1
}

# $1 name, $2 cargo mode, $3 gh mode, $4 expected exit, $5 text the output must contain
check() {
  local name="$1" want="$4" out status
  make_tree
  out="$(run "$2" "$3")"
  status=$?
  if [ "$status" != "$want" ]; then
    echo "FAIL $name: exit $status, expected $want"
    printf '     %s\n' "$out"
    failures=$((failures + 1))
    return
  fi
  if ! grep -qF "$5" <<<"$out"; then
    echo "FAIL $name: output does not mention '$5'"
    printf '     %s\n' "$out"
    failures=$((failures + 1))
    return
  fi
  echo "ok   $name"
}

check "pending updates with no issue open it"            behind none        0 "opened the issue"
check "pending updates with an issue REFRESH it"         behind existing    0 "refreshed issue #77"
check "level with an issue closes it"                    level  existing    0 "closed issue #77"
check "level with no issue reports and does nothing"     level  none        0 "nothing behind across 1"

# THE ONES THAT MUST NOT LOOK LIKE HEALTH.
check "a refused issue list FAILS"                       behind refuse      1 "A refusal is not an answer"
check "a failing cargo FAILS"                            broken none        1 "unanswered question"
check "a creation that fails FAILS"                      behind createfails 1 "nothing records them"

# A cargo that is not on PATH at all.
make_tree
if out="$(CARGO_MODE=behind GH_MODE=none REPO_ROOT="$root" REPO="o/r" CARGO=definitely-not-cargo GH=fakegh bash "$script" 2>&1)"; then
  echo "FAIL a missing cargo must fail rather than report a clean run"
  printf '     %s\n' "$out"
  failures=$((failures + 1))
elif ! grep -qF "An unrun check is not a clean one" <<<"$out"; then
  echo "FAIL a missing cargo fails, but does not say that nothing was checked"
  printf '     %s\n' "$out"
  failures=$((failures + 1))
else
  echo "ok   a missing cargo fails, naming the fact that nothing was checked"
fi

# NO BLOCKED DIRECTORY DERIVED. Reads exactly like "the blockage was fixed", so it must not pass.
make_tree
rm -f "$root/frontend/src-tauri/plugins/plug/Cargo.toml"
if out="$(CARGO_MODE=behind GH_MODE=none REPO_ROOT="$root" REPO="o/r" CARGO=fakecargo GH=fakegh bash "$script" 2>&1)"; then
  echo "FAIL deriving no blocked directory must fail rather than report a clean run"
  printf '     %s\n' "$out"
  failures=$((failures + 1))
elif ! grep -qF "distinguishes the two" <<<"$out"; then
  echo "FAIL deriving nothing fails, but does not name the test that says which cause it is"
  printf '     %s\n' "$out"
  failures=$((failures + 1))
else
  echo "ok   deriving nothing fails, and names the test that says which cause it is"
fi

# The clean directory must NOT be reported on - it is Dependabot's, and duplicating it here would
# put a pull request and an issue on the same bump.
make_tree
out="$(CARGO_MODE=behind GH_MODE=none REPO_ROOT="$root" REPO="o/r" CARGO=fakecargo GH=fakegh bash "$script" 2>&1)"
if grep -qF "/apps/clean" <<<"$out"; then
  echo "FAIL a directory Dependabot CAN reach must not be reported here"
  failures=$((failures + 1))
else
  echo "ok   only the blocked directory is reported; Dependabot keeps the other"
fi

if [ "$failures" -ne 0 ]; then
  echo ""
  echo "$failures check(s) failed."
  exit 1
fi
echo ""
echo "OK: the trigger reports the blocked directories, and refuses every empty answer that lies."
