#!/usr/bin/env bash
# WHAT EACH CHECK RUNS, WRITTEN ONCE - for `ci.yml`, for `code-analysis.yml`'s guards, for the
# `build-mls-wasm` action AND for the local hooks (`local-ci.sh`).
#
# WHY (owner, 2026-11-15): *"tout ce qui est verifie a la PR devrait etre verifie au commit, la
# fusion de PR devrait etre une formalite"*. A local run that types its own commands next to the
# workflow's is a second copy, and a second copy agrees with the first right up to the day one of
# them changes - which is the day the local run starts saying green about a change CI refuses. So a
# workflow step and a hook both call a subcommand here, and the command exists in one place.
# The tiers (what runs at commit, at push, and only in CI) are `local-ci.sh`'s, and the inventory
# with its measured durations is in docs/wiki/cicd.md ("Checks at commit, at push, and in CI only").
#
# Usage: checks.sh <check> [args]
#   rust <crate> [lockfile|fmt|clippy|task]...     one Rust crate's gate (default: all four)
#   ts <service> [install|lint|format|typecheck|build|test]...   one NestJS service (default: all)
#   frontend-prepare          deps, SvelteKit sync, protobuf bindings (the WASM is mls-wasm-build)
#   frontend-lint             oxlint + oxvelte, svelte-check, oxfmt --check
#   dead-code                 the knip ratchet
#   frontend-test [shard]     vitest with coverage, the whole suite or shard N of 4
#   frontend-test-related <base>   the push's vitest: only what `base..HEAD` reaches (owner, 2026-11-16)
#   frontend-build <sha>      the production web build, then what it must carry
#   mls-wasm-build            frontend/mls-wasm -> frontend/src/lib/wasm, and frontend/mail-tls ->
#                             frontend/src/lib/wasm/mail-tls, warnings denied
#   mls-wasm-verify           both built WASMs exist and carry no unsupported-platform panic
#   lockfile-version          every committed bun.lock is lockfileVersion 1
#   tauri-parity              the Tauri plugins' JS and Rust halves agree on major.minor
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

die() {
  echo "checks.sh: $*" >&2
  exit 2
}

# ── Rust ─────────────────────────────────────────────────────────────────────────────────────────
# The per-crate table. It was the `cmd` / `check` / `fmt` fields of the CI matrix JSON until
# 2026-11-15; the matrix now carries only what a RUNNER needs to set up (`wasm`, `tauri`).

# The crate's own task: its tests, or for the WASM crate the real wasm32 build.
rust_task() {
  case "$1" in
    apps/chat-gateway | apps/call-service | frontend/mls-core) echo "cargo test" ;;
    frontend/mls-wasm) echo "cargo build --target wasm32-unknown-unknown --release" ;;
    # The mail client's TLS (docs/wiki/mail-client-transport.md): its handshake tests, natively.
    # Its wasm32 build is `mls-wasm-build`, which every frontend job runs with warnings denied.
    frontend/mail-tls) echo "cargo test" ;;
    frontend/src-tauri) echo "cargo test --all-targets" ;;
    *) return 1 ;;
  esac
}

# Clippy is part of every crate's gate but the Tauri one, which CI has never linted: it was
# verified by hand on Windows only, never on Linux with `--all-features`, and a gate turned on for
# everybody on an unverified guess goes red for a reason nobody changed (the reasoning is at the
# src-tauri entry of ci-scopes.sh). Kept exactly as it was; changing it is its own decision.
rust_clippy_gated() {
  [ "$1" != "frontend/src-tauri" ]
}

