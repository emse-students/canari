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
#              a list that sends the service's requests to the new replica's name alone, and
#              reloaded; the old replica is told to stop
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

# HOW LONG AN nginx KEEPS AN ADDRESS IT RESOLVED BY NAME: `valid=` in the resolver of the frontend
# image and of the edge, which resolve a resting target (a service's DNS name) per request. Two
# things read it, and neither is a guess:
#   - a frontend image from BEFORE the target lists (a transition, rotation_is_legacy) re-resolves
#     every service by DNS, so a replica it may still choose is retired only once this has run out -
#     the drain every deploy made before 2026-11-01;
#   - a ROLLBACK runs the older release's own rolling.sh, which waits exactly this long before
#     retiring, so the targets it finds (named by DNS, rotation_restore) must expire as fast.
# deploy-replace.test.sh holds this number to both proxies' configurations and to the frozen libraries.
ROLLING_RESOLVER_TTL_SECONDS=2
# The default stands for a caller of retire() outside replace_services (deploy-rolling.test.sh case 2b
# retires a replica directly): the window is then the whole log.
ROLLING_STARTED_AT="${ROLLING_STARTED_AT:-1970-01-01T00:00:00Z}"
TRANSPORT_RESETS_TOTAL=0
TRANSPORT_RESETS_UNKNOWN=0

