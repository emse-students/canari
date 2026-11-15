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
#   frontend-build <sha>      the production web build, then what it must carry
#   mls-wasm-build            frontend/mls-wasm -> frontend/src/lib/wasm, warnings denied
#   mls-wasm-verify           the built WASM exists and carries no unsupported-platform panic
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

check_frontend_build() {
  local sha="${1:-}"
  [ -n "$sha" ] || die "frontend-build: pass the commit sha the build is stamped with"
  (cd frontend && BUILD_WEB=1 bun run build)
  bun .github/scripts/assert-frontend-build.mjs frontend "$sha"
}

# `-D warnings` here and not in `package.json`'s `wasm:build`: this is the gate, that is the
# developer's quick build, and a warning must fail the gate on every machine alike.
check_mls_wasm_build() {
  (cd frontend/mls-wasm && RUSTFLAGS='-D warnings' wasm-pack build --target web --out-dir ../src/lib/wasm)
}

check_mls_wasm_verify() {
  local wasm=frontend/src/lib/wasm/mls_wasm_bg.wasm
  if [ ! -s "$wasm" ]; then
    echo "::error::MLS WASM is missing after the build step (cache-hit=${CACHE_HIT:-n/a})"
    exit 1
  fi
  ls -l frontend/src/lib/wasm/
  if grep -qa 'not implemented on this platform' "$wasm"; then
    # `std` prefixes the sentence with the API's own name ("time", "random", ...), which is what
    # turns this refusal into a lead rather than a verdict.
    local found
    found=$(grep -ao '.\{0,40\}not implemented on this platform' "$wasm" | sed -n 1p | tr -c '[:print:]' ' ')
    echo "::error::The built WASM can panic on wasm32: ...${found}. A std API that does not exist on this target still compiles for it and panics at runtime, in the browser, on a path no test here covers. Gate the call behind #[cfg(not(target_arch = \"wasm32\"))], or take the value it needs (a clock, an entropy source) as a parameter from the caller, which has one on every target. See CHANGELOG v0.16.5."
    exit 1
  fi
  echo "wasm carries no unsupported-platform panic (cache-hit=${CACHE_HIT:-n/a})"
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
  frontend-build) check_frontend_build "$@" ;;
  mls-wasm-build) check_mls_wasm_build ;;
  mls-wasm-verify) check_mls_wasm_verify ;;
  lockfile-version) check_lockfile_version ;;
  tauri-parity) check_tauri_parity ;;
  *) die "unknown check: $name" ;;
esac
