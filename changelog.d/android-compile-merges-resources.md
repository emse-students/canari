### Changed - The Android compile gate on a pull request now merges the resources

`compile-android-app` ran three debug tasks and none of them reads `strings.xml`, so a bare apostrophe (#2945) passed it and failed the Play build. It now also executes `:app:mergeArm64DebugResources`, where aapt2 flattens the strings ([cicd](docs/wiki/cicd.md#native-and-identity-provider-manifests-2026-10-23)).
