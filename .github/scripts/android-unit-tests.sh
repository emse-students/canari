#!/usr/bin/env bash
#
# RUN THE ANDROID UNIT TESTS, AND PROVE THEY RAN.
#
# WHAT THIS EXISTS FOR. `PushDecryptLadderTest.kt` is a real JUnit suite over the order the FCM
# service tries its recoveries in - MLS behaviour on the platform where MLS defects are hardest to
# see - and no workflow and no Makefile target ever invoked Gradle's unit tests, so its assertions
# had never executed on any machine. First run: 2026-09-10, five tests, all passing.
#
# THE SECOND HALF IS THE ONE WORTH READING. The obvious command - `./gradlew testDebugUnitTest`,
# which is what the backlog entry proposed - MATCHES NO TASK IN THE `app` MODULE. Tauri's Android
# template gives that module ABI product flavours, so its unit-test tasks are
# `testUniversalDebugUnitTest`, `testArm64DebugUnitTest` and three more; a bare `testDebugUnitTest`
# runs the plugin modules (which have no test sources) and exits 0. Measured: `BUILD SUCCESSFUL in
# 16s`, zero `:app:` tasks, zero tests. That gate would have been green for ever while running
# nothing - which is the same defect it was written to fix, one layer up.
#
# So the run is not the assertion. The RESULTS ARE: this reads the JUnit XML Gradle writes and
# fails when it finds no suite, or a suite with no tests in it. A green build that ran nothing
# cannot get past that, whatever the task is called next year.
#
# ONE FLAVOUR IS ENOUGH. These are JVM unit tests; the ABI a variant targets changes nothing about
# them, and running all five flavours would run the same five tests five times.
set -uo pipefail

ANDROID_DIR="${ANDROID_DIR:-frontend/src-tauri/gen/android}"
TASK="${TASK:-:app:testUniversalDebugUnitTest}"
RESULTS="$ANDROID_DIR/app/build/test-results"

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
  echo "that matches nothing in the app module makes Gradle exit 0 having done nothing. The app"
  echo "module has ABI product flavours, so its unit-test tasks are testUniversalDebugUnitTest,"
  echo "testArm64DebugUnitTest and three more - a bare testDebugUnitTest matches none of them."
  echo ""
  echo "Run './gradlew :app:tasks --all | grep UnitTest' and set TASK to one that exists."
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