check_rust() {
  local crate="${1:-}"
  [ -n "$crate" ] || die "rust: name a crate"
  shift
  local task
  task="$(rust_task "$crate")" || die "rust: $crate is not in the table - add it to rust_task"
  local steps=("$@")
  [ ${#steps[@]} -gt 0 ] || steps=(lockfile fmt clippy task)
  local s
  for s in "${steps[@]}"; do
    echo "--- rust $crate: $s"
    case "$s" in
      lockfile)
        # COMMITTED, not present: a workstation's build leaves an ignored lock in mls-core, which a
        # version bump then makes stale - and a clean CI checkout has none (2026-11-15).
        if ! git ls-files --error-unmatch "$crate/Cargo.lock" >/dev/null 2>&1; then
          echo "no committed Cargo.lock here by design - asserted through this crate's consumers"
        else
          (cd "$crate" && cargo metadata --locked --format-version 1 >/dev/null)
        fi
        ;;
      fmt) (cd "$crate" && cargo fmt -- --check) ;;
      clippy)
        if rust_clippy_gated "$crate"; then
          (cd "$crate" && cargo clippy --all-targets --all-features -- -D warnings)
        else
          echo "clippy is not part of $crate's gate (rust_clippy_gated in checks.sh)"
        fi
        ;;
      task)
        local cmd
        read -r -a cmd <<<"$task"
        (cd "$crate" && "${cmd[@]}")
        # THE VENDORED WEBSOCKET PLUGIN IS A PATH DEPENDENCY, NOT A WORKSPACE MEMBER: the crate's own
        # `cargo test` never reaches its tests (the going-away mute lives there). Run with the Tauri crate.
        if [ "$crate" = "frontend/src-tauri" ]; then
          echo "--- rust $crate: vendored plugin tests"
          (cd "$crate/patches/tauri-plugin-websocket" && cargo test)
        fi
        ;;
      *) die "rust: unknown step $s" ;;
    esac
  done
}

# ── NestJS services ──────────────────────────────────────────────────────────────────────────────
# Every service declares every script below; a missing one fails `bun run` loudly, which is the
# point - the `Check Lint Script` steps that used to skip a missing script were retired with this
# file, because a gate that skips what is absent is a gate that passes on a deleted script.
# `node --run test` and not `bun run test`: the suites are jest, and jest under bun fails one
# spec in chat-delivery-service (see the Makefile's `test-history`). No npm.
check_ts() {
  local svc="${1:-}"
  [ -n "$svc" ] || die "ts: name a service"
  [ -f "$svc/package.json" ] || die "ts: $svc has no package.json"
  shift
  local steps=("$@")
  [ ${#steps[@]} -gt 0 ] || steps=(install lint format typecheck build test)
  local s
  for s in "${steps[@]}"; do
    echo "--- ts $svc: $s"
    case "$s" in
      install) (cd "$svc" && bun install --frozen-lockfile) ;;
      lint) (cd "$svc" && bun run lint) ;;
      format) (cd "$svc" && bun run format:check) ;;
      typecheck) (cd "$svc" && bun run typecheck) ;;
      build) (cd "$svc" && bun run build) ;;
      test) (cd "$svc" && node --run test) ;;
      *) die "ts: unknown step $s" ;;
    esac
  done
}

# ── Frontend ─────────────────────────────────────────────────────────────────────────────────────
check_frontend_prepare() {
  (cd frontend && bun install --frozen-lockfile && bun run sync && bun run proto:gen)
}

check_frontend_lint() {
  (cd frontend && bun run lint && bun run check && bun run format:check)
}

check_dead_code() {
  bun .github/scripts/dead-code-ratchet.mjs frontend
}

check_frontend_test() {
  local shard="${1:-}"
  if [ -n "$shard" ]; then
    (cd frontend && bun run test:coverage --shard="$shard"/4)
  else
    (cd frontend && bun run test:coverage)
  fi
}

# The files whose change can move ANY test, so a push touching one runs the whole suite. The import
# graph cannot see them: the runner's own config, the setup files and helpers of `src/test/`, the
# dependencies, the messages every `m.xxx()` is generated from, the static assets, and the sources
# of what the build GENERATES into src (the MLS WASM from its two crates, the protobuf bindings
# from libs/proto) or what tests read across the tree (libs/contracts).
FRONTEND_TEST_SETUP='^(frontend/(vite\.config\.js|vitest\.config\.ts|kit\.config\.js|tsconfig\.json|package\.json|bun\.lock|src/test/|messages/|project\.inlang/|static/|mls-wasm/|mls-core/)|libs/(proto|contracts)/)'

