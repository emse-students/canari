#!/usr/bin/env bash
#
# Asserts that every cargo directory declared to Dependabot is one Dependabot can actually PARSE.
#
# IT EXISTS BECAUSE THE FAILURE MODE IS A DIRECTORY THAT SIMPLY STOPS PRODUCING PULL REQUESTS, and
# that is indistinguishable from a directory with nothing to update. On 2026-08-08 the Android
# custom-tabs plugin landed (`7cf394f3`) carrying `links = "tauri-plugin-customtabs"` in its
# manifest. `links` is meaningful only with a build script, and Dependabot materialises a temp
# checkout of MANIFESTS AND LOCKFILES ONLY - never `build.rs` - so from that day cargo refused the
# manifest before considering any version:
#
#   error: failed to get `tauri-plugin-customtabs` as a dependency of package `canari`
#   Caused by: package specifies that it links to `tauri-plugin-customtabs`
#              but does not have a custom build script
#
# Every cargo update in `frontend/src-tauri` has been impossible since, security ones included, and
# it was found 25 days later only because enabling `automated-security-fixes` produced a FAILING
# update job in the Actions log. The population had said it too and nobody was reading: that
# directory has produced exactly one Dependabot pull request ever (#195, 2026-07-24, two weeks
# before the plugin), while `/apps/chat-gateway` and `/apps/call-service` in the same ecosystem
# entry produced eighteen.
#
# SO THE ASSERTION IS DERIVED, NOT A LIST OF NAMES. It reads the cargo directories out of
# `.github/dependabot.yml`, follows every `path = ` dependency out of each root manifest, and
# collects the manifests that declare `links`. The result is compared against the set pinned below,
# so a NEW one fails on the day it is committed and the KNOWN ones cannot be forgotten.
#
# Usage: .github/scripts/tests/dependabot-cargo-reach.test.sh   (no arguments, no network, no cargo)
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
config="$repo_root/.github/dependabot.yml"

failures=0

pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

# THE DIRECTORIES DEPENDABOT IS BLOCKED ON TODAY, and the entry that carries the decision.
# Removing a line here is how a fix is recorded; adding one by hand is how a regression is admitted.
readonly BLOCKED_REFERENCE='docs/wiki/backlog.md'
readonly EXPECTED_BLOCKED='/frontend/src-tauri
/frontend/src-tauri/plugins/tauri-plugin-customtabs'

# --- 1. the config is where this test thinks it is -------------------------------------------------

if [ ! -f "$config" ]; then
  echo "FAIL $config is not in the tree; the derivation below has no input."
  exit 1
fi
pass "dependabot.yml is readable"

# --- 2. derive the declared cargo directories -----------------------------------------------------

# The `directories:` list of the ONE `package-ecosystem: "cargo"` entry. Read positionally rather
# than with a YAML parser, because this repository has no YAML dependency for shell and the file is
# ours: the block is entered on the ecosystem line and left on the next key at the same indent.
cargo_dirs="$(
  awk '
    /^  - package-ecosystem:/ { inside = ($0 ~ /"cargo"/); inlist = 0; next }
    !inside { next }
    /^    directories:/ { inlist = 1; next }
    /^    [a-z]/ { inlist = 0 }
    inlist && /^      - "/ {
      line = $0
      sub(/^      - "/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      print line
    }
  ' "$config"
)"

if [ -z "$cargo_dirs" ]; then
  fail "no cargo directories were derived from dependabot.yml - the parse above is broken, not the config"
else
  pass "$(printf '%s\n' "$cargo_dirs" | wc -l | tr -d ' ') cargo directories declared to Dependabot"
fi

# --- 3. every declared directory exists and has a manifest ----------------------------------------

missing=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  [ -f "$repo_root$d/Cargo.toml" ] || {
    fail "declared cargo directory $d has no Cargo.toml"
    missing=$((missing + 1))
  }
done <<<"$cargo_dirs"
[ "$missing" -eq 0 ] && pass "every declared cargo directory carries a Cargo.toml"

# --- 4. the derivation itself, proven on a fixture ------------------------------------------------

