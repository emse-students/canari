#!/usr/bin/env bash
#
# WHICH CARGO DIRECTORIES DEPENDABOT IS DECLARED ON, AND WHICH OF THEM IT CANNOT PARSE.
#
# ONE DEFINITION, because two readers of the same fact drift and the drift is silent. This started
# life inside `tests/dependabot-cargo-reach.test.sh`, whose job is to REFUSE a new blocked
# directory; `cargo-blocked-update-report.sh` needs the same set in order to go and update those
# directories by hand. A reporter that derived the set its own way would eventually report on a
# directory the test does not guard, or miss one it does, and nothing would say so.
#
# THE FACT ITSELF. Dependabot materialises a temp checkout of MANIFESTS AND LOCKFILES ONLY - it
# stubs declared lib and bin targets and copies no `build.rs` - so a manifest carrying `links` is
# one cargo refuses to read before it considers any version:
#
#   error: package specifies that it links to `tauri-plugin-customtabs`
#          but does not have a custom build script
#
# The refusal is not local to that manifest: it blocks every declared directory whose dependency
# graph REACHES it. That is why the derivation walks `path = ` dependencies rather than looking at
# the declared directories' own manifests.
#
# Source it; it defines functions and runs nothing.

# The `directories:` list of the ONE `package-ecosystem: "cargo"` entry in dependabot.yml.
#
# Read positionally rather than with a YAML parser: this repository has no YAML dependency for
# shell, and the file is ours. The block is entered on the ecosystem line and left on the next key
# at the same indent. An empty result is a BROKEN PARSE, never "no cargo directories" - callers
# must treat it as an error, which is the whole reason this prints nothing rather than guessing.
declared_cargo_dirs() {
  awk '
    /^  - package-ecosystem:/ { inside = ($0 ~ /"cargo"/); inlist = 0; next }
    !inside { next }
    /^    directories:/ { inlist = 1; next }
    /^    [a-z]/ { inlist = 0 }
    inlist && /^      - "/ {
      line = $0
      sub(/^      - "/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      print line
    }
  ' "$1"
}

# links_in_graph <repo root> <absolute start dir>
#
# Prints the repo-relative manifest paths, reachable from that directory by `path = ` dependencies,
# that declare `links`. Breadth-first with a seen-set, so a dependency cycle terminates.
links_in_graph() {
  local root="$1" queue="$2" seen="" cur manifest dep
  while [ -n "$queue" ]; do
    cur="$(printf '%s\n' "$queue" | head -1)"
    queue="$(printf '%s\n' "$queue" | tail -n +2)"
    case "$seen" in *"[$cur]"*) continue ;; esac
    seen="${seen}[$cur]"
    manifest="$cur/Cargo.toml"
    [ -f "$manifest" ] || continue
    if grep -qE '^[[:space:]]*links[[:space:]]*=' "$manifest"; then
      printf '%s\n' "${manifest#"$root"/}"
    fi
    # Path dependencies, relative to the manifest's own directory, as cargo resolves them. The
    # `.rs$` filter drops `path = "src/main.rs"` style target paths, which are not dependencies.
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      queue="$(printf '%s\n%s' "$queue" "$(cd "$cur" && cd "$dep" 2>/dev/null && pwd)")"
    done <<<"$(grep -oE 'path[[:space:]]*=[[:space:]]*"[^"]+"' "$manifest" |
      sed -E 's/.*"([^"]+)"/\1/' | grep -v '\.rs$' | sort -u)"
  done
}

# blocked_cargo_dirs <repo root> <dependabot.yml>
#
# Prints the DECLARED directories whose graph reaches a `links` manifest - i.e. the ones Dependabot
# will never open a pull request for. Sorted, one per line, empty if none.
blocked_cargo_dirs() {
  local root="$1" config="$2" d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -n "$(links_in_graph "$root" "$root$d")" ]; then
      printf '%s\n' "$d"
    fi
  done <<<"$(declared_cargo_dirs "$config")" | sort
}
