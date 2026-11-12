#!/usr/bin/env bash
#
# A VENDORED FORK IS A DEPENDENCY NOTHING ELSE WATCHES, SO THIS IS ITS WATCH.
#
# `frontend/src-tauri` replaces a crates.io package with a local copy under `patches/` through
# `[patch.crates-io]` and pins the exact version that copy was taken from (`= "=X.Y.Z"`). From that
# moment no mechanism here reports an upstream release: Dependabot does not reach `src-tauri` (the
# `links` blockage, docs/wiki/cicd.md), `cargo-blocked-update-report.sh` asks `cargo update`, which
# cannot move an `=` pin, and whether `cargo audit` matches advisories against a PATH package was
# never verified. So an upstream fix - security included - would reach nobody, silently.
#
# WHAT IS COMPARED WITH WHAT. For each crate on the allowlist below: the version the fork was taken
# from (the `[package]` version of `patches/<crate>/Cargo.toml`, which must equal the `=` pin in
# `frontend/src-tauri/Cargo.toml`) against crates.io. A fork of a STABLE release is compared with
# `max_stable_version` only: `tauri-plugin-websocket` has a `3.0.0-alpha` line on crates.io the day
# this was written, and a fork of a stable release owes no rebase to an alpha. A fork of a
# PRE-release (`tauri-plugin-keystore`, taken from `2.1.0-alpha.1`, a crate with no stable release
# at all) is compared with `max_version`, upstream's newest release of ANY kind, in semver
# precedence: the next alpha is exactly what such a fork owes a look at (lead decision, 2026-11-11,
# reversible - docs/wiki/cicd.md).
#
# AN ALLOWLIST, NOT A DERIVATION, and every entry is asserted against the tree: a crate listed here
# that is no longer patched fails (the entry is stale - delete it), so the list cannot rot into a
# watch over nothing. The other `[patch.crates-io]` entries are not on it because the backlog row
# that asked for this named one crate; adding one is adding a line. `wry` joined on 2026-11-03: it
# is not a direct dependency, so its `=` pin in `[dependencies]` exists ONLY to hold the fork in
# place (a newer registry release would otherwise out-resolve the path patch and drop it silently).
# `tauri-plugin-system-components` joined on 2026-11-11 (its `=0.1.8` pin sits in the iOS target
# table), and `tauri-plugin-keystore` the same day, under the pre-release rule above: every
# `[patch.crates-io]` entry is watched.
#
# HOW IT REPORTS. `gh run list` shows 1 and 75 alike - both are an ordinary failed run - so what
# tells them apart is the `::error` annotation TITLE, legible in the run summary without opening the
# log. The exit code is the same distinction for a caller or a test:
#   0   every watched fork is on upstream's latest stable release.
#   1   a FINDING (upstream released past the fork, or yanked what the fork was taken from), or this
#       reporter is broken (a stale allowlist entry, a pin and a fork that disagree, a response whose
#       shape changed). Each is an `::error title=...::` naming what to do.
#   75  crates.io did not answer (EX_TEMPFAIL, the convention `deploy-environment.sh` set): nothing
#       was compared, which is neither a finding nor a pass. A finding elsewhere in the same run
#       wins, so a flaky registry cannot hide one.
#
# Usage: .github/scripts/vendored-upstream-report.sh
# Env:   REPO_ROOT, CURL, CRATES_IO_API, VENDORED_WATCHED - overridden by the self-test only.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
CURL="${CURL:-curl}"
CRATES_IO_API="${CRATES_IO_API:-https://crates.io/api/v1/crates}"
TAURI_DIR="$REPO_ROOT/frontend/src-tauri"
MANIFEST="$TAURI_DIR/Cargo.toml"

# THE ALLOWLIST. One crate per line; each must be a `[patch.crates-io]` entry of `$MANIFEST` whose
# path is `patches/<crate>`. The self-test narrows it to the one crate its fixture trees carry.
readonly WATCHED="${VENDORED_WATCHED:-tauri-plugin-websocket
wry
tauri-plugin-system-components
tauri-plugin-keystore}"

# crates.io refuses an anonymous client (its crawler policy asks for a contact in the User-Agent).
readonly USER_AGENT='canari-ci vendored-upstream-report (https://github.com/emse-students/canari)'

findings=0
unreachable=0

# The response BODY goes to a file, never to stdout: with `--retry`, curl re-sends a failed
# attempt's body to stdout before the successful one's, while `-w` prints only the final status, so
# a 503 then a 200 captured from stdout reads as junk-then-JSON and fails jq - a false "broken
# reporter". `-o` truncates the file before each retry, so it holds exactly the final answer.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

