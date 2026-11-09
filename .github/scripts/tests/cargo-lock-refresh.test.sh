#!/usr/bin/env bash
#
# Self-tests for `cargo-lock-refresh.sh` - the completing half of the Rust-lock auto-merge
# (WP-RUST-LOCK-AUTOMERGE, decided 2026-10-18).
#
# WHAT THESE PIN, and it is the REFUSALS more than the happy path, because the pull request this
# script opens is ARMED for an unattended merge:
#   - who a commit belongs to is GitHub's answer (login by address, committer, signature verdict),
#     so a lookalike `dependabot[bot]` name, an unsigned commit and the real #296 shape (a
#     `github-actions[bot]` merge commit on a Dependabot branch) are all refused;
#   - a non-dependency file, a Tauri-runtime crate (named, or moved by the refresh), a breaking
#     update, a dependency the ceiling has no gate for, a hostile trailer, a failing cargo, a lock
#     still stale, a conflict onto main: each refused, REPORTED, and nothing opened;
#   - running twice opens ONE pull request, and a run that died half-way converges on the next one -
#     from durable state (the pull requests and the branch), never from a clock;
#   - a refusal lands in ONE issue (created, then updated, then closed) and ONE comment;
#   - an unreadable `gh` or a cargo that cannot answer is a RED run, never "nothing to do".
#
# A REAL git (a bare remote serving `refs/pull/<n>/head`, and a clone) with a FAKE cargo and a
# STATEFUL fake gh: pull requests and issues live in JSON files, every `--jq` the script passes is
# run by the real jq over them, and the commit list is generated from the bare remote the way GitHub
# answers it (a login is resolved from the address; only `web-flow` commits carry a signature).
#
# Usage: .github/scripts/tests/cargo-lock-refresh.test.sh   (no arguments, no network)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../cargo-lock-refresh.sh"
real_ceiling="$here/../lib/ceiling.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

command -v jq >/dev/null 2>&1 || {
  echo "FAIL jq is required by cargo-lock-refresh.sh and by this test"
  exit 1
}

failures=0
passes=0
bin="$work/bin"
mkdir -p "$bin"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

readonly DEPENDABOT='dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>'
readonly APP_NAME='canari-auto-merge[bot]'
readonly APP_EMAIL='323531864+canari-auto-merge[bot]@users.noreply.github.com'
readonly BRANCH='deps/lock-refresh/cargo/dependabot-12'

# ── the fakes ─────────────────────────────────────────────────────────────────────────────────────
# A lock is "satisfied" when serde sits at 1.0.5. `update` moves 1.0.0 -> 1.0.5 and can be told to
# fail, to do nothing, or to drag `tauri` along.
cat >"$bin/cargo" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_CARGO_LOG"
case "$1" in
  metadata)
    [ "${FAKE_METADATA_BROKEN:-}" = 1 ] && { echo "error: failed to load manifest" >&2; exit 101; }
    grep -q 'version = "1.0.5"' Cargo.lock && exit 0
    echo "error: the lock file needs to be updated but --locked was passed to prevent this" >&2
    exit 101
    ;;
  update)
    [ "${FAKE_UPDATE_FAIL:-}" = 1 ] && { echo "error: no matching package" >&2; exit 101; }
    [ "${FAKE_UPDATE_NOOP:-}" = 1 ] && exit 0
    sed -i 's/version = "1.0.0"/version = "1.0.5"/' Cargo.lock
    [ "${FAKE_MOVE_TAURI:-}" = 1 ] && sed -i '/^name = "tauri"$/{n;s/.*/version = "2.99.0"/}' Cargo.lock
    case "${FAKE_GIT_SOURCE:-}" in
      1) printf '\n[[package]]\nname = "evil"\nversion = "0.1.0"\nsource = "git+https://example.invalid/evil#abc"\n' >>Cargo.lock ;;
      tight) printf '\n[[package]]\nname = "evil"\nversion = "0.1.0"\nsource="git+https://example.invalid/evil#abc"\n' >>Cargo.lock ;;
      quoted) printf '\n[[package]]\nname = "evil"\nversion = "0.1.0"\n  "source" = "git+https://example.invalid/evil#abc"\n' >>Cargo.lock ;;
    esac
    case "${FAKE_CRATES_SOURCE:-}" in
      1) printf '\n[[package]]\nname = "itoa"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' >>Cargo.lock ;;
      sparse) printf '\n[[package]]\nname = "itoa"\nversion = "1.0.0"\nsource = "sparse+https://index.crates.io/"\n' >>Cargo.lock ;;
    esac
    [ "${FAKE_ADD_RUNTIME_TIGHT:-}" = 1 ] && printf '\n[[package]]\nname="wry"\nversion="0.50.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' >>Cargo.lock
    exit 0
    ;;
