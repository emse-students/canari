# shellcheck shell=bash
#
# THE ONE TABLE OF WHAT `bun audit` IS ASKED OF EACH TREE, read by the pull-request audit, the
# nightly audit (both `code-analysis.yml`) and the stable gate of `release-preflight.sh`. Three
# readers of one table, so a tree, a level or an ignore can never differ between the moment a
# pull request merges and the moment its code ships.
#
# TWO CLOSURES (owner, 2026-11-17: "Ce qu'on livre"). A pull request and a stable block only on an
# advisory in what we SHIP; an advisory in build or test tooling is reported by the nightly audit,
# where it is still a failure, and freezes no merge. docs/wiki/cicd.md carries the measurement.
#
#   production  the four services are audited `--prod`: their runtime image runs `bun dist/main.js`
#               and loads only what `dependencies` reaches. The FRONTEND IS NEVER `--prod`: svelte,
#               @sveltejs/kit, protobufjs and parse5 are devDependencies and are BUNDLED into what
#               ships, so `--prod` would silently stop auditing the code users run - #1229's hole
#               reopened for the one tree where it matters most.
#   full        every tree, every dependency: the nightly pass.
#
# AN IGNORE IS AN ALLOWLIST OF ONE ADVISORY IN ONE TREE, and its proof is an ASSERTED premise in
# `code-analysis.yml` (the minio ones: "The premises behind media-service's ignores"; picomatch:
# `picomatch-premise.mjs`). Every one is retired by "Every ignored advisory is still reported".

# Every tree with a `bun.lock`. `audit-dependencies.test.sh` asserts the matrix in
# `code-analysis.yml` names exactly these.
# shellcheck disable=SC2034  # read by the files that source this one
AUDIT_TREES=(frontend apps/core-service apps/social-service apps/media-service apps/chat-delivery-service)

# audit_install_flags <tree>: how the audit job installs the tree (the premises read `node_modules`).
# The frontend runs its scripts (Tauri and the WASM glue need them); every service skips them.
audit_install_flags() {
  case "$1" in
    frontend) echo '--frozen-lockfile' ;;
    apps/*) echo '--frozen-lockfile --ignore-scripts' ;;
    *) echo "::error::audit_install_flags: $1 is not an audited tree" >&2; return 1 ;;
  esac
}

# audit_ignores <tree> <closure>: the `--ignore=` flags of that tree, one line, possibly empty.
audit_ignores() {
  local tree="$1" closure="$2" ids=()
  case "$closure" in production | full) ;; *) echo "::error::audit_ignores: closure '$closure' is neither production nor full" >&2; return 1 ;; esac
  case "$tree" in
    # minio's edges, runtime dependencies: ignored in BOTH closures. code-analysis.yml carries why.
    apps/media-service) ids+=(GHSA-vcc3-ghjq-m6fr GHSA-qr28-fpjm-wq7f GHSA-528h-pc64-c93x GHSA-hqr4-qq8f-hg3x GHSA-mjw6-4jj6-33hc) ;;
    # picomatch ReDoS (2026-11-17, no fixed version exists). Shipped as `typeorm > tinyglobby`,
    # which globs only string entity/migration/subscriber paths, and these services pass classes.
    # PRODUCTION ONLY: the full nightly audit still reports picomatch through the build tools.
    apps/core-service | apps/social-service | apps/chat-delivery-service)
      [ "$closure" = production ] && ids+=(GHSA-fc5q-39xc-vjpf) ;;
    # The frontend has one closure (above), where picomatch arrives only through build tools.
    frontend) ids+=(GHSA-fc5q-39xc-vjpf) ;;
    *) echo "::error::audit_ignores: $tree is not an audited tree" >&2; return 1 ;;
  esac
  local out=() id
  for id in "${ids[@]}"; do out+=("--ignore=$id"); done
  echo "${out[*]}"
}

# audit_flags <tree> <closure>: every argument `audit-dependencies.sh <tree>` passes to `bun audit`.
audit_flags() {
  local tree="$1" closure="$2" flags=() ignores
  ignores="$(audit_ignores "$tree" "$closure")" || return 1
  case "$tree" in
    frontend) ;;
    apps/*)
      [ "$closure" = production ] && flags+=(--prod)
      flags+=(--audit-level=moderate) ;;
  esac
  # shellcheck disable=SC2206  # the ignores are a word list by construction
  [ -n "$ignores" ] && flags+=($ignores)
  echo "${flags[*]}"
}
