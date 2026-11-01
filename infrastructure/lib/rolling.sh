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
#              a list that names the new replica alone, and reloaded; the old replica is told to stop
#              only once the pairing check says no old nginx worker is still about to choose a replica
#              and nothing is left queued on it (rotation_take_out, wait_unqueued). THEN it gets
#              SIGTERM, which the services answer by closing their listener and finishing what is in
#              flight (`drain-on-sigterm` in each NestJS service, axum's graceful shutdown in the
#              gateway, nginx's own SIGQUIT, adapter-node's own handler). Once it is gone, the list
#              goes back to naming the service by its DNS name (rotation_restore).
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
#   plan="$(dc config --format json | python3 infrastructure/lib/replace-modes.py ...)"
#   rotation_seed <<<"$plan"       # before ANY `up`: the proxies cannot start without their lists
#   replace_services <<<"$plan"

# How long a retired replica may take to finish what is in flight before Docker kills it. A drained
# NestJS replica exits by itself as soon as its last request is answered; this bounds the one that
# cannot (an hour-long WebSocket on the frontend or the gateway, which the client re-opens).
ROLLING_DRAIN_SECONDS="${ROLLING_DRAIN_SECONDS:-10}"

# How many 2-second health reads a new replica gets before it is declared broken. Bounds the FAILURE
# case only: a healthy replica is believed the moment Docker says so.
ROLLING_HEALTH_ATTEMPTS="${ROLLING_HEALTH_ATTEMPTS:-90}"

# How many half-second reads of a proxy's workers the deploy makes, after a reload, before declaring
# that the workers which knew the old list will never settle. Bounds the FAILURE case only (a request
# that never ends): the check is believed the moment it holds, which for a request in flight is when
# that request has chosen its replica. Ten minutes, because an upload is read in full before nginx
# chooses where to send it. A reload nginx REFUSED is read from its error log at the first read, not
# waited out.
ROLLING_ROTATION_READS="${ROLLING_ROTATION_READS:-1200}"

# How many reads of a retiring replica's sockets the deploy makes before declaring its process unable
# to accept. Bounds the FAILURE case only: a process that is alive empties its accept queue in one
# turn of its event loop.
ROLLING_QUIESCE_READS="${ROLLING_QUIESCE_READS:-100}"

# HOW LONG AN nginx KEEPS AN ADDRESS IT RESOLVED BY NAME: `valid=` in every list this file writes,
# and in the frontend image's own server-level resolver. Two things read it, and neither is a guess:
#   - a frontend image from BEFORE the lists (a transition, rotation_is_legacy) re-resolves every
#     service by DNS, so a replica it may still choose is retired only once this has run out - the
#     drain every deploy made before 2026-11-01;
#   - a ROLLBACK to such a release runs that release's own rolling.sh, which waits exactly this long
#     before retiring, so the lists it finds (named by DNS, rotation_restore) must expire as fast.
# deploy-replace.test.sh holds this number to the lists, to both images and to the frozen library.
ROLLING_RESOLVER_TTL_SECONDS=2

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
# accept() and the close(). So the replica leaves rotation FIRST, and is told to stop after.
#
# Docker's DNS cannot be the lever: it names a container for as long as it runs - an unhealthy or a
# paused one included (measured on Docker 29, 2026-11-01). So each nginx in front reads an explicit
# list: an `upstream <service>` block per service it routes to, written by this file into
# ROTATION_DIR (mounted read-only into the frontend and, through its own directory, into the edge)
# and applied by `nginx -s reload`.
#
# TWO FORMS, AND THE ESTATE RESTS IN THE FIRST. Between deploys every block names its service by its
# DNS NAME (`server core-service:3012 resolve;`) - the very list the frontend image bakes for an
# estate with no such deploy, so `rotation_seed` can write it before anything starts. Only while ONE
# service is being replaced does its block name a CONTAINER (`server canari-core-service-2:3012
# resolve;`): the new replica alone, so the old one is out before it stops; once the old one is gone
# the block goes back to the DNS name. Every other block is carried over byte for byte - a sibling is
# never re-read, so a sibling that is `starting` or `unhealthy` stays exactly as reachable as it was.
# The resting form is also what makes a ROLLBACK work: the rolling.sh of a release older than the
# lists never rewrites them, and a list naming a container that rollback removes would answer 502;
# a list naming the service by DNS follows that older deploy the way its own nginx always did.

# The routes of the estate, "<service> <proxy> <port>" per line, from the plan (rotation_routes_set).
ROTATION_ROUTES=""
# The render id of the list last written for a proxy: the line `# render <id>` the proxy's own
# `nginx -T` must show before a reload is believed to read THIS file (rotation_apply).
ROTATION_TOKEN=""
# Whether the last rotation_write changed a list, render id aside.
ROTATION_CHANGED=no

