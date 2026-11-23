#!/usr/bin/env bash
# WHICH CI JOBS A CHANGE OWES, DECIDED ONCE - for `ci.yml`'s `changes` job AND for the local
# pre-push run (`local-ci.sh push`). Moved here out of `ci.yml` on 2026-11-15, when the owner
# decided that what a pull request checks is checked before the push: two copies of these filters
# would agree right up to the day one of them gained a path, which is the day the local run would
# start saying green about a change CI then refuses.
#
# Usage: CI_WORKFLOW=<path of the CI workflow file> ci-scopes.sh <base> [<head>]
#   prints one `name=value` line per output of the `changes` job on stdout (ci.yml appends them to
#   `$GITHUB_OUTPUT`); everything said for a human goes to stderr. An empty <base> runs everything.
#
# CI_WORKFLOW IS PASSED BY THE CALLER AND MUST EXIST. In CI it is derived from GITHUB_WORKFLOW_REF
# (see the comment at the guard below); locally it is `.github/workflows/ci.yml`, and a rename of
# that file fails here, loudly, instead of quietly matching nothing.
set -euo pipefail

BASE="${1-}"
HEAD_REF="${2:-HEAD}"
SELF="${CI_WORKFLOW:-}"
if [[ -z "$SELF" ]]; then
  echo "::error::CI_WORKFLOW is empty, so this script cannot name the workflow file whose change must run everything - which is the exact silent failure the guard below was rewritten to end." >&2
  exit 1
fi
if [[ ! -f "$SELF" ]]; then
  echo "::error::CI_WORKFLOW names $SELF, which does not exist - the CI workflow was renamed or moved, and the run-everything guard would match nothing." >&2
  exit 1
fi
# ── Full matrices (used as fallback) ──
ALL_RUST='[{"name":"Chat Gateway","path":"apps/chat-gateway"},{"name":"Call Service (SFU)","path":"apps/call-service"},{"name":"Frontend MLS Core","path":"frontend/mls-core"},{"name":"Frontend MLS WASM","path":"frontend/mls-wasm","wasm":true},{"name":"Frontend Native (Tauri)","path":"frontend/src-tauri","tauri":true}]'
ALL_TS='["apps/core-service","apps/social-service","apps/chat-delivery-service","apps/media-service"]'

# EVERY OUTPUT THIS JOB DECLARES, OR "run everything" IS A LIE. Two were missing until
# 2026-09-15 - `android` and `mls_compat` - so a pull request that CHANGED `ci.yml`, the
# one case this function exists for, skipped the Android suite and the MLS cross-version
# gate and went green for the reason that they had not run. That is the failure the
# comment below it describes and #521 already paid for once; it was reintroduced by
# adding outputs to the job and not to this function, which is why
# `changes-outputs.test.mjs` now DERIVES the list from the `outputs:` block instead of
# trusting anyone to remember.
run_all() {
  echo "rust=$ALL_RUST"
  echo "ts=$ALL_TS"
  echo "frontend=true"
  echo "frontend_build=true"
  echo "harness=true"
  echo "android=true"
  echo "android_app=true"
  echo "ios_app=true"
  echo "mls_compat=true"
  echo "miconnect=true"
  echo "call_e2e=true"
}

if [[ -z "$BASE" ]]; then
  echo "No base commit available - running all tests." >&2
  run_all; exit 0
fi

CHANGED="$(git diff --name-only "$BASE" "$HEAD_REF")"
{ echo "Changed files:"; echo "$CHANGED"; } >&2

# Helper: returns 0 if any changed file matches the pattern
has() { grep -qE "$1" <<<"$CHANGED"; }

# THE CI DEFINITION ITSELF CHANGED -> test everything, and THE PATH IS DERIVED FROM THE
# RUN rather than written down here.
#
# This guard named `pull-request.yml` from #356 - the commit that renamed the file to
# `ci.yml` - until 2026-09-11, so it matched nothing and said nothing. What the silence
# cost: #521 REPAIRED a broken `boot-nest-apps` job and merged with that very job
# SKIPPED, because a workflow edit touches no service path, and `CI passed` went green
# for the reason that the jobs had not run. A name-based guard fails by ABSENCE, which is
# invisible. In CI, `GITHUB_WORKFLOW_REF` is written by the runner from the workflow actually
# executing, so it cannot go stale under a rename. `code-analysis.yml` is named explicitly because
# it RUNS inside this workflow as a library - it is part of the CI definition, not a neighbour of
# it - and so, since 2026-11-15, are this file and `checks.sh`, which say what each job runs.
# The path is matched as a FIXED WHOLE LINE, so no regex escaping stands between the
# name the runner gave us and the name in the diff.
if grep -qxF "$SELF" <<<"$CHANGED" \
   || has '^\.github/workflows/code-analysis\.yml$' \
   || has '^\.github/scripts/(ci-scopes|checks)\.sh$'; then
  echo "CI definition changed ($SELF) - running all tests." >&2
  run_all; exit 0