esac
SH

cat >"$bin/gh" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\t%s\n' "${GH_TOKEN:-}" "$*" >>"$FAKE_GH_LOG"
[ "${FAKE_GH_REFUSE:-}" = 1 ] && { echo "HTTP 403" >&2; exit 1; }
S="$FAKE_STATE"
c1="$1"
c2="${2:-}"
shift 2
pos=()
declare -A o=()
while [ $# -gt 0 ]; do
  case "$1" in
    --*) o[$1]="${2:-}"; shift 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
out() { if [ -n "${o[--jq]:-}" ]; then jq -r "${o[--jq]}"; else cat; fi; }
upd() { # <file> <jq args...>
  local f="$S/$1"
  shift
  jq "$@" "$f" >"$S/tmp" && mv "$S/tmp" "$f"
}
login_of() { # GitHub resolves a login from a noreply address, and from nothing else here
  case "$1" in
    noreply@github.com) echo web-flow ;;
    *+*@users.noreply.github.com) local l="${1#*+}"; echo "${l%@users.noreply.github.com}" ;;
    *) echo null ;;
  esac
}
case "$c1 $c2" in
  "pr list")
    # The shape `gh` answers with: a bot author is `app/<slug>`, a fork pull request is
    # cross-repository, and `createdAt` orders them (derived from the number, which only grows).
    view='{number, state, headRefName, isCrossRepository: (.cross // false),
           createdAt: ("2026-10-19T" + ((100000 + .number) | tostring)),
           author: {login: (if (.author | endswith("[bot]")) then "app/" + (.author | rtrimstr("[bot]")) else .author end)}}'
    if [ -n "${o[--head]:-}" ]; then
      jq --arg h "${o[--head]}" "[.[] | select(.headRefName == \$h) | $view]" "$S/prs.json" | out
    else
      jq "[.[] | select(.state == \"OPEN\" and .author == \"dependabot[bot]\") | $view]" "$S/prs.json" | out
    fi
    ;;
  "pr view")
    jq --argjson n "${pos[0]}" '.[] | select(.number == $n) | {title, comments}' "$S/prs.json" | out
    ;;
  "pr comment")
    upd prs.json --argjson n "${pos[0]}" --arg b "${o[--body]}" 'map(if .number == $n then .comments += [{body: $b}] else . end)'
    ;;
  "pr close")
    if [ -f "$S/close-fails" ]; then rm -f "$S/close-fails"; echo "HTTP 502" >&2; exit 1; fi
    upd prs.json --argjson n "${pos[0]}" --arg b "${o[--comment]:-}" 'map(if .number == $n then .state = "CLOSED" | .comments += [{body: $b}] else . end)'
    ;;
  "pr create")
    if [ -f "$S/create-fails" ]; then rm -f "$S/create-fails"; echo "HTTP 502" >&2; exit 1; fi
    n=$((90 + $(jq '[.[] | select(.author == "canari-auto-merge[bot]")] | length' "$S/prs.json")))
    upd prs.json --argjson n "$n" --arg h "${o[--head]}" --arg t "${o[--title]}" --arg b "${o[--body]}" \
      '. += [{number: $n, headRefName: $h, state: "OPEN", author: "canari-auto-merge[bot]", title: $t, body: $b, comments: []}]'
    echo "https://github.com/o/r/pull/$n"
    ;;
  "issue list")
    jq '[.[] | select(.state == "OPEN") | {number, title}]' "$S/issues.json" | out
    ;;
  "issue create")
    n=$((500 + $(jq length "$S/issues.json")))
    upd issues.json --argjson n "$n" --arg t "${o[--title]}" --arg b "${o[--body]}" '. += [{number: $n, title: $t, body: $b, state: "OPEN"}]'
    ;;
  "issue edit")
    upd issues.json --argjson n "${pos[0]}" --arg b "${o[--body]}" 'map(if .number == $n then .body = $b else . end)'
    ;;
  "issue close")
    upd issues.json --argjson n "${pos[0]}" 'map(if .number == $n then .state = "CLOSED" else . end)'
    ;;
  api*)
    [ "${FAKE_COMMITS_FAIL:-}" = 1 ] && { echo "HTTP 500" >&2; exit 1; }
    n="${c2#repos/o/r/pulls/}"
    n="${n%%/*}"
    head="refs/pull/$n/head"
    base="$(git -C "$FAKE_REMOTE" merge-base refs/heads/main "$head")"
    list='[]'
    for sha in $(git -C "$FAKE_REMOTE" rev-list --reverse "$base..$head"); do
      ae="$(git -C "$FAKE_REMOTE" log -1 --format=%ae "$sha")"
      ce="$(git -C "$FAKE_REMOTE" log -1 --format=%ce "$sha")"
      al="$(login_of "$ae")"
      cl="$(login_of "$ce")"
      verified=false
      [ "$cl" = web-flow ] && verified="${FAKE_VERIFIED:-true}"
      list="$(jq --arg s "$sha" --arg ae "$ae" --arg al "$al" --arg cl "$cl" --argjson v "$verified" \
        --arg m "$(git -C "$FAKE_REMOTE" log -1 --format=%B "$sha")" \
        '. += [{sha: $s, author: (if $al == "null" then null else {login: $al} end),
                committer: (if $cl == "null" then null else {login: $cl} end),
                commit: {message: $m, author: {email: $ae}, verification: {verified: $v}}}]' <<<"$list")"
    done
    printf '%s' "$list" | out
    ;;
  *)
    echo "fake gh: unhandled $c1 $c2" >&2
    exit 1
    ;;