# The image this release runs for each service, "<service> <image>" per line, from the plan.
ROTATION_IMAGES=""

# rotation_routes_set - reads the plan replace-modes.py prints on stdin and keeps its routes and the
# image of each service.
rotation_routes_set() {
  local plan
  plan="$(cat)"
  ROTATION_ROUTES="$(printf '%s\n' "$plan" | awk '$4 != "" && $4 != "-" { split($4, r, ":"); print $1, r[1], r[2] }')"
  ROTATION_IMAGES="$(printf '%s\n' "$plan" | awk 'NF >= 5 && $5 != "-" { print $1, $5 }')"
}

# rotation_runs_this_release <proxy> <container> - whether <container> runs the very image this release
# deploys for <proxy>: 0 yes, 1 no, 2 unknown (no image in the plan, or one not on this host).
rotation_runs_this_release() {
  local image running wanted
  image="$(printf '%s\n' "$ROTATION_IMAGES" | awk -v s="$1" '$1 == s { print $2 }')"
  [ -n "$image" ] || return 2
  wanted="$($DOCKER_CLI image inspect -f '{{.Id}}' "$image" 2>/dev/null)" || return 2
  running="$($DOCKER_CLI inspect -f '{{.Image}}' "$2" 2>/dev/null)" || return 2
  [ "$running" = "$wanted" ]
}

# rotation_file <proxy> - where the list a proxy includes is written.
rotation_file() {
  printf '%s/%s.conf\n' "$ROTATION_DIR" "$1"
}

# rotation_route <service> - prints "<proxy> <port>" for a routed service, nothing otherwise.
rotation_route() {
  printf '%s\n' "$ROTATION_ROUTES" | awk -v s="$1" '$1 == s { print $2, $3 }'
}

# The proxies whose list is included in a `stream {}` context (a TCP relay) rather than `http {}`.
# deploy-replace.test.sh holds this to the include sites; deploy-rolling.test.sh runs `nginx -t` on
# both real configurations with the lists rendered here.
ROTATION_STREAM_PROXIES="edge"

# rotation_block <proxy> <service> <port> [<container name>...] - one `upstream` block: the replicas
# named, or, with none, the service's DNS name (the resting form). The same text, byte for byte, as
# the list baked in Dockerfile.frontend (deploy-replace.test.sh compares them).
#
# `keepalive 0` IN EVERY http BLOCK, AND THE PAIRING CHECK IS ONLY SOUND WITH IT (2026-11-01). Since
# nginx 1.29.7 an `upstream` block caches up to 32 idle connections per worker by default; an idle
# cached connection is ESTABLISHED, holds nothing, and is indistinguishable in /proc from an upstream
# a request has chosen - so it paired a request still in its auth_request (CI: 1 client against 13
# idle upstreams, then a 502). A worker closes them when its graceful shutdown begins, which the
# check would have to race. With no cache, every upstream connection of an old worker belongs to a
# request in flight. A `stream` upstream caches nothing and does not know the directive.
rotation_block() {
  local proxy="$1" service="$2" port="$3" name
  shift 3
  printf 'upstream %s {\n    zone %s 64k;\n    resolver 127.0.0.11 valid=%ss ipv6=off;\n' \
    "$service" "$service" "$ROLLING_RESOLVER_TTL_SECONDS"
  case " $ROTATION_STREAM_PROXIES " in
  *" $proxy "*) ;;
  *) printf '    keepalive 0;\n' ;;
  esac
  if [ $# -eq 0 ]; then
    printf '    server %s:%s resolve;\n' "$service" "$port"
  else
    # `resolve` re-reads the name if the container restarts with another address; a container name
    # names exactly one replica, so the list stays the list.
    for name in "$@"; do
      printf '    server %s:%s resolve;\n' "$name" "$port"
    done
  fi
  printf '}\n'
}

# rotation_existing_block <file> <service> - the block for <service> as the file holds it, or nothing.
rotation_existing_block() {
  [ -f "$1" ] || return 0
  awk -v s="upstream $2 {" '$0 == s { on = 1 } on { print } on && $0 == "}" { exit }' "$1"
}

