## P2 - a release build must not depend on a third-party rate limit at build time (2026-11-25)

target: 1.8.2

**What happened.** The `1.8.1` stable's Android build (job "Google Play / Build Android APK", run
45606794415) failed once on a Maven Central `429 Too Many Requests` fetching
`error_prone_annotations-2.26.0.jar`. A rerun of the failed job passed and the release went on: a
rerun of one failed job, NOT an admin bypass (the gates ran, nothing was skipped).

**Why it is a defect.** The stable is cut once the latest alpha is read on both phones; a build that
reaches out to a public repository for every dependency makes the cut hostage to a limit nobody here
controls, on the one run that must not be repeated for a flake.

**The gate that would lift it.** The Android build resolves its dependencies from a cache keyed on the
lockfile (Gradle dependency locking plus a restored `~/.gradle` cache, or a project-owned mirror), and a
CI test asserts that a build with the network to Maven Central cut passes from that cache alone. Until
that test exists, a `429` on a release build is a rerun of the failed job and is written into
`CHANGELOG.md`, never a reason to skip a gate.
