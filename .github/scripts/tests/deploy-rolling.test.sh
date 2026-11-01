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
#      (`nginx -t`), and the frontend's `nginx -T` is what rolling.sh reads its subrequests from;
#   1. THE SWITCH: an estate whose frontend predates the replica lists takes a release that carries
#      them - the old frontend is drained the old way, never refused, and the estate ends on lists;
#   2. a release under load: every POST answered 200, and only the new version is left running;
#   3. a request held in its `auth_request` when the release starts: the pairing check waits for it
#      to choose its upstream, and it is answered;
#   4. A ROLLBACK, run by the library an older release shipped (frozen in rolling-fixture/): the lists
#      it finds name each service by DNS, so the estate answers on the rolled-back version without
#      anybody rewriting them;
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
EDGE_DIR="$(host_path "$REPO/infrastructure/edge")"
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
# Where rolling.sh writes the replica lists: the real edge/rotation, which the edge mounts with edge/
# and the fixture's frontend mounts as production's does. The written lists are never tracked.
ROTATION_DIR="$REPO/infrastructure/edge/rotation"
# Three seconds instead of ten: the fixture's API is busy for 1.5 s when SIGTERM arrives (api.mjs says
# why) and then answers what it holds in 150 ms, and a frontend replica holds no WebSocket here. A
# drained replica leaves by itself; this bounds only the one that cannot.
export ROLLING_DRAIN_SECONDS=3
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/rolling.sh
. "$REPO/infrastructure/lib/rolling.sh"