# rotation_write <proxy> <service> <block> - rewrites the list of <proxy>: <service>'s block becomes
# <block>, every other block is carried over as the file holds it (written in the resting form only
# when the file has none). An empty <service> writes EVERY block in the resting form. Written to a
# temporary file and renamed, so a reload never reads half a file. Sets ROTATION_TOKEN and
# ROTATION_CHANGED.
rotation_write() {
  local proxy="$1" target="$2" block="$3" file tmp svc via port existing
  file="$(rotation_file "$proxy")"
  tmp="$file.tmp"
  ROTATION_TOKEN="$(date +%s)-$$-$RANDOM"
  {
    printf '# WRITTEN BY infrastructure/lib/rolling.sh AT EVERY DEPLOY - which replicas %s may choose.\n' "$proxy"
    printf '# Not tracked by git; docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to.\n'
    printf '# render %s\n' "$ROTATION_TOKEN"
    while read -r svc via port; do
      [ "$via" = "$proxy" ] || continue
      printf '\n'
      if [ -n "$target" ] && [ "$svc" = "$target" ]; then
        printf '%s\n' "$block"
        continue
      fi
      existing=""
      [ -z "$target" ] || existing="$(rotation_existing_block "$file" "$svc")"
      if [ -n "$existing" ]; then
        printf '%s\n' "$existing"
      else
        rotation_block "$proxy" "$svc" "$port"
      fi
    done <<<"$ROTATION_ROUTES"
  } >"$tmp" || return 1
  if [ -f "$file" ] && cmp -s <(grep -v '^# render ' "$file") <(grep -v '^# render ' "$tmp"); then
    ROTATION_CHANGED=no
  else
    ROTATION_CHANGED=yes
  fi
  mv -f "$tmp" "$file" || return 1
}

# Run INSIDE a proxy container (busybox sh, as root). Shared by the three scripts below: the
# configuration file the running master was started with (`-c`, read from its own command line),
# and the workers, as "<pid>:<start time>" so a recycled pid is never taken for the same worker.
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_PROXY_PRELUDE='
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
'

# Prints the configuration nginx would load NOW (`nginx -T`), every included file under a
# `# configuration file <path>:` line. Fails when nginx refuses it.
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_DUMP_SCRIPT="$ROTATION_PROXY_PRELUDE"'
exec nginx ${conf:+-c "$conf"} -T -q
'

# Prints "<uid of the workers>|<the workers that exist BEFORE the reload>", then sends it.
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_RELOAD_SCRIPT="$ROTATION_PROXY_PRELUDE"'
before=" $(workers | tr "\n" " ")"
w="${before# }"
w="${w%%:*}"
uid=""
[ -n "$w" ] && uid="$(awk "/^Uid:/ { print \$2 }" "/proc/$w/status")"
nginx ${conf:+-c "$conf"} -s reload || exit 2
printf "%s|%s\n" "$uid" "$before"
'

# One read after the reload: $1 the workers from before it, $2 the pairing awk program below, $3 the
# subrequest ports (hex). Prints "<a new worker exists: 0|1> <unpaired client connections of the old
# workers, or ?> <old workers still alive>".
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_READ_SCRIPT="$ROTATION_PROXY_PRELUDE"'
fresh=0
old=""
for w in $(workers); do
  case "$1" in
  *" $w "*) old="$old ${w%%:*}" ;;
  *) fresh=1 ;;
  esac
