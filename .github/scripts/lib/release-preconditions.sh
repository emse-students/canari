#!/usr/bin/env bash
#
# THE THREE QUESTIONS A RELEASE MUST ANSWER BEFORE IT IS ALLOWED TO START.
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

# CAN THE BUMP STILL PUSH? Answered from two facts the preflight already holds, rather than by
# finding out at the push.
#
# The bump job checks out the RELEASED commit, writes the version across 18 files and runs
# `git push origin HEAD:main`. That push is a fast-forward only while `main` still POINTS AT the
# released commit - and the second gate deliberately accepts `ahead` as well, because `main`
# containing the commit is what that gate is about.
#
# FOR ONE SHAPE OF RELEASE `ahead` IS PERFECTLY SAFE: if the released tree already carries the
# version being released, the bump writes nothing, commits nothing and pushes nothing, which is the
# no-op branch the bump job documents. For every other shape the push is a non-fast-forward, the
# preflight has already said yes, and the release dies at its SECOND job with a git error that
# names none of this - a gate approving what a later step refuses, which is the shape the rule
# against learning by failing exists to forbid.
#
# The discriminator is the version in the released tree, which the preflight has checked out and
# can read for free. So it is carried to where the decision is made.
#
# args:  <compare status>  <version in the released tree>  <version being released>
# stdout: `pushable head` | `pushable noop` | `unpushable <tree version>` | `undecidable <why>`
classify_main_position() {
  local status="${1-}" tree="${2-}" want="${3-}"

  # An unreadable input is never permission, on the same principle as every other judgement here.
  if [ -z "$want" ]; then
    printf 'undecidable no version was passed to compare against\n'
    return 0
  fi

  case "$status" in
    identical)
      # `main` is the released commit, so a bump commit on top of it fast-forwards by construction.
      printf 'pushable head\n'
      ;;
    ahead)
      if [ -z "$tree" ]; then
        # THE TREE NOT STATING A VERSION IS ITSELF THE REFUSAL. Without it there is no way to tell
        # the harmless no-op from the release that dies at its second job, and a guess here picks
        # between deploying production and not deploying at all.
        printf 'undecidable the released tree states no version, so the no-op case cannot be told apart\n'
      elif [ "$tree" = "$want" ]; then
        printf 'pushable noop\n'
      else
        printf 'unpushable %s\n' "$tree"
      fi
      ;;
    '')
      printf 'undecidable status is empty\n'
      ;;
    *)
      # `behind` and `diverged` never reach here - gate 2 refuses them first - but a classifier
      # that answers for an input it was not given is a classifier its next caller will trust.
      printf 'undecidable status %s is not a position this answers for\n' "$status"
      ;;
  esac
}
