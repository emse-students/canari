# shellcheck shell=bash
#
# FROZEN - NOT CODE THIS REPOSITORY RUNS. infrastructure/lib/rolling.sh as every release before the
# replica lists shipped it (main at 489cf82b9, 2026-11-01), kept byte for byte below this header so
# deploy-rolling.test.sh can run a ROLLBACK the way one really happens: re-running an older
# release's deploy runs THAT release's library, which never rewrites the lists. Never edit the body;
# docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to says why it must keep working.
#
# How a release replaces the services of an estate without taking the estate off the air.
#
# WHY THIS FILE EXISTS (2026-10-17). The deploy ended in one `docker compose up -d`, which RECREATES
# every container whose image moved - and every release moves every image this repository builds. A
# recreate stops the old container before the new one has booted, so for the minute or two a release
# took, nginx had nothing to proxy to: a member with the app open got `502`, and a message sent in
# that window showed "Echec de l'envoi" (backlog, 2026-10-09). The window was the release, every
# release. docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to.
#
# WHAT IT DOES INSTEAD, per service, in the order `replace-modes.py` derives from `depends_on`:
#
#   overlap    the new container starts BESIDE the old one (`--scale` to one more, `--no-recreate`),
#              and the old one is retired only once the new one is HEALTHY and every nginx in front
#              of it has had time to learn its address. Retiring sends SIGTERM, which the services
#              answer by closing their listener and finishing what is in flight (`drain-on-sigterm`
#              in each NestJS service, axum's graceful shutdown in the gateway, nginx's own SIGQUIT,
#              adapter-node's own handler): a new connection to the old replica is REFUSED, and a
#              refused connect is the one failure nginx hands to the next address without having sent
#              a byte - so it reaches the new replica instead of becoming a 502.
#   exclusive  stopped, then started, as before: a gap, for a service that keeps state in its own
#              process and would split it if two ran at once.
#   pinned     brought up as it is; recreated only when its own definition changes (a datastore's
#              digest, the edge's image), which a release does not do.
#
# A NEW REPLICA THAT NEVER BECOMES HEALTHY IS REMOVED AND THE OLD ONE KEEPS SERVING. The deploy then
# fails, loudly, on an estate that is still up - the opposite of the old order, where the failure was
# discovered by the estate being down.
#
# The caller defines `dc` (its compose invocation), `DOCKER_CLI`, `PROJECT` (the compose project,
# read from the file's `name:`) and `on_port_conflict <service>` (frees a host port held by a stale
# container it is allowed to remove, or returns 1), and runs from the repository root.
#
# Usage:
#   . "$ROOT/infrastructure/lib/rolling.sh"
#   replace_services <<<"$(dc config --format json | python3 infrastructure/lib/replace-modes.py ...)"

# HOW LONG AN nginx IN FRONT OF A SERVICE KEEPS A RESOLVED ADDRESS - `resolver 127.0.0.11 valid=2s`
# in BOTH nginx configurations (the edge's, and the frontend's in Dockerfile.frontend). The old
# replica must not stop listening before every nginx has re-resolved the name at least once since the
# new replica appeared, or an nginx whose cache still names only the old address has no other address
# to fail over to. This is not a guess at a delay: it is the cache's own lifetime, read by
# `deploy-replace.test.sh` out of both configurations and required to equal this number.
ROLLING_RESOLVER_TTL_SECONDS=2

# How long a retired replica may take to finish what is in flight before Docker kills it. A drained
# NestJS replica exits by itself as soon as its last request is answered; this bounds the one that
# cannot (an hour-long WebSocket on the frontend or the gateway, which the client re-opens).
ROLLING_DRAIN_SECONDS="${ROLLING_DRAIN_SECONDS:-10}"

# How many 2-second health reads a new replica gets before it is declared broken. Bounds the FAILURE
# case only: a healthy replica is believed the moment Docker says so.
ROLLING_HEALTH_ATTEMPTS="${ROLLING_HEALTH_ATTEMPTS:-90}"

# containers_of <service> - every container of that service in this project, running or not, one id
# per line. One-off `compose run` containers are not replicas and are left out.
containers_of() {
  $DOCKER_CLI ps -aq \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" \
    --filter "label=com.docker.compose.oneoff=False"
}

# wait_healthy <container> <service> - returns 0 once the container is healthy (or merely running,
# when its definition declares no healthcheck), 1 as soon as it is unhealthy or has stopped, and 1
# when ROLLING_HEALTH_ATTEMPTS reads have passed without either.
wait_healthy() {
  local cid="$1" service="$2" state attempt
  for attempt in $(seq 1 "$ROLLING_HEALTH_ATTEMPTS"); do
    state="$($DOCKER_CLI inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo 'gone none')"
    case "$state" in
    'running healthy' | 'running none')
      printf '  %s: %s is %s after %s read(s)\n' "$service" "${cid:0:12}" "${state#running }" "$attempt"
      return 0
      ;;
    'running starting') ;;
    *)
      printf '::error::%s: the new replica %s is %s\n' "$service" "${cid:0:12}" "$state" >&2
      $DOCKER_CLI logs --tail 40 "$cid" >&2 2>&1 || true
      return 1
      ;;
    esac
    sleep 2
  done
  printf '::error::%s: the new replica %s was not healthy after %s reads (last state: %s)\n' \
    "$service" "${cid:0:12}" "$ROLLING_HEALTH_ATTEMPTS" "$state" >&2
  $DOCKER_CLI logs --tail 40 "$cid" >&2 2>&1 || true
  return 1
}