# containers_of <service> [running] - every container of that service in this project, one id per
# line: running or not, or only the running ones with the second argument. One-off `compose run`
# containers are not replicas and are left out.
containers_of() {
  local all=-a
  [ "${2:-}" = running ] && all=""
  $DOCKER_CLI ps -q $all \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" \
    --filter "label=com.docker.compose.oneoff=False" \
    ${2:+--filter status=$2}
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
# list: the TARGET of every service it routes to, one `map "" $target_<service> { default <host>:<port>; }`
# per service, which its `proxy_pass http://$target_<service>` reads. Written by this file into
# ROTATION_DIR (mounted read-only into the frontend as /etc/nginx/targets and, through its own
# directory, into the edge) and applied by `nginx -s reload`.
#
# TWO FORMS, AND THE ESTATE RESTS IN THE FIRST. Between deploys every target is the service's DNS
# NAME (`core-service:3012`) - the very list the frontend image bakes for an estate with no such
# deploy, so `rotation_seed` can write it before anything starts. Only while ONE service is being
# replaced is its target the new replica's CONTAINER NAME (`canari-core-service-2:3012`, which
# Docker's DNS answers with that one container), so the old one is out before it stops; once the
# old one is gone the target goes back to the DNS name. Every other target is carried over byte for byte - a sibling
# is never re-read, so a sibling that is `starting` or `unhealthy` stays exactly as reachable as it
# was. The resting form is also what makes a ROLLBACK work: an older release's rolling.sh never
# rewrites these lists, and a target naming a replica that rollback removes would answer 502; a
# target naming the service by DNS follows that older deploy the way its own nginx always did.
#
# WHY A VARIABLE AND NOT AN `upstream` BLOCK (2026-11-02, the reset of main CI run 41368923993). The
# lists used to be `upstream <service> { server <name>:<port> resolve; }`, and nginx never resolves a
# `resolve` server when it loads a configuration: the new worker starts with that server's peers EMPTY
# and fills them when its own DNS query returns, carrying addresses over a reload only for a server
# whose NAME it already resolved. A take-out renamed the server (service -> container) and a restore
# renamed it back, so after each of those reloads the new worker refused what it took on the spot -
# `no live upstreams`: an ECONNRESET at the edge, a 502 at the frontend (252 resets in 300 renaming
# edge reloads, measured). A variable target has no peer list to start empty: a DNS name is resolved
# for the REQUEST, which waits for the answer - the service's name at rest as a container's during a
# take-out (deploy-rolling.test.sh case 2b reloads both proxies hundreds of times between the two
# under load, every POST asserted 200). And a variable target caches no upstream connection, so the
# pairing check below needs no `keepalive 0` to stay sound.

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

# rotation_var <service> - the nginx variable a proxy reads <service>'s target from, `$` left out:
# `target_` and the service's name, its `-` written `_` (nginx variable names take no `-`).
rotation_var() {
  printf 'target_%s' "${1//-/_}"
}

# rotation_block <service> <port> [<host>] - the one line that sets <service>'s target: the host given
# (a replica's container name), or, with none, the service's DNS name (the resting form). The same text, byte for byte, as the
# list baked in Dockerfile.frontend (deploy-replace.test.sh compares them). The same line serves an
# `http {}` and a `stream {}` context alike: `map` exists in both, with the same syntax.
rotation_block() {
  local service="$1" port="$2" host="${3:-}"
  printf 'map "" $%s { default %s:%s; }\n' "$(rotation_var "$service")" "${host:-$service}" "$port"
}

# rotation_existing_block <file> <service> - the line for <service> as the file holds it, or nothing.
rotation_existing_block() {
  [ -f "$1" ] || return 0
  awk -v s="map \"\" \$$(rotation_var "$2") {" 'index($0, s) == 1 { print; exit }' "$1"
}

# rotation_write <proxy> <service> <line> - rewrites the list of <proxy>: <service>'s line becomes
# <line>, every other line is carried over as the file holds it (written in the resting form only
# when the file has none). An empty <service> writes EVERY line in the resting form. Written to a
# temporary file and renamed, so a reload never reads half a file. Sets ROTATION_TOKEN and
# ROTATION_CHANGED.
rotation_write() {
  local proxy="$1" target="$2" block="$3" file tmp svc via port existing
  file="$(rotation_file "$proxy")"
  tmp="$file.tmp"
  ROTATION_TOKEN="$(date +%s)-$$-$RANDOM"
  {
    printf '# WRITTEN BY infrastructure/lib/rolling.sh AT EVERY DEPLOY - where %s sends each service.\n' "$proxy"
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
        rotation_block "$svc" "$port"
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
# and the workers, as "<pid>:<start time>:<uid>" so a recycled pid is never taken for the same worker.
# A worker an earlier reload retired exits on its own clock, between the listing of /proc and ANY
# later read of it, so every read of one worker happens in `workers` itself, together, and a worker
# gone before they are done is not listed: it is not one (the uid was once read afterwards, from the
# first worker listed - a retiring one, under load - and came back empty: "had no worker to read").
# shellcheck disable=SC2016 # runs in the proxy's shell, not this one
ROTATION_PROXY_PRELUDE='
workers() {
  for d in /proc/[0-9]*; do
    s="$(cat "$d/stat" 2>/dev/null)" || continue
    set -- $s
    [ "$4" = 1 ] || continue
    c="$(tr "\0" " " 2>/dev/null <"$d/cmdline")" || continue
    case "$c" in
    "nginx: worker process"*)
      u="$(awk "/^Uid:/ { print \$2 }" 2>/dev/null <"$d/status")" || continue
      [ -n "$u" ] && echo "$1:${22}:$u"
      ;;
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
w="${w%% *}"
uid="${w##*:}"
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
# every service an `auth_request` location proxies to: a `host:port` as written, a `$target_<service>`
# through the proxy's own route. Fails, rather than guessing, on a target it cannot place.
rotation_subrequest_ports() {
  local proxy="$1" uri target route port svc via p
  # shellcheck disable=SC2016 # an awk program
  awk '
    $1 == "auth_request" { u = $2; sub(/;$/, "", u); if (u != "off") want[u] = 1; next }
    $1 == "location" && $2 == "=" { cur = $3; next }
    cur != "" && $1 == "}" { cur = ""; next }
    cur != "" && $1 == "set" && $2 ~ /^\$/ { t = $3; sub(/;$/, "", t); target[cur] = t; next }
    cur != "" && $1 == "proxy_pass" {
      t = $2; sub(/;$/, "", t); sub(/^https?:\/\//, "", t); sub(/\/.*/, "", t)
      if (t !~ /^\$/ || t ~ /^\$target_/) target[cur] = t
    }
    END { for (u in want) print u, ((u in target) ? target[u] : "-") }' |
    while read -r uri target; do
      case "$target" in
      '$target_'*)
        route=""
        while read -r svc via p; do
          [ "$via" = "$proxy" ] && [ "\$$(rotation_var "$svc")" = "$target" ] && route="$p"
        done <<<"$ROTATION_ROUTES"
        if [ -z "$route" ]; then
          printf '::error::%s: auth_request %s proxies to %s, which names no service routed through %s - its port is unknown\n' "$proxy" "$uri" "$target" "$proxy" >&2
          return 1
        fi
        port="$route"
        ;;
      *:[0-9]*) port="${target##*:}" ;;
      *)
        printf '::error::%s: auth_request %s proxies to %s, which this deploy cannot place - the pairing check would count its connections as chosen requests\n' "$proxy" "$uri" "$target" >&2
        return 1
        ;;
      esac
      printf '%s\n' "$port"
    done | sort -u
  # The loop runs in a subshell: its `return 1` is the pipeline's status only through PIPESTATUS.
  [ "${PIPESTATUS[1]}" -eq 0 ]
}

# rotation_is_legacy <proxy> - reads `nginx -T` on stdin; true when it is a proxy from BEFORE the
# target lists: it includes no target list at all, and names EVERY service routed through it by its
# DNS name and port - `set $upstream_gateway chat-gateway:3000;` in an image from before any list, or
# `server chat-gateway:3000 resolve;` in one from the `upstream` lists (1.6.2), at rest. Both resolve
# the service by DNS every ROLLING_RESOLVER_TTL_SECONDS. That is the frontend image a release still
# finds running on the first deploy that carries the target lists, and after a rollback to an older
# release. Anything else that reads no target list is refused - an `upstream` list a killed 1.6.2
# deploy left naming a container among them, since that proxy would keep choosing it.
rotation_is_legacy() {
  local proxy="$1" dump svc via port
  dump="$(cat)"
  case "$dump" in *"/targets/"*) return 1 ;; esac
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
# one proxy allowed to read no target list is a frontend image from before them (rotation_is_legacy),
# which is drained the way every deploy drained before the lists.
#
# A REPLICA THAT IS NOT RUNNING IS SKIPPED IN MODE `plain`, with a warning (2026-11-01 third review).
# `docker ps` lists restarting and paused containers too, and an `exec` into one fails: refusing on it
# would stop the deploy before its migrations, so the release that fixes a crash-looping frontend could
# never ship. Skipping is exact for a restarting one - it reads the list on disk when it starts - and a
# paused one serves nothing until it is unpaused. In mode `retiring` the refusal stands: the pairing
# check cannot be proven on a replica it cannot read, and a replica is about to stop.
rotation_apply() {
  local proxy="$1" mode="$2" pid dump ports="" legacy=0 status
  for pid in $($DOCKER_CLI ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$proxy" --filter "label=com.docker.compose.oneoff=False"); do
    if [ "$mode" = plain ]; then
      status="$($DOCKER_CLI inspect -f '{{.State.Status}}' "$pid" 2>/dev/null)" || status="unreadable"
      if [ "$status" != running ]; then
        printf '::warning title=A proxy replica that is not running::%s: %s is %s - not reloaded; it reads the list on disk when it starts\n' \
          "$proxy" "${pid:0:12}" "$status" >&2
        continue
      fi
    fi
    if ! dump="$($DOCKER_CLI exec "$pid" sh -c "$ROTATION_DUMP_SCRIPT" 2>&1)"; then
      printf '::error::%s: %s refuses its configuration with the new list - it keeps serving the old one; stopping the deploy\n' "$proxy" "${pid:0:12}" >&2
      printf '%s\n' "$dump" | tail -5 >&2
      cat "$(rotation_file "$proxy")" >&2 || true
      return 1
    fi
    if grep -qE "^# configuration file .*/targets/$proxy\.conf:\$" <<<"$dump"; then
      if ! grep -qxF "# render $ROTATION_TOKEN" <<<"$dump"; then
        printf '::error::%s: %s includes a targets/%s.conf that is not the one just written in %s (render %s) - its mount is not that directory; stopping the deploy\n' \
          "$proxy" "${pid:0:12}" "$proxy" "$ROTATION_DIR" "$ROTATION_TOKEN" >&2
        return 1
      fi
      # The subrequest ports serve the pairing check alone, which only mode `retiring` runs.
      if [ "$mode" = retiring ]; then
        ports="$(printf '%s\n' "$dump" | rotation_subrequest_ports "$proxy")" || return 1
      fi
      rotation_reload "$proxy" "$pid" "$mode" "$ports" || return 1
    elif printf '%s\n' "$dump" | rotation_is_legacy "$proxy"; then
      # A TRANSITION ONLY: the image still running is the PREVIOUS release's (the first deploy carrying
      # the target lists, or the roll-forward after a rollback). The image this release deploys reading
      # no target list is a release built wrong, and is refused like any proxy that reads none.
      rotation_runs_this_release "$proxy" "$pid"
      case $? in
      0)
        printf "::error::%s: %s runs THIS release's own image, and it reads no targets/%s.conf - not a transition from an older release; stopping the deploy\n" \
          "$proxy" "${pid:0:12}" "$proxy" >&2
        return 1
        ;;
      1) printf "::warning title=A proxy from before the target lists::%s: %s reads no targets/%s.conf and names its services by DNS - the previous release's image (the first deploy carrying the target lists, or the roll-forward after a rollback). It is drained the old way.\n" \
        "$proxy" "${pid:0:12}" "$proxy" >&2 ;;
      *) printf "::error::%s: %s reads no targets/%s.conf, and whether it runs this release's image could not be read - drained the old way, as a transition would be\n" \
        "$proxy" "${pid:0:12}" "$proxy" >&2 ;;
      esac
      legacy=1
    else
      printf '::error::%s: %s includes no targets/%s.conf, and does not name its services by DNS either - nothing would take a retiring replica out of its rotation; stopping the deploy\n' \
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
# resting form too (a deploy killed mid-replacement leaves a container's name in it).
#
# EVERY RUNNING PROXY IS RELOADED ON IT, CHANGED OR NOT (2026-11-01 review). "At rest" is a fact about
# what nginx RUNS, and the file is only what it was last told: a restore whose reload failed leaves the
# file at rest and nginx on a container's name, and a seed that reloaded only on a changed file would
# never correct it - then a rollback, whose older library never touches these lists, retires that
# replica and the proxy answers 502 (on the edge, the whole site). One graceful reload per proxy per
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
# that did not end the way it was written to. For the caller's EXIT trap (deploy-environment.sh). The
# proxy is ALWAYS reloaded: the file may already be at rest from a restore whose reload failed.
rotation_restore_in_flight() {
  local service="$ROTATION_IN_FLIGHT"
  [ -n "$service" ] || return 0
  printf '::error::%s with %s out of rotation - putting its list back at rest\n' "$1" "$service" >&2
  if rotation_restore "$service" force; then
    ROTATION_IN_FLIGHT=""
    return 0
  fi
  printf '::error::%s: its list could NOT be put back at rest in what the proxy runs - the next deploy reloads it first (rotation_seed); a rollback before that would retire a replica the proxy still names\n' "$service" >&2
  return 1
}