VERSIONS="v1 v2 v3 v4 v5 broken v6"
TMP="$(mktemp -d)"
cleanup() {
  # TAG given: the file requires it, and the cleanup that runs FIRST has none - without it `down`
  # failed silently and a previous run's estate survived into this one.
  TAG="${TAG:-cleanup}" dc down -v --remove-orphans >/dev/null 2>&1 || true
  for v in $VERSIONS; do docker image rm -f "rolltest/api:$v" "rolltest/frontend:$v" >/dev/null 2>&1 || true; done
  docker image rm -f rolltest/frontend-real >/dev/null 2>&1 || true
  rm -f "$ROTATION_DIR"/*.conf "$ROTATION_DIR"/*.tmp
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup
TMP="$(mktemp -d)"

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
# lists_at_rest - every block of every list names its own service by DNS, and no container.
lists_at_rest() {
  local f
  for f in "$ROTATION_DIR"/*.conf; do
    [ -f "$f" ] || return 1
    awk '/^upstream [^ ]+ \{$/ { u = $2; next } $1 == "server" { split($2, a, ":"); if (a[1] != u) bad = 1 } END { exit bad }' "$f" || return 1
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
  ROTATION_DIR="$TMP/real/edge/rotation"
  # A project nothing runs: these lists are rendered, never applied to a live proxy.
  PROJECT="canari-rolltest-render"
  mkdir -p "$ROTATION_DIR"
  cp "$REPO/infrastructure/edge/nginx.conf" "$TMP/real/edge/nginx.conf"
  rotation_seed <<<"$prod_plan" >/dev/null || {
    echo fail "rotation_seed writes the production lists"
    exit 1
  }
  # A list mid-replacement: core-service named by a container, the rest at rest.
  rotation_write frontend core-service "$(rotation_block core-service 3012 canari-core-service-2)" || {
    echo fail "rotation_write names core-service by a container"
    exit 1
  }
  token="$ROTATION_TOKEN"
  rotation_write edge frontend "$(rotation_block frontend 80 canari-frontend-2)" || {
    echo fail "rotation_write names the frontend by a container"
    exit 1
  }
  rot="$(host_path "$ROTATION_DIR")"
  if nopath docker run --rm -v "$rot:/etc/nginx/rotation:ro" rolltest/frontend-real nginx -t -q >&2; then
    echo ok "the real frontend accepts a list naming a container"
  else
    echo fail "the real frontend accepts a list naming a container"
  fi
  dump="$(nopath docker run --rm -v "$rot:/etc/nginx/rotation:ro" rolltest/frontend-real nginx -T -q 2>&1)"
  if printf '%s\n' "$dump" | grep -qE '^# configuration file /etc/nginx/rotation/frontend\.conf:$' &&
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
  if nopath docker run --rm -v "$rot:/etc/nginx/rotation:ro" rolltest/frontend-real nginx -t -q >/dev/null 2>&1; then
    echo fail "the real frontend starts with an EMPTY rotation mount - the seed would be unnecessary, or the include is not the list"
  else
    echo ok "the real frontend refuses to start with no list - which is why the deploy seeds them first"
  fi
)

# ── 1. The switch, from a frontend that predates the lists ───────────────────
printf '\ndeploy-rolling: v1 up, its frontend from before the replica lists\n'
build v1 frontend-pre-rotation.conf || {
  fail "the fixture images build"
  exit 1
}
export TAG=v1
# Through the library too, which is the estate's first deploy: every service has no replica yet. Not
# `dc up`: compose 2.26 (the host's) hashes a service that has `depends_on` differently with and
# without `--no-deps`, so an estate brought up WITH dependencies would see its edge recreated by the
# first deploy - a real, one-time cost of the transition, and not what the cases measure.
deploy >"$TMP/v1.log" 2>&1 || {
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

printf '\ndeploy-rolling: v1 -> v2, the first release carrying the lists\n'
build v2
export TAG=v2
if deploy >"$TMP/switch.log" 2>&1; then ok "the release is not refused by the old frontend"; else
  fail "the release is not refused by the old frontend"
  cat "$TMP/switch.log" >&2
fi
if grep -q '::warning title=A proxy from before the replica lists::frontend' "$TMP/switch.log" &&
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
  fail "after the switch: answered by '$(answered_by)', lists: $(cat "$ROTATION_DIR"/*.conf 2>/dev/null | grep server | tr -s ' ' | tr '\n' ' ')"
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
if lists_at_rest; then ok "every list is back at rest"; else fail "a list still names a container after the release"; fi
if [ "$(containers_of edge)" = "$edge_before" ]; then
  ok "the edge is the same container it was before the release"
else
  fail "the release recreated the edge ($edge_before -> $(containers_of edge)) - the one container that must never be replaced"
fi

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
if wait "$DEPLOY_PID"; then ok "the release succeeded"; else
  fail "the release succeeded"
  cat "$TMP/auth.log" >&2
fi
if [ "$waited" = yes ]; then
  ok "the pairing check waited for the request in its auth_request, rather than count the subrequest as its upstream"
else
  fail "the pairing check did not wait for the request in its auth_request"
  cat "$TMP/auth.log" >&2
  # What the old workers' other sockets were: the proxies' own access lines, and each table.
  dc logs --no-color --tail 60 frontend api >&2 2>&1 || true
  for c in $(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=frontend"); do
    printf -- '-- %s /proc/net/tcp\n' "$c" >&2
    docker exec "$c" cat /proc/net/tcp >&2 || true
  done
fi
if [ "$(cat "$TMP/hold-auth.code")" = 200 ]; then
  ok "the POST released from its auth_request was answered 200"
else
  fail "the POST released from its auth_request was answered $(cat "$TMP/hold-auth.code")"
fi

# ── 4. A rollback, by the library of a release older than the lists ─────────
printf '\ndeploy-rolling: v4 -> v5, ROLLED BACK by the pre-lists library with a pre-lists frontend\n'
build v5 frontend-pre-rotation.conf
export TAG=v5
if lists_at_rest; then ok "the lists a rollback finds name each service by DNS"; else fail "the lists a rollback finds name a container"; fi
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
# 2026-11-01: the first POST failed, the next answered v5). A list still naming a removed container
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
