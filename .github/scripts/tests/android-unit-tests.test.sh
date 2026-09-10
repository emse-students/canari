#!/usr/bin/env bash
#
# Self-tests for `android-unit-tests.sh` - the runner that has to prove the suite RAN.
#
# THE CASE THAT MATTERS IS ONE A REAL RUN NEVER PRODUCES, which is the whole reason the assertion
# exists. `./gradlew testDebugUnitTest` - the obvious command, and the one the backlog entry
# proposed - matches NO task in the `app` module, because Tauri gives that module ABI product
# flavours. Gradle exits 0 having run nothing: measured 2026-09-10, `BUILD SUCCESSFUL in 16s`,
# zero `:app:` tasks, zero tests. A gate that green is the defect it was written to remove.
#
# So these drive the script against a FAKE gradlew, which is what lets the empty-and-green case be
# produced on demand instead of waited for.
#
# Usage: .github/scripts/tests/android-unit-tests.test.sh   (no arguments, no network, no Gradle)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../android-unit-tests.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0

# A fake Android project: a `gradlew` that does whatever FAKE_MODE says, and nothing else.
make_project() {
  local mode="$1"
  rm -rf "$work/android"
  mkdir -p "$work/android/app/build"
  cat > "$work/android/gradlew" <<GRADLEW
#!/usr/bin/env bash
# \$1 is the task name; this fake ignores it except to report it, exactly as a real Gradle
# invocation with an unmatched task name would - successfully, and having done nothing.
echo "> Task \$1"
case "$mode" in
  ran)
    mkdir -p app/build/test-results/testUniversalDebugUnitTest
    cat > app/build/test-results/testUniversalDebugUnitTest/TEST-fr.emse.canari.PushDecryptLadderTest.xml <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="fr.emse.canari.PushDecryptLadderTest" tests="5" skipped="0" failures="0" errors="0">
</testsuite>
XML
    echo "BUILD SUCCESSFUL"
    ;;
  empty)
    echo "BUILD SUCCESSFUL"
    ;;
  zero)
    mkdir -p app/build/test-results/testUniversalDebugUnitTest
    cat > app/build/test-results/testUniversalDebugUnitTest/TEST-nothing.xml <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="nothing" tests="0" skipped="0" failures="0" errors="0">
</testsuite>
XML
    echo "BUILD SUCCESSFUL"
    ;;
  broken)
    echo "FAILURE: a test failed" >&2
    exit 1
    ;;
esac
GRADLEW
  chmod +x "$work/android/gradlew"
}

indent() {
  while IFS= read -r line; do printf '     %s\n' "$line"; done <<< "$1"
}

# $1 name, $2 mode, $3 expected exit, $4 text the output must contain
check() {
  local name="$1" mode="$2" want="$3" expected_text="$4"
  local out status
  make_project "$mode"
  out="$(ANDROID_DIR="$work/android" bash "$script" 2>&1)"
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

check "a suite that ran is reported with its count" ran 0 "5 Android unit test(s) ran"

# THE SILENT ONE. Green Gradle, no report written - a task name that matches nothing.
check "refuses a green build that wrote no report" empty 1 "The Android suite did not run"

# And it must say WHY, because the cause is not guessable from the symptom.
check "names the flavoured task names as the cause" empty 1 "testUniversalDebugUnitTest"

# A report with no tests in it is the same lie in a different shape.
check "refuses a report containing zero tests" zero 1 "reported zero tests"

# An ordinary failing test still fails, and is not swallowed by the new assertions.
check "a failing suite still fails" broken 1 "Android unit tests failed"

# A stale report from a previous run must not be judged as this run's evidence.
make_project ran
ANDROID_DIR="$work/android" bash "$script" >/dev/null 2>&1
make_project empty
# `make_project` wipes the tree, so re-plant the stale report the script must clear itself.
mkdir -p "$work/android/app/build/test-results/testUniversalDebugUnitTest"
printf '<testsuite name="stale" tests="9" failures="0"></testsuite>\n' \
  > "$work/android/app/build/test-results/testUniversalDebugUnitTest/TEST-stale.xml"
if ANDROID_DIR="$work/android" bash "$script" >/dev/null 2>&1; then
  echo "FAIL a stale report from a previous run must not count as this run's evidence"
  failures=$((failures + 1))
else
  echo "ok   a stale report is cleared before the run, not counted after it"
fi

# A missing project is a broken caller, not a pass.
if ANDROID_DIR="$work/nope" bash "$script" >/dev/null 2>&1; then
  echo "FAIL a missing android directory must not pass"
  failures=$((failures + 1))
else
  echo "ok   a missing android directory is refused"
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "OK: the runner proves the suite ran, and refuses a green build that ran nothing."
