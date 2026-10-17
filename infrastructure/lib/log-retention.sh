# shellcheck shell=bash
#
# Is any container log of this project older than the privacy policy allows? A READ-ONLY report.
#
# THE PROMISE (frontend/src/routes/legal/privacy/+page.svelte): "Logs techniques (IP, horodatage) :
# conserves au maximum 90 jours a des fins de securite, puis supprimes automatiquement". The
# frontend's nginx writes every client's address into its container log (`canari_redacted` in
# infrastructure/local/Dockerfile.frontend), and every other service writes user ids into its own.
#
# WHY A SIZE CAP IS NOT THE ANSWER. `json-file` with `max-size: 10m` / `max-file: "3"` bounds the
# BYTES a container keeps, never their age: the oldest line held is the one written 30 MB ago, and
# on a quiet container - postgres, garage, redis, an estate over the summer - that is months. Docker
# has no time-based rotation, and a container's log is deleted only with the container, so the one
# operation that bounds a live log in time is RECREATING its container.
#
# WHY THIS ONLY REPORTS. Recreating a production container unattended is a production change, and
# that is the user's decision, not this script's (docs/wiki/infrastructure/logging.md, "the 90-day
# ceiling"). So each container's log is ASKED for a line older than LOG_LIVE_MAX_DAYS
# (`docker logs --until`) - the log itself is the evidence, never the container's creation date, so
# a busy container whose rotation already dropped its old lines is not reported - and the run goes
# RED naming every container that holds one, with the line's date. The archive half IS enforced:
# prune_log_archive (archive-logs.sh) deletes what this project wrote, and touches no container.
#
# Requires archive-logs.sh to be sourced first (its constants).

# A live line older than this is reported, which leaves 30 days to act before the promise breaks.
LOG_LIVE_MAX_DAYS=60
# The estates whose containers are read - the two this repository deploys. Authentik's stack
# (`miconnect`) is not deployed by a pipeline (docs/wiki/infrastructure/dsi-log-retention-request.md).
# shellcheck disable=SC2034 # read by log-retention-report.sh
LOG_RETENTION_PROJECTS="canari-prod canari-dev"

# log_oldest_line_before <docker-cli> <container> <hours> - prints the first line of the container's
# log older than <hours>, empty when there is none, and RETURNS docker's own verdict: non-zero when
# the log could not be read. The status decides "unreadable", never the shape of the output - a CLI
# that fails silently would otherwise read as a log holding nothing old, a green run.
log_oldest_line_before() {
  local docker_cli="$1" id="$2" hours="$3" out rc
  # shellcheck disable=SC2086 # DOCKER_CLI may be "sudo docker"
  out="$($docker_cli logs --timestamps --until "${hours}h" "$id" 2>&1 | head -n 1
    exit "${PIPESTATUS[0]}")"
  rc=$?
  printf '%s' "$out"
  # 141 is docker killed by SIGPIPE once `head` had its line: the read succeeded.
  [ "$rc" -eq 0 ] || [ "$rc" -eq 141 ]
}

# report_live_log_age <docker-cli> <project> - prints one line per container of the estate and
# returns 1 when any log holds a line older than LOG_LIVE_MAX_DAYS, or could not be read.
report_live_log_age() {
  local docker_cli="$1" project="$2"
  local ids id name first stamp promise_cut status=0
  promise_cut="$(date -u -d "-${LOG_PROMISE_DAYS} days" +%Y-%m-%dT%H:%M:%S)"

  # shellcheck disable=SC2086
  ids="$($docker_cli ps -a -q --filter "label=com.docker.compose.project=$project")" || {
    printf '::error::log-retention: cannot list the containers of %s - their logs were not checked\n' "$project" >&2
    return 1
  }
  if [ -z "$ids" ]; then
    printf 'log-retention: %s has no container - nothing to check\n' "$project"
    return 0
  fi

  for id in $ids; do
    # shellcheck disable=SC2086
    name="$($docker_cli inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
    [ -n "$name" ] || name="$id"
    if ! first="$(log_oldest_line_before "$docker_cli" "$id" "$((LOG_LIVE_MAX_DAYS * 24))")"; then
      # An inability to measure is not a failing measurement: it is named as what it is.
      printf '::error::log-retention: could not read the log of %s, so its age is unknown: %s\n' "$name" "${first:-docker logs failed with no output}" >&2
      status=1
      continue
    fi
    if [ -z "$first" ]; then
      printf 'log-retention: %s holds nothing older than %s days\n' "$name" "$LOG_LIVE_MAX_DAYS"
      continue
    fi
    if ! [[ "$first" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}) ]]; then
      # A read docker called successful whose first line carries no timestamp: unknown age too.
      printf '::error::log-retention: the log of %s answered a line with no timestamp, so its age is unknown: %s\n' "$name" "$first" >&2
      status=1
      continue
    fi
    stamp="${BASH_REMATCH[1]}"
    status=1
    if [[ "$stamp" < "$promise_cut" ]]; then
      printf '::error title=Privacy policy broken::%s holds a line from %sZ, older than the %s days the privacy policy promises - recreate it now\n' \
        "$name" "$stamp" "$LOG_PROMISE_DAYS" >&2
    else
      printf '::error title=Container log near the 90-day ceiling::%s holds a line from %sZ, older than %s days - recreate it (docker compose up -d --force-recreate --no-deps <service>) before it reaches %s\n' \
        "$name" "$stamp" "$LOG_LIVE_MAX_DAYS" "$LOG_PROMISE_DAYS" >&2
    fi
  done
  return "$status"
}
