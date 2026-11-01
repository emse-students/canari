#!/usr/bin/env bash
#
# THE QUESTIONS A RELEASE MUST ANSWER BEFORE IT IS ALLOWED TO START.
#
# WHY THEY DID NOT EXIST. `bump-version.yml` is the first link of every deployment - production, the
# dev estate and both stores all start from its COMPLETION - and until 2026-09-03 it contained SIX
# STEPS AND NOT ONE `if:`. It bumped and pushed whatever tag it was handed. Two consequences, both
# measured on the day the chain first ran for real:
#
#   * `v0.15.0` was published from `main`'s tip, three merged pull requests past the commit the dev
#     estate had been given, so PRODUCTION RECEIVED FOUR COMMITS DEV HAD NEVER SERVED. The two
#     releases have no relationship to each other: two human gestures on two independent commits.
#   * The CI run on the released commit was RED, and production deployed anyway. Nothing anywhere
#     required the tests to be green - the chain requires the BUMP to succeed, which is a different
#     statement.
#
# THE ANSWER IS NOT A DETECTOR. A report that says production is ahead of dev arrives after the fact
# and asks a human to care; what is wanted is that it cannot happen. So these are PRECONDITIONS on
# the first link, and because nothing downstream starts unless the bump succeeds, refusing here
# refuses the whole chain - the fail-safe that already exists, used on purpose instead of by
# accident.
#
# Kept apart from the caller so the decisions can be exercised on inputs the API will not produce on
# demand. Tested by `.github/scripts/tests/release-preflight.test.sh`.

# Which kind of release a version string names, and the hyphen IS the definition - the same rule
# `cd.yml` reads off the bumped manifest and `bump-app-version.sh` computes the store band from.
# Stated once, here, so three places cannot drift.
#
# Prints one verdict; the caller switches on the first word:
#   stable                a production release
#   prerelease <label>    a tester release, bound for the dev estate
#   invalid <why>         not a version this project can release
release_kind() {
  local v="${1#v}"
  case "$v" in
    '') printf 'invalid version is empty\n'; return 0 ;;
  esac
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf 'stable\n'
  elif [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z.]+)$ ]]; then
    printf 'prerelease %s\n' "${BASH_REMATCH[1]}"
  else
    printf 'invalid %s is not major.minor.patch[-label]\n' "$v"
  fi
}

# HAS THE DEV ESTATE ALREADY SERVED THE COMMIT THIS RELEASE WOULD PUT IN PRODUCTION?
#
# Reads a `GET /compare/{target}...{dev-deployed}` payload rendered as three lines - `status`,
# `ahead_by`, `behind_by`.
#
# THE BASE IS THE TARGET AND THE HEAD IS DEV, AND THAT CHOICE IS THE WHOLE POINT. A compare is
# written from the base's point of view, so putting the thing being shipped in the base makes
# GitHub's own words read the way a person would say them: dev is `ahead` of what we are shipping,
# or `behind` it. The first draft of this check had them the other way round and every field name
# meant its opposite, which is exactly how a lagging estate gets reported as healthy.
#
# Prints one verdict:
#   covered identical         dev is at precisely this commit - the normal, intended case
#   covered ahead <n>         dev is n commits FURTHER on, so this code has been through it
#   uncovered behind <n>      dev is missing n commits this release carries - REFUSE
#   uncovered diverged <a> <b>  neither contains the other - REFUSE
#   undecidable <why>         no evidence either way, which is not permission
classify_dev_coverage() {
  local status ahead behind

  IFS= read -r status || { printf 'undecidable empty payload\n'; return 0; }
  IFS= read -r ahead  || { printf 'undecidable payload has no ahead_by line\n'; return 0; }
  IFS= read -r behind || { printf 'undecidable payload has no behind_by line\n'; return 0; }
  # `_` and not a named variable: shellcheck runs with no severity floor here and a write-only
  # variable comes back as SC2034. The read's SUCCESS is the whole signal.
  if IFS= read -r _; then
    printf 'undecidable payload has more than three lines\n'
    return 0
  fi

  case "$status" in
    identical|ahead|behind|diverged) ;;
    '') printf 'undecidable status is empty\n'; return 0 ;;
    *)  printf 'undecidable unknown status %s\n' "$status"; return 0 ;;
  esac

  # BOTH counts are validated even where only one is read: a verdict carrying a number nobody
  # checked is exactly the number its reader will trust.
  case "$ahead$behind" in
    *[!0-9]*|'') printf 'undecidable ahead_by/behind_by are not both numeric\n'; return 0 ;;
  esac

  case "$status" in
    identical) printf 'covered identical\n' ;;
    ahead)     printf 'covered ahead %s\n' "$ahead" ;;
    behind)    printf 'uncovered behind %s\n' "$behind" ;;
    diverged)  printf 'uncovered diverged %s %s\n' "$ahead" "$behind" ;;
  esac
}

