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
case " \$* " in *" --offline "*) [ -n "\${FAKE_OFFLINE_FAIL:-}" ] && { echo "Could not resolve (offline)"; exit 1; } ;; esac
case " \$* " in *" :app:bundleUniversalRelease "*) [ -n "\${FAKE_NO_JAR:-}" ] || { mkdir -p "\$GRADLE_USER_HOME/caches/modules-2/files-2.1/com.google.errorprone/error_prone_annotations/2.0/h"; : > "\$GRADLE_USER_HOME/caches/modules-2/files-2.1/com.google.errorprone/error_prone_annotations/2.0/h/e.jar"; } ;; esac
case " \$* " in *" :app:help "*) echo "Type"; echo "     \${FAKE_TASKTYPE:-BuildTask} (\${FAKE_TASKTYPE:-BuildTask})"; exit 0 ;; esac
OFFLINE_SUFFIX=""
case " \$* " in *" --offline "*)
  [ -e app/build/marker ] && { echo "build outputs still present"; exit 1; }
  OFFLINE_SUFFIX="\${FAKE_OFFLINE_SUFFIX:+ \$FAKE_OFFLINE_SUFFIX}" ;;
  *) mkdir -p app/build; : > app/build/marker ;; esac
for t in "\$@"; do
  case "\$t" in :app:*) ;; *) continue ;; esac
  if [ "\$t" = "$skip" ]; then
    [ -n "$suffix" ] && echo "> Task \$t $suffix"
  else
    echo "> Task \$t\${OFFLINE_SUFFIX:-}"
  fi
done
exit 0
GRADLEW
  chmod +x "$work/android/gradlew"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$work/keytool"; chmod +x "$work/keytool"
  rm -rf "$work/gh"
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
    ANDROID_NDK_HOME="$work/ndk" GRADLE_USER_HOME="$work/gh" KEYTOOL="$work/keytool" bash "$script" > "$work/out" 2>&1
}

expect() { # <name> <wanted exit: 0|nonzero> <text the output must carry>
  export FAKE_TASKTYPE
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
expect "all four tasks ran" 0 "OK :app:checkArm64DebugAarMetadata"
expect "the rust tasks are BuildTasks" 0 "are BuildTasks"
if cmp -s "$real_stub" "$work/android/app/google-services.json"; then
  echo "  ok   the stub was copied where the Google Services plugin reads it"
else
  echo "  FAIL the stub was not copied"; failures=$((failures + 1))
fi

echo "a task that did not execute is refused:"
for t in :app:checkArm64DebugAarMetadata :app:processArm64DebugMainManifest :app:compileArm64DebugKotlin :app:mergeArm64DebugResources; do
  make_project "$t" ""
  expect "$t absent from the output" nonzero "$t did not execute"
  make_project "$t" "UP-TO-DATE"
  expect "$t reported UP-TO-DATE" nonzero "$t did not execute"
done

echo "a rustBuild task that is not a BuildTask is refused:"
make_project
FAKE_TASKTYPE=DefaultTask expect "an empty DefaultTask" nonzero "is not a BuildTask"
unset FAKE_TASKTYPE

echo "the release chain is run online and then offline:"
make_project
expect "both passes ran" 0 "OK the release chain ran (offline)"
expect "the error_prone jar is asked for" 0 "error_prone_annotations is in the Gradle cache"
if [ ! -e "$work/android/keystore.properties" ] && [ ! -e "$work/android/app/src/main/jniLibs/arm64-v8a/libstub.so" ]; then
  echo "  ok   the throwaway keystore properties and the stub .so are removed on exit"
else
  echo "  FAIL the stubs were left behind"; failures=$((failures + 1))
fi
make_project
FAKE_OFFLINE_FAIL=1 expect "a dependency missing from the cache fails the offline pass" nonzero "failed (offline)"
unset FAKE_OFFLINE_FAIL
make_project
FAKE_NO_JAR=1 expect "a release that downloaded no error_prone jar is refused" nonzero "error_prone_annotations is not in"
unset FAKE_NO_JAR
for t in :app:mergeUniversalReleaseNativeLibs :app:minifyUniversalReleaseWithR8 :app:bundleUniversalRelease; do
  make_project "$t" "NO-SOURCE"
  expect "$t NO-SOURCE on the online pass" nonzero "$t did not execute (online)"
  make_project "$t" "SKIPPED"
  expect "$t SKIPPED on the online pass" nonzero "$t did not execute (online)"
  make_project "$t" "UP-TO-DATE"
  expect "$t UP-TO-DATE on the online pass" nonzero "$t did not execute (online)"
done
make_project
FAKE_OFFLINE_SUFFIX=UP-TO-DATE expect "a release task UP-TO-DATE on the offline pass is refused" nonzero "did not execute (offline)"
unset FAKE_OFFLINE_SUFFIX
make_project
FAKE_OFFLINE_SUFFIX=NO-SOURCE expect "a release task NO-SOURCE on the offline pass is refused" nonzero "did not execute (offline)"
unset FAKE_OFFLINE_SUFFIX
make_project
echo 'storeFile=real.jks' > "$work/android/keystore.properties"
expect "a real keystore.properties is never overwritten" nonzero "will not overwrite"
if [ "$(cat "$work/android/keystore.properties")" = 'storeFile=real.jks' ]; then
  echo "  ok   and it is left in place"
else
  echo "  FAIL the real keystore.properties was removed or changed"; failures=$((failures + 1))
fi

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