done
blind=0
socks=""
for p in $old; do
  n=0
  for f in /proc/$p/fd/*; do
    l="$(readlink "$f" 2>/dev/null)"
    case "$l" in "socket:["*) i="${l#socket:[}"; socks="$socks
S $p ${i%]}"; n=$((n + 1)) ;; esac
  done
  # A live worker always holds its listening socket: seeing none is not seeing it, not a clean worker.
  [ -d "/proc/$p" ] && [ "$n" = 0 ] && blind=1
done
if [ "$blind" = 1 ]; then
  unpaired="?"
else
  unpaired="$({
    printf "%s\n" "$socks"
    cat /proc/net/tcp
    cat /proc/net/tcp6 2>/dev/null
  } | awk -v skip="$3" "$2")"
fi
echo "$fresh $(echo $old | wc -w) $unpaired"
'

# THE PAIRING CHECK - what it proves, and what it does not.
#
# `nginx -s reload` starts new workers on the new list; the old workers keep the old list, and the
# connections they hold - a reload never cuts one. An old worker accepts nothing new, so it can only
# choose a replica for a request it was already handling. The check reads every old worker's sockets
# (`/proc/<pid>/fd`) joined to the TCP table, and holds when, in each old worker, the client
# connections (a socket on a port nginx listens on) are no more than its ESTABLISHED upstream
# connections - a request nginx is already proxying has chosen its replica. What is left are requests
# being proxied and WebSockets, which an old worker may keep for an hour; waiting for it to EXIT
# would wait for the last WebSocket opened before the release.
#
# A SUBREQUEST'S CONNECTION NEVER PAIRS A CLIENT (2026-11-01 review). `auth_request` opens an upstream
# connection (the frontend's to core-service) BEFORE the request chooses where it is going; counted,
# it would stand for a request that has not chosen yet. So every upstream connection to a port an
# `auth_request` location proxies to (rotation_subrequest_ports, read from `nginx -T`) is left out,
# main requests to that service included: those then hold the check until they end - by their own
# completion, never by a clock.
#
# WHAT IT DOES NOT PROVE. A request whose upstream FAILS after it was paired can choose again from
# the old list: `proxy_next_upstream` (an idempotent method only, nginx's own rule) or an `error_page`
# that proxies elsewhere (the frontend's all answer from nginx itself). Such a re-choice needs a
# replica the deploy has NOT touched to fail on its own, and lands on the retiring replica only by that
# coincidence; it is left visible, not waited for. One request per client connection is assumed
# (no `mirror`, no SSI in the frontend config).
#
# A table it cannot read prints `?`, never `0`: an unreadable /proc is not a clean one.
# shellcheck disable=SC2016 # an awk program
ROTATION_PAIRS_AWK='
BEGIN { ns = split(skip, s, " "); for (i = 1; i <= ns; i++) sk[s[i]] = 1 }
$1 == "S" { own[$3] = $2; next }
$1 == "sl" { hdr = 1; next }
{
  n = split($2, a, ":"); port = a[n]
  m = split($3, b, ":"); rport = b[m]
  if ($4 == "0A") { listen[port] = 1; next }
  if ($10 in own) { k++; P[k] = port; R[k] = rport; ST[k] = $4; W[k] = own[$10] }
}
END {
  if (!hdr) { print "?"; exit }
  for (i = 1; i <= k; i++) {
    if (P[i] in listen) { c[W[i]]++; C++; continue }
    d[R[i] "." ST[i]]++
    if (R[i] in sk) S++
    else if (ST[i] == "01") { u[W[i]]++; U++ }
  }
  bad = 0
  for (w in c) if (c[w] > u[w] + 0) bad += c[w] - u[w]
  # The verdict, then its evidence: client connections, upstreams counted, subrequest ones left out,
  # and every non-client socket by remote port (hex) and TCP state, so a count that looks wrong
  # names what it counted.
  det = ""
  for (x in d) det = det (det == "" ? "" : ",") x "x" d[x]
  print bad + 0, C + 0, U + 0, S + 0, (det == "" ? "-" : det)
}'

# rotation_sockets_said <detail> - the pairing read's non-client sockets, `<hex port>.<hex state>x<n>`
# comma-joined, said as `<port>/<TCP state>x<n>` for a human.
rotation_sockets_said() {
  local item said="" port state n
  if [ -z "$1" ] || [ "$1" = - ]; then
    printf 'none'
    return 0
  fi
  for item in ${1//,/ }; do
    port="${item%%.*}"
    state="${item#*.}"
    n="${state#*x}"
    state="${state%%x*}"
    case "$state" in
    01) state=ESTABLISHED ;;
    02) state=SYN_SENT ;;
    04) state=FIN_WAIT1 ;;
    05) state=FIN_WAIT2 ;;
    06) state=TIME_WAIT ;;
    08) state=CLOSE_WAIT ;;
    09) state=LAST_ACK ;;
    esac
    said="$said${said:+, }$((16#$port))/${state}x$n"
  done
  printf '%s' "$said"
}

# rotation_subrequest_ports <proxy> -reads `nginx -T` on stdin and prints, one per line, the port of
# every service an `auth_request` location proxies to: a `host:port` as written, a bare name through
# the proxy's own route. Fails, rather than guessing, on a target it cannot place.
rotation_subrequest_ports() {
  local proxy="$1" uri target route port
  # shellcheck disable=SC2016 # an awk program
  awk '
    $1 == "auth_request" { u = $2; sub(/;$/, "", u); if (u != "off") want[u] = 1; next }
    $1 == "location" && $2 == "=" { cur = $3; next }
    cur != "" && $1 == "}" { cur = ""; next }
    cur != "" && $1 == "set" && $2 ~ /^\$/ { t = $3; sub(/;$/, "", t); target[cur] = t; next }
    cur != "" && $1 == "proxy_pass" {
      t = $2; sub(/;$/, "", t); sub(/^https?:\/\//, "", t); sub(/\/.*/, "", t)
      if (t !~ /^\$/) target[cur] = t
    }
    END { for (u in want) print u, ((u in target) ? target[u] : "-") }' |
    while read -r uri target; do
      case "$target" in
      *:[0-9]*) port="${target##*:}" ;;
      -)
        printf '::error::%s: auth_request %s proxies to nothing this deploy can read - the pairing check would count its connections as chosen requests\n' "$proxy" "$uri" >&2
        return 1
        ;;
      *)
        route="$(rotation_route "$target")"
        if [ "${route%% *}" != "$proxy" ]; then
          printf '::error::%s: auth_request %s proxies to %s, which is not routed through %s - its port is unknown\n' "$proxy" "$uri" "$target" "$proxy" >&2
          return 1
        fi
        port="${route#* }"
        ;;
      esac
      printf '%s\n' "$port"
    done | sort -u
  # The loop runs in a subshell: its `return 1` is the pipeline's status only through PIPESTATUS.
  [ "${PIPESTATUS[1]}" -eq 0 ]
}

