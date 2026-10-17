# shellcheck shell=bash
#
# Keep a container's log past the container, which a deploy RECREATES - and never past the age the
# privacy policy promises.
#
# WHY THIS FILE EXISTS. A json-file log lives in the container's own directory, so `docker compose
# up -d` deleting the old container deleted its log with it: a report arriving hours after a deploy
# met an estate whose evidence had gone (2026-09-21: a wrong conclusion about a post that never
# reached the server, reached from logs that began at the deploy). The `logging:` stanza bounds the
# DISK; this is what outlives the container. journald would have outlived it for free, but the
# deploy user is not in `systemd-journal` on the shared host and cannot read it back, so the sink is
# a directory the deploy user owns. See docs/wiki/infrastructure/logging.md.
#
# AND WHY IT IS BOUNDED BY AGE AS WELL AS BY COUNT (2026-10-16). The privacy policy
# (frontend/src/routes/legal/privacy/+page.svelte) promises "Logs techniques (IP, horodatage) :
# conserves au maximum 90 jours [...] puis supprimes automatiquement", and the frontend's access log
# carries every client's address. A count of deploys is no bound in time - ten deploys can span a
# year - so each archive holds only the last LOG_ARCHIVE_WINDOW_DAYS of each log (`--since`), and an
# archive older than LOG_ARCHIVE_WINDOW_DAYS is deleted whatever the count says. A line therefore
# lives at most 2 x LOG_ARCHIVE_WINDOW_DAYS here, plus the gap between two runs of the pruning,
# which runs at every deploy AND daily (infrastructure/deploy/log-retention-report.sh).
#
# One directory per deploy, `<root>/<project>/<UTC stamp>/<container>.log.gz`. A container whose
# log cannot be read is reported and skipped - the other containers' logs are still worth keeping.
#
# The caller defines nothing; it passes the docker command, the compose project and the root.
#
# Usage:
#   . "$ROOT/infrastructure/lib/archive-logs.sh"
#   archive_logs "$DOCKER_CLI" "$PROJECT" "$LOG_ARCHIVE_ROOT" 10

# What the privacy policy promises, in days. Everything below is derived to stay under it.
# shellcheck disable=SC2034 # read by the files that source this one
LOG_PROMISE_DAYS=90
# How far back an archive reaches into a log, and how long the archive itself is kept. Two of these
# end-to-end are 60 days, which leaves 30 days of slack for runs of the daily pruning that never
# happen (a dropped GitHub schedule, a runner offline) before the promise is at stake.
LOG_ARCHIVE_WINDOW_DAYS=30
# Where the archives live, ONE definition for the deploy and the daily enforcement: both run as the
# runner account, so `$HOME` is the same directory for both.
# shellcheck disable=SC2034 # read by the files that source this one
LOG_ARCHIVE_ROOT="${CANARI_LOG_ARCHIVE:-$HOME/deploy-log-archive}"

# log_stamp_days_ago <days> - the UTC instant N days ago, in the archive's directory-stamp format,
# so that a lexical comparison of two stamps is a chronological one.
log_stamp_days_ago() {
  date -u -d "-$1 days" +%Y%m%dT%H%M%SZ
}

# prune_log_archive <root> <project> - deletes every archive of the project older than
# LOG_ARCHIVE_WINDOW_DAYS. ALLOWLIST: only a directory named like a stamp this file writes is ever
# removed; anything else is reported and left, because its age is unknown. Returns 1 when an entry
# could not be judged or a removal did not take, so the daily run can go red on it.
prune_log_archive() {
  local root="$1" project="$2" cutoff name listing status=0
  [ -d "$root/$project" ] || return 0
  cutoff="$(log_stamp_days_ago "$LOG_ARCHIVE_WINDOW_DAYS")"
  # Listed first, so a `find` that fails is a red run rather than an empty loop that passes.
  if ! listing="$(find "$root/$project" -mindepth 1 -maxdepth 1 -printf '%f\n')"; then
    printf '::error::log-retention: cannot list %s/%s - its archives were not pruned\n' "$root" "$project" >&2
    return 1
  fi
  for name in $(printf '%s\n' "$listing" | sort); do
    if ! [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || [ ! -d "$root/$project/$name" ]; then
      printf '::warning::log-retention: %s/%s is not an archive this script wrote - left in place, and its age is unknown\n' \
        "$project" "$name" >&2
      status=1
      continue
    fi
    [[ "$name" < "$cutoff" ]] || continue
    rm -rf "${root:?}/$project/${name:?}"
    # A bulk removal on the shared host can be killed half-way with no diagnostic: the state is
    # what is checked, never the exit status (docs/wiki/durable-rules.md, the shared host).
    if [ -e "$root/$project/$name" ]; then
      printf '::error::log-retention: %s/%s is older than %s days and could not be removed\n' \
        "$project" "$name" "$LOG_ARCHIVE_WINDOW_DAYS" >&2
      status=1
    else
      printf 'log-retention: dropped the archive %s/%s (older than %s days)\n' \
        "$project" "$name" "$LOG_ARCHIVE_WINDOW_DAYS"
    fi
  done
  return "$status"
}

archive_logs() {
  local docker_cli="$1" project="$2" root="$3" keep="$4"
  local stamp dir ids id name kept=0 failed=0 old

  # shellcheck disable=SC2086 # DOCKER_CLI may be "sudo docker"
  ids="$($docker_cli ps -a -q --filter "label=com.docker.compose.project=$project")" || {
    printf '::warning::archive-logs: cannot list the containers of %s - their logs will not be kept\n' "$project" >&2
    return 0
  }
  if [ -z "$ids" ]; then
    printf 'archive-logs: %s has no container yet - nothing to keep\n' "$project"
    return 0
  fi

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$root/$project/$stamp"
  mkdir -p "$dir" || {
    printf '::warning::archive-logs: cannot create %s - the logs of %s will not be kept\n' "$dir" "$project" >&2
    return 0
  }

  for id in $ids; do
    # shellcheck disable=SC2086
    name="$($docker_cli inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
    [ -n "$name" ] || name="$id"
    # stdout and stderr are both the record; `--timestamps` so a line survives the file's rotation
    # and a later read can be placed against the deploy it preceded. `--since` keeps the archive
    # inside the retention window: a quiet container can hold months in its 30 MB.
    # shellcheck disable=SC2086
    if $docker_cli logs --timestamps --since "$((LOG_ARCHIVE_WINDOW_DAYS * 24))h" "$id" 2>&1 |
      gzip -c >"$dir/$name.log.gz" &&
      [ "${PIPESTATUS[0]}" -eq 0 ]; then
      kept=$((kept + 1))
    else
      failed=$((failed + 1))
      rm -f "$dir/$name.log.gz"
      printf '::warning::archive-logs: could not read the log of %s\n' "$name" >&2
    fi
  done
  printf 'archive-logs: %s container logs kept in %s (%s unreadable)\n' "$kept" "$dir" "$failed"

  # Retention by COUNT: the newest KEEP directories. Stamps sort lexically = chronologically.
  for old in $(find "$root/$project" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | tail -n +$((keep + 1))); do
    rm -rf "${root:?}/$project/${old:?}"
    printf 'archive-logs: dropped the oldest archive %s\n' "$old"
  done
  # And by AGE, whatever the count: the privacy policy's ceiling. A failure here is reported by
  # prune_log_archive itself and is not a reason to fail the deploy that called it - the daily run
  # repeats the prune and goes red on it.
  prune_log_archive "$root" "$project" || true
}