esac
SH
chmod +x "$bin/cargo" "$bin/gh"

# A ceiling that refuses serde: the REAL library, with one entry added, so the parser and the
# breaking predicate the script also reads from it stay the real ones.
cat >"$work/ceiling-refuses.sh" <<SH
# shellcheck source=/dev/null
. "$real_ceiling"
gate_for_dependency() { [ "\$1" = serde ] && echo "a test that does not exist"; return 0; }
SH

LOCK_STALE='[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "tauri"
version = "2.11.1"
'
LOCK_FRESH="${LOCK_STALE/1.0.0/1.0.5}"

# make_world: a remote whose `main` has two stale-able locks, and Dependabot's pull request #12.
# Knobs (environment): W_AUTHOR (the commit's author), W_COMMITTER, W_EXTRA (a non-dependency file),
# W_PRLOCK (lock content on the head, or `-`), W_NAME / W_TYPE / W_VERSION (the trailer), W_TITLE,
# W_MERGE_COMMIT (append the real #296 shape: a github-actions merge commit), W_CONFLICT (move main).
make_world() {
  rm -rf "$work/remote.git" "$work/clone" "$work/state"
  mkdir -p "$work/state"
  : >"$work/gh.log"
  : >"$work/cargo.log"
  git init -q --bare "$work/remote.git"
  git init -q -b main "$work/clone"
  (
    cd "$work/clone" || exit 1
    g() { git -c user.name=t -c user.email=t@t "$@"; }
    git remote add origin "$work/remote.git"
    mkdir -p .github frontend/mls-core frontend/mls-wasm frontend/src-tauri
    cat >.github/dependabot.yml <<'YML'
version: 2
updates:
  - package-ecosystem: "cargo"
    directories:
      - "/frontend/mls-core"
      - "/frontend/mls-wasm"
      - "/frontend/src-tauri"
    schedule:
      interval: "weekly"
YML
    printf '[package]\nname = "core"\n[dependencies]\nserde = "1.0.0"\n' >frontend/mls-core/Cargo.toml
    printf '[package]\nname = "wasm"\n' >frontend/mls-wasm/Cargo.toml
    printf '[package]\nname = "app"\n' >frontend/src-tauri/Cargo.toml
    printf '%s' "$LOCK_STALE" >frontend/mls-wasm/Cargo.lock
    printf '%s' "$LOCK_STALE" >frontend/src-tauri/Cargo.lock
    g add -A && g commit -q -m base && git push -q origin main
    git checkout -q -b dependabot/cargo/frontend/mls-core/serde-1.0.5
    sed -i 's/serde = "1.0.0"/serde = "1.0.5"/' frontend/mls-core/Cargo.toml
    if [ "${W_PRLOCK:--}" != "-" ]; then
      printf '%s' "$W_PRLOCK" >frontend/mls-wasm/Cargo.lock
      printf '%s' "$W_PRLOCK" >frontend/src-tauri/Cargo.lock
    fi
    [ -n "${W_EXTRA:-}" ] && echo x >"$W_EXTRA"
    git add -A
    local_author="${W_AUTHOR:-$DEPENDABOT}"
    GIT_AUTHOR_NAME="${local_author% <*}" GIT_AUTHOR_EMAIL="$(sed 's/.*<//; s/>$//' <<<"$local_author")" \
      GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL="${W_COMMITTER:-noreply@github.com}" \
      git commit -q -F - <<MSG
chore(deps): bump ${W_NAME:-serde} in /frontend/mls-core

---
updated-dependencies:
- dependency-name: ${W_NAME:-serde}
  dependency-version: ${W_VERSION:-1.0.5}
  dependency-type: direct:production
  update-type: version-update:semver-${W_TYPE:-patch}
...

Signed-off-by: dependabot[bot] <support@github.com>
MSG
    if [ -n "${W_MERGE_COMMIT:-}" ]; then
      GIT_AUTHOR_NAME='github-actions[bot]' GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
        GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com \
        git commit -q --allow-empty -m "Merge branch 'main' into dependabot/cargo/frontend/mls-core/serde-1.0.5"
    fi
    git push -q origin HEAD HEAD:refs/pull/12/head
    git checkout -q main
    if [ -n "${W_CONFLICT:-}" ]; then
      sed -i 's/serde = "1.0.0"/serde = "1.0.3"/' frontend/mls-core/Cargo.toml
      g commit -q -am "main moves the same line" && git push -q origin main
    fi
    git fetch -q origin
  )
  jq -n --arg t "${W_TITLE:-chore(deps): bump serde from 1.0.0 to 1.0.5 in /frontend/mls-core}" \
    '[{number: 12, headRefName: "dependabot/cargo/frontend/mls-core/serde-1.0.5", state: "OPEN", author: "dependabot[bot]", title: $t, comments: []}]' \
    >"$work/state/prs.json"
  echo '[]' >"$work/state/issues.json"
}

