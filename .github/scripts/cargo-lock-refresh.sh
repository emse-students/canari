#!/usr/bin/env bash
#
# COMPLETE A DEPENDABOT CARGO PULL REQUEST THAT IS INCOMPLETE BY CONSTRUCTION.
#
# THE DEFECT. `frontend/mls-wasm` and `frontend/src-tauri` each commit a `Cargo.lock` and depend on
# `frontend/mls-core` by path, and `mls-core` commits no lock on purpose. So Dependabot's one pull
# request for a bump in `mls-core/Cargo.toml` leaves BOTH committed locks describing the old graph,
# and CI's `cargo metadata --locked` step fails it - the one dependency update that could never
# merge unattended ([cicd](../../docs/wiki/cicd.md#a-dependabot-cargo-bump-that-is-incomplete-by-construction-is-completed-and-merged-wp-rust-lock-automerge-2026-10-18)).
#
# THE DECISION (user, 2026-10-18): complete it by machine, auto-merge the result, and let `CI
# passed` be the only verdict. This script is the completing half; `arm-auto-merge.yml` is the
# arming half, and it re-checks every property below over the API before it arms anything.
#
# WHAT IT DOES, per open Dependabot cargo pull request <n>:
#   1. verifies, over the API, the shape of EVERY commit: author login `dependabot[bot]` with
#      Dependabot's noreply address, committer `web-flow`, and a signature GitHub verified - and that
#      those are exactly the commits git would cherry-pick. WHAT THAT PROVES, AND WHAT IT DOES NOT:
#      `web-flow` + verified proves GITHUB created the commit (Dependabot, the web UI or the API) -
#      not that Dependabot did, because a writer can create a signed commit through the API naming
#      any author. The Dependabot evidence is that the pull request's AUTHOR is `dependabot[bot]`,
#      which nobody can set. So the precondition of this whole mechanism is that WRITE ACCESS IS
#      ALREADY TRUSTED - a writer can open and arm a pull request of their own anyway;
#   2. verifies every changed file is a `Cargo.toml` or a `Cargo.lock`;
#   3. reads the `updated-dependencies` trailers (one parser, `lib/ceiling.sh`) and refuses what an
#      unattended actor must not move (below);
#   4. skips the pull request unless a committed lock no longer satisfies `cargo metadata --locked`;
#   5. builds `deps/lock-refresh/cargo/dependabot-<n>` from `main`: Dependabot's commits cherry-picked
#      (author and trailers kept, so `dependency-ceiling` still reads them on the new pull request),
#      then ONE commit of the App's running `cargo update -p <crate> --precise <version>` in each
#      stale lock - NEVER a push onto Dependabot's branch, which this repository measured as refused
#      ten times out of ten;
#   6. opens the pull request AS THE `canari-auto-merge` APP and closes the original with a pointer.
#
# WHAT IT REFUSES - reported, never silently skipped:
#   - a commit that is not a signed Dependabot commit (a lookalike author name is not Dependabot);
#   - a file that is not a manifest or a lockfile;
#   - a crate of the Tauri runtime (`tauri`, `tauri-*`, `wry`, `tao`), named or moved by the refresh:
#     a runtime bump is a native work package owed a device reading, never an unattended merge;
#   - a BREAKING update (`ceiling_update_is_breaking`: a major, a `0.x` minor, an unclassified type);
#   - a dependency `lib/ceiling.sh` has no gate for;
#   - a trailer whose name or version is not a plain crate name and semver (hostile input);
#   - a `cargo update` that fails, or a lock still failing `cargo metadata --locked` afterwards;
#   - commits that do not cherry-pick onto `main`;
#   - a refresh pull request a PERSON closed unmerged (their answer, kept visible);
#   - a lockfile line naming a source other than crates.io;
#   - a branch of that name that exists with no pull request of ours and a tip the App did not write.
#
# THE BRANCH NAME IS NOT OURS ALONE. A fork can open a pull request whose head is called
# `deps/lock-refresh/cargo/dependabot-<n>`, so durable state is read only from pull requests that
# live in THIS repository AND were opened by the App - newest first; anything else on that name is
# ignored and reported, never taken as "already refreshed" (which would close Dependabot's pull
# request on a stranger's say-so).
#
# HOW IT REPORTS, by meaning, the same split as `cargo-blocked-update-report.sh`: a REFUSAL is work
# for a person, so it goes into ONE issue (exact title, updated, closed when none stands) and ONE
# marked comment on the pull request; a FAILURE (an unreadable API, a cargo that cannot answer, a
# push refused) is this mechanism broken, so the run goes RED - `gh run list` is what is read.
#
# IDEMPOTENCE COMES FROM DURABLE STATE, NEVER FROM A CLOCK: the branch name derives from <n>, so a
# refresh pull request that exists (open, merged or closed) decides everything; a branch pushed by a
# run that died before opening its pull request is overwritten with a lease on the SHA just read;
# the refusal comment carries a marker; the issue is found by its exact title.
#
# EVERY STRING FROM A PULL REQUEST IS HOSTILE. Numbers are matched against `^[0-9]+$`, crate names
# and versions against their grammar before they reach cargo or a regex, the title is stripped to
# printable characters and passed as one argument, the branch Dependabot pushed is never used (the
# head is fetched as `refs/pull/<n>/head`), and nothing is ever `eval`ed.
#
# Usage: .github/scripts/cargo-lock-refresh.sh   (cwd anywhere; a full clone of main, remote `origin`)
# Env:   GH_TOKEN      the App token (push, pull requests)
#        REPORT_TOKEN  the token that writes the report issue (the job's GITHUB_TOKEN, `issues: write`)
#        REPO          default $GITHUB_REPOSITORY
#        COMMIT_NAME, COMMIT_EMAIL   the App's bot identity, so its commits resolve to its login
#        REPO_ROOT, CARGO, GH, CEILING_LIB, BASE_REF - overridden by the self-test only.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$HERE/../.." && pwd)}"
CARGO="${CARGO:-cargo}"
GH="${GH:-gh}"
REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
CONFIG="$REPO_ROOT/.github/dependabot.yml"
BASE_REF="${BASE_REF:-origin/main}"

