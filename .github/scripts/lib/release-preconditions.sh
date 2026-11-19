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

# DOES THE STABLE BUILD EXACTLY ITS LATEST PRE-RELEASE'S COMMIT? Gate 4's first question, stables
# only (owner, 2026-11-14: *"La stable devrait toujours etre build depuis la derniere alpha,
# independamment de main."*).
#
# `release.yml`'s resolve step DERIVES the commit (`latest_prerelease_tag`, then the tag's commit),
# and until 2026-11-14 nothing ASSERTED the result: gate 2 asks only that `main` contains the commit
# and gate 4 only that dev is at or past it, so `main`'s head - which the stable's own tag names when
# it is typed against `main` - would have passed both. The preflight re-derives the pair from the API
# itself and hands it here; anything but equality refuses, so the stable's commit is decided by its
# alpha and by nothing `main` holds.
#
# args:   <target sha> <latest pre-release tag of this version, or empty> <that tag's commit sha>
# stdout: `exact <tag>`                     the stable builds precisely that pre-release's commit
#         `mismatch <tag> <its sha>`        it would build something else - REFUSE
#         `undecidable <why>`               no evidence either way, which is not permission
classify_stable_source() {
  local target="${1-}" tag="${2-}" tag_sha="${3-}"
  if [ -z "$tag" ]; then
    printf 'undecidable no pre-release of this version exists\n'
    return 0
  fi
  if ! [[ "$target" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'undecidable the target %s is not a full commit sha\n' "${target:-(empty)}"
    return 0
  fi
  if ! [[ "$tag_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'undecidable the commit of %s could not be read (%s)\n' "$tag" "${tag_sha:-nothing}"
    return 0
  fi
  if [ "$target" = "$tag_sha" ]; then
    printf 'exact %s\n' "$tag"
  else
    printf 'mismatch %s %s\n' "$tag" "$tag_sha"
  fi
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

# Gate 6: does this release add a migration the owner must approve, without the approval?
#
# THE DEPLOY REFUSES SUCH A FILE ANYWAY (`apply_migrations`), but only after the bump has pushed, the
# images are built and a store has taken the build - a refusal that lands at the end of a release.
# The same question asked of the TREE, before anything moves, costs a second. It is pure repository:
# the files `git diff` names between the commit production serves (`prod-released`, the caller's
# $1) and the released commit, ADDED, COPIED or RENAMED under `apps/*/src/migrations/` - the paths
# production's ledger has no row for, which are exactly the files the deploy will judge and apply.
# A file only MODIFIED since then is already in that ledger: the deploy never re-applies it (the
# changed checksum only warns), so judging it here would refuse a release for a file nothing runs
# (final review of #2873 - the first version asked AMR). Each file is judged by
# `migration_gate_verdict` (infrastructure/lib/migration-hold.sh, the deploy's own judge) against the
# approvals file of the working tree, which IS the released commit. The caller sources that library.
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
  if ! files="$(git diff --name-only --diff-filter=ACR "$base" "$target" -- 'apps/*/src/migrations/*.sql')"; then
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

# Gate 7, stables only: what `audit-dependencies.sh` answered for ONE tree's production closure
# (owner, 2026-11-17: a stable is refused while an advisory touches what it ships). The script's
# own three exits, read with an outage TOLERATED so that "the registry never answered" stays
# distinguishable from "it named an advisory" - and BOTH refuse a stable, since an unaudited
# closure is no evidence. Anything else is undecidable, and refuses too.
#
#   classify_shipped_audit <exit status>  ->  clean | advisory | unanswered | undecidable <status>
classify_shipped_audit() {
  case "$1" in
    0) printf 'clean\n' ;;
    1) printf 'advisory\n' ;;
    2) printf 'unanswered\n' ;;
    *) printf 'undecidable %s\n' "${1:-nothing}" ;;
  esac
}

# Gate 7's loop: every tree of `lib/audit-trees.sh`, its PRODUCTION closure, through
# `audit-dependencies.sh`. Needs the caller's printers (`ok`, `refuse`, `hint`) and the table
# (`AUDIT_TREES`, `audit_flags`) loaded. `AUDIT_SCRIPT` replaces the audit (the self-test's fake).
#
# EVERY REFUSAL CARRIES ITS EVIDENCE: the audit's whole output, indented, for every verdict but
# `clean` - an advisory's package and path, or the line an unrecognised failure printed.
#
# AN OUTAGE IS ASKED ONCE PER TREE AFTER THE FIRST. Three attempts of up to five minutes each are
# worth spending on the first tree; once the registry has been silent for one, the rest are asked
# with `AUDIT_ATTEMPTS=1`, so an outage costs one tree's budget plus one attempt per other tree
# instead of eighty minutes. Its remedy is a rerun of this same run, which re-reads the same tag.
shipped_closure_gate() {
  local here audit tree flags out rc once=''
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  audit="${AUDIT_SCRIPT:-$here/../audit-dependencies.sh}"
  for tree in "${AUDIT_TREES[@]}"; do
    flags="$(audit_flags "$tree" production)" || { refuse "$tree has no audit setup in lib/audit-trees.sh"; continue; }
    rc=0
    # shellcheck disable=SC2086  # `$flags` is a word-split list by construction
    out="$(env REGISTRY_OUTAGE_IS_FAILURE=false ${once:+AUDIT_ATTEMPTS=1} bash "$audit" "$tree" $flags 2>&1)" || rc=$?
    case "$(classify_shipped_audit "$rc")" in
      clean)
        ok "$tree: no advisory in its production closure"
        continue
        ;;
      advisory)
        refuse "$tree: an advisory touches what this stable ships (audit output below)"
        hint 'Fix it (or measure it unreachable and add an ignore with its asserted premise, lib/audit-trees.sh),'
        hint 'then cut a NEW pre-release and its stable: a rerun re-reads this same commit.'
        ;;
      unanswered)
        refuse "$tree: the npm advisory endpoint never answered, so what this stable ships is unaudited"
        hint "Remedy: gh run rerun ${GITHUB_RUN_ID:-<this run>} once npm answers - it re-reads the same tag."
        [ -z "$once" ] && hint 'The trees after this one are asked once each: the registry is already known to be silent.'
        once=1
        ;;
      *)
        refuse "$tree: the audit exited $rc, which is no verdict (audit output below)"
        ;;
    esac
    while IFS= read -r line; do hint "  | $line"; done <<<"$out"
  done
}

