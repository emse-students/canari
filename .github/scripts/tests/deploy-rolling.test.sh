#!/usr/bin/env bash
# Does a release replace an estate WITHOUT a member who is sending seeing a single failure?
#
# WHY THIS EXISTS (2026-10-17). Every production deploy answered `502` for the minute or two it took,
# and a message sent in that window showed "Echec de l'envoi" (backlog, 2026-10-09): the deploy's one
# `docker compose up -d` stopped each old container before its successor had booted.
# `infrastructure/lib/rolling.sh` replaces that, and the only honest proof is the outcome - a client
# sending throughout, and its count of failures. So this runs the REAL library, the REAL
# `replace-modes.py` and the REAL edge configuration against a four-service estate wired as
# production is (fixture in rolling-fixture/), with Docker, and asserts what the client saw:
#
#   0. the REAL frontend image and the REAL edge configuration accept the lists rolling.sh writes
#      (`nginx -t`), the frontend's `nginx -T` is what rolling.sh reads its subrequests from, and the
#      library of 1.6.2 (frozen in rolling-fixture/) takes that image for one it drains by DNS;
#   1. THE SWITCH: an estate deployed by 1.6.2, its frontend on that release's `upstream` lists, takes
#      a release that carries the target lists - the old frontend is drained the old way, never
#      refused, and the estate ends on targets;
#   2. a release under load: every POST answered 200, and only the new version is left running;
#   2b. THE RELOADS THEMSELVES: each proxy reloaded hundreds of times between a take-out list and the
#      resting one, under load - every POST answered 200 (the `upstream` lists failed this within a
#      few dozen reloads: a renamed `resolve` server starts its worker with no peer);
#   3. a request held in its `auth_request` when the release starts: the pairing check waits for it
#      to choose its upstream, and it is answered;
#   4. TWO ROLLBACKS, each run by the library an older release shipped (frozen in rolling-fixture/):
#      to 1.6.2, whose library finds this frontend naming every service by DNS and drains it so, and
#      then, after a roll-forward, to a release from before any list - the targets it finds name each
#      service by DNS, so the estate answers on the rolled-back version without anybody rewriting them;
#   5. a release whose new replica never starts: the deploy FAILS, and still no POST fails;
#   6. THE CONTROL - a release made the old way, one `up -d`: POSTs DO fail. Without it, a fixture too
#      slow or too gentle to catch an outage would pass the cases above for nothing.
#
# Needs Docker with compose, and bun for the client. ROLLTEST_COMPOSE overrides the compose command
# (to run it under the compose version a host actually has: 2.26.1 on the shared host, 2026-10-17).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
FIX="$REPO/.github/scripts/tests/rolling-fixture"
PASS=0
FAIL=0
ok() {
  printf '  ok   %s\n' "$1"
  PASS=$((PASS + 1))
}
fail() {
  printf '  FAIL %s\n' "$1"
  FAIL=$((FAIL + 1))
}

docker info >/dev/null 2>&1 || {
  printf '::error::deploy-rolling.test.sh needs a reachable Docker daemon - a skipped gate reads exactly like a passed one, so this fails instead\n' >&2
  exit 1
}

# The interpreter that runs replace-modes.py on the host is `python3`; on a workstation it may be
# named `python`. Each is asked to run, because a name on PATH can be a stub that prints and fails.
PYTHON=""
for candidate in python3 python; do
  if "$candidate" -c 'import json' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
[ -n "$PYTHON" ] || {
  printf '::error::no Python interpreter runs here - replace-modes.py cannot be exercised\n' >&2
  exit 1
}

# nopath <command...> - runs it with Git Bash's path rewriting off, for an argument that is a path
# INSIDE a container (`/etc/nginx/...`), which Git Bash would otherwise turn into a Windows path before
# docker.exe saw it. No effect off Windows.
nopath() { MSYS_NO_PATHCONV=1 "$@"; }
# Docker on Windows needs a Windows path for the bind mount; `pwd -W` gives one under Git Bash.
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
export EDGE_DIR FIX_DIR
FIX_DIR="$(host_path "$FIX")"
export ROLLTEST_PORT="${ROLLTEST_PORT:-18481}"
URL="http://127.0.0.1:${ROLLTEST_PORT}/api/send"

COMPOSE="${ROLLTEST_COMPOSE:-docker compose}"
# What rolling.sh asks of its caller.
DOCKER_CLI="docker"
PROJECT="canari-rolltest"
dc() {
  # shellcheck disable=SC2086 # COMPOSE may be two words
  $COMPOSE -f "$FIX_DIR/compose.yml" "$@"
}
on_port_conflict() { return 1; }
# Three seconds instead of ten: the fixture's API is busy for 1.5 s when SIGTERM arrives (api.mjs says
# why) and then answers what it holds in 150 ms, and a frontend replica holds no WebSocket here. A
# drained replica leaves by itself; this bounds only the one that cannot.
export ROLLING_DRAIN_SECONDS=3
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/rolling.sh
. "$REPO/infrastructure/lib/rolling.sh"