run() {
  (
    cd "$work/clone" || exit 1
    PATH="$bin:$PATH" REPO_ROOT="$work/clone" REPO=o/r GH_TOKEN=app-token REPORT_TOKEN=report-token \
      COMMIT_NAME="$APP_NAME" COMMIT_EMAIL="$APP_EMAIL" \
      FAKE_GH_LOG="$work/gh.log" FAKE_CARGO_LOG="$work/cargo.log" FAKE_STATE="$work/state" FAKE_REMOTE="$work/remote.git" \
      bash "$script" 2>&1
  )
}

pass() {
  echo "ok   $1"
  passes=$((passes + 1))
}
fail() {
  echo "FAIL $1"
  shift
  [ $# -gt 0 ] && printf '%s\n' "$*" | sed 's/^/     /'
  failures=$((failures + 1))
}

pr_state() { jq -r --argjson n "$1" '.[] | select(.number == $n) | .state' "$work/state/prs.json"; }
app_prs() { jq '[.[] | select(.author == "canari-auto-merge[bot]")] | length' "$work/state/prs.json"; }
comments_on_12() { jq '[.[] | select(.number == 12) | .comments[] | select(.body | contains("cargo-lock-refresh:refused"))] | length' "$work/state/prs.json"; }
open_issues() { jq '[.[] | select(.state == "OPEN")] | length' "$work/state/issues.json"; }
branch_pushed() { git -C "$work/remote.git" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null; }
on_branch() { git -C "$work/remote.git" "$@"; }

# ── A1-A4: the happy path ─────────────────────────────────────────────────────────────────────────
make_world
out="$(run)"
st=$?
if [ "$st" = 0 ] && branch_pushed && [ "$(app_prs)" = 1 ] && [ "$(pr_state 90)" = OPEN ]; then
  pass "A1 stale locks: the branch is pushed and ONE pull request opens, as the App, from $BRANCH"
else
  fail "A1 stale locks: expected a push and one App pull request (exit $st)" "$out"
fi
if [ "$(on_branch merge-base main "refs/heads/$BRANCH")" = "$(on_branch rev-parse main)" ] &&
  [ "$(on_branch log -1 --format='%an <%ae>' "refs/heads/$BRANCH~1")" = "$DEPENDABOT" ] &&
  on_branch log -1 --format=%B "refs/heads/$BRANCH~1" | grep '^- dependency-name: serde$' >/dev/null; then
  pass "A2 the branch starts at main and carries Dependabot's commit, author and trailer intact"
else
  fail "A2 Dependabot's commit was not carried intact" "$(on_branch log --format='%H %an <%ae> | %cn <%ce>' "main..refs/heads/$BRANCH")"
fi
last_files="$(on_branch show --name-only --format= "refs/heads/$BRANCH")"
if [ "$(on_branch log -1 --format='%an <%ae>|%cn <%ce>' "refs/heads/$BRANCH")" = "$APP_NAME <$APP_EMAIL>|$APP_NAME <$APP_EMAIL>" ] &&
  ! grep -qvE '(^|/)Cargo\.lock$' <<<"$last_files" &&
  on_branch show "refs/heads/$BRANCH:frontend/mls-wasm/Cargo.lock" | grep 'version = "1.0.5"' >/dev/null &&
  on_branch show "refs/heads/$BRANCH:frontend/src-tauri/Cargo.lock" | grep 'version = "1.0.5"' >/dev/null; then
  pass "A3 the App's one commit touches only the two lockfiles, and both now satisfy their manifests"
else
  fail "A3 the App's commit is not a lockfile-only refresh" "$last_files"
fi
if [ "$(pr_state 12)" = CLOSED ] && jq -e '.[] | select(.number == 12) | .comments[-1].body | contains("#90")' "$work/state/prs.json" >/dev/null; then
  pass "A4 the original is closed with a pointer to the new pull request"
else
  fail "A4 the original was not closed with a pointer" "$(cat "$work/state/prs.json")"
fi

# ── A5-A8: idempotence, from durable state ────────────────────────────────────────────────────────
out="$(run)"
st=$?
if [ "$st" = 0 ] && [ "$(app_prs)" = 1 ]; then
  pass "A5 a second run opens nothing: still ONE pull request"
else
  fail "A5 the second run opened another pull request (exit $st, $(app_prs) App pull requests)" "$out"
fi

make_world
touch "$work/state/create-fails"
out1="$(run)"
st1=$?
out2="$(run)"
st2=$?
if [ "$st1" = 1 ] && [ "$st2" = 0 ] && [ "$(app_prs)" = 1 ] && [ "$(pr_state 12)" = CLOSED ]; then
  pass "A6 a run that died after its push and before its pull request is RED, and the next run converges on one"
else
  fail "A6 the half-done run did not converge (exits $st1/$st2, $(app_prs) App pull requests)" "$out1" "$out2"
fi

make_world
touch "$work/state/close-fails"
out1="$(run)"
st1=$?
out2="$(run)"
st2=$?
if [ "$st1" = 1 ] && [ "$st2" = 0 ] && [ "$(app_prs)" = 1 ] && [ "$(pr_state 12)" = CLOSED ]; then
  pass "A7 a run that died before closing the original is RED, and the next run only closes it"
else
  fail "A7 the half-closed run did not converge (exits $st1/$st2, $(app_prs) App pull requests)" "$out1" "$out2"
fi

make_world
jq '. += [{number: 77, headRefName: "deps/lock-refresh/cargo/dependabot-12", state: "CLOSED", author: "canari-auto-merge[bot]", title: "x", comments: []}]' \
  "$work/state/prs.json" >"$work/state/tmp" && mv "$work/state/tmp" "$work/state/prs.json"
out="$(run)"
st=$?
if [ "$st" = 0 ] && ! branch_pushed && [ "$(app_prs)" = 1 ] && [ "$(pr_state 12)" = OPEN ] && [ "$(open_issues)" = 1 ]; then
  pass "A8 a refresh pull request a person closed is respected (nothing reopened) and REPORTED"
else
  fail "A8 a closed refresh pull request was overridden or not reported (exit $st)" "$out"
fi

# ── A9: what is not this job's ────────────────────────────────────────────────────────────────────
W_PRLOCK="$LOCK_FRESH" make_world
out="$(run)"
st=$?
if [ "$st" = 0 ] && ! branch_pushed && [ "$(pr_state 12)" = OPEN ] && [ "$(comments_on_12)" = 0 ] && [ "$(open_issues)" = 0 ]; then
  pass "A9 a pull request Dependabot completed itself is left to CI, untouched and unreported"
else
  fail "A9 a complete pull request was touched (exit $st)" "$out"
fi

# ── A10-A22: the refusals - nothing pushed, nothing opened, ONE comment, ONE issue ────────────────
refused() { # <id and name> <text the issue must carry>
  local st="$1" name="$2" text="$3" out="$4"
  if [ "$st" = 0 ] && ! branch_pushed && [ "$(app_prs)" = 0 ] && [ "$(pr_state 12)" = OPEN ] &&
    [ "$(comments_on_12)" = 1 ] && [ "$(open_issues)" = 1 ] &&
    jq -e --arg t "$text" '.[0].body | contains($t)' "$work/state/issues.json" >/dev/null; then
    pass "$name"
  else
    fail "$name (exit $st, expected a refusal carrying '$text')" "$out" "$(jq -c . "$work/state/issues.json")"
  fi
}
refusal_case() { # <name> <text> [VAR=value ...] - the VARs shape the world or the fakes
  local name="$1" text="$2" kv out st
  shift 2
  (
    for kv in "$@"; do export "${kv?}"; done
    make_world
  )
  out="$(
    for kv in "$@"; do export "${kv?}"; done
    run
  )"
  st=$?
  refused "$st" "$name" "$text" "$out"
}

