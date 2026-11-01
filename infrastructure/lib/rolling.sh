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
#   overlap    the new container starts BESIDE the old one (`--scale` to one more, `--no-recreate`).
#              Once it is HEALTHY, the nginx in front of the service (its ROTATION, a label) is given
#              a list of replicas that names the new one and no longer the old one, and reloaded; the
#              old replica is told to stop only once that is PROVEN to have taken effect - every
#              nginx worker that still knew the old list can no longer choose a replica - and nothing
#              is left queued on it (rotation_update, wait_unqueued). THEN it gets SIGTERM, which the
#              services answer by closing their listener and finishing what is in flight
#              (`drain-on-sigterm` in each NestJS service, axum's graceful shutdown in the gateway,
#              nginx's own SIGQUIT, adapter-node's own handler).
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
# read from the file's `name:`), `ROTATION_DIR` (the host directory both proxies mount, where the
# replica lists are written) and `on_port_conflict <service>` (frees a host port held by a stale
# container it is allowed to remove, or returns 1), and runs from the repository root.
#
# Usage:
#   . "$ROOT/infrastructure/lib/rolling.sh"
#   replace_services <<<"$(dc config --format json | python3 infrastructure/lib/replace-modes.py ...)"

# How long a retired replica may take to finish what is in flight before Docker kills it. A drained
# NestJS replica exits by itself as soon as its last request is answered; this bounds the one that
# cannot (an hour-long WebSocket on the frontend or the gateway, which the client re-opens).
ROLLING_DRAIN_SECONDS="${ROLLING_DRAIN_SECONDS:-10}"

# How many 2-second health reads a new replica gets before it is declared broken. Bounds the FAILURE
# case only: a healthy replica is believed the moment Docker says so.
ROLLING_HEALTH_ATTEMPTS="${ROLLING_HEALTH_ATTEMPTS:-90}"

# How many half-second reads of a proxy's workers the deploy makes, after a reload, before declaring
# that the workers which knew the old list will never settle. Bounds the FAILURE case only (a reload
# nginx refused after `-t` accepted it, a request that never ends): the proof is believed the moment
# it holds, which for a request in flight is when that request has chosen its replica. Ten minutes,
# because an upload is read in full before nginx chooses where to send it.
ROLLING_ROTATION_READS="${ROLLING_ROTATION_READS:-1200}"

# How many reads of a retiring replica's sockets the deploy makes before declaring its process unable
# to accept. Bounds the FAILURE case only: a process that is alive empties its accept queue in one
# turn of its event loop.
ROLLING_QUIESCE_READS="${ROLLING_QUIESCE_READS:-100}"

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

# ── Rotation: which replicas each nginx in front may choose ──────────────────
#
# WHY (2026-11-01, main CI run 41311303760: one POST in 346 answered 502 across a release). Closing a
# listener RESETS every connection still in its accept queue - handshakes the kernel completed and
# the process had not yet accepted. The nginx in front had already written the POST into that
# connection, so the reset reached it while reading the answer (`recv() failed (104: Connection reset
# by peer) while reading response header from upstream`), and a POST that has been sent is the one
# request nginx may NOT replay: 502. A replica that closes its listener while it is still in rotation
# cannot avoid this however fast it accepts: a handshake can always complete between the last
# accept() and the close(). So the replica leaves rotation FIRST, provably, and is told to stop after.
#
# Rotation used to be Docker's DNS, and DNS cannot be the lever: it names a container for as long as
# it runs - an unhealthy or a paused one included (measured on Docker 29, 2026-11-01). So each nginx
# in front reads an explicit list instead: an `upstream <service>` block per service it routes to,
# naming each replica by its container name, written by this file into ROTATION_DIR (mounted
# read-only into the frontend and, through its own directory, into the edge) and applied by
# `nginx -s reload`. A replica enters the list only once it is healthy, and leaves it before it stops.

# The routes of the estate, "<service> <proxy> <port>" per line, from the plan replace_services reads.
ROTATION_ROUTES=""