# WHAT A PUSH'S VITEST RUNS (owner, 2026-11-16, "alleger le push": the whole suite was 720 of a
# frontend-only push's 846 s). The full suite stays CI's (`frontend-test`). Here:
#   - a change to FRONTEND_TEST_SETUP, or a deletion under frontend/src, runs the whole suite,
#     said by a named line;
#   - otherwise `vitest related` over the changed files - the tests whose import graph reaches one -
#     PLUS what that graph cannot see: every scan of the source tree (`src/test/sourceTree`, read
#     from disk, imports nothing it checks), and every test that names a changed file (one that
#     reads a component's text with `readFileSync`).
# CHECKS_DRY_RUN=1 prints the decision instead of running it (the self-test reads it).
check_frontend_test_related() {
  local base="${1:-}"
  [ -n "$base" ] || die "frontend-test-related: pass the base the range starts from"
  # No rename detection: a rename is the deletion of its old path, and handled as one.
  local changed setup deleted
  changed="$(git diff --name-only --no-renames "$base" HEAD)"
  setup="$(grep -E "$FRONTEND_TEST_SETUP" <<<"$changed" || true)"
  # A deleted module has no import graph left to ask: the tests that imported it are found by
  # nothing but running them all.
  deleted="$(git diff --name-only --no-renames --diff-filter=D "$base" HEAD -- frontend/src/)"
  if [ -n "$setup" ] || [ -n "$deleted" ]; then
    if [ -n "$setup" ]; then
      echo "frontend-test: the test setup changed ($(head -1 <<<"$setup" | sed 's#^frontend/##')) - the whole suite is CI's"
    else
      echo "frontend-test: a file under frontend/src was deleted ($(head -1 <<<"$deleted" | sed 's#^frontend/##')) - the whole suite is CI's"
    fi
    # The whole suite is 40+ min on a workstation and 6 on a runner, so it is never run at push
    # (owner, 2026-11-16: "Je veux que notre workflow soit le plus rapide possible"); CI runs it on
    # every pull request, and this line names what the push did not prove.
    return 0
  fi
  local sources=() name f
  while IFS= read -r f; do
    [ -n "$f" ] && sources+=("${f#frontend/}")
  done < <(grep -E '^frontend/src/' <<<"$changed" || true)
  if [ "${#sources[@]}" -eq 0 ]; then
    echo "frontend-test: no file under frontend/src changed - no test is related"
    return 0
  fi
  local extra=()
  while IFS= read -r f; do
    [ -n "$f" ] && extra+=("$f")
  done < <(
    cd frontend && {
      grep -rlE "test/sourceTree'" src --include='*.test.ts' --include='*.spec.ts' || true
      for f in "${sources[@]}"; do
        name="$(basename "$f")"
        grep -rlF "$name" src --include='*.test.ts' --include='*.spec.ts' || true
      done
    } | sort -u
  )
  echo "frontend-test: related to ${#sources[@]} changed file(s), plus ${#extra[@]} test(s) that read the source from disk"
  if [ "${CHECKS_DRY_RUN:-}" = "1" ]; then
    printf 'related: %s\n' "${sources[@]}" "${extra[@]}"
    return 0
  fi
  (cd frontend && bun run paraglide:compile && bun run paraglide:compile:test &&
    bunx vitest related --run "${sources[@]}" "${extra[@]}")
}

check_frontend_build() {
  local sha="${1:-}"
  [ -n "$sha" ] || die "frontend-build: pass the commit sha the build is stamped with"
  (cd frontend && BUILD_WEB=1 bun run build)
  bun .github/scripts/assert-frontend-build.mjs frontend "$sha"
}

