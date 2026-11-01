#!/usr/bin/env bash
# Does a release replace an estate WITHOUT a member who is sending seeing a single failure?
#
# WHY THIS EXISTS (2026-10-17). Every production deploy answered `502` for the minute or two it took,
# and a message sent in that window showed "Echec de l'envoi" (backlog, 2026-10-09): the deploy's one
# `docker compose up -d` stopped each old container before its successor had booted.
# `infrastructure/lib/rolling.sh` replaces that, and the only honest proof is the outcome - a client
# sending throughout, and its count of failures. So this runs the REAL library, the REAL
# `replace-modes.py` and the REAL edge configuration against a three-service estate wired as
# production is (fixture in rolling-fixture/), with Docker, and asserts what the client saw:
#
#   1. a release (v1 -> v2) under load: every POST answered 200, and v2 is what is left running;
#   2. a release whose new replica never starts: the deploy FAILS, and still no POST fails - the old
#      replica was never touched;
#   3. THE CONTROL - the same release made the old way, one `up -d`: POSTs DO fail. Without it, a
#      fixture too slow or too gentle to catch an outage would pass the first two for nothing.
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

# Docker on Windows needs a Windows path for the bind mount; `pwd -W` gives one under Git Bash.
host_path() { (cd "$1" && { pwd -W 2>/dev/null || pwd; }); }
export EDGE_DIR
EDGE_DIR="$(host_path "$REPO/infrastructure/edge")"
export ROLLTEST_PORT="${ROLLTEST_PORT:-18481}"
URL="http://127.0.0.1:${ROLLTEST_PORT}/api/send"