# rotation_take_out <service> <container> - the target of <service> becomes the NAME of the given
# replica (running and healthy: the health check applies to the service being replaced, and to
# nothing else), and the proxy is reloaded on it, the pairing check holding. A NAME and not an
# address (2026-11-02 review): it is resolved for the request exactly as the resting service name is,
# so it follows the replica through a restart, and once the container is gone it answers NXDOMAIN
# instead of landing on whatever container Docker hands that address next - chat-gateway and
# frontend-ssr both listen on :3000, and the frontend sends `X-Internal-Token` to both. Docker's DNS
# answers a container's name on every network it is attached to, which is every network the proxy
# can reach it on. A service with no route has nothing to do.
rotation_take_out() {
  local service="$1" cid="$2" route proxy port state
  route="$(rotation_route "$service")"
  [ -n "$route" ] || return 0
  proxy="${route%% *}"
  port="${route#* }"
  state="$($DOCKER_CLI inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Name}}' "$cid" 2>/dev/null)" || state=gone
  case "$state" in
  'running healthy '* | 'running none '*) ;;
  *)
    printf '::error::%s: the replica meant to stay (%s) is %s - taking the others out would leave %s nothing to choose\n' "$service" "${cid:0:12}" "${state% *}" "$proxy" >&2
    return 1
    ;;
  esac
  rotation_write "$proxy" "$service" "$(rotation_block "$service" "$port" "${state##* /}")" || return 1
  rotation_apply "$proxy" retiring
}

