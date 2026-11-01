# shellcheck shell=bash
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
#              of it has had time to learn its address. Retiring first takes the old one out of
#              rotation - a new connection to it is REFUSED, and a refused connect is the one failure
#              nginx hands to the next address without having sent a byte - and proves nothing is
#              left queued on it (out_of_rotation, below). THEN it sends SIGTERM, which the services
#              answer by closing their listener and finishing what is in flight (`drain-on-sigterm`
#              in each NestJS service, axum's graceful shutdown in the gateway, nginx's own SIGQUIT,
#              adapter-node's own handler).
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

# THE IMAGE THAT TAKES A RETIRING REPLICA OUT OF ROTATION - run for a second, inside that replica's
# network namespace and nowhere else (see out_of_rotation). The official Docker image, the one
# official image that ships `iptables`, pinned by digest like every third-party image this repository
# runs. Its own daemon is never started: only `iptables`, `awk` and `sh` are used.
ROLLING_NETNS_IMAGE='docker:29.9.2-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977'

# How many reads of the replica's sockets out_of_rotation makes before declaring its process unable
# to accept. Bounds the FAILURE case only: a replica whose process is alive empties its accept queue
# in one turn of its event loop, and the proof is believed the moment it holds.
ROLLING_QUIESCE_READS="${ROLLING_QUIESCE_READS:-100}"

# out_of_rotation <service> <container> - from now on, nothing new reaches this replica; returns once
# that is PROVEN, i.e. once nothing that arrived before is still waiting to be accepted.
#
# WHY (2026-11-01, main CI run 41311303760: one POST in 346 answered 502 across a release). Closing a
# listener RESETS every connection still in its accept queue - handshakes the kernel completed and
# the process had not yet accepted. Each nginx in front had already written the POST into that
# connection, so the reset reached it while reading the answer (`recv() failed (104: Connection reset
# by peer) while reading response header from upstream`), and a POST that has been sent is the one
# request nginx may NOT replay: 502. Closing the listener on SIGTERM while the replica is still in
# rotation cannot avoid this, however fast it accepts: a handshake can always complete between the
# last accept() and the close().
#
# So the replica leaves rotation FIRST, and only then is it told to stop. Rotation is Docker's DNS,
# which names a container for as long as it runs - an unhealthy or a paused one included (measured
# on Docker 29, 2026-11-01) - so it cannot be the lever. The lever is the replica's own network
# namespace: a rule there REFUSES every new connection that does not come from inside the container
# (`--syn`, so an established connection - a request in flight, a WebSocket - is untouched; `! -i lo`,
# so its own healthcheck and Docker's DNS on 127.0.0.11 still work). A refused connect is the one
# failure every nginx in front hands to the next replica with no byte sent. The rule lives and dies
# with the namespace: nothing on the host changes, and nothing outlives the container.
#
# THE PROOF, read from the namespace's own sockets: no connection still half-open (state 03,
# SYN_RECV - one that slipped in before the rule and could still complete) and every listener's
# accept queue empty (state 0A, whose rx_queue column IS that queue), on two consecutive reads. Once
# the rule holds no handshake can start, so the first clean read means none can complete any more,
# and the second means none is still waiting: SIGTERM after that closes a listener nobody is queued on.
out_of_rotation() {
  local service="$1" cid="$2"
  # shellcheck disable=SC2016 # the script runs in the helper's shell, not this one
  $DOCKER_CLI run --rm --network "container:$cid" --cap-add NET_ADMIN --entrypoint sh \
    "$ROLLING_NETNS_IMAGE" -c '
      iptables -w -I INPUT ! -i lo -p tcp --syn -j REJECT --reject-with tcp-reset || exit 2
      clean=0
      read=0
      while [ "$read" -lt "$1" ]; do
        read=$((read + 1))
        waiting="$(awk '\''FNR > 1 && ($4 == "03" || ($4 == "0A" && substr($5, 10) != "00000000")) { n++ } END { print n + 0 }'\'' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
        if [ "$waiting" = 0 ]; then
          clean=$((clean + 1))
          if [ "$clean" -ge 2 ]; then
            echo "$read"
            exit 0
          fi
        else
          clean=0
        fi
        sleep 0.1
      done
      echo "$waiting"
      exit 3
    ' sh "$ROLLING_QUIESCE_READS"
}

# retire <service> <container...> - takes the given replicas out of rotation, then drains and removes
# them. `docker stop` sends the image's stop signal and waits ROLLING_DRAIN_SECONDS for the process to
# leave by itself.
retire() {
  local service="$1" cid out rc
  shift
  for cid in "$@"; do
    out="$(out_of_rotation "$service" "$cid")"
    rc=$?
    case "$rc" in
    0) printf '  %s: %s is out of rotation, its accept queue proven empty after %s read(s)\n' "$service" "${cid:0:12}" "$out" ;;
    3)
      # The rule holds - nothing new reaches it - but its process did not accept what was already
      # queued: it is hung, and those connections are lost whether it is stopped now or later.
      # Stopping it is still the right move; it is said, because it is the defect this function exists
      # to prevent, arriving from a replica that cannot be helped.
      printf '::error::%s: %s still held %s unaccepted connection(s) after %s reads - its process is not accepting; retiring it anyway\n' \
        "$service" "${cid:0:12}" "$out" "$ROLLING_QUIESCE_READS" >&2
      ;;
    *)
      # The rule could not be set: the replica is STILL in rotation, and stopping it now is the 502
      # this exists to prevent. Stop the deploy instead - both replicas keep serving.
      printf '::error::%s: could not take %s out of rotation (exit %s) - stopping the deploy; both replicas are serving\n' \
        "$service" "${cid:0:12}" "$rc" >&2
      return 1
      ;;
    esac
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