# The shape of a Dependabot commit, read off the real ones (#296, 2026-08-31): author login and
# address, and the committer GitHub stamps on a commit it creates and signs itself. A name is not an
# identity - anybody can write `dependabot[bot]` into `user.name` - so all four are required. They
# prove "made through GitHub, naming Dependabot"; see the header for what that does not prove.
readonly DEPENDABOT_LOGIN='dependabot[bot]'
readonly DEPENDABOT_EMAIL='49699333+dependabot[bot]@users.noreply.github.com'
readonly SIGNING_COMMITTER='web-flow'
readonly BRANCH_PREFIX='deps/lock-refresh/cargo/dependabot-'
readonly REFUSAL_MARKER='<!-- cargo-lock-refresh:refused -->'
# The report's identity, matched EXACTLY: it must never carry a count, a date or a number.
readonly REPORT_TITLE='Dependabot cargo updates the lockfile refresh refused'

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/cargo-dirs.sh
source "$HERE/lib/cargo-dirs.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/ceiling.sh
source "${CEILING_LIB:-$HERE/lib/ceiling.sh}"

failures=0
refusals=''
notices=''
workdirs=()

die() {
  echo "::error::$1"
  exit 1
}

log() { printf '%s\n' "$*"; }

[ -n "$REPO" ] || die "REPO is unset and GITHUB_REPOSITORY is empty - this job does not know which repository to act on."
[ -f "$CONFIG" ] || die "$CONFIG is not in the tree, so no directory can be derived."
if [ -z "${COMMIT_NAME:-}" ] || [ -z "${COMMIT_EMAIL:-}" ]; then
  die "COMMIT_NAME and COMMIT_EMAIL are required: the commit must be the App's, never an anonymous one."