# rotation_is_legacy <proxy> - reads `nginx -T` on stdin; true when it is a proxy from BEFORE the
# lists: it includes no rotation file at all, and names EVERY service routed through it by its DNS
# name and port (`set $upstream_gateway chat-gateway:3000;`). That is the frontend image a release
# still finds running on the first deploy that carries the lists, and after a rollback to an older
# release. Anything else that reads no list is refused.
rotation_is_legacy() {
  local proxy="$1" dump svc via port
  dump="$(cat)"
  case "$dump" in *"/rotation/"*) return 1 ;; esac
  while read -r svc via port; do
    [ "$via" = "$proxy" ] || continue
    case "$dump" in *"$svc:$port"*) ;; *) return 1 ;; esac
  done <<<"$ROTATION_ROUTES"
  return 0
}

# rotation_reload <proxy> <container> <mode> <subrequest ports> - reloads one replica of the proxy and
# returns once the reload has taken effect: a new worker exists, and, in mode `retiring`, the pairing
# check holds. A reload nginx refused (it can, after `nginx -T` accepted the files: a port it cannot
# bind) is read from the replica's own error log the moment no new worker has appeared.
rotation_reload() {
  local proxy="$1" pid="$2" mode="$3" ports="$4" hex="" p t0 before uid out read=0 waited=0 fresh unpaired alive
  for p in $ports; do hex="$hex $(printf '%04X' "$p")"; done
  t0="$(date +%s)"
  before="$($DOCKER_CLI exec "$pid" sh -c "$ROTATION_RELOAD_SCRIPT")" || {
    printf '::error::%s: %s did not take the reload signal - it keeps serving the old list; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
    return 1
  }
  uid="${before%%|*}"
  before="${before#*|}"
  [ -n "$uid" ] || {
    printf '::error::%s: %s had no worker to read before the reload - the pairing check has nothing to stand on; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
    return 1
  }
  while [ "$read" -lt "$ROLLING_ROTATION_READS" ]; do
    read=$((read + 1))
    # AS THE WORKERS' OWN USER, and it is load-bearing (measured 2026-11-01): /proc/<pid>/fd of a
    # process owned by another user needs CAP_SYS_PTRACE, which an exec does not have, so read as
    # root every fd list came back EMPTY, every old worker looked like it held nothing, and the check
    # held vacuously. nginx keeps its workers dumpable, so their own uid reads them with no
    # capability at all. A worker whose fds still read as nothing makes the read `?` (unknown).
    out="$($DOCKER_CLI exec -u "$uid" "$pid" sh -c "$ROTATION_READ_SCRIPT" sh "$before" "$ROTATION_PAIRS_AWK" "$hex")" || out=""
    read -r fresh alive unpaired clients ups skipped sockets <<<"$out"
    case "$fresh:$unpaired" in
    0:*)
      # No new worker yet: either the master has not got to the signal, or it refused the files.
      if $DOCKER_CLI logs --since "$t0" "$pid" 2>&1 | grep -F '[emerg]' >&2; then
        printf '::error::%s: %s REFUSED the reload (above) - it keeps serving the old list; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
        return 1
      fi
      ;;
    1:0 | 1:[0-9]*)
      if [ "$mode" != retiring ] || [ "$unpaired" = 0 ]; then
        printf '  %s: %s reloaded; ' "$proxy" "${pid:0:12}"
        if [ "$mode" = retiring ]; then
          printf 'paired after %s read(s) (%s old worker(s) still finishing proxied requests; %s client connection(s), %s upstream(s), %s subrequest connection(s) not counted; other sockets: %s)\n' \
            "$read" "$alive" "$clients" "$ups" "$skipped" "$(rotation_sockets_said "$sockets")"
        else
          printf 'a new worker runs on the list\n'
        fi
        return 0
      fi
      if [ "$waited" = 0 ]; then
        printf '  %s: %s waiting for %s request(s) of the old workers to choose an upstream (%s client connection(s), %s upstream(s), %s subrequest connection(s) not counted; other sockets: %s)\n' \
          "$proxy" "${pid:0:12}" "$unpaired" "$clients" "$ups" "$skipped" "$(rotation_sockets_said "$sockets")"
        waited=1
      fi
      ;;
    *)
      # `?`, or an exec that failed: unknown, which is never taken for clean.
      ;;
    esac
    sleep 0.5
  done
  printf '::error::%s: %s did not settle on the new list after %s reads (last read: %s) - the old replica stays up; stopping the deploy\n' \
    "$proxy" "${pid:0:12}" "$ROLLING_ROTATION_READS" "${out:-unreadable}" >&2
  return 1
}

