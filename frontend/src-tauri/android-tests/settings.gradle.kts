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
// WHY MOVING IT IS THE FIX RATHER THAN A DODGE. Nothing the suite runs needs an Android class, a
// tauri class or the `:app` build. It was never an Android test; it was a JVM test that happened to
// be filed inside an Android module, and it inherited that module's entire build cost for nothing.
//
// AND IT NO LONGER TESTS A MIRROR, WHICH IS WHAT THAT COST WAS FEARED TO BUY BACK. Until
// 2026-09-22 the suite restated the service's ladder in the test file, so it could not fail when
// `CanariFirebaseMessagingService` changed; lifting the ladder out was expected to drag the app
// module back in with it. It did not: `fr.emse.canari.push` needs no platform, so `build.gradle.kts`
// beside this file adds that directory of the app tree as a `main` source directory and the one
// function is compiled in both projects. **Which is why nothing with an Android import may be filed
// there** - see the comment on that `sourceSets` block.

rootProject.name = "canari-android-tests"