# `-D warnings` here and not in `package.json`'s `wasm:build`: this is the gate, that is the
# developer's quick build, and a warning must fail the gate on every machine alike.
#
# The mail client's TLS is a SECOND WASM, built here beside the MLS one (one place, one wasm-pack,
# one cache): it is loaded only when the Mail tab is used, so it is its own file and never part of
# the boot download (docs/wiki/mail-client-transport.md). Built AFTER mls-wasm, whose out-dir holds
# it, so nothing the first build writes can stand on the second.
check_mls_wasm_build() {
  (cd frontend/mls-wasm && RUSTFLAGS='-D warnings' wasm-pack build --target web --out-dir ../src/lib/wasm)
  (cd frontend/mail-tls && RUSTFLAGS='-D warnings' wasm-pack build --target web --out-dir ../src/lib/wasm/mail-tls)
}

check_mls_wasm_verify() {
  local wasm
  for wasm in frontend/src/lib/wasm/mls_wasm_bg.wasm frontend/src/lib/wasm/mail-tls/mail_tls_bg.wasm; do
    verify_one_wasm "$wasm"
  done
}

verify_one_wasm() {
  local wasm="$1"
  if [ ! -s "$wasm" ]; then
    echo "::error::$wasm is missing after the build step (cache-hit=${CACHE_HIT:-n/a})"
    exit 1
  fi
  ls -l "$(dirname "$wasm")"
  if grep -qa 'not implemented on this platform' "$wasm"; then
    # `std` prefixes the sentence with the API's own name ("time", "random", ...), which is what
    # turns this refusal into a lead rather than a verdict.
    local found
    found=$(grep -ao '.\{0,40\}not implemented on this platform' "$wasm" | sed -n 1p | tr -c '[:print:]' ' ')
    echo "::error::The built WASM can panic on wasm32: ...${found}. A std API that does not exist on this target still compiles for it and panics at runtime, in the browser, on a path no test here covers. Gate the call behind #[cfg(not(target_arch = \"wasm32\"))], or take the value it needs (a clock, an entropy source) as a parameter from the caller, which has one on every target. See CHANGELOG v0.16.5."
    exit 1
  fi
  echo "$wasm carries no unsupported-platform panic (cache-hit=${CACHE_HIT:-n/a})"
}

# ── Lockfile guards (code-analysis.yml's `guards` job) ───────────────────────────────────────────
check_lockfile_version() {
  local bad="" lock v
  while IFS= read -r lock; do
    v="$(grep -o '"lockfileVersion"[[:space:]]*:[[:space:]]*[0-9]*' "$lock" | sed -n 1p | grep -o '[0-9]*$' || true)"
    echo "--- $lock: lockfileVersion=${v:-MISSING}"
    [ "$v" = "1" ] || bad="$bad $lock"
  done < <(git ls-files '*bun.lock')
  if [ -n "$bad" ]; then
    echo "::error::bun lockfile version must be 1 (Dependabot cannot read v2):$bad"
    exit 1
  fi
}

check_tauri_parity() {
  (cd frontend && bun ./scripts/check-tauri-plugin-versions.mjs)
}

name="${1:-}"
[ -n "$name" ] || die "name a check (see the header of this file)"
shift
case "$name" in
  rust) check_rust "$@" ;;
  ts) check_ts "$@" ;;
  frontend-prepare) check_frontend_prepare ;;
  frontend-lint) check_frontend_lint ;;
  dead-code) check_dead_code ;;
  frontend-test) check_frontend_test "$@" ;;
  frontend-test-related) check_frontend_test_related "$@" ;;
  frontend-build) check_frontend_build "$@" ;;
  mls-wasm-build) check_mls_wasm_build ;;
  mls-wasm-verify) check_mls_wasm_verify ;;
  lockfile-version) check_lockfile_version ;;
  tauri-parity) check_tauri_parity ;;
  *) die "unknown check: $name" ;;
esac