# rotation_apply <proxy> <mode> - makes every running replica of <proxy> load the list last written
# (ROTATION_TOKEN), and returns once that has taken effect in each. Mode `retiring`: a replica is
# about to be stopped, so the pairing check must hold; mode `plain`: nothing is retired. A proxy with
# no running replica has nothing to reload: it reads the list when it starts.
#
# BEFORE A RELOAD, THE PROXY IS ASKED WHAT IT WOULD LOAD (`nginx -T`). The list must be in it, with
# this render's id: a proxy that does not include the file, or includes a different one (a missing or
# misdirected mount), would reload, pass the check, and keep choosing the replica about to stop. The
# one proxy allowed to read no list is a frontend image from before the lists (rotation_is_legacy),
# which is drained the way every deploy drained before them.
rotation_apply() {
  local proxy="$1" mode="$2" pid dump ports legacy=0
  for pid in $($DOCKER_CLI ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$proxy" --filter "label=com.docker.compose.oneoff=False"); do
    if ! dump="$($DOCKER_CLI exec "$pid" sh -c "$ROTATION_DUMP_SCRIPT" 2>&1)"; then
      printf '::error::%s: %s refuses its configuration with the new list - it keeps serving the old one; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
      printf '%s\n' "$dump" | tail -5 >&2
      cat "$(rotation_file "$proxy")" >&2 || true
      return 1
    fi
    if printf '%s\n' "$dump" | grep -qE "^# configuration file .*/rotation/$proxy\.conf:\$"; then
      if ! printf '%s\n' "$dump" | grep -qxF "# render $ROTATION_TOKEN"; then
        printf '::error::%s: %s includes a rotation/%s.conf that is not the one just written in %s (render %s) - its mount is not that directory; stopping the deploy\n' \
          "$proxy" "${pid:0:12}" "$proxy" "$ROTATION_DIR" "$ROTATION_TOKEN" >&2
        return 1
      fi
      ports="$(printf '%s\n' "$dump" | rotation_subrequest_ports "$proxy")" || return 1
      rotation_reload "$proxy" "$pid" "$mode" "$ports" || return 1
    elif printf '%s\n' "$dump" | rotation_is_legacy "$proxy"; then
      # A TRANSITION ONLY: the image still running is the PREVIOUS release's (the first deploy carrying
      # the lists, or the roll-forward after a rollback). The image this release deploys reading no
      # list is a release built wrong, and is refused like any proxy that reads none.
      rotation_runs_this_release "$proxy" "$pid"
      case $? in
      0)
        printf "::error::%s: %s runs THIS release's own image, and it reads no rotation/%s.conf - not a transition from an older release; stopping the deploy\n" \
          "$proxy" "${pid:0:12}" "$proxy" >&2
        return 1
        ;;
      1) printf "::warning title=A proxy from before the replica lists::%s: %s reads no rotation/%s.conf and names its services by DNS - the previous release's image (the first deploy carrying the lists, or the roll-forward after a rollback). It is drained the old way.\n" \
        "$proxy" "${pid:0:12}" "$proxy" >&2 ;;
      *) printf "::error::%s: %s reads no rotation/%s.conf, and whether it runs this release's image could not be read - drained the old way, as a transition would be\n" \
        "$proxy" "${pid:0:12}" "$proxy" >&2 ;;
      esac
      legacy=1
    else
      printf '::error::%s: %s includes no rotation/%s.conf, and does not name its services by DNS either - nothing would take a retiring replica out of its rotation; stopping the deploy\n' \
        "$proxy" "${pid:0:12}" "$proxy" >&2
      return 1
    fi
  done
  if [ "$legacy" = 1 ] && [ "$mode" = retiring ]; then
    # The pre-2026-11-01 drain, unchanged: such a proxy re-resolves the service by DNS every
    # ROLLING_RESOLVER_TTL_SECONDS, so once that has run out it names the new replica too. Its reset
    # window is the one every deploy had before the lists; the next deploy runs no such image.
    printf '  %s: waiting %ss for the DNS-resolving proxy to re-resolve (the drain from before the lists)\n' \
      "$proxy" "$((ROLLING_RESOLVER_TTL_SECONDS + 1))"
    sleep $((ROLLING_RESOLVER_TTL_SECONDS + 1))
  fi
}