# Gate 8, stables only: production MiConnect would take this release's authentik pin (review of
# #3486, 2026-11-19). A stable's MiConnect step runs in `serve-prod`, AFTER both stores took the
# version (`serve-prod` needs `android` and `ios`), so a refusal there leaves the stable HALF-SHIPPED.
# The verdict is already KNOWN before the bump: the daily `miconnect-preflight` job of `scheduled.yml`
# runs the deploy's read-only half (`deploy-stack.sh preflight`) against production every morning. It
# is carried here rather than learned again at the end of the release.
#
#   classify_miconnect_preflight <job conclusion> <pin the run judged> <pin this stable ships>
#     passed                    that run's verdict, success, on this very pin
#     failed <conclusion>       the run judged this pin, and refused (or did not finish)
#     stale <judged pin>        the run judged ANOTHER pin, so it says nothing about this one
#     absent                    no completed run found
#     undecidable <why>         a pin could not be read
# A PIN, NOT A DATE: the run is relevant when it judged the image this stable ships, whatever its age;
# production's running state can change by hand in between, and the stable's own step still asks then.
classify_miconnect_preflight() {
  local conclusion="$1" judged="$2" shipped="$3"
  if [ -z "$conclusion" ]; then printf 'absent\n'; return 0; fi
  if [ -z "$judged" ] || [ -z "$shipped" ]; then
    printf 'undecidable a pin could not be read (judged %s, shipped %s)\n' "${judged:-?}" "${shipped:-?}"
    return 0
  fi
  if [ "$judged" != "$shipped" ]; then printf 'stale %s\n' "$judged"; return 0; fi
  case "$conclusion" in
    success) printf 'passed\n' ;;
    *) printf 'failed %s\n' "$conclusion" ;;
  esac
}