# IS THE RELEASED COMMIT ON `main`? Gate 2, read from a `GET /compare/{target}...main` status
# (base = the released commit, head = main, so `identical` and `ahead` both mean main contains it).
#
# CONTAINMENT, AND NOTHING ABOUT WHERE `main` POINTS NOW (2026-10-30). Until then a pre-release's
# bump pushed to `main`, so this gate also asked whether `main` still POINTED at the commit, and a
# pull request merged in the minutes after the cut killed the release: `v1.5.1-alpha.3` refused
# here, `v1.5.1-alpha.5` rejected at the push one minute after a green preflight. The bump of EVERY
# release goes to `release/vX.Y.Z` now (docs/wiki/cicd.md, "A pre-release is pinned on its release
# branch"), nothing in a release's critical path pushes to `main`, and `main` moving on is the
# ordinary case. What the gate keeps is its intent: the commit reached the trunk through a pull
# request. `main` is never force-pushed (ruleset), so what it contains now it contained at the cut.
#
# args:   <compare status>
# stdout: `on-main <status>` | `off-main <status>` | `undecidable <why>`
classify_on_main() {
  local status="${1-}"
  case "$status" in
    identical|ahead) printf 'on-main %s\n' "$status" ;;
    behind|diverged) printf 'off-main %s\n' "$status" ;;
    '')              printf 'undecidable status is empty\n' ;;
    *)               printf 'undecidable unknown status %s\n' "$status" ;;
  esac
}

