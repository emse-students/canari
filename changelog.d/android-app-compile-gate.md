### Changed - a pull request now compiles the Android app module, so Gradle bumps there can be judged

The dependency ceiling refused every Gradle update to `gen/android` because nothing built it before a release; `compile-android-app` does, with a stub `google-services.json` ([cicd](docs/wiki/cicd.md#native-and-identity-provider-manifests-2026-10-23)).
