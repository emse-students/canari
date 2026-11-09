# shellcheck shell=bash
#
# Did Docker's DNS fail the two nginx in front of the estate? A READ-ONLY daily report.
#
# WHY THIS EXISTS (2026-11-02 review of the target lists). Since the replica lists became variable
# targets, EVERY request the frontend proxies and every connection the edge relays waits on Docker's
# resolver for its target - at rest the service's DNS name, during a take-out the new replica's
# container name (docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to). A resolver that
# fails does not degrade quietly: the request fails after `resolver_timeout` (2 s). So the nginx error
# log's `<host> could not be resolved (<code>: <reason>)` lines are the evidence, and nothing read
# them. This counts them over the last RESOLVER_REPORT_HOURS, per proxy container and per host, and
# goes RED on the ones no design explains:
#
#  - any failure that is not "Host not found" (a timeout, a server failure): Docker's DNS itself;
#  - "Host not found" for a host that is not an `exclusive` service of the estate - an `overlap`
#    service always has a replica, and a container's name (`canari-core-service-2`) is a take-out
#    that outlived its container.
#
# "Host not found" for an `exclusive` service (media-service, call-service: recreated in place, the
# gap cicd.md owns) is printed with its count and is not red: it is the measure of that known gap.
# The classification reads the estate's own labels (`canari.deploy.replace`), never a list kept here.

# The estates read - the two this repository deploys - and the proxies in front of each.
# shellcheck disable=SC2034 # read by resolver-report.sh
RESOLVER_REPORT_PROJECTS="canari-prod canari-dev"
RESOLVER_REPORT_PROXIES="edge frontend"
# One day: the job runs daily, so each line is read once.
RESOLVER_REPORT_HOURS=24

# resolver_failure_lines <docker-cli> <container> <hours> - prints the container's error-log lines of
# the last <hours> naming a resolution failure, and RETURNS docker's own verdict: a log that could not
# be read must never pass for a log with no failure.
resolver_failure_lines() {
  local docker_cli="$1" id="$2" hours="$3" out rc
  # shellcheck disable=SC2086 # DOCKER_CLI may be "sudo docker"
  out="$($docker_cli logs --since "${hours}h" "$id" 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || {
    printf '%s' "$out"
    return 1
  }
  printf '%s\n' "$out" | grep -E 'could not be resolved|resolver timed out' || true
}

# resolver_is_exclusive <docker-cli> <project> <host> - whether <host> is a service of <project>
# declared `exclusive` (recreated in place, so briefly absent from DNS by design).
resolver_is_exclusive() {
  local docker_cli="$1" project="$2" host="$3"
  # shellcheck disable=SC2086
  [ -n "$($docker_cli ps -a -q --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$host" --filter "label=canari.deploy.replace=exclusive")" ]
}

# report_resolver_failures <docker-cli> <project> - prints one line per proxy container and per
# failing host, and returns 1 when a failure no design explains was found, or a log could not be read.
report_resolver_failures() {
  local docker_cli="$1" project="$2" proxy ids id name lines count host code reason status=0
  for proxy in $RESOLVER_REPORT_PROXIES; do
    # shellcheck disable=SC2086
    ids="$($docker_cli ps -a -q --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$proxy")" || {
      printf '::error::resolver: cannot list the %s containers of %s - their logs were not read\n' "$proxy" "$project" >&2
      status=1
      continue
    }
    for id in $ids; do
      # shellcheck disable=SC2086
      name="$($docker_cli inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
      [ -n "$name" ] || name="$id"
      if ! lines="$(resolver_failure_lines "$docker_cli" "$id" "$RESOLVER_REPORT_HOURS")"; then
        printf '::error::resolver: could not read the log of %s, so its DNS failures are unknown: %s\n' \
          "$name" "${lines:-docker logs failed with no output}" >&2
        status=1
        continue
      fi
      if [ -z "$lines" ]; then
        printf 'resolver: %s - no resolution failure in the last %sh\n' "$name" "$RESOLVER_REPORT_HOURS"
        continue
      fi
      # One row per (host, code, reason): `could not be resolved (3: Host not found)`; a line in no
      # such shape (`resolver timed out`) is its own row, host unknown.
      while read -r count host code reason; do
        if [ "$code" = 3 ] && resolver_is_exclusive "$docker_cli" "$project" "$host"; then
          printf 'resolver: %s - %s x%s "Host not found": an exclusive service recreated in place (its known gap)\n' \
            "$name" "$host" "$count"
        else
          printf '::error title=A proxy could not resolve its target::%s could not resolve %s %s time(s) in %sh (%s: %s) - %s\n' \
            "$name" "$host" "$count" "$RESOLVER_REPORT_HOURS" "$code" "$reason" \
            "$([ "$code" = 3 ] && echo 'no replica answered to that name: a service that must always have one, or a take-out that outlived its container' || echo "Docker's DNS itself failed")" >&2
          status=1
        fi
      done < <(printf '%s\n' "$lines" | sed -nE \
        -e 's/.* ([A-Za-z0-9._-]+) could not be resolved \(([0-9]+): ([^)]*)\).*/\1 \2 \3/p' \
        -e '/could not be resolved \(/!s/.*resolver timed out.*/unknown 110 resolver timed out/p' |
        sort | uniq -c)
    done
  done
  return "$status"
}