# rotation_restore <service> [force] - the target of <service> back in the resting form (its DNS name:
# every replica that runs), the proxy reloaded on it when that changed it - or ALWAYS, with `force`.
# The retry after a failure needs `force` (2026-11-01 third review): a restore whose reload failed has
# already written the file at rest, so the retry finds it unchanged, and without `force` it would reload
# nothing, clear the marker and report success while nginx still names the container.
rotation_restore() {
  local service="$1" force="${2:-}" route proxy
  route="$(rotation_route "$service")"
  [ -n "$route" ] || return 0
  proxy="${route%% *}"
  rotation_write "$proxy" "$service" "$(rotation_block "$service" "${route#* }")" || return 1
  [ "$ROTATION_CHANGED" = yes ] || [ "$force" = force ] || return 0
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

# transport_resets <container> - prints how many lines of that container's log, since this deploy
# started, report a connection reset by a peer, or `unknown` when the read failed. BEST EFFORT, NEVER
# A GATE: a failed read prints an accusing ::warning:: and answers `unknown` - never a zero, which
# would read as "none seen" - and the deploy goes on.
#
# WHAT IT COUNTS, AND WHAT IT CANNOT NAME. The services run on bun, whose fetch error names neither
# the peer nor its port: a reset reads `The socket connection was closed unexpectedly` with code
# `ECONNRESET`, a refusal `Unable to connect` with code `ConnectionRefused` (sample taken on bun 1.4,
# `fetch` POSTing to a socket that resets, then to a closed port). So a line cannot be matched to a
# service-to-service call; the count is of RESETS in a service's own log, external callers included
# (Safe Browsing, Lydia, Authentik), and is read against the rate of an ordinary day. Refusals are
# NOT counted: they match boot-time retries to Postgres and Redis, and a stopped replica leaves
# Docker's DNS, so a refusal is not what a retirement causes. ROLLING_LOG_SINCE (RFC 3339) overrides
# the start of the window, for the test.
TRANSPORT_RESET_PATTERN='ECONNRESET|socket hang up|socket connection was closed unexpectedly'
transport_resets() {
  local out n
  if ! out="$($DOCKER_CLI logs --since "${ROLLING_LOG_SINCE:-$ROLLING_STARTED_AT}" "$1" 2>&1)"; then
    printf '::warning::[TRANSPORT_RESETS] could not read the log of %s - the count is UNKNOWN, not zero\n' "${1:0:12}" >&2
    echo unknown
    return 0
  fi
  # grep -c answers 0 or 1 when it ran (1: no match) and 2 when it did not: that one is UNKNOWN.
  local rc=0
  n="$(grep -cE "$TRANSPORT_RESET_PATTERN" <<<"$out")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    printf '::warning::[TRANSPORT_RESETS] could not count the log of %s - the count is UNKNOWN, not zero\n' "${1:0:12}" >&2
    echo unknown
    return 0
  fi
  echo "${n:-0}"
}

# transport_resets_report <service> <state> <container> - reads one container and prints its line,
# adding the count to the deploy-wide totals. `retired` is read AFTER `docker stop` (drain-time resets
# are in the log by then) and BEFORE `docker rm` takes the log with the container; `running` is read by the sweep that ends the deploy.
transport_resets_report() {
  local service="$1" state="$2" cid="$3" n
  n="$(transport_resets "$cid")"
  printf '[TRANSPORT_RESETS] service=%s container=%s state=%s count=%s\n' "$service" "${cid:0:12}" "$state" "$n"
  if [ "$n" = unknown ]; then
    TRANSPORT_RESETS_UNKNOWN=$((TRANSPORT_RESETS_UNKNOWN + 1))
  else
    TRANSPORT_RESETS_TOTAL=$((TRANSPORT_RESETS_TOTAL + n))
  fi
}

# transport_resets_sweep <service...> - reads every RUNNING container of the services this deploy
# replaced, once the last one is done, and prints the deploy-wide total. A caller is replaced before
# or after its peer depending on the order, so only a read at the END sees the resets a peer's
# retirement caused in a caller replaced earlier - or one never replaced at all.
transport_resets_sweep() {
  local service cid ids
  for service in "$@"; do
    if ! ids="$(containers_of "$service" running)"; then
      # A failed listing is not "no container": the service's count is UNKNOWN.
      printf '::warning::[TRANSPORT_RESETS] could not list the containers of %s - the count is UNKNOWN, not zero\n' "$service" >&2
      printf '[TRANSPORT_RESETS] service=%s container=- state=running count=unknown\n' "$service"
      TRANSPORT_RESETS_UNKNOWN=$((TRANSPORT_RESETS_UNKNOWN + 1))
      continue
    fi
    for cid in $ids; do
      transport_resets_report "$service" running "$cid"
    done
  done
  printf '[TRANSPORT_RESETS] total=%s unknown=%s\n' "$TRANSPORT_RESETS_TOTAL" "$TRANSPORT_RESETS_UNKNOWN"
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
    # A stopped container's log is still readable, and the drain's own resets are in it: read it
    # here, BEFORE `docker rm` takes the log with the container.
    transport_resets_report "$service" retired "$cid"
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
    grep -qx "$cid" <<<"$old" || new="$new $cid"
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
  local plan service mode ports replaced=""
  plan="$(cat)"
  ROLLING_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  rotation_routes_set <<<"$plan"
  while read -r service mode ports _ <&3; do
    [ -n "$service" ] || continue
    printf '\n-- %s (%s)\n' "$service" "$mode"
    replaced="$replaced $service"
    case "$mode" in
    overlap) replace_overlap "$service" || return 1 ;;
    exclusive | pinned) replace_in_place "$service" "$ports" || return 1 ;;
    *)
      printf '::error::%s: unknown replacement mode "%s"\n' "$service" "$mode" >&2
      return 1
      ;;
    esac
  done 3<<<"$plan"
  # shellcheck disable=SC2086 # deliberate word splitting: one service per word
  transport_resets_sweep $replaced
}