fi
[ -n "${REPORT_TOKEN:-}" ] || die "REPORT_TOKEN is unset, so a refusal could not be reported - and an unreported refusal is found by hand, a day late."
command -v "$CARGO" >/dev/null 2>&1 || die "\`$CARGO\` is not on PATH, so nothing was checked. An unrun check is not a clean one."
command -v jq >/dev/null 2>&1 || die "jq is not on PATH, so no API answer can be read."
# The App's slug, from its bot name: `gh` names a bot author `app/<slug>`, and that is the one author
# whose pull requests on the refresh branch count as ours.
APP_SLUG="${COMMIT_NAME%\[bot\]}"
if ! [[ "$APP_SLUG" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || [ "$COMMIT_NAME" != "${APP_SLUG}[bot]" ]; then
  die "COMMIT_NAME must be the App's bot name, \`<slug>[bot]\`."
fi

# shellcheck disable=SC2317,SC2329 # invoked only by the EXIT trap, so the body looks unreachable and the definition unused (SC2329 exists from shellcheck 0.11; CI pins 0.10)
cleanup() {
  local w
  for w in "${workdirs[@]:-}"; do
    [ -n "$w" ] || continue
    git -C "$REPO_ROOT" worktree remove --force "$w" >/dev/null 2>&1 || rm -rf "$w"
  done
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- the directories that commit a lock, derived rather than named --------------------------------
lock_dirs="$(
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    [ -f "$REPO_ROOT$d/Cargo.lock" ] && printf '%s\n' "$d"
  done <<<"$(declared_cargo_dirs "$CONFIG")"
)"
[ -n "$lock_dirs" ] || die "no declared cargo directory commits a Cargo.lock - the derivation is broken, or this job has nothing left to do and should be deleted."

# stale_state <worktree> <dir>: prints `ok`, `stale` or `error`. A lock is STALE only when cargo says
# so in so many words; any other failure is an unanswered question and must not read as a verdict.
stale_state() {
  local out
  if out="$(cd "$1$2" && "$CARGO" metadata --locked --format-version 1 2>&1 >/dev/null)"; then
    echo ok
  elif grep -q 'needs to be updated' <<<"$out"; then
    echo stale
  else
    printf '%s\n' "$out" | tail -5 >&2
    echo error
  fi
}

# runtime_packages <Cargo.lock>: `name version` of every Tauri-runtime package, sorted - the unit the
# refresh is compared on before and after.
# A key is read with ANY spacing and bare or quoted (`name="x"`, ` "name" = 'x'`): a check keyed on
# the spelling Cargo writes is one a hand-written lock walks past.
runtime_packages() {
  awk '
    function val(s) { sub(/^[^=]*=[[:space:]]*/, "", s); gsub(/["\047[:space:]]/, "", s); return s }
    /^[[:space:]]*["\047]?name["\047]?[[:space:]]*=/ { n = val($0) }
    /^[[:space:]]*["\047]?version["\047]?[[:space:]]*=/ { v = val($0); if (n != "") { print n, v; n = "" } }
  ' "$1" |
    while read -r name version; do
      if ceiling_is_tauri_runtime_crate "$name"; then printf '%s %s\n' "$name" "$version"; fi
    done | sort
}

# The ONLY sources a lockfile line this job writes may name: crates.io, by git index or sparse
# index. A lock cannot name a source its manifests do not, and the manifests are Dependabot's - so a
# `git+` or any other registry here means the input was not what it claimed, and nothing is pushed.
readonly CRATES_IO_SOURCES='"registry+https://github.com/rust-lang/crates.io-index"
"sparse+https://index.crates.io/"'

# foreign_lock_sources <worktree>: the VALUES of the `source` keys the uncommitted lock change adds
# (any spacing, bare or quoted key) that are anything other than crates.io. Empty is the only
# acceptable answer.
foreign_lock_sources() {
  git -C "$1" diff -U0 -- '*Cargo.lock' | grep -v '^+++ ' |
    sed -nE "s/^\+[[:space:]]*[\"']?source[\"']?[[:space:]]*=[[:space:]]*(.*[^[:space:]])[[:space:]]*\$/\1/p" |
    grep -vxF "$CRATES_IO_SOURCES" || true
}

# refuse <number> <reason>: recorded for the issue, and said ONCE on the pull request (marker).
# The reason is built by this script from validated values only - never from a raw trailer or title.
refuse() {
  local n="$1" reason="$2" bodies
  log "refused #$n: $reason"
  refusals="${refusals}- #${n}: ${reason}
"
  if ! bodies="$("$GH" pr view "$n" --repo "$REPO" --json comments --jq '.comments[].body' 2>&1)"; then
    log "could not read the comments of #$n: $bodies"
    failures=$((failures + 1))
    return
  fi
  if grep -qF "$REFUSAL_MARKER" <<<"$bodies"; then
    log "  (already said so on #$n)"
    return
  fi
  "$GH" pr comment "$n" --repo "$REPO" --body "${REFUSAL_MARKER}
The lockfile refresh did not complete this pull request: ${reason}

It stays open for a person, and it is listed in the issue \"${REPORT_TITLE}\". This comment is written once by \`.github/scripts/cargo-lock-refresh.sh\`." >/dev/null || {
    log "could not comment on #$n"
    failures=$((failures + 1))
  }
}

# --- the candidates: numbers only, so nothing else from the listing travels -----------------------
if ! candidates="$("$GH" pr list --repo "$REPO" --state open --author 'app/dependabot' --limit 100 \
  --json number,headRefName,isCrossRepository \
  --jq '.[] | select(.isCrossRepository == false and (.headRefName | startswith("dependabot/cargo/"))) | .number' 2>&1)"; then
  printf '%s\n' "$candidates" | tail -5
  die "could not list the open pull requests. A refusal is not an answer: without it this run cannot tell 'none' from 'unreadable'."
fi

refresh_one() {
  local n="$1"
  local branch="$BRANCH_PREFIX$n"

  # 0. DURABLE STATE FIRST: a refresh pull request OF OURS that exists, in any state, decides
  # everything. Ours = in this repository AND opened by the App; the newest wins. `--head` matches a
  # branch NAME, which a fork can borrow, so every other pull request on it is ignored and reported.
  local on_branch existing foreign
  if ! on_branch="$("$GH" pr list --repo "$REPO" --head "$branch" --state all --limit 100 \
    --json number,state,isCrossRepository,author,createdAt 2>&1)"; then
    log "could not read the pull requests of $branch: $on_branch"
    return 1
  fi
  if ! existing="$(jq -r --arg app "app/$APP_SLUG" \
    '[.[] | select(.isCrossRepository == false and .author.login == $app)] | sort_by(.createdAt) | last
     | select(. != null) | "\(.number) \(.state)"' <<<"$on_branch")" ||
    ! foreign="$(jq -r --arg app "app/$APP_SLUG" \
      '[.[] | select(.isCrossRepository != false or .author.login != $app) | .number] | map(tostring) | join(" ")' <<<"$on_branch")"; then
    log "the pull requests of $branch could not be read as JSON"
    return 1
  fi
  if [ -n "$foreign" ]; then
    [[ "$foreign" =~ ^[0-9\ ]+$ ]] || foreign='(unreadable numbers)'
    notices="${notices}- pull request(s) ${foreign} use the reserved branch name of #${n}'s refresh but were not opened by the App in this repository; IGNORED, and nothing about #${n} was decided from them.
"
  fi
  if [ -n "$existing" ]; then
    local en="${existing%% *}" es="${existing##* }"
    [[ "$en" =~ ^[0-9]+$ ]] || {
      log "the refresh pull request of #$n has no readable number: $existing"
      return 1
    }
    case "$es" in
      OPEN | MERGED)
        log "#$n already has refresh pull request #$en ($es); closing the original."
        "$GH" pr close "$n" --repo "$REPO" --comment "Superseded by #$en, which carries the same update with its lockfiles refreshed." >/dev/null || return 1
        ;;
      *)
        refuse "$n" "its refresh pull request #$en was closed without being merged - a person's answer, so nothing reopens it."
        ;;
    esac
    return 0
  fi

  # 1. WHO WROTE EVERY COMMIT, asked of GitHub - which is the only party that can say a signature is
  # valid. One answer per line: sha, author login, author email, committer login, verified.
  local api_commits
  if ! api_commits="$("$GH" api "repos/$REPO/pulls/$n/commits?per_page=100" \
    --jq '.[] | [.sha, (.author.login // "-"), (.commit.author.email // "-"), (.committer.login // "-"), (.commit.verification.verified | tostring)] | @tsv' 2>&1)"; then
    log "could not read the commits of #$n: $api_commits"
    return 1
  fi
  if [ -z "$api_commits" ] || [ "$(grep -c . <<<"$api_commits")" -ge 100 ]; then
    refuse "$n" "it carries no commit, or more than this check reads in one page."
    return 0
  fi
  local sha alogin aemail clogin verified
  while IFS=$'\t' read -r sha alogin aemail clogin verified; do
    if [ "$alogin" != "$DEPENDABOT_LOGIN" ] || [ "$aemail" != "$DEPENDABOT_EMAIL" ] ||
      [ "$clogin" != "$SIGNING_COMMITTER" ] || [ "$verified" != true ]; then
      [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || sha='(unreadable sha)'
      refuse "$n" "commit \`${sha:0:12}\` is not a signed Dependabot commit (author login, address, committer and GitHub's signature verdict must all be Dependabot's), so a person touched this pull request and it is theirs."
      return 0
    fi
  done <<<"$api_commits"

  # 2. WHAT GIT WOULD PICK MUST BE WHAT GITHUB VERIFIED. The head is fetched by NUMBER, never by the
  # branch name the pull request declares.
  local head="refs/lock-refresh/pr-$n"
  git -C "$REPO_ROOT" fetch --quiet origin "+refs/pull/$n/head:$head" || {
    log "could not fetch refs/pull/$n/head"
    return 1
  }
  local base commits
  base="$(git -C "$REPO_ROOT" merge-base "$BASE_REF" "$head")" || return 1
  commits="$(git -C "$REPO_ROOT" rev-list --reverse --topo-order "$base..$head")"
  if [ "$commits" != "$(cut -f1 <<<"$api_commits")" ]; then
    log "#$n: the commits git would cherry-pick are not the ones GitHub verified."
    return 1
  fi

  # 3. Scope: manifests and lockfiles only.
  local f
  while IFS= read -r f; do
    case "$f" in
      Cargo.toml | Cargo.lock | */Cargo.toml | */Cargo.lock) ;;
      *)
        refuse "$n" "it changes a file that is not a \`Cargo.toml\` or a \`Cargo.lock\`; only those are this job's."
        return 0
        ;;
    esac
  done <<<"$(git -C "$REPO_ROOT" diff --name-only "$base" "$head")"

  # 4. What the update IS, from the trailers of the commits just verified - and every value is
  # validated before anything uses it.
  local updates
  updates="$(git -C "$REPO_ROOT" log --format=%B "$base..$head" | ceiling_parse_updates)"
  if [ -z "$updates" ]; then
    refuse "$n" "no commit carries an updated-dependencies block, so nothing here can tell which crates to move."
    return 0
  fi
  local name type version gate
  while IFS='|' read -r name type version; do
    # A crate name starts with a letter (so it can never read as an option to cargo); a version is
    # a full semver, which is also all `--precise` accepts.
    if ! [[ "$name" =~ ^[A-Za-z][A-Za-z0-9_-]{0,63}$ ]] ||
      ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]{1,64})?$ ]]; then
      refuse "$n" "a trailer names a dependency or a version that is not a crate name and a full semver version, so nothing here passes it to cargo."
      return 0
    fi
    if ceiling_is_tauri_runtime_crate "$name"; then
      refuse "$n" "\`$name\` is a crate of the Tauri runtime. A runtime bump is a native work package owed a device reading, never an unattended merge."
      return 0
    fi
    if ceiling_update_is_breaking "$type" "$version"; then
      refuse "$n" "\`$name\` -> \`$version\` is a breaking update (type \`${type:-unclassified}\`). The unattended refresh carries patch and compatible minor updates only; this one is a person's."
      return 0
    fi
    gate="$(gate_for_dependency "$name" "$version" cargo)"
    if [ -n "$gate" ]; then
      refuse "$n" "\`$name\` has no gate here that would see it fail: $gate"
      return 0
    fi
  done <<<"$updates"

  # 5. Is any committed lock stale at Dependabot's head? If not, Dependabot's pull request is
  # complete and CI decides it like any other.
  local probe
  probe="$(mktemp -d)"
  workdirs+=("$probe")
  git -C "$REPO_ROOT" worktree add --detach --quiet "$probe" "$head" || return 1
  local d state any_stale=0
  while IFS= read -r d; do
    state="$(stale_state "$probe" "$d")"
    case "$state" in
      stale) any_stale=1 ;;
      error)
        log "could not tell whether $d is stale on #$n"
        return 1
        ;;
    esac
  done <<<"$lock_dirs"
  if [ "$any_stale" -eq 0 ]; then
    log "#$n: every committed lock already satisfies its manifests; nothing to complete."
    return 0
  fi

  # 6. The new branch, from main, with Dependabot's commits carried. The committer is the App - set
  # in the environment, which outranks any ambient configuration.
  local wt
  wt="$(mktemp -d)"
  workdirs+=("$wt")
  git -C "$REPO_ROOT" worktree add --quiet --detach "$wt" "$BASE_REF" || return 1
  local c
  while IFS= read -r c; do
    if ! GIT_COMMITTER_NAME="$COMMIT_NAME" GIT_COMMITTER_EMAIL="$COMMIT_EMAIL" \
      git -C "$wt" cherry-pick --allow-empty "$c" >/dev/null 2>&1; then
      git -C "$wt" cherry-pick --abort >/dev/null 2>&1 || true
      refuse "$n" "Dependabot's commits do not apply cleanly onto main (a conflict in \`${c:0:12}\`)."
      return 0
    fi
  done <<<"$commits"

  # 7. Refresh each stale lock, crate by crate, to the version Dependabot declared.
  local before out
  while IFS= read -r d; do
    state="$(stale_state "$wt" "$d")"
    case "$state" in
      ok) continue ;;
      error)
        log "could not tell whether $d is stale on the refresh of #$n"
        return 1
        ;;
    esac
    before="$(runtime_packages "$wt$d/Cargo.lock")"
    while IFS='|' read -r name type version; do
      grep -qxF "name = \"$name\"" "$wt$d/Cargo.lock" || continue
      if ! out="$(cd "$wt$d" && "$CARGO" update -p "$name" --precise "$version" 2>&1)"; then
        printf '%s\n' "$out" | tail -5
        refuse "$n" "\`cargo update -p $name --precise $version\` failed in \`$d\`."
        return 0
      fi
    done <<<"$updates"
    if [ "$before" != "$(runtime_packages "$wt$d/Cargo.lock")" ]; then
      refuse "$n" "the refresh would move a crate of the Tauri runtime (\`tauri\`, \`tauri-*\`, \`wry\` or \`tao\`) in \`$d\`. That is a native work package, never an unattended merge."
      return 0
    fi
  done <<<"$lock_dirs"

  while IFS= read -r d; do
    state="$(stale_state "$wt" "$d")"
    case "$state" in
      ok) ;;
      stale)
        refuse "$n" "\`$d\` still fails \`cargo metadata --locked\` after the refresh."
        return 0
        ;;
      *)
        log "could not tell whether $d is satisfied after the refresh of #$n"
        return 1
        ;;
    esac
  done <<<"$lock_dirs"

  # 8. The App's ONE commit: lockfiles and nothing else, asserted rather than assumed.
  local changed
  changed="$(git -C "$wt" status --porcelain | cut -c4-)"
  if [ -z "$changed" ]; then
    log "#$n: the refresh changed nothing."
    return 0
  fi
  if grep -qvE '(^|/)Cargo\.lock$' <<<"$changed"; then
    log "#$n: the refresh touched something that is not a Cargo.lock: $(tr '\n' ' ' <<<"$changed")"
    return 1
  fi
  # Every source a refreshed lock names is crates.io - asserted on the diff, before anything leaves.
  local foreign_sources
  foreign_sources="$(foreign_lock_sources "$wt")"
  if [ -n "$foreign_sources" ]; then
    refuse "$n" "the refreshed lockfiles would name a source that is not crates.io; nothing was pushed."
    return 0
  fi
  git -C "$wt" add -A || return 1
  GIT_AUTHOR_NAME="$COMMIT_NAME" GIT_AUTHOR_EMAIL="$COMMIT_EMAIL" \
    GIT_COMMITTER_NAME="$COMMIT_NAME" GIT_COMMITTER_EMAIL="$COMMIT_EMAIL" \
    git -C "$wt" commit --quiet \
    -m "chore(deps): refresh the committed lockfiles for #$n" \
    -m "Dependabot's pull request is incomplete by construction: mls-wasm and src-tauri commit their own lock and consume mls-core by path. Written by cargo-lock-refresh.sh." || return 1

  # 9. Push. No pull request of ours exists (step 0), so a branch of this name is either the debris
  # of a run that died before opening one - its tip authored by the App - or SOMEBODY ELSE'S. Only
  # the first is overwritten, with a lease on the SHA read here so a branch moved in between is
  # refused rather than clobbered; the second is reported and left alone.
  local remote_sha tip_author
  remote_sha="$(git -C "$REPO_ROOT" ls-remote origin "refs/heads/$branch" | cut -f1)" || return 1
  if [ -n "$remote_sha" ]; then
    git -C "$REPO_ROOT" fetch --quiet origin "+refs/heads/$branch:refs/lock-refresh/tip-$n" || return 1
    tip_author="$(git -C "$REPO_ROOT" log -1 --format='%an <%ae>' "refs/lock-refresh/tip-$n")" || return 1
    if [ "$tip_author" != "$COMMIT_NAME <$COMMIT_EMAIL>" ]; then
      refuse "$n" "a branch \`$branch\` already exists with no pull request of the App's, and its tip was not written by the App; nothing overwrites it. A person deletes it, or takes the update."
      return 0
    fi
  fi
  git -C "$wt" push --quiet --force-with-lease="refs/heads/$branch:$remote_sha" origin "HEAD:refs/heads/$branch" || return 1

  # 10. The pull request, as the App. The title is Dependabot's, reduced to printable characters and
  # capped, and travels as ONE argument; the body is this script's own text.
  local title url newn
  if ! title="$("$GH" pr view "$n" --repo "$REPO" --json title --jq .title 2>&1)"; then
    log "could not read the title of #$n: $title"
    return 1
  fi
  title="$(head -1 <<<"$title" | tr -cd '[:print:]' | cut -c1-200)"
  [ -n "$title" ] || {
    log "#$n has an empty title once reduced to printable characters; a person names it."
    return 1
  }
  url="$("$GH" pr create --repo "$REPO" --base main --head "$branch" --title "$title" --body "Supersedes #$n.