refusal_case "A10 a lookalike: the NAME dependabot[bot] at another address is not Dependabot" "not a signed Dependabot commit" \
  'W_AUTHOR=dependabot[bot] <dependabot@lookalike.example>'
refusal_case "A11 a commit GitHub did not sign is not Dependabot's" "not a signed Dependabot commit" FAKE_VERIFIED=false
refusal_case "A12 a Dependabot address committed by someone else (not web-flow) is not Dependabot's" "not a signed Dependabot commit" \
  'W_COMMITTER=12345+someone@users.noreply.github.com'
refusal_case "A13 the real #296 shape - a github-actions merge commit on the branch - is refused" "not a signed Dependabot commit" W_MERGE_COMMIT=1
refusal_case "A14 a file that is not a manifest or a lockfile is refused" "not a \`Cargo.toml\` or a \`Cargo.lock\`" W_EXTRA=frontend/mls-core/build.rs
refusal_case "A15 a crate of the Tauri runtime, named by the trailer, is refused" "Tauri runtime" W_NAME=tauri-plugin-fs
refusal_case "A16 a refresh that MOVES tauri in a lock is refused" "Tauri runtime" FAKE_MOVE_TAURI=1
refusal_case "A17 a semver-major update is refused" "breaking update" W_TYPE=major W_VERSION=2.0.0
refusal_case "A18 a 0.x minor (breaking below 1.0) is refused" "breaking update" W_TYPE=minor W_VERSION=0.9.0
refusal_case "A19 a dependency lib/ceiling.sh has no gate for is refused" "no gate here" "CEILING_LIB=$work/ceiling-refuses.sh"
refusal_case "A20 a failing cargo update is refused" "failed in" FAKE_UPDATE_FAIL=1
refusal_case "A21 a lock still failing --locked after the refresh is refused" "still fails" FAKE_UPDATE_NOOP=1
refusal_case "A22 commits that do not cherry-pick onto main are refused" "do not apply cleanly" W_CONFLICT=1

