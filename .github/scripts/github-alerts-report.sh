#!/bin/bash
# =================================================================================================
# WHAT GITHUB KNOWS ABOUT THIS REPOSITORY - ITS DEPENDENCIES AND ITS CODE - AND NO GATE HERE READS.
#
# WHY IT EXISTS, AND IT IS NOT A DUPLICATE OF THE AUDIT. Three mechanisms are supposed to keep a
# vulnerable dependency out of this tree, and on 2026-09-04 all three were blind to the same one at
# the same time:
#
#   * Dependabot could not open the pull request. `frontend/src-tauri` and its customtabs plugin
#     declare a `links` key, which cargo refuses in the manifest-only checkout Dependabot
#     materialises - so the app that ships to phones has had no automated update since 2026-08-08.
#     `.github/scripts/tests/dependabot-cargo-reach.test.sh` asserts that blindness rather than
#     letting it be noticed again.
#   * `cargo audit` could not see the advisory. GHSA-7gcf-g7xr-8hxj (serde_with 3.19.0, a panic on
#     an empty `KeyValueMap` entry) is GHSA-only and is not in the RustSec database `cargo audit`
#     reads. Run by hand on the unbumped tree it exited 0. A green Rust pass is not evidence about
#     GHSA at all.
#   * Nothing read GitHub's own alert list, which is the ONLY place that advisory ever appeared. It
#     was found because a `git push` happened to print a line about it.
#
# This is the third one. `GET /repos/{owner}/{repo}/dependabot/alerts` is GitHub's own view, fed by
# the advisory database that raised the alert, and it needs no manifest it can parse and no second
# vulnerability database.
#
# WHY THE NIGHTLY AND NOWHERE ELSE. The alert list is a property of the DEFAULT BRANCH, not of a
# pull request's tree: a pull request can neither be blamed for an open alert it did not introduce
# nor sensibly blocked by one. Putting it in the pull-request path would wall every merge in the
# repository on a fact about `main`, which is the shape of gate this repository refuses.
#
# WHY A RED RUN IS THE REPORT. There is no alerting in this estate - both outages of 2026-09-01 were
# reported by the USER. What is actually read here is `gh run list`, so a failing run is the only
# channel that already exists, and every finding is emitted as an `error` annotation so it is
# legible in the run summary without opening a log.
#
# THE EMPTY ANSWER IS THE WHOLE DIFFICULTY, and it is why this is not four lines of `gh api`. An
# empty list has four causes and only one of them is health:
#
#   | reading                          | what it means                                             |
#   | -------------------------------- | --------------------------------------------------------- |
#   | 200, zero open alerts            | health - GitHub has looked and has nothing                  |
#   | 403                              | the token may not read alerts; NOTHING has looked           |
#   | 404                              | Dependabot alerts are DISABLED, or the repo name is wrong   |
#   | no response at all               | a transport failure, which is not an answer to anything     |
#
# The last three are reported as failures, loudly and by name. A reporter that prints "0 open
# alerts" when it was refused is the exact defect this file was written to end - a correct mechanism
# with no report, wearing the mask of a clean one.
#
# WHAT A FINDING CARRIES. Severity, the GHSA id, the package, the ecosystem and the MANIFEST PATH -
# because the path is what says whether anything will ever fix it on its own. An open alert against
# `frontend/src-tauri/Cargo.lock` is strictly worse than the same alert anywhere else in this
# repository: that is one of the two directories Dependabot cannot open a pull request for, so it
# will sit there until a human bumps it. The report does not re-derive which directories those are -
# the derivation lives in `dependabot-cargo-reach.test.sh` and one implementation is the rule - it
# prints the path and lets the reader make the join the backlog entry already documents.
#
# AND THE SAME SILENCE HELD FOR CODE SCANNING, SO THE SAME READER ASKS IT (2026-10-04). The `CodeQL`
# check on a pull request refuses only a NEW alert, so a STANDING one fails nothing: alert 2521 stood
# four weeks named by no page, and 2544 was found the same way, by listing them by hand. The first
# argument picks the list - `dependabot` (the default) or `code-scanning` - and everything else, the
# four causes of an empty answer and the red run as the report, is the same code. Code scanning
# alerts ARE readable by `GITHUB_TOKEN` under `security-events: read`, so that half needs no secret.
# A false positive is closed by DISMISSING it on GitHub, which is the one channel that records why.
#
# Structure follows `infrastructure/deploy/host-update-report.sh`: `gather` talks to GitHub and
# writes facts, `judge` reads facts and decides. They are separate so the self-test can drive the
# judgement on a fixture without a network, a token or a repository.
# =================================================================================================
set -uo pipefail