# WHICH PRE-RELEASE DOES A STABLE SHIP? The latest one of ITS OWN version (user, 2026-10-02: *"une
# release n'opere que sur le tag de la derniere pre-release, comme ca on peut commit sur main sans
# empecher la release"*). A stable used to be refused the moment `main` moved past its commit, so
# every merge during the minutes of a release cost a new tag; now the stable is built from the commit
# the pre-release was cut at, whatever `main` has become since.
#
# args:  <stable version, no v>   stdin: tag names, one per line
# stdout: the highest `v<version>-<label>` tag (version order, so alpha.10 follows alpha.9), or
#         nothing when no pre-release of that version exists - which the caller refuses.
latest_prerelease_tag() {
  local want="${1#v}"
  local -a tags=()
  local tag
  while IFS= read -r tag; do
    [[ "$tag" =~ ^v${want//./\.}-[0-9A-Za-z.]+$ ]] && tags+=("$tag")
  done
  [ "${#tags[@]}" -eq 0 ] && return 0
  printf '%s\n' "${tags[@]}" | sort -V | tail -1
}

# IS THIS PRE-RELEASE STILL THE NEWEST RELEASE? Gate 2's second question, pre-releases only
# (2026-10-30).
#
# Until 2026-10-30 gate 2 also asked whether `main` still POINTED at the commit, and that refused a
# stale pre-release by accident: anything older than the newest release was behind `main`. With the
# bump off `main` that half went, so a `gh run rerun` of a refused `alpha.5` after `alpha.6` shipped
# would pass every gate, force `release/vX.Y.Z` back to its own bump, redeploy older code to dev,
# move `dev-deployed` back, and upload store build ..05 after ..06 - which App Store Connect refuses
# (CFBundleVersion must rise) and Play refuses as a rollout that blocks upgrades. It is asked on
# purpose now, from the tags, before anything moves.
#
# THE ORDER IS THE STORE BAND, read from `bump-app-version.sh --code`/`--codes` - the one implementation of it,
# never restated here. A tag the band cannot parse never reached a store, so it orders nothing.
#
# args:   <version being released>  <path to bump-app-version.sh>
# stdin:  every `v*` tag name, one per line
# stdout: `current`                  no tag carries a higher store build number
#         `stale <tag>`              a later pre-release of THIS version exists - the common case
#         `superseded <tag>`         a release of another version (or this version's stable) is higher
#         `undecidable <why>`        no evidence either way, which is not permission
classify_prerelease_currency() {
  local want="${1#v}" bump="${2-}"
  local own tag code best_code=0 best_tag='' latest latest_code
  local -a tags=()

  if [ -z "$want" ] || [ -z "$bump" ]; then
    printf 'undecidable no version or no bump script was passed\n'
    return 0
  fi
  own="$(bash "$bump" --code "$want" 2>/dev/null)" || {
    printf 'undecidable %s has no store band\n' "$want"
    return 0
  }
  while IFS= read -r tag; do
    tag="${tag%$'\r'}"
    [ -n "$tag" ] && tags+=("$tag")
  done
  # The release's own tag is in this list whenever it was published, so an empty list, or one
  # without it, is an unreadable or partial answer - never a repository with nothing newer in it.
  if [ "${#tags[@]}" -eq 0 ]; then
    printf 'undecidable no tag was listed\n'
    return 0
  fi
  for tag in "${tags[@]}"; do
    [ "$tag" = "v$want" ] && break
  done
  if [ "$tag" != "v$want" ]; then
    printf 'undecidable v%s itself is not in the tag list, so the list is incomplete\n' "$want"
    return 0
  fi

  # ONE process for every tag (`--codes`), never one per tag.
  latest="$(printf '%s\n' "${tags[@]}" | latest_prerelease_tag "${want%%-*}")"
  latest_code=0
  while IFS=' ' read -r code tag; do
    if [ "$code" -gt "$best_code" ]; then best_code="$code"; best_tag="$tag"; fi
    [ "$tag" = "$latest" ] && latest_code="$code"
  done < <(printf '%s\n' "${tags[@]}" | bash "$bump" --codes)

  if [ "$latest_code" -gt "$own" ]; then
    printf 'stale %s\n' "$latest"
  elif [ "$best_code" -gt "$own" ]; then
    printf 'superseded %s\n' "$best_tag"
  else
    printf 'current\n'
  fi
}

# Gate 6: does this release add or change a migration the owner must approve, without the approval?
#
# THE DEPLOY REFUSES SUCH A FILE ANYWAY (`apply_migrations`), but only after the bump has pushed, the
# images are built and a store has taken the build - a refusal that lands at the end of a release.
# The same question asked of the TREE, before anything moves, costs a second. It is pure repository:
# the files `git diff` names between the commit production serves (`prod-released`, the caller's
# $1) and the released commit (added, modified
# or renamed under `apps/*/src/migrations/`), each judged by `migration_gate_verdict`
# (infrastructure/lib/migration-hold.sh, the deploy's own judge) against the approvals file of the
# working tree, which IS the released commit. The caller sources that library first.
#
# Prints one line per examined file - `plain <file>`, `approved <file>`, `refused <file> <sha256>
# <reason>` - and returns 0 when nothing is refused, 1 when something is, 2 when it cannot decide
# (`undecidable <why>` is printed): a comparison or a file it cannot read is never permission.
held_migrations_since() {
  local base="$1" target="$2" files file verdict kind rest refused=0
  if ! declare -F migration_gate_verdict >/dev/null; then
    printf 'undecidable the hold library (infrastructure/lib/migration-hold.sh) is not loaded\n'
    return 2
  fi
  if ! files="$(git diff --name-only --diff-filter=AMR "$base" "$target" -- 'apps/*/src/migrations/*.sql')"; then
    printf 'undecidable git could not compare %s with %s\n' "$base" "$target"
    return 2
  fi
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if ! verdict="$(migration_gate_verdict "$file")"; then
      printf 'undecidable %s could not be judged\n' "$file"
      return 2
    fi
    kind="${verdict%%|*}"
    rest="${verdict#*|}"
    case "$kind" in
      plain) printf 'plain %s\n' "$file" ;;
      approved) printf 'approved %s\n' "$file" ;;
      *)
        refused=1
        printf 'refused %s %s %s\n' "$file" "${rest%%|*}" "${verdict##*|}"
        ;;
    esac
  done <<<"$files"
  return "$refused"
}