# EVERY COMMAND BELOW THAT CAN FAIL SAYS `|| return 1`: the caller runs `replace_services` under
# `if !`, which switches `set -e` off for everything inside it, so an unchecked failure here would be
# walked straight past.
#
# retire <service> <container...> - drains and removes the given replicas. `docker stop` sends the
# image's stop signal and waits ROLLING_DRAIN_SECONDS for the process to leave by itself.
retire() {
  local service="$1" cid
  shift
  for cid in "$@"; do
    printf '  %s: retiring %s (drain up to %ss)\n' "$service" "${cid:0:12}" "$ROLLING_DRAIN_SECONDS"
    $DOCKER_CLI stop --time "$ROLLING_DRAIN_SECONDS" "$cid" >/dev/null || return 1
    $DOCKER_CLI rm "$cid" >/dev/null || return 1
  done
}

# replace_overlap <service> - the new replica beside the old, then the old one out.
replace_overlap() {
  local service="$1" old new count cid
  old="$(containers_of "$service")"
  count="$(printf '%s' "$old" | grep -c . || true)"

  if [ "$count" -eq 0 ]; then
    # Nothing to overlap with: the estate's first deploy, or a service added by this release.
    printf '%s: no running replica - starting the first one\n' "$service"
    dc up -d --no-deps "$service" || return 1
    new="$(containers_of "$service")"
    wait_healthy "$new" "$service"
    return
  fi

  printf '%s: starting a new replica beside %s running one(s)\n' "$service" "$count"
  # `--no-recreate` is what keeps the old replica serving: without it compose RECREATES a replica
  # whose definition moved - which, for a release, is every one - and that recreate is the outage.
  dc up -d --no-deps --no-recreate --scale "$service=$((count + 1))" "$service" || return 1

  new=""
  for cid in $(containers_of "$service"); do
    printf '%s\n' "$old" | grep -qx "$cid" || new="$new $cid"
  done
  new="${new# }"
  case "$new" in
  '' | *' '*)
    printf '::error::%s: expected exactly one new replica beside %s, found "%s"\n' \
      "$service" "$(printf '%s' "$old" | tr '\n' ' ')" "$new" >&2
    return 1
    ;;
  esac

  if ! wait_healthy "$new" "$service"; then
    # The old replica has not been touched, so the estate is still serving this service. Remove what
    # failed and stop the deploy; nothing a member sees has changed.
    printf '::error::%s: the new replica never became healthy - removing it; the old replica is still serving\n' "$service" >&2
    $DOCKER_CLI rm -f "$new" >/dev/null || true
    return 1
  fi

  # Every nginx in front of this service re-resolves its name at least once in this time, so each
  # one now names the new replica - see ROLLING_RESOLVER_TTL_SECONDS.
  sleep $((ROLLING_RESOLVER_TTL_SECONDS + 1))
  # shellcheck disable=SC2086 # deliberate word splitting: one id per word
  retire "$service" $old
}

# replace_in_place <service> <publishes-a-host-port> - compose recreates the container if, and only
# if, its definition moved. A service holding a host port whose `up` fails gets ONE retry after the
# caller's `on_port_conflict <service>` has had the chance to free the port: the policy of what may
# be removed to free it (an allowlist) belongs to the caller, which knows the port and the registry.
replace_in_place() {
  local service="$1" ports="$2" cid
  if ! dc up -d --no-deps "$service"; then
    [ "$ports" = yes ] || return 1
    printf '%s: the first attempt failed - asking whether a stale container holds its host port\n' "$service"
    on_port_conflict "$service" || return 1
    dc up -d --no-deps "$service" || return 1
  fi
  for cid in $(containers_of "$service"); do
    wait_healthy "$cid" "$service" || return 1
  done
}

# replace_services - reads "<service> <mode> <publishes-a-host-port>" lines on stdin, in the order
# they must be replaced, and replaces each one. Stops at the first failure.
replace_services() {
  local service mode ports
  while read -r service mode ports <&3; do
    [ -n "$service" ] || continue
    printf '\n-- %s (%s)\n' "$service" "$mode"
    case "$mode" in
    overlap) replace_overlap "$service" || return 1 ;;
    exclusive | pinned) replace_in_place "$service" "$ports" || return 1 ;;
    *)
      printf '::error::%s: unknown replacement mode "%s"\n' "$service" "$mode" >&2
      return 1
      ;;
    esac
  done 3<&0
}