VERSIONS="v1 v2 v3 v4 v5a v5b v5 broken v6"
TMP="$(mktemp -d)"
cleanup() {
  # TAG and EDGE_DIR given: the file requires them, and the cleanup that runs FIRST has neither -
  # without them `down` failed silently and a previous run's estate survived into this one.
  TAG="${TAG:-cleanup}" EDGE_DIR="${EDGE_DIR:-/cleanup}" dc down -v --remove-orphans >/dev/null 2>&1 || true
  for v in $VERSIONS; do docker image rm -f "rolltest/api:$v" "rolltest/frontend:$v" >/dev/null 2>&1 || true; done
  docker image rm -f rolltest/frontend-real >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup
TMP="$(mktemp -d)"
# THE EDGE'S DIRECTORY IS A COPY of infrastructure/edge, mounted as production mounts the deployed
# checkout's: a rollback's `git reset --hard` puts an older release's nginx.conf there before that
# release's library runs, and the test does the same (use_edge_conf) without touching the repository.
# rolling.sh writes its target lists into targets/ (both proxies read them, as in production); the
# frozen library of 1.6.2 writes its `upstream` lists into rotation/.
EDGE="$TMP/edge"
mkdir -p "$EDGE/targets" "$EDGE/rotation"
EDGE_DIR="$(host_path "$EDGE")"
ROTATION_DIR="$EDGE/targets"
# use_edge_conf <file> - the edge's nginx.conf on disk becomes <file>, as a checkout of that release has it.
use_edge_conf() { cp "$1" "$EDGE/nginx.conf"; }
use_edge_conf "$REPO/infrastructure/edge/nginx.conf"
# with_release_1_6_2 <function...> - runs it with the library 1.6.2 shipped, in a subshell (it defines
# the same functions, and must not replace this file's), writing that release's lists where it did.
with_release_1_6_2() {
  (
    # shellcheck disable=SC2030 # this subshell's own, for the older library alone
    ROTATION_DIR="$EDGE/rotation"
    # shellcheck source-path=SCRIPTDIR source=rolling-fixture/rolling-upstream-lists.sh
    . "$FIX/rolling-upstream-lists.sh"
    "$@"
  )
}

# build <version> [<frontend conf>] - the API and the frontend of one release.
build() {
  docker build -q -t "rolltest/api:$1" --build-arg "VERSION=$1" -f "$FIX/api.Dockerfile" "$FIX" >/dev/null &&
    docker build -q -t "rolltest/frontend:$1" --build-arg "VERSION=$1" --build-arg "CONF=${2:-frontend.conf}" \
      -f "$FIX/frontend.Dockerfile" "$FIX" >/dev/null
}

# start_client <name> - POSTs through the edge until stop_client <name>.
start_client() {
  rm -f "$TMP/$1.stop"
  bun "$FIX/client.mjs" "$URL" "$TMP/$1.stop" "${ROLLTEST_CONCURRENCY:-4}" >"$TMP/$1.json" &
  CLIENT_PID=$!
  sleep 2
}
stop_client() {
  sleep 2
  : >"$TMP/$1.stop"
  wait "$CLIENT_PID"
  printf '    client: %s\n' "$(cat "$TMP/$1.json")"
}
# field <name> <js expression over the client's result r> - prints the value.
field() {
  bun -e "const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log($2)" "$TMP/$1.json"
}
failures() {
  field "$1" "Object.entries(r.statuses).filter(([k]) => k !== '200').map(([k, n]) => k + ' x' + n).join(', ')"
}
plan() {
  # `tr`: a Windows Python ends its lines with CR, which would end up inside a replica list.
  dc config --format json | "$PYTHON" "$REPO/infrastructure/lib/replace-modes.py" rolltest/ | tr -d '\r'
}
# deploy - what deploy-environment.sh does with the plan: the lists first, then the services.
deploy() {
  local p
  p="$(plan)"
  rotation_seed <<<"$p" && replace_services <<<"$p"
}
running_versions() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=api" \
    --format '{{.Image}}' | sort | tr '\n' ' '
}
# answered_by - the version that answers one POST through the edge, or nothing.
answered_by() {
  curl -fsS -X POST "$URL" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}