REPO_SLUG="${GITHUB_REPOSITORY:-}"

# The API path of each alert list this reader knows. An unknown source is refused at `main`, so a
# typo in the workflow is a red run naming it rather than a report about the wrong list.
alerts_path() {
  case "$1" in
    dependabot) printf 'dependabot/alerts' ;;
    code-scanning) printf 'code-scanning/alerts' ;;
    *) return 1 ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# gather <facts-file> <source>
#
# Asks GitHub, and writes what it learnt as shell assignments. It records the TRANSPORT outcome
# separately from the payload, because "the request failed" and "the answer is empty" are the two
# things this whole file exists to keep apart.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
gather() {
  local facts="$1" source="$2" body status
  : >"$facts"
  printf 'alert_source=%s
' "$source" >>"$facts"

  if [ -z "$REPO_SLUG" ]; then
    printf 'transport=%s\n' 'no-repo' >>"$facts"
    return 0
  fi

  # `--include` gives the status line, so a refusal is a STATUS rather than an empty body. Errors
  # are captured with it: `gh` writes its diagnosis to stderr and a discarded diagnosis is how a
  # report ends up naming the wrong cause.
  body="$(gh api --include --paginate \
    -H 'Accept: application/vnd.github+json' \
    "repos/${REPO_SLUG}/$(alerts_path "$source")?state=open&per_page=100" 2>&1)"
  status="$?"

  if [ "$status" -ne 0 ]; then
    # A status code IS an answer; anything else is a transport failure. Both fail this run, and they
    # fail it saying different things.
    case "$body" in
      *' 403'*) printf 'transport=%s\n' 'forbidden' >>"$facts" ;;
      *' 404'*) printf 'transport=%s\n' 'not-found' >>"$facts" ;;
      *) printf 'transport=%s\n' 'unreachable' >>"$facts" ;;
    esac
    printf 'detail=%q\n' "$(printf '%s' "$body" | tail -3 | tr '\n' ' ')" >>"$facts"
    return 0
  fi

  printf 'transport=%s\n' 'ok' >>"$facts"
  # Strip the header block `--include` prepended, leaving the JSON array(s) the pager returned.
  printf 'alerts=%q\n' "$(printf '%s' "$body" | sed -n '/^\[/,$p')" >>"$facts"
}

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# judge <facts-file>
#
# Reads facts, prints the report, and exits non-zero when this repository is carrying an open alert
# or when nothing was able to look.
# ─────────────────────────────────────────────────────────────────────────────────────────────────
judge() {
  local facts="$1" problems=0 count described label
  # shellcheck disable=SC1090
  . "$facts"
  # A facts file written before the source existed is a Dependabot one, which keeps every fixture
  # of the original report meaning what it meant.
  case "${alert_source:-dependabot}" in
    dependabot) label='Dependabot' ;;
    code-scanning) label='code scanning' ;;
    *)
      printf '::error::Unknown alert source "%s". This report knows dependabot and code-scanning; it has looked at NOTHING.
' "${alert_source}"
      return 1
      ;;
  esac

  case "${transport:-unreachable}" in
    ok) ;;
    no-repo)
      printf '::error::GITHUB_REPOSITORY is unset, so no repository was asked about. This report has looked at NOTHING; it has not found nothing.
'
      return 1
      ;;
    forbidden)
      if [ "$label" = 'Dependabot' ]; then
        # THE OLD MESSAGE NAMED A PERMISSION THE JOB ALREADY HAS, SO IT SENT ITS READER NOWHERE.
        # It said "the job needs security-events: read" - `scheduled.yml` declares exactly that, and
        # every nightly run since this was written has failed anyway. `security-events` covers code
        # scanning and secret scanning; Dependabot alerts are a different resource with NO
        # `permissions:` key at all, so GITHUB_TOKEN cannot read them at any setting. Only a PAT or
        # a GitHub App holding the fine-grained "Dependabot alerts: read" repository permission can,
        # which is a credential a human mints once - so the message names that, not the symptom.
        printf '::error::GitHub refused to list this repository Dependabot alerts (403), and NO workflow permission can lift it: GITHUB_TOKEN cannot read Dependabot alerts at all - there is no "permissions:" key for them, and "security-events" is code scanning. This job reads secrets.DEPENDABOT_ALERTS_TOKEN when it exists; mint one with the fine-grained "Dependabot alerts: read" permission on this repository and the job runs unattended. NOTHING has looked - this is not a clean report. %s