Dependabot's commits are carried unchanged, and the committed lockfiles its pull request leaves stale are refreshed to the versions it declared (\`cargo update -p <crate> --precise <version>\`). Opened by \`.github/scripts/cargo-lock-refresh.sh\`; \`arm-auto-merge.yml\` re-checks every commit and file before arming, and \`CI passed\` decides whether it merges.")" || return 1
  newn="${url##*/}"
  [[ "$newn" =~ ^[0-9]+$ ]] || {
    log "the pull request for #$n was created but its number could not be read: $url"
    return 1
  }
  log "opened #$newn for #$n"
  "$GH" pr close "$n" --repo "$REPO" --comment "Superseded by #$newn, which carries the same update with its lockfiles refreshed." >/dev/null || return 1
  return 0
}

while IFS= read -r n; do
  [ -n "$n" ] || continue
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "::error::the pull request list answered something that is not a number; nothing was done with it."
    failures=$((failures + 1))
    continue
  fi
  log "== #$n"
  if ! refresh_one "$n"; then
    echo "::error::#$n could not be processed (see above); the next run retries it."
    failures=$((failures + 1))
  fi
done <<<"$candidates"

# --- the report: one issue, found by its exact title ----------------------------------------------
report() {
  GH_TOKEN="$REPORT_TOKEN" "$GH" "$@"
}
if ! issue="$(report issue list --repo "$REPO" --state open --search "$REPORT_TITLE in:title" \
  --json number,title --jq "[.[] | select(.title == \"$REPORT_TITLE\")] | .[0].number // empty" 2>&1)"; then
  printf '%s\n' "$issue" | tail -5
  die "could not read the issue list, so the refusals of this run are recorded nowhere."
fi
if [ -n "$issue" ] && ! [[ "$issue" =~ ^[0-9]+$ ]]; then
  die "the issue list answered something that is not a number: $issue"
fi

if [ -z "$refusals" ] && [ -z "$notices" ]; then
  if [ -n "$issue" ] && [ "$failures" -eq 0 ]; then
    report issue close "$issue" --repo "$REPO" --comment "No Dependabot cargo pull request is refused any more; closing. Written by \`cargo-lock-refresh.sh\`, which opens a new issue when one is." >/dev/null ||
      die "nothing is refused but issue #$issue could not be closed."
    log "ok: nothing refused; closed issue #$issue."
  else
    log "ok: nothing refused."
  fi
else
  body="These Dependabot cargo pull requests could not be completed by the lockfile refresh, and each waits for a person. Every line says why; the reasons are the refusals listed in \`.github/scripts/cargo-lock-refresh.sh\`.

${refusals}${notices:+
**On the reserved branch names:**

${notices}}
<sub>Written by \`.github/scripts/cargo-lock-refresh.sh\` on the daily \`Scheduled\` run. This issue is UPDATED rather than duplicated, and closed once no refusal stands. The mechanism: \`docs/wiki/cicd.md\`.</sub>"
  if [ -n "$issue" ]; then
    report issue edit "$issue" --repo "$REPO" --body "$body" >/dev/null ||
      die "issue #$issue could not be updated, so it no longer says what is refused."
    log "reported: refreshed issue #$issue."
  else
    report issue create --repo "$REPO" --title "$REPORT_TITLE" --body "$body" >/dev/null ||
      die "a refusal stands and the issue could not be created, so nothing records it."
    log "reported: opened the issue."
  fi
fi

[ "$failures" -eq 0 ] || exit 1
exit 0