# The job's name, as GitHub names its check run - read by gate 8, written by `scheduled.yml`.
MICONNECT_PREFLIGHT_CHECK="${MICONNECT_PREFLIGHT_CHECK:-MiConnect production preflight}"

# The workflow file whose job gate 8 believes - a check run of the same name from anywhere else is
# not its verdict.
MICONNECT_PREFLIGHT_WORKFLOW="${MICONNECT_PREFLIGHT_WORKFLOW:-.github/workflows/scheduled.yml}"

# miconnect_preflight_candidates <sha> - one line `<completed_at>\t<check run id>\t<conclusion>\t<url>`
# per check run of that job on that commit that RAN TO A VERDICT. Every run of `scheduled.yml` posts
# the job, and all but the 07:30 one and a dispatch post it `skipped` (measured on main 2026-11-19:
# started_at == completed_at, no runner, no step), so a skipped run is no verdict and never read.
# `filter=all`, not `latest`: `latest` keeps one run per name, and that one is the newest SKIPPED.
# Only `github-actions` writes it: another app may post a check run of any name.
miconnect_preflight_candidates() {
  gh api -X GET "repos/$REPO/commits/$1/check-runs" -f check_name="$MICONNECT_PREFLIGHT_CHECK" -f filter=all -f per_page=100 \
    --jq ".check_runs[] | select(.name == \"$MICONNECT_PREFLIGHT_CHECK\" and .app.slug == \"github-actions\" and .status == \"completed\" and .conclusion != \"skipped\") | [.completed_at, .id, .conclusion, .html_url] | @tsv"
}

# Gate 8's reading. Prints ONE line:
#   run\t<conclusion>\t<url>\t<sha>   the newest verdict of the job
#   absent                            no run of it reached a verdict
#   error\t<what>                     an API call failed, and failing is not "no run"
# THE NEWEST BY completed_at ACROSS the stable's own commit (a run dispatched on the alpha's tag
# lands there) AND main's last 50 commits (the morning run lands on main's head of that moment),
# taken together: a commit's ancestry says nothing about what production can take, the pin the run
# judged does, and the gate compares that pin. So an old success on the stable's commit loses to a
# newer failure on main.
# THE JOB, NOT THE NAME (S3 of the third review, 2026-11-19): the check-run listing is per commit,
# which is how a verdict is tied to the pin it judged; the alternative, the workflow's run list, is
# paged by time and 96 runs a day of the 15-minute slot crowd the morning one out of a page. So the
# listing finds the candidates, and the winner is then resolved as a JOB: a check run of GitHub
# Actions has its job's id (measured), the job names its run, and the run names its workflow file,
# which must be `scheduled.yml`. A run cancelled before a runner took it (no `runner_name`) never
# judged anything and is passed over as absent; one cancelled while running is a refusal.
# A pure reader: the API is the `gh` on PATH (the self-test's fake runs these --jq through jq).
miconnect_preflight_reading() {
  local target="$1" shas sha lines="" more _completed id conclusion url job runner run_id path
  if ! shas="$(gh api "repos/$REPO/commits?sha=main&per_page=50" --jq '.[].sha' 2>/dev/null)"; then
    printf 'error\tGET repos/%s/commits?sha=main failed\n' "$REPO"
    return 0
  fi
  for sha in $(printf '%s\n%s\n' "$target" "$shas" | awk 'NF && !seen[$0]++'); do
    if ! more="$(miconnect_preflight_candidates "$sha" 2>/dev/null)"; then
      printf 'error\tGET repos/%s/commits/%s/check-runs failed\n' "$REPO" "$sha"
      return 0
    fi
    if [ -n "$more" ]; then lines+="$(awk -v s="$sha" 'NF { print $0 "\t" s }' <<<"$more")"$'\n'; fi
  done
  while IFS=$'\t' read -r _completed id conclusion url sha; do
    [ -n "$id" ] || continue
    if ! job="$(gh api "repos/$REPO/actions/jobs/$id" --jq '[.run_id, (.runner_name // "")] | @tsv' 2>/dev/null)"; then
      printf 'error\tGET repos/%s/actions/jobs/%s failed\n' "$REPO" "$id"
      return 0
    fi
    IFS=$'\t' read -r run_id runner <<<"$job"
    if ! path="$(gh api "repos/$REPO/actions/runs/$run_id" --jq '.path' 2>/dev/null)"; then
      printf 'error\tGET repos/%s/actions/runs/%s failed\n' "$REPO" "$run_id"
      return 0
    fi
    if [ "$path" != "$MICONNECT_PREFLIGHT_WORKFLOW" ]; then
      printf "error\tthe newest '%s' check run (%s) is a job of %s, not of %s - two jobs must not share that name\n" \
        "$MICONNECT_PREFLIGHT_CHECK" "$url" "${path:-an unknown workflow}" "$MICONNECT_PREFLIGHT_WORKFLOW"
      return 0
    fi
    if [ "$conclusion" = cancelled ] && [ -z "$runner" ]; then continue; fi
    printf 'run\t%s\t%s\t%s\n' "$conclusion" "$url" "$sha"
    return 0
  done < <(sort -r <<<"$lines")
  printf 'absent\n'
}

