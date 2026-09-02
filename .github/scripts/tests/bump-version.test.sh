#!/usr/bin/env bash
#
# Asserts `scripts/bump-app-version.sh` - the one place a release's version becomes the THREE
# different strings the manifests and the two stores each need.
#
# WHY THIS EXISTS. Until 2026-09-03 the script refused any pre-release outright (`normalize_version`
# asserted `^[0-9]+\.[0-9]+\.[0-9]+$`), so `v0.15.0-alpha.1` died on the first step of a release and
# nothing downstream ever ran. Lifting that refusal is not one regex: a pre-release must reach the
# manifests INTACT, must NOT reach `CFBundleShortVersionString` (Apple requires a numeric short
# version), and must produce a DIFFERENT store build number for every counter, because Play and
# TestFlight both refuse a number they have already accepted. Three destinations, three values, one
# argument - and the only way to be sure they stay separate is to run the real script and read the
# files back.
#
# THE ORDERING ASSERTION IS THE POINT. `rank` 99 for a stable rather than 0 is the whole reason the
# band works, and getting it wrong is invisible until a store rejects the stable release AFTER its
# alphas have shipped - the worst possible moment to find out. So the order alpha.1 < alpha.98 <
# stable < next patch's alpha.1 is asserted directly, on numbers this script produced.
#
# It runs against a TEMPORARY tree, never the repository: the script rewrites every manifest it
# finds, and a test that bumps the real files would be a test nobody dares run.
#
# Run by `make test-ci-scripts` and by CI.

set -uo pipefail

# `set -e` is deliberately NOT used: every assertion reports and continues, so one run says
# everything that is wrong rather than only the first thing. That makes this `cd` the one command
# whose failure has to be handled by hand.
cd "$(dirname "$0")/../../.." || exit 1

readonly SCRIPT=scripts/bump-app-version.sh

failures=0
checks=0

fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

ok() {
  printf '  ok    %s\n' "$1"
  checks=$((checks + 1))
}

if [ ! -f "$SCRIPT" ]; then
  printf 'FAIL %s is missing\n' "$SCRIPT"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'FAIL jq is required by %s and is not on PATH\n' "$SCRIPT"
  exit 1
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# Builds a throwaway tree the script can bump. Only the files it reads are created; the ones it
# cannot find it skips by design, and skipping is not what is under test here.
make_sandbox() {
  local root="$1"
  rm -rf "$root"
  mkdir -p "$root/scripts" \
    "$root/frontend/src-tauri/gen/apple/canari.xcodeproj" \
    "$root/frontend/src-tauri/gen/apple/canari_iOS" \
    "$root/frontend/mls-wasm" \
    "$root/frontend/mls-core" \
    "$root/apps/core-service"

  cp "$SCRIPT" "$root/scripts/bump-app-version.sh"

  printf '{\n  "name": "canari",\n  "version": "0.0.0"\n}\n' > "$root/frontend/package.json"
  printf '{\n  "name": "core-service",\n  "version": "0.0.0"\n}\n' > "$root/apps/core-service/package.json"

  printf '{\n  "version": "0.0.0",\n  "bundle": {\n    "active": true\n  }\n}\n' \
    > "$root/frontend/src-tauri/tauri.conf.json"

  for crate in src-tauri mls-wasm mls-core; do
    printf '[package]\nname = "canari-%s"\nversion = "0.0.0"\n' "$crate" \
      > "$root/frontend/$crate/Cargo.toml"
  done

  printf 'MARKETING_VERSION = 0.0.0;\nCURRENT_PROJECT_VERSION = 0.0.0;\n' \
    > "$root/frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj"

  {
    printf '<plist><dict>\n'
    printf '  <key>CFBundleShortVersionString</key>\n  <string>0.0.0</string>\n'
    printf '  <key>CFBundleVersion</key>\n  <string>0.0.0</string>\n'
    printf '</dict></plist>\n'
  } > "$root/frontend/src-tauri/gen/apple/canari_iOS/Info.plist"
}

# Runs the script on a fresh sandbox. Echoes nothing; the caller reads the files back.
run_bump() {
  local root="$SANDBOX/run"
  make_sandbox "$root"
  bash "$root/scripts/bump-app-version.sh" "$1" >/dev/null 2>&1
}

read_json() { jq -r "$2" "$SANDBOX/run/$1"; }

read_plist_key() {
  # The value on the line AFTER the named key, which is how a plist pairs the two.
  awk -v key="$1" '
    index($0, "<key>" key "</key>") { getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit }
  ' "$SANDBOX/run/frontend/src-tauri/gen/apple/canari_iOS/Info.plist"
}

read_pbxproj_setting() {
  sed -n "s/^${1} = \([^;]*\);/\1/p" \
    "$SANDBOX/run/frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj" | head -n 1
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    ok "$1"
  else
    fail "$1 (expected '$3', got '$2')"
  fi
}

printf '\nA STABLE VERSION\n'

if run_bump 0.15.0; then
  ok "0.15.0 is accepted"
else
  fail "0.15.0 was rejected"