# A23: hostile trailer values never reach cargo, a regex or a shell.
# shellcheck disable=SC2016 # the dollar sign is the payload, kept literal on purpose
refusal_case "A23 a hostile dependency name is refused before cargo sees it" "not a crate name" 'W_NAME=serde$(touch PWNED)'
if [ ! -e "$work/clone/PWNED" ] && ! grep -q '^update' "$work/cargo.log"; then
  pass "A23b nothing ran: no file was created and cargo was never asked to update"
else
  fail "A23b the hostile name reached a shell or cargo" "$(cat "$work/cargo.log")"
fi
refusal_case "A23c a version that is not a full semver (an option, say) is refused" "not a crate name" 'W_VERSION=--locked'

# A24: a hostile title is passed as one literal argument and executes nothing.
# shellcheck disable=SC2016 # the dollar sign and backticks are the payload
W_TITLE='chore(deps): bump $(touch PWNED2) `touch PWNED3`' make_world
out="$(run)"
st=$?
title="$(jq -r '.[] | select(.number == 90) | .title' "$work/state/prs.json")"
# shellcheck disable=SC2016
if [ "$st" = 0 ] && [ "$title" = 'chore(deps): bump $(touch PWNED2) `touch PWNED3`' ] &&
  [ ! -e "$work/clone/PWNED2" ] && [ ! -e "$work/clone/PWNED3" ]; then
  pass "A24 a hostile title travels as one literal argument and executes nothing"
else
  fail "A24 the hostile title was interpreted (exit $st, title '$title')" "$out"