# lists_at_rest - every target of every list is its own service's DNS name, and no replica's name.
lists_at_rest() {
  local f
  # shellcheck disable=SC2031 # this file's own value; the older library's lived in its subshell
  for f in "$ROTATION_DIR"/*.conf; do
    [ -f "$f" ] || return 1
    # `map "" $target_<service> { default <host>:<port>; }` - the host must be the service, `-` as `_`.
    awk '$1 == "map" { n++; v = $3; sub(/^\$target_/, "", v); split($6, a, ":"); h = a[1]; gsub(/-/, "_", h); if (h != v) bad = 1 } END { exit bad || !n }' "$f" || return 1
  done
}
# auth_held - how many subrequests the auth service holds.
auth_held() {
  dc exec -T auth wget -qO- http://127.0.0.1:3001/held 2>/dev/null
}

# ── 0. The real configurations accept the lists ──────────────────────────────
printf 'deploy-rolling: the real frontend image and edge configuration, with rendered lists\n'
CTX="$TMP/frontend-ctx"
mkdir -p "$CTX/frontend/build/client" "$CTX/frontend/build/prerendered"
: >"$CTX/frontend/build/client/.keep"
: >"$CTX/frontend/build/prerendered/.keep"
if docker build -q -t rolltest/frontend-real -f "$REPO/infrastructure/local/Dockerfile.frontend" "$CTX" >/dev/null; then
  ok "Dockerfile.frontend builds (its own nginx -t, on the list it bakes)"
else
  fail "Dockerfile.frontend builds"
fi
# shellcheck disable=SC2016 # the image prefix as the compose file spells it, unexpanded on purpose
prod_plan="$(docker compose -f "$REPO/infrastructure/docker-compose.prod.yml" config --no-interpolate --format json 2>/dev/null |
  "$PYTHON" "$REPO/infrastructure/lib/replace-modes.py" '${REGISTRY:-ghcr.io}/${IMAGE_PREFIX:-emse-students/canari}/' | tr -d '\r')"
edge_image="$(docker compose -f "$REPO/infrastructure/docker-compose.prod.yml" config --no-interpolate --format json 2>/dev/null |
  "$PYTHON" -c 'import json, sys; print(json.load(sys.stdin)["services"]["edge"]["image"])')"
# The checks run in a subshell (they move ROTATION_DIR) and print "ok|fail <message>", counted here.
while read -r verdict message; do
  if [ "$verdict" = ok ]; then ok "$message"; else fail "$message"; fi
done < <(
  ROTATION_DIR="$TMP/real/edge/targets"
  # A project nothing runs: these lists are rendered, never applied to a live proxy.
  PROJECT="canari-rolltest-render"
  mkdir -p "$ROTATION_DIR"
  cp "$REPO/infrastructure/edge/nginx.conf" "$TMP/real/edge/nginx.conf"
  rotation_seed <<<"$prod_plan" >/dev/null || {
    echo fail "rotation_seed writes the production lists"
    exit 1
  }
  rot="$(host_path "$ROTATION_DIR")"
  rest="$(nopath docker run --rm -v "$rot:/etc/nginx/targets:ro" rolltest/frontend-real nginx -T -q 2>&1)"
  # A ROLLBACK RUNS THE LIBRARY OF 1.6.2 AGAINST THIS IMAGE. That library reads `nginx -T`: an image
  # that names a `/rotation/` path, or leaves a routed service unnamed by DNS, is refused and the
  # rollback stops; this one must be taken for an image it drains by DNS (its rotation_is_legacy).
  # shellcheck disable=SC2016 # evaluated in the subshell that loaded the older library
  if with_release_1_6_2 eval 'rotation_routes_set <<<"$prod_plan" && printf "%s\n" "$rest" | rotation_is_legacy frontend'; then
    echo ok "the library of 1.6.2 takes the real frontend at rest for one it drains by DNS, so a rollback to it is not refused"
  else
    echo fail "the library of 1.6.2 would REFUSE the real frontend - a rollback to it would stop (a /rotation/ path in nginx -T, or a service not named by DNS)"
  fi
  # NO `upstream` BLOCK, so no idle upstream connection is ever cached: the pairing check counts every
  # upstream connection of an old worker as a request that has chosen, which a cached one is not.
  if printf '%s\n' "$rest" | grep -qE '^[[:space:]]*upstream[[:space:]]'; then
    echo fail "the real frontend declares an upstream block - an idle cached connection would pass for a chosen request"
  else
    echo ok "the real frontend declares no upstream block, so it caches no upstream connection"
  fi
  # A list mid-replacement: core-service at one replica's container name, the rest at rest.
  rotation_write frontend core-service "$(rotation_block core-service 3012 canari-core-service-2)" || {
    echo fail "rotation_write sets core-service to a container's name"
    exit 1
  }
  # shellcheck disable=SC2031 # set by the rotation_write just above, in this same subshell
  token="$ROTATION_TOKEN"
  rotation_write edge frontend "$(rotation_block frontend 80 canari-frontend-2)" || {
    echo fail "rotation_write sets the frontend to a container's name"
    exit 1
  }
  if nopath docker run --rm -v "$rot:/etc/nginx/targets:ro" rolltest/frontend-real nginx -t -q >&2; then
    echo ok "the real frontend accepts a list naming a container"
  else
    echo fail "the real frontend accepts a list naming a container"
  fi
  dump="$(nopath docker run --rm -v "$rot:/etc/nginx/targets:ro" rolltest/frontend-real nginx -T -q 2>&1)"
  if printf '%s\n' "$dump" | grep -qE '^# configuration file /etc/nginx/targets/frontend\.conf:$' &&
    printf '%s\n' "$dump" | grep -qxF "# render $token"; then
    echo ok "the real frontend's nginx -T shows the mounted list, render id included"
  else
    echo fail "the real frontend's nginx -T does not show the mounted list with its render id"
  fi
  ports="$(printf '%s\n' "$dump" | rotation_subrequest_ports frontend | tr '\n' ' ')"
  if [ "$ports" = "3012 " ]; then
    echo ok "the real frontend's auth_request subrequests are read as core-service's port, 3012"
  else
    echo fail "the real frontend's auth_request subrequest ports read as '$ports', not '3012 '"
  fi
  if nopath docker run --rm -v "$(host_path "$TMP/real/edge"):/etc/nginx/edge:ro" "$edge_image" nginx -t -q -c /etc/nginx/edge/nginx.conf >&2; then
    echo ok "the real edge configuration accepts a list naming a container, on production's image $edge_image"
  else
    echo fail "the real edge configuration accepts a list naming a container, on $edge_image"
  fi
  # And a fresh host with no list at all: the reason rotation_seed runs before any `up`.
  rm -f "$ROTATION_DIR"/*.conf
  if nopath docker run --rm -v "$rot:/etc/nginx/targets:ro" rolltest/frontend-real nginx -t -q >/dev/null 2>&1; then
    echo fail "the real frontend starts with an EMPTY targets mount - the seed would be unnecessary, or the include is not the list"
  else
    echo ok "the real frontend refuses to start with no list - which is why the deploy seeds them first"
  fi
)

# ── 1. The switch, from an estate deployed by 1.6.2 ──────────────────────────
printf '\ndeploy-rolling: v1 up, deployed by the library of 1.6.2 with its upstream lists\n'
build v1 frontend-upstream-lists.conf || {
  fail "the fixture images build"
  exit 1
}
export TAG=v1
# The checkout of 1.6.2: its edge configuration reads edge/rotation/edge.conf.
use_edge_conf "$FIX/edge-upstream-lists.conf"
# Through the library too, which is the estate's first deploy: every service has no replica yet. Not
# `dc up`: compose 2.26 (the host's) hashes a service that has `depends_on` differently with and
# without `--no-deps`, so an estate brought up WITH dependencies would see its edge recreated by the
# first deploy - a real, one-time cost of the transition, and not what the cases measure.
deploy_1_6_2() {
  local p
  p="$(plan)"
  rotation_seed <<<"$p" && replace_services <<<"$p"
}
with_release_1_6_2 deploy_1_6_2 >"$TMP/v1.log" 2>&1 || {
  fail "the v1 estate comes up"
  cat "$TMP/v1.log" >&2
  exit 1
}
# ONE POST, NO RETRY: replace_services returned only once every service, the edge included, was
# HEALTHY - and the edge's healthcheck is its listener. A reset here is the deploy believing an edge
# that was not yet listening (3 runs in 62, 2026-10-18, before the edge had a healthcheck), so the
# edge's own log is printed: it separates "never listened" from "listened and could not reach frontend".
if [ "$(answered_by)" = v1 ]; then
  ok "v1 answers through the edge"
else
  fail "v1 answers through the edge"
  edge_cid="$(containers_of edge)"
  $DOCKER_CLI inspect -f 'edge state: {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$edge_cid" >&2 || true
  $DOCKER_CLI logs --tail 20 "$edge_cid" >&2 2>&1 || true
fi
edge_before="$(containers_of edge)"

printf '\ndeploy-rolling: v1 -> v2, the first release carrying the target lists\n'
build v2
export TAG=v2
# The checkout of this release: `git reset --hard` puts its edge configuration in place first.
use_edge_conf "$REPO/infrastructure/edge/nginx.conf"
if deploy >"$TMP/switch.log" 2>&1; then ok "the release is not refused by the old frontend"; else
  fail "the release is not refused by the old frontend"
  cat "$TMP/switch.log" >&2
fi
if grep -q '::warning title=A proxy from before the target lists::frontend' "$TMP/switch.log" &&
  grep -qE '^  frontend: waiting [0-9]+s for the DNS-resolving proxy' "$TMP/switch.log"; then
  ok "the old frontend is said, and drained the way every deploy drained before the lists"
else
  fail "the old frontend was neither named nor drained the old way"
fi
if grep -qE '^  edge: [0-9a-f]+ reloaded; paired' "$TMP/switch.log"; then
  ok "the edge took the old frontend out of its list, the pairing check holding"
else
  fail "the edge never proved the old frontend out of its list"
fi
if [ "$(answered_by)" = v2 ] && lists_at_rest; then
  ok "v2 answers, and every list is back at rest"
else
  fail "after the switch: answered by '$(answered_by)', lists: $(cat "$ROTATION_DIR"/*.conf 2>/dev/null | grep '^map' | tr -s ' ' | tr '\n' ' ')"
fi

# ── 2. A release under load ──────────────────────────────────────────────────
printf '\ndeploy-rolling: v2 -> v3, replaced by rolling.sh under load\n'
build v3
export TAG=v3
# A connection held open across the release, as a WebSocket is: the nginx worker proxying it keeps
# the OLD replica list after the reload, for as long as the connection lives. The release must prove
# that worker can no longer choose a replica, not wait for it to exit - which would be never.
curl -sN "http://127.0.0.1:${ROLLTEST_PORT}/api/hold" >/dev/null 2>&1 &
HOLD_PID=$!
start_client release
if deploy | tee "$TMP/release.log"; then ok "replace_services succeeded"; else fail "replace_services succeeded"; fi
kill "$HOLD_PID" 2>/dev/null || true
if grep -qE '^  frontend: [0-9a-f]+ reloaded; paired .*\([1-9][0-9]* old worker\(s\) still finishing' "$TMP/release.log"; then
  ok "a connection an old frontend worker was still proxying did not hold the release back"
else
  fail "no frontend reload was paired with an old worker still proxying - the held connection was not seen, or was waited for"
fi
if nopath dc exec -T edge nginx -s reload -c /etc/nginx/edge/nginx.conf >/dev/null 2>&1; then
  ok "the edge reloads its configuration in place"
else
  fail "the edge reloads its configuration in place"
fi
stop_client release
bad="$(failures release)"
total="$(field release "Object.values(r.statuses).reduce((a, b) => a + b, 0)")"
if [ -z "$bad" ] && [ "${total:-0}" -gt 20 ]; then
  ok "every one of $total POSTs sent across the release was answered 200"
else
  fail "POSTs sent across the release failed: ${bad:-none} (of $total)"
  # What the proxies said, so the failure names its cause in the CI log (2026-11-02: one ECONNRESET
  # in 401 could only be explained by reproducing it; the edge had logged `no live upstreams`).
  dc logs --no-color --timestamps edge frontend api 2>&1 | grep -E '\[(warn|error|crit|alert|emerg)\]|DRAIN' | sed 's/^/    /'
fi
if [ "$(field release "r.versions.v3 > 0 ? 'yes' : 'no'")" = yes ]; then
  ok "the new release answered during the run"
else
  fail "the new release never answered during the run"
fi
if [ "$(running_versions)" = "rolltest/api:v3 " ]; then
  ok "only v3 is left running"
else
  fail "left running after the release: $(running_versions)"
fi
if lists_at_rest; then ok "every list is back at rest"; else fail "a list still names a replica after the release"; fi
if [ "$(containers_of edge)" = "$edge_before" ]; then
  ok "the edge is the same container it was before the release"
else
  fail "the release recreated the edge ($edge_before -> $(containers_of edge)) - the one container that must never be replaced"
fi

# ── 2b. Every proxy reloaded between a take-out and its restore, under load ──
# THE RELOAD ITSELF MUST COST NOTHING (2026-11-02, main CI run 41368923993: one ECONNRESET in 401
# POSTs). A release reloads each proxy twice per replaced service - onto the take-out list, then back
# onto the resting one - and the `upstream` lists made each of those reloads start a worker with NO
# peer until its DNS query returned: what it took meanwhile was refused (`no live upstreams`). Case 2
# crosses four such reloads, which is why it failed once in 58 runs; this crosses hundreds, so a
# window that small fails it every time (measured on the `upstream` lists: see the wiki).
# The two lists of each proxy are rendered by the library itself, then swapped in and reloaded, the
# edge's and the frontend's in turn. rotation_reload returns once a worker started after the reload
# exists, so every reload counted here took effect.
# THE API IS A REAL OLD -> NEW SWITCH (2026-11-02 review): a second API replica runs beside the first,
# so the frontend's resting list (the DNS name) reaches both and its take-out list names the new one
# alone - each frontend reload takes the old replica out of rotation or puts it back, as a release
# does, under load. The case ends the way a release does, by the library: the new one alone, the old
# one retired, the list at rest. The edge's take-out names the one frontend running.
STORM_CYCLES="${ROLLTEST_STORM_CYCLES:-75}"
printf '\ndeploy-rolling: each proxy reloaded %s times between its take-out list and its resting one, under load\n' \
  "$((STORM_CYCLES * 2))"
rotation_routes_set <<<"$(plan)"
storm=ready
api_old="$(containers_of api)"
dc up -d --no-deps --no-recreate --scale api=2 api >"$TMP/storm.log" 2>&1 || storm=unscaled
api_cid=""
for cid in $(containers_of api); do [ "$cid" = "$api_old" ] || api_cid="$cid"; done
if [ -z "$api_cid" ] || ! wait_healthy "$api_cid" api >>"$TMP/storm.log" 2>&1; then storm=unscaled; fi
fe_cid="$(containers_of frontend)"
edge_cid="$(containers_of edge)"
if [ "$storm" = ready ] &&
  ! { rotation_take_out api "$api_cid" && cp "$(rotation_file frontend)" "$TMP/frontend.out" &&
    rotation_restore api force && cp "$(rotation_file frontend)" "$TMP/frontend.rest" &&
    rotation_take_out frontend "$fe_cid" && cp "$(rotation_file edge)" "$TMP/edge.out" &&
    rotation_restore frontend force && cp "$(rotation_file edge)" "$TMP/edge.rest"; } >>"$TMP/storm.log" 2>&1; then
  storm=unrendered
fi
for proxy in frontend edge; do
  # The render id aside, the two lists must differ, or this would reload one list onto itself.
  cmp -s <(grep -v '^# render ' "$TMP/$proxy.out") <(grep -v '^# render ' "$TMP/$proxy.rest") && storm=unrendered
done
reloads=0
if [ "$storm" = ready ]; then
  ROLLTEST_CONCURRENCY=12 start_client storm
  for _ in $(seq 1 "$STORM_CYCLES"); do
    for form in out rest; do
      for proxy in frontend edge; do
        case "$proxy" in frontend) cid="$fe_cid" ;; *) cid="$edge_cid" ;; esac
        if cp "$TMP/$proxy.$form" "$(rotation_file "$proxy")" && rotation_reload "$proxy" "$cid" plain "" >>"$TMP/storm.log" 2>&1; then
          reloads=$((reloads + 1))
        else
          storm=failed
        fi
      done
    done
  done
  stop_client storm
fi
if [ "$storm" = ready ]; then
  ok "$reloads reloads, each proxy alternating between a take-out list and the resting one, every one taking effect"
else
  fail "the reloads could not all be made ($storm, $reloads made)"
  cat "$TMP/storm.log" >&2
fi
if [ -s "$TMP/storm.json" ]; then
  bad="$(failures storm)"
  total="$(field storm "Object.values(r.statuses).reduce((a, b) => a + b, 0)")"
  if [ -z "$bad" ] && [ "${total:-0}" -gt 100 ]; then
    ok "every one of $total POSTs sent across $reloads reloads was answered 200"
  else
    fail "POSTs sent across $reloads reloads failed: ${bad:-none} (of $total)"
    dc logs --no-color --timestamps edge frontend 2>&1 | grep -E '\[(warn|error|crit|alert|emerg)\]' | tail -n 10 | sed 's/^/    /'
  fi
fi
# The release's own end: the new API replica alone, the old one drained and removed, the list at rest.
if { rotation_take_out api "$api_cid" && retire api "$api_old" && rotation_restore api; } >>"$TMP/storm.log" 2>&1 &&
  [ "$(containers_of api)" = "$api_cid" ]; then
  ok "the old API replica is retired by the library, the new one alone serving"
else
  fail "the old API replica could not be retired after the reloads"
  cat "$TMP/storm.log" >&2
fi
if lists_at_rest; then ok "every list is back at rest after the reloads"; else fail "a list still names a replica after the reloads"; fi

# ── 3. A request held in its auth_request ────────────────────────────────────
printf '\ndeploy-rolling: v3 -> v4 with a POST still in its auth_request\n'
build v4
export TAG=v4
curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${ROLLTEST_PORT}/api/hold-auth" >"$TMP/hold-auth.code" &
AUTH_PID=$!
for _ in $(seq 1 50); do
  [ "$(auth_held)" = 1 ] && break
  sleep 0.2
done
if [ "$(auth_held)" = 1 ]; then ok "the POST is held in its auth subrequest before the release starts"; else fail "the POST never reached its auth subrequest"; fi
# NO IDLE CONNECTION TO THE API IS CACHED (2026-11-01): an idle cached connection is one the pairing
# check cannot tell from a chosen request (CI: 13 of them paired this POST, which then got a 502). Only
# an `upstream` block with `keepalive` caches one, and the target lists declare none - asserted on the
# running frontend's own `nginx -T`, not on a socket count: a count read right after a request also
# sees the upstream nginx is in the middle of closing (measured: 4, gone a second later), which no read
# can tell from a cached one without a clock.
cached=""
for c in $(containers_of frontend); do
  dump="$(docker exec "$c" nginx -T 2>/dev/null)" || {
    cached="$cached unreadable:${c:0:12}"
    continue
  }
  printf '%s\n' "$dump" | grep -qE '^[[:space:]]*upstream[[:space:]]' && cached="$cached ${c:0:12}"
done
if [ -z "$cached" ] && [ -n "$(containers_of frontend)" ]; then
  ok "the running frontend declares no upstream block, so it caches no connection to the api"
else
  fail "the running frontend declares an upstream block, or could not be read:${cached:- no frontend running}"
fi
deploy >"$TMP/auth.log" 2>&1 &
DEPLOY_PID=$!
# Released once the deploy either waits for it (the check is sound) or has moved on to retiring the
# old API without it (the check counted the subrequest's connection as a chosen request). Bounded
# only for the failure case: the deploy builds nothing, so either line comes within seconds.
waited=no
for _ in $(seq 1 600); do
  if grep -qE '^  frontend: [0-9a-f]+ waiting for [1-9][0-9]* request' "$TMP/auth.log"; then
    waited=yes
    break
  fi
  grep -q '^  api: retiring' "$TMP/auth.log" && break
  sleep 0.2
done
dc exec -T auth wget -qO- http://127.0.0.1:3001/release >/dev/null 2>&1
wait "$AUTH_PID"
# The check's own evidence, pass or fail: what it counted in the old frontend workers.
grep -E '^  frontend: [0-9a-f]+ (reloaded; paired|waiting for)' "$TMP/auth.log" || true
if wait "$DEPLOY_PID"; then ok "the release succeeded"; else
  fail "the release succeeded"
  cat "$TMP/auth.log" >&2
fi
if [ "$waited" = yes ]; then
  ok "the pairing check waited for the request in its auth_request, rather than count the subrequest as its upstream"
else
  fail "the pairing check did not wait for the request in its auth_request"
  cat "$TMP/auth.log" >&2
fi
if [ "$(cat "$TMP/hold-auth.code")" = 200 ]; then
  ok "the POST released from its auth_request was answered 200"
else
  fail "the POST released from its auth_request was answered $(cat "$TMP/hold-auth.code")"
fi

# ── 3b. A list at rest on disk that the proxy does not run ──────────────────
# What a restore whose reload failed leaves (2026-11-01 review): the file names the API by DNS, the
# frontend still runs a list naming its container. The next deploy's seed must reload anyway - the
# rollback below would otherwise retire that replica under a frontend still choosing it.
printf '\ndeploy-rolling: a list at rest on disk, while the frontend still runs a container name\n'
api_name="$(docker inspect -f '{{.Name}}' "$(containers_of api)")"
rotation_write frontend api "$(rotation_block api 3000 "${api_name#/}")" &&
  rotation_apply frontend plain >/dev/null &&
  rotation_write frontend "" ""
# The seed's own report: rotation_reload says `reloaded` only once it has seen a worker started after
# the reload it sent, and the render id it wrote read back through `nginx -T`.
if rotation_seed <<<"$(plan)" >"$TMP/seed.log" 2>&1 && grep -qE '^  frontend: [0-9a-f]+ reloaded; a new worker runs on the list$' "$TMP/seed.log"; then
  ok "the next deploy's seed reloads a frontend whose list is at rest on disk but not in what it runs"
else
  fail "the seed did not reload the frontend whose list was at rest on disk only"
  cat "$TMP/seed.log" >&2
fi

# ── 4a. A rollback to 1.6.2, by its own library ─────────────────────────────
# What re-running the deploy of 1.6.2 does: its checkout's edge configuration (reading edge/rotation/),
# then its library, which writes its `upstream` lists and never reads the targets. It finds THIS
# frontend running, which includes no `/rotation/` list and names every service by DNS, so it takes it
# for a frontend from before its lists and drains it the way it drains those: by DNS, and a wait.
printf '\ndeploy-rolling: v4 -> v5a, ROLLED BACK by the library of 1.6.2 with its frontend\n'
build v5a frontend-upstream-lists.conf
export TAG=v5a
use_edge_conf "$FIX/edge-upstream-lists.conf"
if with_release_1_6_2 deploy_1_6_2 >"$TMP/rollback-1-6-2.log" 2>&1; then
  ok "the library of 1.6.2 replaces the estate, not refused by this release's frontend"
else
  fail "the library of 1.6.2 replaces the estate"
  cat "$TMP/rollback-1-6-2.log" >&2
fi
if grep -q '::warning title=A proxy from before the replica lists::frontend' "$TMP/rollback-1-6-2.log"; then
  ok "the library of 1.6.2 drained this release's frontend by DNS, as one from before its lists"
else
  fail "the library of 1.6.2 did not take this release's frontend for one it drains by DNS"
fi
if [ "$(answered_by)" = v5a ] && [ "$(running_versions)" = "rolltest/api:v5a " ]; then
  ok "the estate rolled back to 1.6.2 answers v5a"
else
  fail "after the rollback to 1.6.2: answered by '$(answered_by)', running $(running_versions)"
fi

printf '\ndeploy-rolling: v5a -> v5b, rolled forward again by this library\n'
build v5b
export TAG=v5b
use_edge_conf "$REPO/infrastructure/edge/nginx.conf"
if deploy >"$TMP/forward.log" 2>&1 && [ "$(answered_by)" = v5b ] && lists_at_rest; then
  ok "the roll-forward replaces the 1.6.2 estate, v5b answers, and every list is at rest"
else
  fail "the roll-forward: answered by '$(answered_by)', running $(running_versions)"
  cat "$TMP/forward.log" >&2
fi

# ── 4. A rollback, by the library of a release older than the lists ─────────
printf '\ndeploy-rolling: v5b -> v5, ROLLED BACK by the pre-lists library with a pre-lists frontend\n'
build v5 frontend-pre-rotation.conf
export TAG=v5
if lists_at_rest; then ok "the lists a rollback finds name each service by DNS"; else fail "the lists a rollback finds name a replica"; fi
# A subshell: the frozen library defines the same functions, and must not replace this one's.
if (
  # shellcheck source-path=SCRIPTDIR source=rolling-fixture/rolling-pre-rotation.sh
  . "$FIX/rolling-pre-rotation.sh"
  replace_services <<<"$(plan)"
) >"$TMP/rollback.log" 2>&1; then
  ok "the older library replaces the estate"
else
  fail "the older library replaces the estate"
  cat "$TMP/rollback.log" >&2
fi
# NO edge reload in between: what the edge loaded from the list it found must reach v5 by itself.
# The older library retires the old frontend as soon as its own 3 s wait is over, so the edge may still
# hold that address for the rest of its `valid=2s` - the reset window that library always had (CI,
# 2026-11-01: the first POST failed, the next answered v5). A list still naming a removed replica
# would fail EVERY attempt, so the attempts span one resolver lifetime and no more: one POST each
# half second, ROLLING_RESOLVER_TTL_SECONDS * 2 + 2 of them.
rolled=""
# shellcheck disable=SC2031 # this file's own rolling.sh value; the frozen library's copy lived in its subshell
for _ in $(seq 1 $((ROLLING_RESOLVER_TTL_SECONDS * 2 + 2))); do
  rolled="$(answered_by)"
  [ "$rolled" = v5 ] && break
  sleep 0.5
done
if [ "$rolled" = v5 ] && [ "$(running_versions)" = "rolltest/api:v5 " ]; then
  ok "the rolled-back estate answers v5 through the edge within one resolver lifetime, the lists untouched"
else
  fail "after the rollback: answered by '$rolled', running $(running_versions)"
fi

# ── 5. A new replica that never becomes healthy ──────────────────────────────
printf '\ndeploy-rolling: v5 -> broken, whose new replica never starts\n'
build broken
export TAG=broken
start_client broken
if deploy >"$TMP/broken.log" 2>&1; then
  fail "a release whose replica never starts makes replace_services fail"
else
  ok "a release whose replica never starts makes replace_services fail"
fi
stop_client broken
bad="$(failures broken)"
if [ -z "$bad" ]; then
  ok "and not one POST failed meanwhile"
else
  fail "POSTs failed while the broken release was refused: $bad"
fi
if [ "$(running_versions)" = "rolltest/api:v5 " ] && lists_at_rest; then
  ok "the old replica (v5) is still the one serving, and the lists are at rest"
else
  fail "serving after the refused release: $(running_versions)"
fi

# ── 6. THE CONTROL: the same release, the old way ────────────────────────────
printf '\ndeploy-rolling: v5 -> v6 the OLD way (one "up -d"), which must be seen to fail\n'
build v6
export TAG=v6
start_client control
dc up -d >/dev/null 2>&1
stop_client control
bad="$(failures control)"
if [ -n "$bad" ]; then
  ok "the control sees the outage the old deploy caused ($bad) - this fixture can fail"
else
  fail "the control saw NO failure under a plain 'up -d' - the fixture cannot detect an outage, so the cases above prove nothing"
fi

printf '\ndeploy-rolling: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
