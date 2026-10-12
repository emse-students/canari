# shellcheck shell=bash
#
# Keep a container's log past the container, which a deploy RECREATES.
#
# WHY THIS FILE EXISTS. A json-file log lives in the container's own directory, so `docker compose
# up -d` deleting the old container deleted its log with it: a report arriving hours after a deploy
# met an estate whose evidence had gone (2026-09-21: a wrong conclusion about a post that never
# reached the server, reached from logs that began at the deploy). The `logging:` stanza bounds the
# DISK; this is what outlives the container. journald would have outlived it for free, but the
# deploy user is not in `systemd-journal` on the shared host and cannot read it back, so the sink is
# a directory the deploy user owns. See docs/wiki/infrastructure/logging.md.
#
# One directory per deploy, `<root>/<project>/<UTC stamp>/<container>.log.gz`, and only the newest
# KEEP directories survive: retention is a COUNT of deploys, never a clock. A container whose log
# cannot be read is reported and skipped - the other containers' logs are still worth keeping.
#
# The caller defines nothing; it passes the docker command, the compose project and the root.
#
# Usage:
#   . "$ROOT/infrastructure/lib/archive-logs.sh"
#   archive_logs "$DOCKER_CLI" "$PROJECT" "$HOME/deploy-log-archive" 10

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
    # and a later read can be placed against the deploy it preceded.
    # shellcheck disable=SC2086
    if $docker_cli logs --timestamps "$id" 2>&1 | gzip -c >"$dir/$name.log.gz" &&
      [ "${PIPESTATUS[0]}" -eq 0 ]; then
      kept=$((kept + 1))
    else
      failed=$((failed + 1))
      rm -f "$dir/$name.log.gz"
      printf '::warning::archive-logs: could not read the log of %s\n' "$name" >&2
    fi
  done
  printf 'archive-logs: %s container logs kept in %s (%s unreadable)\n' "$kept" "$dir" "$failed"

  # Retention: the newest KEEP directories. Stamps sort lexically = chronologically.
  for old in $(find "$root/$project" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | tail -n +$((keep + 1))); do
    rm -rf "${root:?}/$project/${old:?}"
    printf 'archive-logs: dropped the oldest archive %s\n' "$old"
  done
}