COMPOSE="${ROLLTEST_COMPOSE:-docker compose}"
# What rolling.sh asks of its caller.
DOCKER_CLI="docker"
PROJECT="canari-rolltest"
FIX_HOST="$(host_path "$FIX")"
dc() {
  # shellcheck disable=SC2086 # COMPOSE may be two words
  $COMPOSE -f "$FIX_HOST/compose.yml" "$@"
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

TMP="$(mktemp -d)"
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f rolltest/api:v1 rolltest/api:v2 rolltest/api:broken rolltest/api:v3 \
    rolltest/frontend:v1 rolltest/frontend:v2 rolltest/frontend:broken rolltest/frontend:v3 >/dev/null 2>&1 || true
  rm -f "$ROTATION_DIR"/*.conf
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup
TMP="$(mktemp -d)"

build() {
  docker build -q -t "rolltest/api:$1" --build-arg "VERSION=$1" -f "$FIX/api.Dockerfile" "$FIX" >/dev/null &&
    docker build -q -t "rolltest/frontend:$1" --build-arg "VERSION=$1" -f "$FIX/frontend.Dockerfile" "$FIX" >/dev/null
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
plan() {
  # `tr`: a Windows Python ends its lines with CR, which would end up inside a replica list.
  dc config --format json | "$PYTHON" "$REPO/infrastructure/lib/replace-modes.py" rolltest/ | tr -d '\r'
}
running_versions() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=api" \
    --format '{{.Image}}' | sort | tr '\n' ' '
}

printf 'deploy-rolling: v1 up\n'
build v1 || {
  fail "the fixture images build"
  exit 1
}
export TAG=v1
# Through the library too, which is the estate's first deploy: every service has no replica yet. Not
# `dc up`: compose 2.26 (the host's) hashes a service that has `depends_on` differently with and
# without `--no-deps`, so an estate brought up WITH dependencies would see its edge recreated by the
# first deploy - a real, one-time cost of the transition, and not what case 1 is measuring.
replace_services <<<"$(plan)" >"$TMP/v1.log" 2>&1 || {
  fail "the v1 estate comes up"
  cat "$TMP/v1.log" >&2
  exit 1
}
# ONE POST, NO RETRY: replace_services returned only once every service, the edge included, was
# HEALTHY - and the edge's healthcheck is its listener. A reset here is the deploy believing an edge
# that was not yet listening (3 runs in 62, 2026-10-18, before the edge had a healthcheck), so the
# edge's own log is printed: it separates "never listened" from "listened and could not reach frontend".
if curl -fsS -X POST "$URL" >/dev/null; then
  ok "v1 answers through the edge"
else
  fail "v1 answers through the edge"
  edge_cid="$(containers_of edge)"
  $DOCKER_CLI inspect -f 'edge state: {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$edge_cid" >&2 || true
  $DOCKER_CLI logs --tail 20 "$edge_cid" >&2 2>&1 || true
fi
edge_before="$(containers_of edge)"

# ── 1. A release under load ──────────────────────────────────────────────────
printf '\ndeploy-rolling: v1 -> v2, replaced by rolling.sh under load\n'
build v2
export TAG=v2
# A connection held open across the release, as a WebSocket is: the nginx worker proxying it keeps
# the OLD replica list after the reload, for as long as the connection lives. The release must prove
# that worker can no longer choose a replica, not wait for it to exit - which would be never.
curl -sN "http://127.0.0.1:${ROLLTEST_PORT}/api/hold" >/dev/null 2>&1 &
HOLD_PID=$!
start_client release
if replace_services <<<"$(plan)" | tee "$TMP/release.log"; then ok "replace_services succeeded"; else fail "replace_services succeeded"; fi
kill "$HOLD_PID" 2>/dev/null || true
if grep -qE '^  frontend: [0-9a-f]+ reloaded; .*\([1-9][0-9]* old worker\(s\) still finishing' "$TMP/release.log"; then
  ok "a connection an old frontend worker was still proxying did not hold the release back"
else
  fail "no frontend reload was proven with an old worker still proxying - the held connection was not seen, or was waited for"
fi
# MSYS_NO_PATHCONV: Git Bash would rewrite `/etc/nginx/...` into a Windows path before docker.exe
# saw it. No effect off Windows.
if MSYS_NO_PATHCONV=1 dc exec -T edge nginx -s reload -c /etc/nginx/edge/nginx.conf >/dev/null 2>&1; then
  ok "the edge reloads its configuration in place"
else
  fail "the edge reloads its configuration in place"
fi
stop_client release
bad="$(field release "Object.entries(r.statuses).filter(([k]) => k !== '200').map(([k, n]) => k + ' x' + n).join(', ')")"
total="$(field release "Object.values(r.statuses).reduce((a, b) => a + b, 0)")"
if [ -z "$bad" ] && [ "${total:-0}" -gt 20 ]; then
  ok "every one of $total POSTs sent across the release was answered 200"
else
  fail "POSTs sent across the release failed: ${bad:-none} (of $total)"
fi
if [ "$(field release "r.versions.v2 > 0 ? 'yes' : 'no'")" = yes ]; then
  ok "the new release answered during the run"
else
  fail "the new release never answered during the run"
fi
if [ "$(running_versions)" = "rolltest/api:v2 " ]; then
  ok "only v2 is left running"
else
  fail "left running after the release: $(running_versions)"
fi
if [ "$(containers_of edge)" = "$edge_before" ]; then
  ok "the edge is the same container it was before the release"
else
  fail "the release recreated the edge ($edge_before -> $(containers_of edge)) - the one container that must never be replaced"
fi

# ── 2. A new replica that never becomes healthy ──────────────────────────────
printf '\ndeploy-rolling: v2 -> broken, whose new replica never starts\n'
build broken
export TAG=broken
start_client broken
if replace_services <<<"$(plan)" >"$TMP/broken.log" 2>&1; then
  fail "a release whose replica never starts makes replace_services fail"
else
  ok "a release whose replica never starts makes replace_services fail"
fi
stop_client broken
bad="$(field broken "Object.entries(r.statuses).filter(([k]) => k !== '200').map(([k, n]) => k + ' x' + n).join(', ')")"
if [ -z "$bad" ]; then
  ok "and not one POST failed meanwhile"
else
  fail "POSTs failed while the broken release was refused: $bad"
fi
if [ "$(running_versions)" = "rolltest/api:v2 " ]; then
  ok "the old replica (v2) is still the one serving"
else
  fail "serving after the refused release: $(running_versions)"
fi

# ── 3. THE CONTROL: the same release, the old way ────────────────────────────
printf '\ndeploy-rolling: v2 -> v3 the OLD way (one "up -d"), which must be seen to fail\n'
build v3
export TAG=v3
start_client control
dc up -d >/dev/null 2>&1
stop_client control
bad="$(field control "Object.entries(r.statuses).filter(([k]) => k !== '200').map(([k, n]) => k + ' x' + n).join(', ')")"
if [ -n "$bad" ]; then
  ok "the control sees the outage the old deploy caused ($bad) - this fixture can fail"
else
  fail "the control saw NO failure under a plain 'up -d' - the fixture cannot detect an outage, so cases 1 and 2 prove nothing"
fi

printf '\ndeploy-rolling: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
