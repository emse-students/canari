#!/usr/bin/env bash
# DOES EACH STACK ON THE HOST RUN THE THIRD-PARTY IMAGES ITS RELEASED COMPOSE FILE PINS?
#
#   image-drift-report.sh <compose project>=<compose file> ...
#
# Run daily by `scheduled.yml` (job `drift`), on the self-hosted runner, READ-ONLY: `docker ps` and
# `docker inspect`, nothing else. Each pair names a project and the compose file the release last put
# it on - the tree at `prod-released` for production and MiConnect, at `dev-deployed` for dev and the
# test MiConnect - so an update merged on `main` and not yet released is never called a drift.
#
# Every third-party `image:` of the file (`${VAR:-default}` read as its default; this repository's
# own images left out - the release deploys them by tag) is compared, as a STRING, with
# `.Config.Image` of every running container of that service: compose stores the reference exactly
# as the file wrote it, digest included (measured 2026-11-13 on the shared host). Why it exists:
# 2026-11-13, production MiConnect ran 2026.8.0 for weeks while this repository said 2026.8.5, and
# the image scan read the repository's.
#
# A DRIFT WITH A KNOWN CAUSE AND A DATE is not reported red every morning: `--known <file>` names
# it (`image-drift-known.txt`: project, service, the exact running image, an expiry date, the backlog
# entry), and the line reads `KNOWN ... until <date>` as a `::warning::`. Only that exact image of that
# service passes; anything else about it is still a DRIFT, and the day after its date it is red again.
# Every exemption is printed at the top of the report, so none is forgotten in a file.
#
# Output: one line per service, `ok`, `KNOWN`, `DRIFT` (running vs pinned) or `ABSENT` (pinned, not
# running); each failure also as `::error::`. Exit: 0 all ok or known; 1 any drift or absence; 64 usage.
set -euo pipefail

own_prefix='ghcr.io/emse-students/canari/'

# drift_pins <compose-file> - `service image` per third-party service image of the file. A reference
# still carrying `${` after the defaults are read has no default, so nothing names what it runs.
# shellcheck disable=SC2016 # the literal `${` is what is searched for, not an expansion.
drift_pins() {
  awk '
    /^services:[[:space:]]*$/ { in_services = 1; next }
    /^[^[:space:]#]/ { in_services = 0 }
    in_services && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); next }
    in_services && svc != "" && $1 == "image:" { img = $2; gsub(/^["\047]|["\047]$/, "", img); print svc, img }
  ' "$1" |
    sed -E 's/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/\1/g' |
    grep -vF " $own_prefix" | grep -vF '${' || true
}

# drift_known <known-file> <project> <service> <running> - the exemption's `<expires> <why>` when
# one names exactly this running image, or nothing. Blank and `#` lines are comments.
drift_known() {
  [ -n "$1" ] && [ -r "$1" ] || return 0
  awk -v p="$2" -v s="$3" -v r="$4" '!/^[[:space:]]*(#|$)/ && $1 == p && $2 == s && $3 == r { $1 = $2 = $3 = ""; sub(/^ +/, ""); print; exit }' "$1"
}

# drift_compare <pins-file> <running-file> [<project> <known-file> <today YYYY-MM-DD>] - both
# `service image` lines; prints the verdicts and returns 1 when any service drifted (unexempted, or
# past its exemption's date) or is absent. Pure: the files and the date are the whole input.
drift_compare() {
  local pins="$1" running="$2" project="${3:-}" known="${4:-}" today="${5:-}" bad=0 service image seen exemption expires
  while read -r service image; do
    [ -n "$service" ] || continue
    seen="$(awk -v s="$service" '$1 == s { print $2 }' "$running" | sort -u)"
    if [ -z "$seen" ]; then
      echo "ABSENT $service pinned=$image"
      bad=1
    elif [ "$seen" = "$image" ]; then
      echo "ok $service $image"
    else
      exemption="$(drift_known "$known" "$project" "$service" "$seen")"
      expires="${exemption%% *}"
      if [ -n "$exemption" ] && [[ "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && ! [[ "$today" > "$expires" ]]; then
        echo "KNOWN $service running=$seen pinned=$image until $expires (${exemption#* })"
      else
        echo "DRIFT $service running=$(tr '\n' ' ' <<<"$seen" | sed 's/ $//') pinned=$image${exemption:+ (its exemption has expired or its date is not one: $expires)}"
        bad=1
      fi
    fi
  done <"$pins"
  return "$bad"
}

# running_images <project> - `service image` for every running container of the project.
running_images() {
  local ids
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$1")"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one argument per container id
  docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}}' $ids
}

main() {
  local pair project file status=0 line known="" today
  if [ "${1:-}" = --known ]; then known="${2:?--known needs a file}"; shift 2; fi
  [ $# -gt 0 ] || { echo "usage: image-drift-report.sh [--known <file>] <project>=<compose file> ..." >&2; exit 64; }
  today="$(date -u +%Y-%m-%d)"
  if [ -n "$known" ]; then
    echo "== known drifts, each with its date ($known):"
    grep -vE '^[[:space:]]*(#|$)' "$known" | sed 's/^/  /' || echo "  none"
  fi
  # Global, not local: the EXIT trap runs after main has returned.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  for pair in "$@"; do
    project="${pair%%=*}"
    file="${pair#*=}"
    if [ ! -r "$file" ]; then
      echo "::error title=Image drift ($project)::$file cannot be read, so nothing says what $project should run"
      status=1
      continue
    fi
    drift_pins "$file" >"$work/pins"
    running_images "$project" >"$work/running"
    echo "== $project (pins from ${file})"
    while read -r line; do
      echo "  $line"
      case "$line" in
        DRIFT* | ABSENT*) echo "::error title=Image drift ($project)::$line" ;;
        KNOWN*) echo "::warning title=Image drift ($project), known::$line" ;;
      esac
    done < <(drift_compare "$work/pins" "$work/running" "$project" "$known" "$today" || true)
    drift_compare "$work/pins" "$work/running" "$project" "$known" "$today" >/dev/null || status=1
  done
  return "$status"
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
