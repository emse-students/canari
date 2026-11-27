## P2 - read the next release's Android log: the Gradle cache restored from the new key, no Maven Central request (2026-11-25)

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

**What is done.** The Android release build hit Maven Central `429 Too Many Requests` twice on
2026-11-25 (the `1.8.1` stable and `1.8.2-alpha.1`) on `error_prone_annotations-2.26.0.jar`, with the
Gradle cache restored on an exact key hit: the cache was filled by debug tasks only. `compile-android-app`
now runs the real release chain (minus rust) online then `--offline` and asserts the jar is in the cache,
and the cache key moved ([cicd](../cicd.md#the-android-release-build-resolves-from-a-cache-ci-completes-and-proves-offline-2026-11-25)).

**What is NOT proven, and this entry stays open until it is.** The offline pass runs in the job that
filled the cache, so it cannot show that a RELEASE restores a complete one. That is a reading of the
first release cut after `main`'s post-merge CI has saved the new key (`gradle-app-Linux-<hash>`, the one
that includes `android-app-compile.sh`):

1. `Cache restored from key: gradle-app-Linux-<the new hash>` in the Android job, not a prefix fallback;
2. no request to `repo.maven.apache.org` for a jar (Gradle's `--info` is not on, so read a successful
   build plus the absence of any `Download` line for a release dependency, or rerun with
   `--info` once if in doubt).

Delete this entry on that reading. A cold or evicted cache (7 days unread) still downloads and can
still meet a `429`: that is a rerun of the failed job, written into `CHANGELOG.md`, never a skipped gate.
