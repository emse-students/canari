#!/usr/bin/env bash
#
# Self-tests for `android-app-compile.sh`: the three promises it makes without a real Android
# toolchain. They are driven against a FAKE cargo (which writes the files the app crate's build
# script would) and a FAKE gradlew, which is what lets the cases a real run never produces be
# made on demand:
#   - a REAL `app/google-services.json` is never overwritten;
#   - a Gradle run that exits 0 without executing one of the three tasks is refused;
#   - the happy path passes.
#
# Usage: .github/scripts/tests/android-app-compile.test.sh   (no arguments, no network, no Gradle)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../android-app-compile.sh"
real_stub="$here/../../../frontend/src-tauri/gen/android/ci/google-services.compile-stub.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

# FAKE_SKIP names one task the fake gradlew leaves out (or reports UP-TO-DATE for).
make_project() {
  local skip="${1:-}" suffix="${2:-}"
  rm -rf "$work/android"
  mkdir -p "$work/android/app" "$work/android/ci"
  cp "$real_stub" "$work/android/ci/"
  cat > "$work/android/gradlew" <<GRADLEW
#!/usr/bin/env bash
for t in "\$@"; do
  case "\$t" in :app:*) ;; *) continue ;; esac
  if [ "\$t" = "$skip" ]; then
    [ -n "$suffix" ] && echo "> Task \$t $suffix"
  else
    echo "> Task \$t"
  fi
done
exit 0
GRADLEW
  chmod +x "$work/android/gradlew"
  cat > "$work/cargo" <<CARGO
#!/usr/bin/env bash
echo "// generated" > "$work/android/tauri.settings.gradle"
echo "include ':tauri-plugin-fake'" >> "$work/android/tauri.settings.gradle"
echo "// generated" > "$work/android/app/tauri.build.gradle.kts"
CARGO
  chmod +x "$work/cargo"
}

run_script() {
  ANDROID_GRADLE_DIR="$work/android" CARGO="$work/cargo" ANDROID_HOME="$work/sdk" \
    ANDROID_NDK_HOME="$work/ndk" bash "$script" > "$work/out" 2>&1
}

expect() { # <name> <wanted exit: 0|nonzero> <text the output must carry>
  local name="$1" want="$2" text="$3" rc=0
  run_script || rc=$?
  local got=nonzero; [ "$rc" -eq 0 ] && got=0
  if [ "$got" = "$want" ] && grep -qF -- "$text" "$work/out"; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (exit $rc, wanted $want, looking for: $text)"
    sed 's/^/        /' "$work/out" | tail -8
    failures=$((failures + 1))
  fi
}

echo "the happy path:"
make_project
expect "all three tasks ran" 0 "OK :app:checkArm64DebugAarMetadata"
if cmp -s "$real_stub" "$work/android/app/google-services.json"; then
  echo "  ok   the stub was copied where the Google Services plugin reads it"
else
  echo "  FAIL the stub was not copied"; failures=$((failures + 1))
fi

echo "a task that did not execute is refused:"
for t in :app:checkArm64DebugAarMetadata :app:processArm64DebugMainManifest :app:compileArm64DebugKotlin; do
  make_project "$t" ""
  expect "$t absent from the output" nonzero "$t did not execute"
  make_project "$t" "UP-TO-DATE"
  expect "$t reported UP-TO-DATE" nonzero "$t did not execute"
done

echo "a real google-services.json is never overwritten:"
make_project
echo '{"real":"secret"}' > "$work/android/app/google-services.json"
expect "a differing file stops the run" nonzero "will not overwrite"
if [ "$(cat "$work/android/app/google-services.json")" = '{"real":"secret"}' ]; then
  echo "  ok   the real file is untouched"
else
  echo "  FAIL the real file was overwritten"; failures=$((failures + 1))
fi
make_project
cp "$real_stub" "$work/android/app/google-services.json"
expect "an existing copy of the stub itself is fine (a second run)" 0 "OK :app:checkArm64DebugAarMetadata"

echo "an unset NDK is an error, not a search:"
make_project
rc=0
ANDROID_GRADLE_DIR="$work/android" CARGO="$work/cargo" ANDROID_HOME="$work/sdk" ANDROID_NDK_LATEST_HOME="$work/ndk" \
  env -u ANDROID_NDK_HOME bash "$script" > "$work/out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "ANDROID_NDK_HOME is not set" "$work/out"; then
  echo "  ok   ANDROID_NDK_LATEST_HOME is not a fallback"
else
  echo "  FAIL the script ran without ANDROID_NDK_HOME (exit $rc)"; failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then echo "$failures check(s) failed."; exit 1; fi
echo "OK: android-app-compile.sh refuses what it promised to refuse."