# rotation_file <proxy> - where the list a proxy includes is written.
rotation_file() {
  printf '%s/%s.conf\n' "$ROTATION_DIR" "$1"
}

# rotation_render <proxy> [<container to leave out>...] - writes the replica lists of every service
# routed through <proxy>: each running, healthy replica, minus the ones being retired. Written to a
# temporary file and renamed, so a reload never reads half a file.
rotation_render() {
  local proxy="$1" service via port cid state name file tmp count
  shift
  file="$(rotation_file "$proxy")"
  tmp="$file.tmp"
  {
    printf '# WRITTEN BY infrastructure/lib/rolling.sh AT EVERY DEPLOY - which replicas %s may choose.\n' "$proxy"
    printf '# Not tracked by git; docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to.\n'
    while read -r service via port; do
      [ "$via" = "$proxy" ] || continue
      printf '\nupstream %s {\n    zone %s 64k;\n' "$service" "$service"
      # `resolve` re-reads the name if the container restarts with another address; a container name
      # names exactly one replica, so the list stays the list.
      printf '    resolver 127.0.0.11 valid=2s ipv6=off;\n'
      count=0
      for cid in $(containers_of "$service"); do
        case " $* " in *" $cid "*) continue ;; esac
        state="$($DOCKER_CLI inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Name}}' "$cid" 2>/dev/null)" || continue
        case "$state" in
        'running healthy '* | 'running none '*)
          name="${state##* }"
          printf '    server %s:%s resolve;\n' "${name#/}" "$port"
          count=$((count + 1))
          ;;
        esac
      done
      if [ "$count" -eq 0 ]; then
        # A service with no healthy replica: said in the file, where nginx answers it with a 502
        # ("no live upstreams") rather than a name that would resolve to nothing.
        printf '    server 127.0.0.1:1 down;\n'
        printf '::warning::%s: no healthy replica of %s to put in rotation\n' "$proxy" "$service" >&2
      fi
      printf '}\n'
    done <<<"$ROTATION_ROUTES"
  } >"$tmp" || return 1
  mv -f "$tmp" "$file" || return 1
}

# Run INSIDE a proxy container (busybox sh, as root), with the number of reads as $1 and the awk
# program below as $2. Tests the new list, reloads, then reads until every worker that existed before
# the reload has either exited or can no longer choose a replica, and prints "<reads> <old workers
# still alive>". Exit 2: nginx refused the list; exit 3: never settled.
#
# THE PROOF. `nginx -s reload` starts new workers on the new list; the old workers keep the old list,
# and the connections they hold - a reload never cuts one. An old worker accepts nothing new, so it can
# only choose a replica for a request it was already handling, and only before that request is being
# proxied. So once each of its client connections (a socket on a port nginx listens on) is paired with
# an upstream connection already established, it has nothing left to choose: what remains is requests
# being proxied and WebSockets, which it may keep for an hour without ever reaching the retiring
# replica anew. Waiting for those workers to EXIT instead would wait for the last WebSocket opened
# before the release. Read from /proc - the workers' own sockets, joined to the namespace's TCP table.
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_SETTLE_SCRIPT='
workers() {
  for d in /proc/[0-9]*; do
    s="$(cat "$d/stat" 2>/dev/null)" || continue
    set -- $s
    [ "$4" = 1 ] || continue
    case "$(tr "\0" " " <"$d/cmdline" 2>/dev/null)" in
    "nginx: worker process"*) echo "$1:${22}" ;;
    esac
  done
}
conf=""
prev=""
for a in $(tr "\0" " " </proc/1/cmdline); do
  [ "$prev" = "-c" ] && conf="$a"
  prev="$a"