fi

# ── Rust matrix ──
rust=()
# chat-gateway generates its protobufs from `libs/proto`; since `libs/shared-rust`
# was deleted on 2026-08-31 that is its ONLY path dependency inside this repo. Its TESTS
# also read `libs/contracts/` (the presence-audience cap, `presence.rs`), so a contract
# change runs them, and chat-delivery's device limit (`state.rs` asserts its copy of it):
# ask what the gate reads.
if has '^libs/proto/' || has '^libs/contracts/' || has '^apps/chat-gateway/' || has '^apps/chat-delivery-service/src/retention\.constants\.ts$'; then
  rust+=('{"name":"Chat Gateway","path":"apps/chat-gateway"}')
fi
# THE SFU, WHICH NOTHING HERE COMPILED UNTIL 2026-08-27 - the same hole as the native
# crate below, found the same way. `apps/call-service` was in no matrix at all, so the
# ONLY thing that ever built it was the Docker stage in `deploy.yml`, which runs AFTER a
# merge. Two Dependabot majors went green through that gap and landed on `main` broken:
# #222 (webrtc 0.11 -> 0.17, which deleted `RTCIceServer::credential_type`) and #227
# (axum 0.7 -> 0.8, whose text frames became `Utf8Bytes`). The failure surfaced as a red
# CD and a skipped deploy, which is far too late and one step from a release.
# LINTED (`rust_clippy_gated` in checks.sh): `cargo fmt --check` and `clippy --all-targets --all-features -D warnings`
# were both run against this crate before this entry was added, and both are clean - it
# is not on an unverified guess, unlike the deliberate omission noted for Tauri below.
# It has no path dependency on anything in this repo, so only its own sources trigger it.
if has '^apps/call-service/'; then
  rust+=('{"name":"Call Service (SFU)","path":"apps/call-service"}')
fi

mls_core=false
if has '^frontend/mls-core/'; then mls_core=true; fi
if [[ "$mls_core" == "true" ]]; then
  rust+=('{"name":"Frontend MLS Core","path":"frontend/mls-core"}')
fi
# mls-wasm depends on mls-core
if [[ "$mls_core" == "true" ]] || has '^frontend/mls-wasm/'; then
  rust+=('{"name":"Frontend MLS WASM","path":"frontend/mls-wasm","wasm":true}')
fi
# AND SO DOES THE NATIVE CRATE, WHICH NOTHING HERE COMPILED UNTIL 2026-08-23. A variant
# added to `mls_core::DecryptErrorKind` broke `src-tauri`'s exhaustive match, and every
# gate stayed green: CI has no matrix entry for it, and the only workflows that build it
# are the three release ones - so the break would have surfaced at a release, which is the
# worst possible moment and exactly the shipping-order hazard `legacy-compatibility.md`
# is about. Triggered by its own sources AND by mls-core, because that is the direction
# the dependency runs.
#
# DELIBERATELY NOT LINTED (`rust_clippy_gated` in checks.sh; rustfmt runs since 2026-09-02). Both were
# verified by hand on Windows the day this was added; neither has ever run against this
# crate on Linux with `--all-features`, and turning a gate on for everybody on an
# unverified guess is how a pipeline goes red for a reason nobody changed.
#
# IT RUNS THE TESTS NOW, AND UNTIL 2026-08-31 IT DID NOT. `cargo check --all-targets` was
# the exact scope of the defect that prompted the entry - does it compile - and it stayed
# that scope after the crate acquired 33 tests, so every one of them was COMPILED and none
# was ever RUN by anything but a developer's machine. That is the house rule about native
# code written into the pipeline itself: verifying by compiling proves nothing about
# running. `cargo test --all-targets` strictly dominates the old command - it still
# compiles every target - and it is what makes `cross_version_push.rs`, the gate that
# retired the `aes-gcm` ceiling clause, an actual gate rather than a file that compiles.
# The webkit2gtk install below is what lets the test binary LINK on Linux; it was already
# there for the check.
if [[ "$mls_core" == "true" ]] || has '^frontend/src-tauri/'; then
  rust+=('{"name":"Frontend Native (Tauri)","path":"frontend/src-tauri","tauri":true}')