fi

# ── A30-A35: the review of #2135 - the branch NAME is not ours alone, and a lock names crates.io ──
add_pr() { # <json object> - another pull request in the fake's state
  jq --argjson p "$1" '. += [$p]' "$work/state/prs.json" >"$work/state/tmp" && mv "$work/state/tmp" "$work/state/prs.json"
}

# F1: a FORK pull request named like the refresh must neither close Dependabot's nor suppress it.
make_world
add_pr '{"number": 66, "headRefName": "deps/lock-refresh/cargo/dependabot-12", "state": "OPEN", "author": "mallory", "cross": true, "title": "x", "comments": []}'
out="$(run)"
st=$?
if [ "$st" = 0 ] && [ "$(app_prs)" = 1 ] && [ "$(pr_state 66)" = OPEN ] &&
  jq -e '.[] | select(.number == 12) | (.state == "CLOSED") and (.comments[-1].body | contains("#90")) and (.comments[-1].body | contains("#66") | not)' "$work/state/prs.json" >/dev/null &&
  jq -e '[.[] | select(.state == "OPEN") | .body | contains("66")] | any' "$work/state/issues.json" >/dev/null; then
  pass "A30 a fork pull request on the reserved name is ignored and reported; the original points at the App's own"
else
  fail "A30 a fork pull request on the reserved name decided something (exit $st)" "$out" "$(jq -c . "$work/state/prs.json")"
fi
make_world
add_pr '{"number": 66, "headRefName": "deps/lock-refresh/cargo/dependabot-12", "state": "CLOSED", "author": "mallory", "cross": true, "title": "x", "comments": []}'
out="$(run)"
st=$?
if [ "$st" = 0 ] && [ "$(app_prs)" = 1 ] && [ "$(pr_state 12)" = CLOSED ]; then
  pass "A31 a CLOSED fork pull request on the reserved name does not suppress the refresh"
else
  fail "A31 a closed fork pull request suppressed the refresh (exit $st)" "$out"
fi

# F6: the App's pull request is picked deterministically - the newest - never `.[0]`.
make_world
add_pr '{"number": 70, "headRefName": "deps/lock-refresh/cargo/dependabot-12", "state": "CLOSED", "author": "canari-auto-merge[bot]", "title": "x", "comments": []}'
add_pr '{"number": 71, "headRefName": "deps/lock-refresh/cargo/dependabot-12", "state": "OPEN", "author": "canari-auto-merge[bot]", "title": "x", "comments": []}'
out="$(run)"
st=$?
if [ "$st" = 0 ] && ! branch_pushed && [ "$(pr_state 12)" = CLOSED ] &&
  jq -e '.[] | select(.number == 12) | .comments[-1].body | contains("#71")' "$work/state/prs.json" >/dev/null; then
  pass "A32 of two App pull requests on the name, the NEWEST decides"
else
  fail "A32 the App pull request was not picked by recency (exit $st)" "$out"
fi

# F6: a branch of that name that somebody else wrote is never overwritten.
make_world
(
  cd "$work/clone" || exit 1
  git checkout -q -b squat origin/main
  echo x >squat.txt
  git add squat.txt
  git -c user.name=mallory -c user.email=m@x commit -q -m squat
  git push -q origin "HEAD:refs/heads/$BRANCH"
  git checkout -q main
)
squat="$(on_branch rev-parse "refs/heads/$BRANCH")"
out="$(run)"
st=$?
if [ "$st" = 0 ] && [ "$(on_branch rev-parse "refs/heads/$BRANCH")" = "$squat" ] && [ "$(app_prs)" = 0 ] &&
  [ "$(pr_state 12)" = OPEN ] && [ "$(open_issues)" = 1 ]; then
  pass "A33 a branch of the reserved name the App did not write is left alone, and reported"
else
  fail "A33 somebody else's branch was overwritten or the refusal not reported (exit $st)" "$out"
fi

# F3: a refreshed lock that names anything but crates.io is never pushed; crates.io itself is fine.
refusal_case "A34 a refreshed lock naming a git source is refused before the push" "not crates.io" FAKE_GIT_SOURCE=1
make_world
out="$(FAKE_CRATES_SOURCE=1 run)"
st=$?
if [ "$st" = 0 ] && [ "$(app_prs)" = 1 ]; then
  pass "A35 a refreshed lock naming crates.io is carried"
else
  fail "A35 a crates.io source was refused (exit $st)" "$out"
fi