' "${detail:-}"
      else
        # Here the permission IS the remedy: code scanning is exactly what `security-events` covers.
        printf '::error::GitHub refused to list this repository code scanning alerts (403). The job token needs "security-events: read" in scheduled.yml. NOTHING has looked - this is not a clean report. %s
' "${detail:-}"
      fi
      return 1
      ;;
    not-found)
      printf '::error::GitHub has no %s alert list for this repository (404): the feature is DISABLED, or the slug is wrong. A disabled alert list reads exactly like a clean one, which is the defect this report exists to end. %s
' "$label" "${detail:-}"
      return 1
      ;;
    *)
      printf '::error::Could not reach the %s alerts API at all. A transport failure is not an answer, and nothing is behind this run, so it is reported rather than tolerated. %s
' "$label" "${detail:-}"
      return 1
      ;;
  esac

  count="$(printf '%s' "${alerts:-[]}" | jq -s '[.[][]] | length' 2>/dev/null)"
  if [ -z "$count" ]; then
    printf '::error::The alert list came back and could not be parsed as JSON. Reporting that, rather than reading it as zero alerts.
'
    return 1
  fi

  if [ "$count" -eq 0 ]; then
    printf 'ok   GitHub holds no open %s alert for this repository.
' "$label"
    return 0
  fi

  # One line per alert, each naming the thing that decides what to do next: for a dependency, the
  # manifest (whether anything will fix it on its own); for code, the rule and the line it sits on.
  # A field the reader expects and does not find yields no line, so a changed shape is caught below
  # rather than printed as "null".
  if [ "$label" = 'Dependabot' ]; then
    described="$(printf '%s' "$alerts" | jq -rs '
      [.[][]]
      | sort_by(.security_advisory.severity)
      | .[]
      | select(.security_advisory.ghsa_id != null)
      | "open Dependabot alert #\(.number) [\(.security_advisory.severity)] \(.security_advisory.ghsa_id): "
        + "\(.dependency.package.ecosystem) package \(.dependency.package.name) in \(.dependency.manifest_path // "an unnamed manifest")"
        + (if .security_vulnerability.first_patched_version.identifier
           then " - patched in \(.security_vulnerability.first_patched_version.identifier)"
           else " - NO patched version published" end)
    ' 2>/dev/null)"
  else
    described="$(printf '%s' "$alerts" | jq -rs '
      [.[][]]
      | .[]
      | select(.rule.id != null)
      | "open code scanning alert #\(.number) [\(.rule.security_severity_level // .rule.severity // "unrated")] \(.rule.id): "
        + "\(.most_recent_instance.location.path // "an unnamed file"):\(.most_recent_instance.location.start_line // "?")"
        + " (\(.tool.name // "an unnamed tool"))"
    ' 2>/dev/null)"
  fi

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '::error::%s
' "$line"
    problems=$((problems + 1))
  done <<<"$described"

  if [ "$problems" -eq 0 ]; then
    printf '::error::%s open alert(s) were counted and none could be described. The shape of the response changed; fix this reader rather than believing the silence.
' "$count"
    return 1
  fi

  if [ "$label" = 'Dependabot' ]; then
    printf '
%s open Dependabot alert(s). An alert in a manifest Dependabot cannot open a pull request for will not fix itself - see docs/wiki/backlog.md.
' "$problems"
  else
    printf '
%s open code scanning alert(s). The pull-request check refuses only NEW ones, so nothing else will ever name these: fix the code, or dismiss a false positive on GitHub with its reason.
' "$problems"
  fi
  return 1
}

# main [dependabot|code-scanning] - the list to read, Dependabot when omitted.
main() {
  local facts source="${1:-dependabot}"
  if ! alerts_path "$source" >/dev/null; then
    printf '::error::Unknown alert source "%s". This report knows dependabot and code-scanning.
' "$source"
    return 1
  fi
  facts="$(mktemp)"
  # shellcheck disable=SC2064  # expand `$facts` now, deliberately
  trap "rm -f '$facts'" EXIT
  gather "$facts" "$source"
  judge "$facts"
}

# Sourced by the self-test, run directly by the workflow.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