# Gate 8's loop. Needs the caller's printers (`ok`, `refuse`, `hint`), `REPO`, `TARGET_SHA`, and the
# released tree checked out (its compose.yml is the pin this stable ships).
miconnect_preflight_gate() {
  local here reading kind conclusion url sha shipped judged tmp verdict
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/authentik/release-lib.sh
  source "$here/../../../infrastructure/authentik/release-lib.sh"
  shipped="$(ak_pin_image infrastructure/authentik/compose.yml 2>/dev/null)" || shipped=''
  reading="$(miconnect_preflight_reading "$TARGET_SHA")"
  IFS=$'\t' read -r kind conclusion url sha <<<"$reading"
  judged=''
  case "$kind" in
    run)
      tmp="$(mktemp)"
      if gh api "repos/$REPO/contents/infrastructure/authentik/compose.yml?ref=$sha" -H 'Accept: application/vnd.github.raw' >"$tmp" 2>/dev/null; then
        judged="$(ak_pin_image "$tmp" 2>/dev/null)" || judged=''
        verdict="$(classify_miconnect_preflight "$conclusion" "$judged" "$shipped")"
      else
        verdict="undecidable GET repos/$REPO/contents/infrastructure/authentik/compose.yml?ref=$sha failed"
      fi
      rm -f "$tmp"
      ;;
    absent) verdict=absent conclusion='' url='' ;;
    # An API failure is classified HERE, where it is known, never read later as "no run".
    error) verdict="undecidable $conclusion" url='' ;;
    *) verdict="undecidable the reading came back unparsed" url='' ;;
  esac
  case "$verdict" in
    passed)
      ok "production MiConnect would take $shipped: the preflight passed in $url"
      return 0
      ;;
    failed*)
      refuse "production MiConnect's preflight on $shipped concluded '${verdict#failed }' in $url"
      hint 'Its MiConnect step runs AFTER both stores took the version, so refusing there would ship half a'
      hint 'stable. Read that run: it names what blocks the upgrade and the exact hand command.'
      ;;
    stale*)
      refuse "the newest MiConnect preflight ($url) judged ${verdict#stale }, not the $shipped this stable ships"
      ;;
    absent)
      refuse "no '$MICONNECT_PREFLIGHT_CHECK' run reached a verdict on ${TARGET_SHA:0:8} nor on main's last 50 commits (skipped runs and runs cancelled before they started are not verdicts)"
      ;;
    *)
      refuse "could not decide - ${verdict#undecidable }${url:+ (run: $url)}"
      ;;
  esac
  hint "Ask it now for this commit: gh workflow run scheduled.yml --ref <the latest v\$VERSION-alpha.N tag> -f job=miconnect-preflight"
  hint "then re-run this release's preflight once it is green: gh run rerun ${GITHUB_RUN_ID:-<this run>}"
}