# The second review: a TOML key is a key whatever its spacing or quoting, and the sparse index is
# crates.io too.
refusal_case "A36 a git source written source=\"...\" is refused" "not crates.io" FAKE_GIT_SOURCE=tight
refusal_case "A36b a git source written with a quoted key is refused" "not crates.io" FAKE_GIT_SOURCE=quoted
refusal_case "A37 a Tauri-runtime crate added as name=\"wry\" is refused" "Tauri runtime" FAKE_ADD_RUNTIME_TIGHT=1
make_world
out="$(FAKE_CRATES_SOURCE=sparse run)"
st=$?
if [ "$st" = 0 ] && [ "$(app_prs)" = 1 ]; then
  pass "A38 a refreshed lock naming the SPARSE crates.io index is carried"
else
  fail "A38 the sparse crates.io index was refused (exit $st)" "$out"
fi

# ── A25-A27: the report - written once, updated, closed ───────────────────────────────────────────
make_world
out1="$(FAKE_MOVE_TAURI=1 run)"
out2="$(FAKE_MOVE_TAURI=1 run)"
st=$?
if [ "$st" = 0 ] && [ "$(comments_on_12)" = 1 ] && [ "$(jq length "$work/state/issues.json")" = 1 ] && [ "$(open_issues)" = 1 ]; then
  pass "A25 a standing refusal is said ONCE on the pull request and kept in ONE issue across runs"
else
  fail "A25 the refusal was repeated or duplicated" "$out1" "$out2" "$(cat "$work/state/issues.json")"
fi
if awk -F'\t' '$2 ~ /^issue / && $1 != "report-token" { bad = 1 } END { exit bad }' "$work/gh.log" &&
  awk -F'\t' '$2 ~ /^pr (create|close|comment)/ && $1 != "app-token" { bad = 1 } END { exit bad }' "$work/gh.log"; then
  pass "A26 the issue is written with the report token, the pull requests with the App's - no token does both"
else
  fail "A26 a write used the wrong token" "$(cat "$work/gh.log")"
fi
# The refusal is lifted (the pull request completed itself): the next run closes the issue.
jq 'map(if .number == 12 then .state = "CLOSED" else . end)' "$work/state/prs.json" >"$work/state/tmp" && mv "$work/state/tmp" "$work/state/prs.json"
out="$(run)"
st=$?
if [ "$st" = 0 ] && [ "$(open_issues)" = 0 ]; then
  pass "A27 once no refusal stands, the issue is closed"
else
  fail "A27 the issue outlived its refusals (exit $st)" "$out"
fi

# ── A28-A29: what must NOT look like health ───────────────────────────────────────────────────────
make_world
out="$(FAKE_GH_REFUSE=1 run)"
st=$?
if [ "$st" = 1 ] && grep -q 'A refusal is not an answer' <<<"$out"; then
  pass "A28 a refused pull-request list is a RED run, not 'nothing to do'"
else
  fail "A28 a refused list read as health (exit $st)" "$out"
fi
make_world
out="$(FAKE_COMMITS_FAIL=1 run)"
st=$?
if [ "$st" = 1 ] && ! branch_pushed && grep -q 'could not be processed' <<<"$out"; then
  pass "A28b an unreadable commit list is a RED run, and nothing is pushed on an unanswered question"
else
  fail "A28b an unreadable commit list was read as permission or as health (exit $st)" "$out"
fi
make_world
out="$(FAKE_METADATA_BROKEN=1 run)"
st=$?
if [ "$st" = 1 ] && ! branch_pushed; then
  pass "A29 a cargo that fails for another reason is a RED run, not a stale lock"
else
  fail "A29 a broken cargo read as a verdict (exit $st)" "$out"
fi
make_world
out="$(cd "$work/clone" && PATH="$bin:$PATH" REPO_ROOT="$work/clone" REPO=o/r COMMIT_NAME=a COMMIT_EMAIL=b \
  FAKE_GH_LOG="$work/gh.log" FAKE_STATE="$work/state" bash "$script" 2>&1)"
st=$?
if [ "$st" = 1 ] && grep -q 'REPORT_TOKEN' <<<"$out"; then
  pass "A29b without a way to report, the run refuses to start"
else
  fail "A29b a run with no report channel was accepted (exit $st)" "$out"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures of $((passes + failures)) cargo-lock-refresh assertion(s) FAILED"
  exit 1
fi
echo "all $passes cargo-lock-refresh assertions passed"
