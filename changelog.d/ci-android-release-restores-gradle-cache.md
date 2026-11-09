### Fixed - the Android release build no longer downloads Gradle and its jars cold

`android.yml` restores the Gradle wrapper and dependency cache that `main` wrote, read-only, so a 504 from `services.gradle.org` or Maven Central no longer blocks a release ([cicd](docs/wiki/cicd.md#the-android-release-build-restores-gradle-it-never-saves-it-2026-11-09)).