# report <title> <message> - one finding or one broken premise. Never exits: every crate is judged.
report() {
  printf '::error title=%s::%s\n' "$1" "$2"
  findings=$((findings + 1))
}

# package_version <manifest> - the `version` of its `[package]` table, and nothing below it.
package_version() {
  awk '
    /^\[/ { in_pkg = ($0 == "[package]"); next }
    in_pkg && /^version[[:space:]]*=/ { gsub(/^version[[:space:]]*=[[:space:]]*"|".*$/, ""); print; exit }
  ' "$1"
}

# is_stable_semver <v> - plain X.Y.Z.
is_stable_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# is_semver <v> - X.Y.Z with an optional pre-release (`-alpha.1`); build metadata is not read.
is_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; }

# prerelease_cmp <a> <b> - prints -1, 0 or 1 for two pre-release strings (`alpha.1`), by semver's
# rule: identifier by identifier, numbers numerically and below any text, text in ASCII order, and
# a list that is a prefix of the other is lower.
prerelease_cmp() {
  local -a a b
  local i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for ((i = 0; i < ${#a[@]} && i < ${#b[@]}; i++)); do
    x="${a[i]}"
    y="${b[i]}"
    [ "$x" = "$y" ] && continue
    if [[ "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
      if ((10#$x < 10#$y)); then echo -1; else echo 1; fi
    elif [[ "$x" =~ ^[0-9]+$ ]]; then
      echo -1
    elif [[ "$y" =~ ^[0-9]+$ ]]; then
      echo 1
    elif [[ "$x" < "$y" ]]; then
      echo -1
    else
      echo 1
    fi
    return
  done
  if ((${#a[@]} < ${#b[@]})); then
    echo -1
  elif ((${#a[@]} > ${#b[@]})); then
    echo 1
  else
    echo 0
  fi
}

# version_cmp <a> <b> - prints -1, 0 or 1 in semver precedence; both pass `is_semver`. A release
# ranks above every pre-release of the same X.Y.Z.
version_cmp() {
  local core_a="${1%%-*}" core_b="${2%%-*}" pre_a="" pre_b="" c
  [ "$1" != "$core_a" ] && pre_a="${1#*-}"
  [ "$2" != "$core_b" ] && pre_b="${2#*-}"
  c="$(semver_cmp "$core_a" "$core_b")"
  if [ "$c" != 0 ]; then
    echo "$c"
  elif [ -z "$pre_a" ] && [ -z "$pre_b" ]; then
    echo 0
  elif [ -z "$pre_a" ]; then
    echo 1
  elif [ -z "$pre_b" ]; then
    echo -1
  else
    prerelease_cmp "$pre_a" "$pre_b"
  fi
}

# semver_cmp <a> <b> - prints -1, 0 or 1. Both must be plain X.Y.Z.
semver_cmp() {
  local -a a b
  local i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((10#${a[i]} < 10#${b[i]})); then
      echo -1
      return
    fi
    if ((10#${a[i]} > 10#${b[i]})); then
      echo 1
      return
    fi
  done
  echo 0
}

[ -f "$MANIFEST" ] || {
  echo "::error title=Vendored-fork watch is broken::$MANIFEST is not in the tree, so no fork can be read."
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "::error title=Vendored-fork watch is broken::jq is not on PATH, so no answer from crates.io can be read. An unrun check is not a clean one."
  exit 1
}

while IFS= read -r crate; do
  [ -n "$crate" ] || continue
  fork_dir="patches/$crate"

  # --- 1. the premise: the crate is still vendored, and the pin names the fork's version ----------
  if ! grep -qE "^${crate}[[:space:]]*=[[:space:]]*\{[[:space:]]*path[[:space:]]*=[[:space:]]*\"${fork_dir}\"" "$MANIFEST"; then
    report 'Stale vendored-fork allowlist entry' \
      "$crate is on the allowlist of vendored-upstream-report.sh but frontend/src-tauri/Cargo.toml no longer patches it from $fork_dir. If the fork is gone, delete the entry; if it moved, fix the entry."
    continue
  fi
  vendored="$(package_version "$TAURI_DIR/$fork_dir/Cargo.toml" 2>/dev/null || true)"
  if [ -z "$vendored" ]; then
    report 'Vendored-fork watch is broken' "$fork_dir/Cargo.toml carries no [package] version, so there is nothing to compare upstream with."
    continue
  fi
  pin="$(grep -E "^${crate}[[:space:]]*=[[:space:]]*\"=" "$MANIFEST" | sed -n 1p | sed -E 's/^[^"]*"=([^"]*)".*/\1/')"
  if [ "$pin" != "$vendored" ]; then
    report 'Vendored fork and its pin disagree' \
      "frontend/src-tauri/Cargo.toml pins $crate to '=${pin:-<no exact pin>}' but $fork_dir is version $vendored. A patch whose version does not match the requirement is not applied, so the app builds against crates.io's copy without the CANARI PATCH hunks."
    continue
  fi
  # Which of upstream's releases this fork is compared with: a stable fork, the stable ones only; a
  # fork of a pre-release, every release.
  if is_stable_semver "$vendored"; then
    upstream_field=max_stable_version
  elif is_semver "$vendored"; then
    upstream_field=max_version
  else
    report 'Vendored-fork watch is broken' "$crate's fork is $vendored, neither X.Y.Z nor X.Y.Z-<pre-release>: this report has no rule for that shape."
    continue
  fi

  # --- 2. what upstream has released ---------------------------------------------------------------
  # Transient failures (transport, 408/429/5xx) are re-attempted a bounded number of times by curl
  # itself; a 404 is an answer and is not.
  # curl's own error line (`-sS`) goes to stderr, straight into the job log; stdout is the status.
  if ! status="$("$CURL" -sS --max-time 30 --retry 3 --retry-delay 5 --retry-all-errors \
    -A "$USER_AGENT" -H 'Accept: application/json' -o "$BODY_FILE" -w '%{http_code}' \
    "$CRATES_IO_API/$crate")"; then
    echo "crates.io did not answer for $crate (transport failure after retries) - nothing was compared."
    unreachable=$((unreachable + 1))
    continue
  fi
  body="$(cat "$BODY_FILE")"
  case "$status" in
    200) ;;
    404)
      report 'Vendored-fork watch is broken' "crates.io has no crate named $crate (404). The allowlist entry is wrong, or the crate was renamed upstream - either way this fork is unwatched."
      continue
      ;;
    408 | 429 | 5??)
      echo "crates.io answered $status for $crate after retries - unavailable, not an answer; nothing was compared."
      unreachable=$((unreachable + 1))
      continue
      ;;
    *)
      report 'Vendored-fork watch is broken' "crates.io answered HTTP ${status:-<none>} for $crate. That is not a version, and reading it as 'nothing newer' would be the silence this report exists to end."
      continue
      ;;
  esac
  latest="$(printf '%s' "$body" | jq -r --arg f "$upstream_field" '.crate[$f] // empty' 2>/dev/null || true)"
  if ! is_semver "$latest" || { [ "$upstream_field" = max_stable_version ] && ! is_stable_semver "$latest"; }; then
    report 'Vendored-fork watch is broken' "crates.io's answer for $crate carries no usable crate.$upstream_field ('${latest}'). The response shape changed; fix this reader rather than believing the silence."
    continue
  fi

  # --- 3. the verdict ------------------------------------------------------------------------------
  hunks="$(grep -rIo 'CANARI PATCH' "$TAURI_DIR/$fork_dir" 2>/dev/null | wc -l | tr -d ' ')"
  case "$(version_cmp "$latest" "$vendored")" in
    0)
      echo "ok: $crate - the fork in $fork_dir is $vendored, upstream's latest ${upstream_field/max_stable_version/stable} release."
      ;;
    1)
      report "Upstream $crate released past the vendored fork" \
        "crates.io has $crate $latest; frontend/src-tauri/$fork_dir is a fork of $vendored, so whatever $latest fixes (security included) reaches nobody. The rebase it asks for: take the published $latest crate into $fork_dir, re-apply the $hunks CANARI PATCH hunk(s), move the '=$vendored' pin in frontend/src-tauri/Cargo.toml to '=$latest', and let CI build the Android artefact. This run stays red until then."
      ;;
    -1)
      report "Upstream withdrew the release $crate was forked from" \
        "crates.io's latest ${upstream_field/max_stable_version/stable} $crate is $latest, OLDER than the $vendored that $fork_dir was taken from - $vendored was yanked. Read upstream's reason before the next release: a yank is usually a defect, and the fork carries it."
      ;;
  esac
done <<<"$WATCHED"

if [ "$findings" -gt 0 ]; then
  exit 1
fi
if [ "$unreachable" -gt 0 ]; then
  printf '::error title=crates.io unreachable - not a finding::%s watched crate(s) could not be compared because crates.io did not answer. Nothing was judged; re-run the job once it answers.\n' "$unreachable"
  exit 75
fi
exit 0