# rotation_seed - reads the plan on stdin and writes every proxy's list in the resting form. Called
# BEFORE ANY `up`: the frontend and the edge include their list unconditionally and refuse to start
# without it - a fresh host, a lost directory. A list that already exists is normalised to the
# resting form too (a deploy killed mid-replacement leaves a container name in it).
#
# EVERY RUNNING PROXY IS RELOADED ON IT, CHANGED OR NOT (2026-11-01 review). "At rest" is a fact about
# what nginx RUNS, and the file is only what it was last told: a restore whose reload failed leaves the
# file at rest and nginx on a container name, and a seed that reloaded only on a changed file would
# never correct it - then a rollback, whose older library never touches the lists, retires that
# container and the proxy answers 502 (on the edge, the whole site). One graceful reload per proxy per
# deploy, verified like every other (rotation_apply reads the render id back through `nginx -T`).
rotation_seed() {
  local proxy
  rotation_routes_set
  [ -n "$ROTATION_ROUTES" ] || return 0
  [ -n "${ROTATION_DIR:-}" ] || {
    printf '::error::the plan routes services through a proxy, but the caller set no ROTATION_DIR\n' >&2
    return 1
  }
  mkdir -p "$ROTATION_DIR" || return 1
  for proxy in $(printf '%s\n' "$ROTATION_ROUTES" | awk 'NF { print $2 }' | sort -u); do
    rotation_write "$proxy" "" "" || return 1
    printf 'rotation: %s written for %s\n' "$(rotation_file "$proxy")" "$proxy"
    rotation_apply "$proxy" plain || return 1
  done
}

# The service one of whose replicas is out of rotation right now: set by replace_overlap from the
# take-out until its list is back at rest, so whatever ends the deploy in between - a failure, a
# cancelled job, a signal - knows which list to put back (rotation_restore_in_flight).
ROTATION_IN_FLIGHT=""

# rotation_restore_in_flight <why> - puts the list of the service in flight back at rest, if any, and
# says so at a level that accuses: a deploy that ends between a take-out and its restore is a deploy
# that did not end the way it was written to. For the caller's EXIT trap (deploy-environment.sh).
rotation_restore_in_flight() {
  local service="$ROTATION_IN_FLIGHT"
  [ -n "$service" ] || return 0
  printf '::error::%s with %s out of rotation - putting its list back at rest\n' "$1" "$service" >&2
  if rotation_restore "$service"; then
    ROTATION_IN_FLIGHT=""
    return 0
  fi
  printf '::error::%s: its list could NOT be put back at rest in what the proxy runs - the next deploy reloads it first (rotation_seed); a rollback before that would retire a replica the proxy still names\n' "$service" >&2
  return 1
}

# rotation_take_out <service> <container...> - the block of <service> names the given replicas alone
# (those of them running and healthy: the health filter applies to the service being replaced, and
# to nothing else), and the proxy is reloaded on it, the pairing check holding. A service with no
# route has nothing to do.
rotation_take_out() {
  local service="$1" route proxy port cid state names=""
  shift
  route="$(rotation_route "$service")"
  [ -n "$route" ] || return 0
  proxy="${route%% *}"
  port="${route#* }"
  for cid in "$@"; do
    state="$($DOCKER_CLI inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Name}}' "$cid" 2>/dev/null)" || continue
    case "$state" in
    'running healthy '* | 'running none '*) names="$names ${state##* /}" ;;
    esac
  done
  if [ -z "$names" ]; then
    printf '::error::%s: none of the replicas meant to stay (%s) is healthy - taking the others out would leave %s nothing to choose\n' "$service" "$*" "$proxy" >&2
    return 1
  fi
  # shellcheck disable=SC2086 # deliberate word splitting: one name per word
  rotation_write "$proxy" "$service" "$(rotation_block "$proxy" "$service" "$port" $names)" || return 1
  rotation_apply "$proxy" retiring
}