fi
assert_eq "frontend/package.json carries the full version" "$(read_json frontend/package.json .version)" "0.15.0"
assert_eq "a service package.json is bumped too" "$(read_json apps/core-service/package.json .version)" "0.15.0"
assert_eq "tauri.conf.json carries the numeric core" "$(read_json frontend/src-tauri/tauri.conf.json .version)" "0.15.0"
assert_eq "android versionCode ends in the stable rank 99" "$(read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)" "1500099"
assert_eq "CFBundleShortVersionString is the core" "$(read_plist_key CFBundleShortVersionString)" "0.15.0"
assert_eq "CFBundleVersion is the band, not the version" "$(read_plist_key CFBundleVersion)" "1500099"
assert_eq "MARKETING_VERSION is the core" "$(read_pbxproj_setting MARKETING_VERSION)" "0.15.0"
assert_eq "CURRENT_PROJECT_VERSION is the band" "$(read_pbxproj_setting CURRENT_PROJECT_VERSION)" "1500099"
assert_eq "a crate manifest carries the full version" \
  "$(sed -n 's/^version = "\(.*\)"/\1/p' "$SANDBOX/run/frontend/src-tauri/Cargo.toml")" "0.15.0"

printf '\nA PRE-RELEASE - THE CASE THAT USED TO EXIT ON THE FIRST STEP\n'

if run_bump 0.15.0-alpha.1; then
  ok "0.15.0-alpha.1 is accepted"
else
  fail "0.15.0-alpha.1 was rejected - the whole release path dies here"
fi
assert_eq "the manifest keeps the suffix (the client identifies itself by it)" \
  "$(read_json frontend/package.json .version)" "0.15.0-alpha.1"
assert_eq "a crate manifest keeps the suffix" \
  "$(sed -n 's/^version = "\(.*\)"/\1/p' "$SANDBOX/run/frontend/src-tauri/Cargo.toml")" "0.15.0-alpha.1"
assert_eq "tauri.conf.json is STRIPPED to the core (Apple refuses a non-numeric short version)" \
  "$(read_json frontend/src-tauri/tauri.conf.json .version)" "0.15.0"
assert_eq "CFBundleShortVersionString is stripped too" "$(read_plist_key CFBundleShortVersionString)" "0.15.0"
assert_eq "the counter reaches the android versionCode" \
  "$(read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)" "1500001"
assert_eq "the counter reaches the iOS build number" "$(read_plist_key CFBundleVersion)" "1500001"

if run_bump v0.15.0-alpha.2; then
  ok "a leading v is stripped, as a release tag carries one"
else
  fail "v0.15.0-alpha.2 was rejected"
fi
assert_eq "a second alpha gets a DIFFERENT store number" \
  "$(read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)" "1500002"

printf '\nTHE ORDER THE STORES ENFORCE\n'

alpha1="$(run_bump 0.15.0-alpha.1 && read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)"
alpha98="$(run_bump 0.15.0-alpha.98 && read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)"
stable="$(run_bump 0.15.0 && read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)"
next_alpha="$(run_bump 0.15.1-alpha.1 && read_json frontend/src-tauri/tauri.conf.json .bundle.android.versionCode)"

if [ "$alpha1" -lt "$alpha98" ] && [ "$alpha98" -lt "$stable" ]; then
  ok "a stable sits ABOVE every alpha of its own version ($alpha1 < $alpha98 < $stable)"
else
  fail "the stable does not sit above its own alphas ($alpha1, $alpha98, $stable) - a store will refuse it"
fi

if [ "$stable" -lt "$next_alpha" ]; then
  ok "the next patch's first alpha sits above the previous stable ($stable < $next_alpha)"
else
  fail "0.15.1-alpha.1 ($next_alpha) does not sit above 0.15.0 ($stable)"
fi

# THE BAND HAS TO CLEAR WHAT THE STORES HAVE ALREADY ACCEPTED, and that number was produced by a
# DIFFERENT formula - Tauri's own `major*1e6 + minor*1e3 + patch`, which made 0.14.15 into 14015.
# Written as the literal it is, because deriving it with the new formula would compare the band
# against itself and could never fail.
readonly SHIPPED_0_14_15=14015
if [ "$SHIPPED_0_14_15" -lt "$alpha1" ]; then
  ok "the band clears the codes the stores already hold (0.14.15 shipped as $SHIPPED_0_14_15)"
else
  fail "the band does not clear 0.14.15's shipped code ($SHIPPED_0_14_15 vs $alpha1)"
fi

printf '\nWHAT MUST BE REFUSED\n'

# A bump that guesses is worse than a release that stops at its first step, so each of these has to
# exit non-zero rather than invent a version.
for bad in "" "0.15" "0.15.0.1" "0.15.0-beta.1" "0.15.0-alpha" "0.15.0-alpha.0" "0.15.0-alpha.99" "0.15.1000.0" "not-a-version"; do
  if run_bump "$bad"; then
    fail "'${bad}' was ACCEPTED and should not have been"
  else
    ok "'${bad}' is refused"
  fi
done

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%d assertion(s) FAILED (%d passed)\n' "$failures" "$checks"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
