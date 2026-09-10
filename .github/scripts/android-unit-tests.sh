#!/usr/bin/env bash
#
# RUN THE ANDROID UNIT TESTS, AND PROVE THEY RAN.
#
# WHAT THIS EXISTS FOR. `PushDecryptLadderTest.kt` is a real JUnit suite over the order the FCM
# service tries its recoveries in - MLS behaviour on the platform where MLS defects are hardest to
# see - and no workflow and no Makefile target ever invoked Gradle's unit tests, so its assertions
# had never executed on any machine.
#
# THE SUITE IS NOT IN THE APP MODULE, AND THAT IS WHAT MAKES THIS RUNNABLE IN CI. It was, until
# 2026-09-10, and the consequence was that this gate could only ever pass on a developer's own
# box: configuring `:app` reads `gen/android/tauri.settings.gradle`, a file tauri GENERATES with
# absolute paths into one machine's cargo registry and `.gitignore` therefore excludes, and the
# module also wants a `google-services.json` that lives in a secret. This script was believed
# green on the strength of one local run; over the fourteen CI runs that followed it was SKIPPED
# thirteen times and FAILED the only time a change touched Android files, on `Could not read
# script 'tauri.settings.gradle' as it does not exist`.
#
# The suite imports `org.junit` and nothing else - no Android type, no tauri type, nothing from
# `:app` - so it never needed any of that. It now lives in a standalone Kotlin/JVM project whose
# whole toolchain is a JDK; `frontend/src-tauri/android-tests/settings.gradle.kts` carries the
# full account, including what this still does NOT prove.
#
# THE RUN IS NOT THE ASSERTION. THE RESULTS ARE. The original version of this script learned that
# the hard way on the old layout: the obvious `./gradlew testDebugUnitTest` matched NO task in the
# flavoured app module and exited 0 having run nothing. So this reads the JUnit XML Gradle writes
# and fails when it finds no suite, or a suite with no tests in it. A green build that ran nothing
# cannot get past that, whatever the task is called next year.
set -uo pipefail

ANDROID_DIR="${ANDROID_DIR:-frontend/src-tauri/android-tests}"
TASK="${TASK:-test}"
RESULTS="$ANDROID_DIR/build/test-results"

[ -d "$ANDROID_DIR" ] || { echo "::error::$ANDROID_DIR does not exist"; exit 1; }

# A STALE RESULT IS NOT A RESULT. Without this, a run whose Gradle invocation failed early would be
# judged on the XML from the previous one.
rm -rf "$RESULTS"

echo "running $TASK in $ANDROID_DIR"
( cd "$ANDROID_DIR" && ./gradlew "$TASK" --console=plain ) || {
  echo "::error title=Android unit tests failed::$TASK exited non-zero. The report above names the case."
  exit 1
}

# ── The run is not the evidence; the results are ────────────────────────────────────────────────
mapfile -t reports < <(find "$RESULTS" -name 'TEST-*.xml' 2>/dev/null | sort)

if [ "${#reports[@]}" -eq 0 ]; then
  echo "::error title=The Android suite did not run::$TASK succeeded and wrote no JUnit report to $RESULTS."
  echo ""
  echo "This is the failure mode this script exists for, and it is silent by nature: a task name"
  echo "that matches nothing makes Gradle exit 0 having done nothing."
  echo ""
  echo "Run './gradlew tasks --all | grep -i test' in $ANDROID_DIR and set TASK to one that exists."
  exit 1
fi

total=0
for report in "${reports[@]}"; do
  n="$(sed -n 's/.*<testsuite[^>]* tests="\([0-9]*\)".*/\1/p' "$report" | head -1)"
  total=$((total + ${n:-0}))
  printf '  %-64s %s test(s)\n' "$(basename "$report")" "${n:-0}"
done

if [ "$total" -eq 0 ]; then
  echo "::error title=The Android suite reported zero tests::${#reports[@]} report(s) written and not one test in them."
  exit 1
fi

echo "ok: $total Android unit test(s) ran across ${#reports[@]} suite(s)."