# rotation_restore <service> - the block of <service> back in the resting form (its DNS name: every
# replica that runs), the proxy reloaded on it when that changed it.
rotation_restore() {
  local service="$1" route proxy
  route="$(rotation_route "$service")"
  [ -n "$route" ] || return 0
  proxy="${route%% *}"
  rotation_write "$proxy" "$service" "$(rotation_block "$proxy" "$service" "${route#* }")" || return 1
  [ "$ROTATION_CHANGED" = yes ] || return 0
  rotation_apply "$proxy" plain
}

# The retiring replica's own sockets: no connection half-open (state 03, SYN_RECV) and every
# listener's accept queue empty (a LISTEN row's rx_queue IS that queue). Prints "<waiting>
# <established on a listened port>", or "? ?" when it read no table at all.
# shellcheck disable=SC2016 # an awk program
QUEUE_AWK='
$1 == "sl" { hdr = 1; next }
{
  n = split($2, a, ":"); port = a[n]
  if ($4 == "0A") { listen[port] = 1; if (substr($5, 10) != "00000000") w++ }
  else if ($4 == "03") w++
  else if ($4 == "01") { k++; E[k] = port }
}
END { if (!hdr) { print "? ?"; exit } for (i = 1; i <= k; i++) if (E[i] in listen) f++; print w + 0, f + 0 }'

# wait_unqueued <service> <container> - returns once nothing is waiting to be accepted by the
# replica, which rotation has already stopped sending anything new FROM nginx: two clean reads in a row
# mean no half-open connection from nginx could still complete and none is still queued. A read that
# fails (the exec, or the table) is UNKNOWN, never clean. In flight is printed, not waited for:
# SIGTERM is what drains it, and a WebSocket would never let it reach zero. Returns 1 when the reads
# run out.
#
# WHAT IT DOES NOT COVER: a call from ANOTHER SERVICE (chat-gateway to chat-delivery, social to core,
# frontend-ssr to all three...) resolves the replica through Docker's DNS, never left any rotation,
# and can arrive after the two reads - for those callers the reads are a clock, not a proof. The
# enumerated gap: docs/wiki/backlog.d/p2-service-to-service-calls-bypass-the-rotation.md.
wait_unqueued() {
  local service="$1" cid="$2" read=0 clean=0 out="" raw
  while [ "$read" -lt "$ROLLING_QUIESCE_READS" ]; do
    read=$((read + 1))
    if raw="$($DOCKER_CLI exec "$cid" sh -c 'cat /proc/net/tcp && { cat /proc/net/tcp6 2>/dev/null || true; }')"; then
      out="$(printf '%s\n' "$raw" | awk "$QUEUE_AWK")"
    else
      out="unreadable"
    fi
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
  # Out of rotation, so nothing new reaches it, but its queue was never read empty: its process is not
  # accepting, or its sockets cannot be read. Either way nothing proves stopping it is safe.
  printf '::error::%s: %s still had connections waiting, or could not be read (%s), after %s reads - not stopping it; stopping the deploy\n' \
    "$service" "${cid:0:12}" "${out:-unreadable}" "$ROLLING_QUIESCE_READS" >&2
  return 1
}

# retire <service> <container...> - drains and removes replicas already out of rotation. `docker
# stop` sends the image's stop signal and waits ROLLING_DRAIN_SECONDS for the process to leave by
# itself.
retire() {
  local service="$1" cid
  shift
  for cid in "$@"; do
    wait_unqueued "$service" "$cid" || return 1
    printf '  %s: retiring %s (drain up to %ss)\n' "$service" "${cid:0:12}" "$ROLLING_DRAIN_SECONDS"
    $DOCKER_CLI stop --time "$ROLLING_DRAIN_SECONDS" "$cid" >/dev/null || return 1
    $DOCKER_CLI rm "$cid" >/dev/null || return 1
  done
}

# replace_overlap <service> - the new replica beside the old, then the old one out of rotation, then
# out, then the list back at rest.
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
    rotation_restore "$service"
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
  # that holds. ANY failure from here puts the list back at rest - naming every replica still
  # running, the old one included, since nothing stopped it - so a failed deploy, like a finished
  # one, leaves lists an older release's deploy (a rollback) can follow. A restore that itself fails
  # leaves the service IN FLIGHT, so the caller's exit trap tries once more and says so.
  ROTATION_IN_FLIGHT="$service"
  if ! rotation_take_out "$service" "$new"; then
    rotation_restore_in_flight "the take-out failed" || true
    return 1
  fi
  # shellcheck disable=SC2086 # deliberate word splitting: one id per word
  if ! retire "$service" $old; then
    rotation_restore_in_flight "the retirement failed" || true
    return 1
  fi
  rotation_restore "$service" || return 1
  ROTATION_IN_FLIGHT=""
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
  rotation_routes_set <<<"$plan"
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