fi

if [[ ${#rust[@]} -eq 0 ]]; then
  echo "rust=[]"
else
  echo "rust=[$(IFS=,; echo "${rust[*]}")]"
fi

# ── TypeScript backend matrix ──
#
# `libs/contracts/` IS IN THREE OF THESE ENTRIES BECAUSE THEIR SUITES READ IT (core-service
# since 2026-10-21: `payment-amount-range.json`, the range social mirrors). A contract
# there is a rule several estates must agree on, shared as DATA because no TypeScript
# package crosses this repository (see `docs/wiki/libs.md`), and it is honoured by one
# test per implementation reading the JSON from disk. A case added to that file with no
# job running is the same silent hole the frontend filter below already paid for once:
# ASK WHAT THE GATE READS.
ts=()
if has '^apps/core-service/' || has '^libs/contracts/'; then
  ts+=('"apps/core-service"')
fi
if has '^apps/social-service/' || has '^libs/contracts/'; then
  ts+=('"apps/social-service"')
fi
if has '^apps/chat-delivery-service/' || has '^libs/contracts/'; then
  ts+=('"apps/chat-delivery-service"')
fi
if has '^apps/media-service/'; then
  ts+=('"apps/media-service"')
fi

if [[ ${#ts[@]} -eq 0 ]]; then
  echo "ts=[]"
else
  echo "ts=[$(IFS=,; echo "${ts[*]}")]"
fi

# ── Frontend ──
#
# `frontend/src-tauri/` IS IN THIS LIST BECAUSE THE FRONTEND SUITE READS IT, not because
# it is under `frontend/`. Twenty-odd vitest files in `frontend/src/lib/mobile/` and
# `frontend/src/lib/services/` open the Kotlin, the Swift, the `.mm` bridges, the Rust
# commands, `tauri.conf.json` and the Android resources, and assert things about them -
# that every declared notification channel is created, that the push payload's fields
# agree on both platforms, that the manifest still registers the FCM service. Until
# 2026-09-17 this filter named `^frontend/src/` only, so a commit touching ONLY the
# native tree ran the Android Gradle job and NONE of the tests written to guard that
# tree - the derived-test failure this repository has now met five times. The `android`
# filter below is correct and is not a substitute: it runs the JVM ladder suite, not
# these.
#
# Ask what the gate READS. These read `frontend/` whole, so the trigger is `frontend/`
# whole, minus nothing that is not separately covered.
#
# EVERY CONFIG FILE AT `frontend/`'S TOP LEVEL THAT SHAPES THE SUITE IS LISTED (2026-11-16): `kit.config.js`
# (adapter, aliases, paths), `oxvelte.config.json` (the Svelte lint) and `project.inlang/` (the
# Paraglide settings the messages are generated from) were not, so a change to ONLY one of them ran
# neither the vitest shards nor the build (`kit.config` fed `frontend_build` below and nothing else).
# `checks.sh frontend-test-related` already treated `kit.config.js` and `project.inlang/` as a test-setup
# change; the scope that lets it run at all now agrees.
#
# `bun.lock` and `patches/` decide which library code the suite runs (2026-10-13): a
# lockfile-only bump of a patched dependency drops its patch silently, and only
# `patchedDependencies.test.ts` and the behavioural test behind the patch would say so.
# `channel-retention.scheduler.ts` IS IN THIS LIST FOR THE SAME REASON: the frontend's
# `retentionFloorPin.test.ts` reads `CHANNEL_MESSAGE_RETENTION_DAYS` from it and fails
# when the graine retention floor no longer matches, so a PR changing ONLY that constant
# must run the frontend suite instead of breaking a later, unrelated frontend PR.
if has '^frontend/src/' || has '^frontend/src-tauri/' || has '^frontend/static/' || \
   has '^apps/social-service/src/channels/channel-retention\.scheduler\.ts$' || \
   has '^frontend/package\.json' || has '^frontend/bun\.lock' || has '^frontend/patches/' || \
   has '^frontend/svelte\.config' || has '^frontend/kit\.config' || has '^frontend/oxvelte\.config' || has '^frontend/project\.inlang/' || \
   has '^frontend/messages/' || has '^frontend/knip\.json' || has '^frontend/dead-code-' || \
   has '^\.github/scripts/dead-code-ratchet\.mjs' || \
   has '^frontend/vite\.config' || has '^frontend/vitest\.config' || \
   has '^frontend/tsconfig' || has '^frontend/\.oxlintrc' || has '^oxfmt\.json' || has '^\.oxlintrc' || has '^rust-toolchain\.toml' || has '^scripts/install-oxvelte\.sh' || \
   has '^frontend/mls-wasm/' || has '^frontend/mls-core/' || has '^libs/proto/' || has '^libs/contracts/' ||              has '^infrastructure/local/Dockerfile.frontend$'; then
  echo "frontend=true"
else
  echo "frontend=false"
fi

# The PRODUCTION BUILD runs on a pull request only when what it consumes changed: the
# dependency set (`package.json`, `bun.lock`, `patches/`), the build configuration
# (`kit.config`, `vite.config`, so the adapters too) and the image that serves the
# output. An `adapter-node` bump broke the main-only build AFTER its pull request had
# passed every gate here, because nothing ran the build before the merge.
if has '^frontend/package.json' || has '^frontend/bun.lock' || has '^frontend/patches/' ||              has '^frontend/kit.config' || has '^frontend/vite.config' ||              has '^infrastructure/local/Dockerfile.frontend$'; then
  echo "frontend_build=true"
else
  echo "frontend_build=false"
fi

# -- Android unit tests --
# Two paths, and they are not the same kind of thing. `gen/android` is the committed
# (though generated) Android client, and a change to its Kotlin is what the ladder suite
# is there to catch; `android-tests` is the standalone JVM project that suite now lives
# in, outside the app module - see its `settings.gradle.kts` for why. A path filter is
# right here and a `cargo`-style dependency walk is not: neither tree reads anything
# outside itself. The plugins' `pure/` directories are compiled into the suite too
# (`android-tests/build.gradle.kts`), and its contract tests read `libs/contracts/`, so a
# change to either runs it - before 2026-11-23 a
# change to the gallery's `pure/` code did not.
if has '^frontend/src-tauri/gen/android/' || has '^frontend/src-tauri/android-tests/' ||    has '^frontend/src-tauri/plugins/[^/]+/android/src/main/java/pure/' ||    has '^libs/contracts/'; then
  echo "android=true"
else
  echo "android=false"
fi

# -- Android `:app` compile --
# What `compile-android-app` reads: the Android project itself, and whatever feeds the
# generation of its `tauri.settings.gradle` AND the Rust it checks for the Android target
# (the app crate's `build.rs` runs under cargo, so the manifest, the lock, the toolchain,
# the crate's sources, `mls-core` it depends on by path, and the native plugins it names),
# plus its own script. This is the ONLY pull-request compile for an Android Rust target,
# which is why `src/` is here. Narrower than `android` above on purpose: `android-tests`
# is a JVM project this job does not build, and it pays minutes of Rust.
if has '^frontend/src-tauri/gen/android/' || \
   has '^frontend/src-tauri/src/' || \
   has '^frontend/src-tauri/Cargo\.(toml|lock)$' || \
   has '^frontend/src-tauri/build\.rs$' || \
   has '^frontend/src-tauri/tauri\.conf\.json$' || \
   has '^frontend/src-tauri/(plugins|patches)/' || \
   has '^frontend/mls-core/' || \
   has '^rust-toolchain\.toml$' || \
   has '^\.github/scripts/android-app-compile\.sh$'; then
  echo "android_app=true"
else
  echo "android_app=false"
fi

# -- iOS app compile --
# What `compile-ios-app` reads: the NATIVE APPLE CODE and what builds it. It runs on a
# macOS runner, the scarcest minutes in this file, so the trigger is the Apple tree and
# not (like `android_app`) the Rust crate: `gen/apple` (the app, the notification and share
# extensions, the pbxproj), a Swift package under `plugins/*/ios` or `patches/*/ios`, any
# Swift / Objective-C source or header under `src-tauri` (a bridge may live beside the
# Rust), the manifest, build script and Tauri config that decide what is linked and
# bundled (owner, 2026-11-04; NOT `Cargo.lock`, which Dependabot bumps would turn into a
# macOS run each), the scripts it runs, `ios.yml` (the release build it mirrors) and the
# toolchain pin. A change to the crate's Rust sources alone is compiled for the host by
# `test-rust` and for iOS by the release.
if has '^frontend/src-tauri/gen/apple/' || \
   has '^frontend/src-tauri/(plugins|patches)/[^/]+/ios/' || \
   has '^frontend/src-tauri/.*\.(swift|m|mm|h)$' || \
   has '^frontend/src-tauri/(Cargo\.toml|build\.rs|tauri(\.ios)?\.conf\.json)$' || \
   has '^rust-toolchain\.toml$' || \
   has '^\.github/workflows/ios\.yml$' || \
   has '^\.github/scripts/ios-(app-compile|libapp|extensions)\.sh$'; then
  echo "ios_app=true"
else
  echo "ios_app=false"
fi

# -- MLS cross-version compatibility --
# THE WIDEST TRIGGER IN THIS FILE, ON PURPOSE. It fires on `mls-core` (the library whose
# wire output is the subject), on `mls-cross-version` (the driver both sides are built
# from), on the two lockfiles that pin the protocol crates for the things that SHIP, and
# on the script and the params it reads. A Dependabot pull request bumping `openmls`
# touches only a lock - and that is exactly the pull request this gate was written to
# judge, since `lib/ceiling.sh` stopped refusing the family on 2026-09-15.
if has '^frontend/mls-core/' || has '^frontend/mls-cross-version/' || \
   has '^frontend/mls-wasm/Cargo\.lock' || has '^frontend/src-tauri/Cargo\.lock' || \
   has '^\.github/scripts/mls-forward-compat\.sh'; then
  echo "mls_compat=true"
else
  echo "mls_compat=false"
fi

# -- The SFU's end-to-end call (owner decision D3, 2026-11-01) --
# ASK WHAT THE GATE READS: the crate (its harness lives in `apps/call-service/e2e/`), the
# shared Chrome driver, the app's E2E worker and every module that worker or the page
# imports - the worker IS the transform under test, built from source, so a change to it
# alone must run the call that proves it still works through the SFU.
if has '^apps/call-service/' || \
   has '^tools/headless-chrome/' || \
   has '^frontend/src/lib/workers/encryption\.worker\.ts$' || \
   has '^frontend/src/lib/utils/(callAudio|callKeys|opusPacket|callVideoFrame|callFrameAad|callE2eReport|sessionLog)\.ts$' || \
   has '^frontend/src/lib/services/callSfuLeg\.ts$' || \
   has '^rust-toolchain\.toml$' || has '^\.bun-version$'; then
  echo "call_e2e=true"
else
  echo "call_e2e=false"
fi

# -- MiConnect's blueprints --
# Everything the fresh-instance test reads is under this one directory: the compose file it
# boots, the blueprints it applies and the two scripts that do it.
if has '^infrastructure/authentik/'; then
  echo "miconnect=true"
else
  echo "miconnect=false"
fi

# -- Cross-client harness self-tests --
# THEY DO NOT READ THE RIG'S OWN SOURCES AND NOTHING ELSE, whatever this comment claimed
# until 2026-09-24. Two of them read the APP: `caption-selftest` resolves every Paraglide
# key the rig spells against `frontend/messages/fr.json`, and `selector-selftest` also
# imports `frontend/src/lib/styles/markupSources.ts`. Those two exist precisely to catch a
# renamed key - and with `tools/cross-client-harness/` as the whole trigger, the pull
# request that renames one is the pull request they do not run on. #1006 replaced the poll
# composer, `channel_poll_add_option` and `channel_poll_option_placeholder` went with it,
# and the rig could no longer compose a poll at all. Nothing said so until an unrelated
# workflow edit made CI run everything.
# AND THE RECIPE LINTS ALL OF `tools/`, not the rig alone: #3568 edited `tools/ios-device/`,
# the gate did not run on it, and its lint warning then failed every later pull request
# that did trigger it. The trigger is what the recipe reads, so it is `tools/` whole.
# THE RECIPE ITSELF IS IN THE MAKEFILE (2026-11-15): a change to `test-harness` is a change to
# what this job runs, and nothing ran it on the pull request that made one.
if has '^tools/' ||
   has '^Makefile$' ||
   has '^[.]oxlintrc[.]json$' ||
   has '^frontend/messages/' ||
   has '^frontend/src/lib/styles/markupSources[.]ts'; then
  echo "harness=true"
else
  echo "harness=false"
fi