# `links_in_graph <abs dir>` prints the repo-relative manifest paths, reachable from that directory
# by `path = ` dependencies, that declare `links`. Proven on a fixture below before it is believed
# on the real tree - a derivation nobody tested is a list of names with extra steps.
links_in_graph() {
  local seen="" queue="$1" cur manifest dep
  while [ -n "$queue" ]; do
    cur="$(printf '%s\n' "$queue" | head -1)"
    queue="$(printf '%s\n' "$queue" | tail -n +2)"
    case "$seen" in *"[$cur]"*) continue ;; esac
    seen="${seen}[$cur]"
    manifest="$cur/Cargo.toml"
    [ -f "$manifest" ] || continue
    if grep -qE '^[[:space:]]*links[[:space:]]*=' "$manifest"; then
      printf '%s\n' "${manifest#"$repo_root"/}"
    fi
    # Path dependencies, which is how cargo reaches a manifest Dependabot never copied a build
    # script for. Relative to the manifest's own directory, as cargo resolves them.
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      queue="$(printf '%s\n%s' "$queue" "$(cd "$cur" && cd "$dep" 2>/dev/null && pwd)")"
    done <<<"$(grep -oE 'path[[:space:]]*=[[:space:]]*"[^"]+"' "$manifest" |
      sed -E 's/.*"([^"]+)"/\1/' | grep -v '\.rs$' | sort -u)"
  done
}

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/app" "$fixture/app/plug" "$fixture/app/clean"
cat >"$fixture/app/Cargo.toml" <<'TOML'
[package]
name = "app"
[dependencies]
plug = { path = "plug" }
clean = { path = "clean" }
TOML
cat >"$fixture/app/plug/Cargo.toml" <<'TOML'
[package]
name = "plug"
links = "plug"
TOML
cat >"$fixture/app/clean/Cargo.toml" <<'TOML'
[package]
name = "clean"
TOML

# The fixture lives outside the repo, so strip its own prefix the way the real call strips the repo's.
# The prefix assignment scopes `repo_root` to this call only, so the real assertion below still
# strips the repository prefix.
fixture_hits="$(repo_root="$fixture" links_in_graph "$fixture/app" | sort)"
if [ "$fixture_hits" = "app/plug/Cargo.toml" ]; then
  pass "the derivation follows a path dependency and reports only the manifest declaring links"
else
  fail "the derivation is wrong on its own fixture: expected app/plug/Cargo.toml, got '$fixture_hits'"
fi

# --- 5. the real tree, compared against the pinned set --------------------------------------------

derived_blocked=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  hits="$(links_in_graph "$repo_root$d")"
  if [ -n "$hits" ]; then
    derived_blocked="$derived_blocked$d
"
  fi
done <<<"$cargo_dirs"
derived_blocked="$(printf '%s' "$derived_blocked" | sed '/^$/d' | sort -u)"
expected_blocked="$(printf '%s\n' "$EXPECTED_BLOCKED" | sed '/^$/d' | sort -u)"

if [ "$derived_blocked" = "$expected_blocked" ]; then
  if [ -n "$derived_blocked" ]; then
    pass "the blocked cargo directories are exactly the pinned ones ($(printf '%s\n' "$derived_blocked" | tr '\n' ' '))"
  else
    pass "no declared cargo directory is blocked"
  fi
else
  fail "the set of cargo directories Dependabot cannot parse has CHANGED."
  echo "     derived : $(printf '%s\n' "$derived_blocked" | tr '\n' ' ')"
  echo "     pinned  : $(printf '%s\n' "$expected_blocked" | tr '\n' ' ')"
  echo "     A manifest reachable from a declared directory declares \`links\`, so cargo refuses it"
  echo "     in Dependabot's manifest-only checkout and the directory silently stops producing"
  echo "     pull requests - security ones included. Either remove the \`links\` key (it is what"
  echo "     exposes a build script's metadata to dependents, so a Tauri mobile plugin needs it and"
  echo "     removing it is verified by BUILDING for Android and iOS, never by this test), or take"
  echo "     the directory out of dependabot.yml and say why in its comment block. If a directory"
  echo "     was FIXED, delete its line from EXPECTED_BLOCKED here. See $BLOCKED_REFERENCE."
fi

# --- 6. the pinned set is not stale in the other direction ----------------------------------------

# A pinned directory that is no longer declared to Dependabot is a line nobody will ever clear.
stale=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  grep -qx "$d" <<<"$cargo_dirs" || {
    fail "EXPECTED_BLOCKED names $d, which dependabot.yml no longer declares - delete the line"
    stale=$((stale + 1))
  }
done <<<"$expected_blocked"
[ "$stale" -eq 0 ] && pass "every pinned directory is still declared to Dependabot"

# --- summary --------------------------------------------------------------------------------------

echo ""
if [ "$failures" -eq 0 ]; then
  echo "dependabot-cargo-reach: all assertions passed"
  exit 0
fi
echo "dependabot-cargo-reach: $failures assertion(s) failed"
exit 1
