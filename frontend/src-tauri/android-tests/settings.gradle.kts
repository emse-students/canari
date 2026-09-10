// KOTLIN UNIT TESTS FOR THE ANDROID CLIENT, OUTSIDE THE ANDROID PROJECT, AND THAT IS THE POINT.
//
// WHAT WENT WRONG. `PushDecryptLadderTest.kt` lived in `gen/android/app/src/test/`, so running it
// meant configuring the `:app` module, and `:app` cannot be configured without the whole mobile
// toolchain: `gen/android/settings.gradle` applies `tauri.settings.gradle`, a file that tauri
// GENERATES and `.gitignore` excludes because it holds absolute paths into a particular machine's
// cargo registry. On top of that the app module wants `google-services.json`, which is a secret.
//
// So the gate added in #487 could only ever pass on a developer's own box. It was believed green
// on the strength of one local run; across the fourteen CI runs that followed it was SKIPPED
// thirteen times and FAILED the only time a change actually touched Android files, on
// `Could not read script 'tauri.settings.gradle' as it does not exist`. A gate that cannot run
// where it is supposed to run is worse than no gate: it blocks every Android change for a reason
// that has nothing to do with the change.
//
// WHY MOVING IT IS THE FIX RATHER THAN A DODGE. The suite imports `org.junit` and NOTHING ELSE -
// no Android class, no tauri class, not one type from `:app`. Its own docblock says so: it
// exercises the ladder "as a pure Kotlin state machine" precisely because the real methods are
// private and JNI-bound. It was never an Android test; it was a JVM test that happened to be
// filed inside an Android module, and it inherited that module's entire build cost for nothing.
//
// WHAT THIS DOES NOT FIX, stated so the green tick is not read as more than it is: the suite
// tests a MIRROR of the service's ladder, written out again in the test file, so it cannot fail
// when the real `CanariFirebaseMessagingService` changes. Making it exercise the real code means
// lifting the ladder out of the private JNI-bound methods into a pure function `:app` and this
// project can share - and THAT test would legitimately need the app module. It is filed in the
// backlog; nothing here closes it.

rootProject.name = "canari-android-tests"