done
nginx ${conf:+-c "$conf"} -t -q || exit 2
before=" $(workers | tr "\n" " ")"
nginx ${conf:+-c "$conf"} -s reload || exit 2
read=0
unpaired="?"
old=""
while [ "$read" -lt "$1" ]; do
  read=$((read + 1))
  fresh=0
  old=""
  for w in $(workers); do
    case "$before" in
    *" $w "*) old="$old ${w%%:*}" ;;
    *) fresh=1 ;;
    esac
  done
  unpaired="$({
    for p in $old; do
      for f in /proc/$p/fd/*; do
        l="$(readlink "$f" 2>/dev/null)"
        case "$l" in "socket:["*) i="${l#socket:[}"; echo "S $p ${i%]}" ;; esac
      done
    done
    cat /proc/net/tcp /proc/net/tcp6 2>/dev/null
  } | awk "$2")"
  if [ "$fresh" = 1 ] && [ "$unpaired" = 0 ]; then
    echo "$read $(echo $old | wc -w)"
    exit 0
  fi
  sleep 0.5
done
echo "$read $(echo $old | wc -w) $unpaired"
exit 3
'

# The join: "S <worker> <inode>" lines, then the TCP tables. Prints how many client connections of the
# old workers are not yet paired with an established upstream connection. A LISTEN row (0A) names a
# port nginx listens on; a socket on such a port is a client's, any other is an upstream.
# shellcheck disable=SC2016 # an awk program
ROTATION_PAIRS_AWK='
$1 == "S" { own[$3] = $2; next }
$1 == "sl" { next }
{
  n = split($2, a, ":"); port = a[n]
  if ($4 == "0A") { listen[port] = 1; next }
  if ($10 in own) { k++; P[k] = port; ST[k] = $4; W[k] = own[$10] }
}
END {
  for (i = 1; i <= k; i++) { if (P[i] in listen) c[W[i]]++; else if (ST[i] == "01") u[W[i]]++ }
  bad = 0
  for (w in c) if (c[w] > u[w] + 0) bad += c[w] - u[w]
  print bad + 0
}'

# rotation_apply <proxy> - reloads every running replica of <proxy> on its new list and returns once
# the reload is PROVEN to have taken effect in each (ROTATION_SETTLE_SCRIPT). A proxy with no running
# replica has nothing to reload: it reads the list when it starts.
rotation_apply() {
  local proxy="$1" pid out rc
  for pid in $($DOCKER_CLI ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$proxy" --filter "label=com.docker.compose.oneoff=False"); do
    out="$($DOCKER_CLI exec "$pid" sh -c "$ROTATION_SETTLE_SCRIPT" sh "$ROLLING_ROTATION_READS" "$ROTATION_PAIRS_AWK")"
    rc=$?
    case "$rc" in
    0)
      # shellcheck disable=SC2086 # "<reads> <old workers>"
      set -- $out
      printf '  %s: %s reloaded; the new list holds, proven after %s read(s) (%s old worker(s) still finishing proxied requests)\n' \
        "$proxy" "${pid:0:12}" "$1" "$2"
      ;;
    2)
      printf '::error::%s: %s refused the new replica list - it keeps serving the old one; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
      cat "$(rotation_file "$proxy")" >&2 || true
      return 1
      ;;
    *)
      printf '::error::%s: %s did not settle on the new list after %s reads (%s) - the old replica stays up; stopping the deploy\n' \
        "$proxy" "${pid:0:12}" "$ROLLING_ROTATION_READS" "${out:-exit $rc}" >&2
      return 1
      ;;
    esac
  done
}

# rotation_update <service> [<container to leave out>...] - puts the current healthy replicas of
# <service>, minus the ones given, into rotation at the proxy that routes to it, and returns once
# that is proven. A service with no route has nothing to do.
rotation_update() {
  local service="$1" proxy
  proxy="$(printf '%s\n' "$ROTATION_ROUTES" | awk -v s="$service" '$1 == s { print $2 }')"
  [ -n "$proxy" ] || return 0
  [ -n "${ROTATION_DIR:-}" ] || {
    printf '::error::%s is routed through %s, but the caller set no ROTATION_DIR\n' "$service" "$proxy" >&2
    return 1
  }
  rotation_render "$proxy" "${@:2}" || return 1
  rotation_apply "$proxy"
}

# The retiring replica's own sockets, read twice in a row: no connection half-open (state 03,
# SYN_RECV) and every listener's accept queue empty (a LISTEN row's rx_queue IS that queue). Prints
# "<waiting> <established on a listened port>".
# shellcheck disable=SC2016 # an awk program
QUEUE_AWK='
$1 == "sl" { next }
{
  n = split($2, a, ":"); port = a[n]
  if ($4 == "0A") { listen[port] = 1; if (substr($5, 10) != "00000000") w++ }
  else if ($4 == "03") w++
  else if ($4 == "01") { k++; E[k] = port }
}
END { for (i = 1; i <= k; i++) if (E[i] in listen) f++; print w + 0, f + 0 }'

# wait_unqueued <service> <container> - returns once nothing is waiting to be accepted by the
# replica, which rotation has already stopped sending anything new: two clean reads in a row mean no
# half-open connection could still complete and none is still queued. In flight is printed, not waited
# for: SIGTERM is what drains it, and a WebSocket would never let it reach zero.
wait_unqueued() {
  local service="$1" cid="$2" read=0 clean=0 out=""
  while [ "$read" -lt "$ROLLING_QUIESCE_READS" ]; do
    read=$((read + 1))
    out="$($DOCKER_CLI exec "$cid" sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null' | awk "$QUEUE_AWK")"
    if [ "${out%% *}" = 0 ]; then
      clean=$((clean + 1))
      if [ "$clean" -ge 2 ]; then
        printf '  %s: %s has nothing queued (%s read(s)), %s request(s) in flight for SIGTERM to drain\n' \
          "$service" "${cid:0:12}" "$read" "${out#* }"
        return 0
      fi
    else
      clean=0
    fi
    sleep 0.1
  done
  # Out of rotation, so nothing new reaches it, but its process did not accept what was queued: it is
  # hung, and those connections are lost whether it is stopped now or later. Stopping it is still
  # right; it is said, because it is the very failure this exists to prevent.
  printf '::error::%s: %s still had connections waiting (%s) after %s reads - its process is not accepting; retiring it anyway\n' \
    "$service" "${cid:0:12}" "${out:-unreadable}" "$ROLLING_QUIESCE_READS" >&2
}

# retire <service> <container...> - drains and removes replicas already out of rotation. `docker
# stop` sends the image's stop signal and waits ROLLING_DRAIN_SECONDS for the process to leave by
# itself.
retire() {
  local service="$1" cid
  shift
  for cid in "$@"; do
    wait_unqueued "$service" "$cid"
    printf '  %s: retiring %s (drain up to %ss)\n' "$service" "${cid:0:12}" "$ROLLING_DRAIN_SECONDS"
    $DOCKER_CLI stop --time "$ROLLING_DRAIN_SECONDS" "$cid" >/dev/null || return 1
    $DOCKER_CLI rm "$cid" >/dev/null || return 1
  done
}

# replace_overlap <service> - the new replica beside the old, then the old one out of rotation, then
# out.
replace_overlap() {
  local service="$1" old new count cid
  old="$(containers_of "$service")"
  count="$(printf '%s' "$old" | grep -c . || true)"

  if [ "$count" -eq 0 ]; then
    # Nothing to overlap with: the estate's first deploy, or a service added by this release.
    printf '%s: no running replica - starting the first one\n' "$service"
    dc up -d --no-deps "$service" || return 1
    new="$(containers_of "$service")"
    wait_healthy "$new" "$service" || return 1
    rotation_update "$service"
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

  # One reload puts the new replica in and takes the old one out; the old one is stopped only once
  # that holds. A failure here leaves both running - the old one merely no longer chosen.
  # shellcheck disable=SC2086 # deliberate word splitting: one id per word
  rotation_update "$service" $old || return 1
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
# replace_services - reads "<service> <mode> <publishes-a-host-port> <rotation>" lines on stdin, in
# the order they must be replaced, and replaces each one. Stops at the first failure.
replace_services() {
  local plan service mode ports
  plan="$(cat)"
  ROTATION_ROUTES="$(printf '%s\n' "$plan" | awk '$4 != "" && $4 != "-" { split($4, r, ":"); print $1, r[1], r[2] }')"
  while read -r service mode ports _ <&3; do
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
  done 3<<<"$plan"
}
