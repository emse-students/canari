#!/usr/bin/env bash
# Can every service of both deployed estates be replaced the way it declares, and do the numbers the
# replacement depends on agree everywhere they are written?
#
# The OUTCOME (no failed request across a release) is deploy-rolling.test.sh, against a fixture.
# This is the other half: the real compose files, read the way the deploy reads them, and the
# agreements the fixture cannot see - that the production nginx carries the directives the fixture
# copied, and that the resolver lifetime the deploy waits out is the one both nginx configurations
# use. docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
MODES="$REPO/infrastructure/lib/replace-modes.py"
DEPLOY="$REPO/infrastructure/deploy/deploy-environment.sh"
FRONTEND_NGINX="$REPO/infrastructure/local/Dockerfile.frontend"
EDGE_NGINX="$REPO/infrastructure/edge/nginx.conf"
FIXTURE_DIR="$REPO/.github/scripts/tests/rolling-fixture"
FIXTURE_NGINX="$FIXTURE_DIR/frontend.conf"
ROLLING="$REPO/infrastructure/lib/rolling.sh"
# The prefix exactly as the compose files spell it: read with --no-interpolate, nothing expands it.
# shellcheck disable=SC2016
OWN='${REGISTRY:-ghcr.io}/${IMAGE_PREFIX:-emse-students/canari}/'
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

# Asked to run, not found on PATH: on a workstation `python3` can be a stub that prints and fails.
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

# edge_healthcheck - reads a `compose config` JSON on stdin, prints its edge's healthcheck test.
edge_healthcheck() {
  "$PYTHON" -c 'import json, sys; print(json.dumps((json.load(sys.stdin)["services"]["edge"].get("healthcheck") or {}).get("test") or ""))' |
    grep -v '^""$'
}
# The fixture's variables are GIVEN, not left uninterpolated: on the runners, compose printed NOTHING for
# this file under `--no-interpolate` (its `${X:?}`s, 2026-10-18), and its stderr is left visible.
fixture_config="$(TAG=v0 EDGE_DIR=/edge FIX_DIR=/fixture ROLLTEST_PORT=1 docker compose \
  -f "$REPO/.github/scripts/tests/rolling-fixture/compose.yml" config --format json)"
fixture_edge_health="$(printf '%s' "$fixture_config" | edge_healthcheck)"

# ── 1. Both deployed estates declare a mode the deploy can honour ─────────────
PROD_PLAN=""
for file in docker-compose.prod.yml docker-compose.dev.yml; do
  config="$(docker compose -f "$REPO/infrastructure/$file" config --no-interpolate --format json 2>/dev/null)"
  [ -n "$config" ] || {
    fail "$file: docker compose could not read it"
    continue
  }
  if ! plan="$(printf '%s' "$config" | "$PYTHON" "$MODES" "$OWN" 2>&1)"; then
    fail "$file: replace-modes.py refuses it: $plan"
    continue
  fi
  plan="$(printf '%s\n' "$plan" | tr -d '\r')" # a Windows Python ends its lines with CR
  [ "$file" = docker-compose.prod.yml ] && PROD_PLAN="$plan"
  declared="$(printf '%s' "$config" | "$PYTHON" -c 'import json,sys; print(len(json.load(sys.stdin)["services"]))')"
  planned="$(printf '%s\n' "$plan" | grep -c .)"
  if [ "$declared" = "$planned" ]; then
    ok "$file: all $declared services have a replacement mode"
  else
    fail "$file: $declared services declared, $planned planned"
  fi

  # The edge is the ONLY service holding the estate's host port, and it is pinned.
  holders="$(printf '%s' "$config" | "$PYTHON" -c '
import json, sys
for name, s in json.load(sys.stdin)["services"].items():
    for p in s.get("ports") or []:
        if "FRONTEND_HOST_PORT" in json.dumps(p):
            print(name)')"
  if [ "$holders" = edge ]; then
    ok "$file: the edge alone publishes FRONTEND_HOST_PORT"
  else
    fail "$file: FRONTEND_HOST_PORT is published by: ${holders:-nobody}"
  fi
  if printf '%s\n' "$plan" | grep -qx 'edge pinned yes -'; then
    ok "$file: the edge is pinned"
  else
    fail "$file: the edge is not 'pinned yes -'"
  fi
  if printf '%s\n' "$plan" | grep -qx 'frontend overlap no edge:80'; then
    ok "$file: the frontend is replaced with overlap, and taken out of rotation at the edge"
  else
    fail "$file: the frontend is not 'overlap no edge:80'"
  fi

  # Order: the frontend is replaced before the edge, so on the deploy that introduces the edge the
  # old frontend has released the port before the edge asks for it.
  f="$(printf '%s\n' "$plan" | grep -n '^frontend ' | cut -d: -f1)"
  e="$(printf '%s\n' "$plan" | grep -n '^edge ' | cut -d: -f1)"
  if [ -n "$f" ] && [ -n "$e" ] && [ "$f" -lt "$e" ]; then
    ok "$file: the frontend is replaced before the edge"
  else
    fail "$file: the frontend (line ${f:-?}) is not replaced before the edge (line ${e:-?})"
  fi

  # The edge's configuration is mounted as a DIRECTORY: a single-file bind mount keeps the inode
  # `git reset --hard` replaced, and the reload would read yesterday's file.
  edge_mount="$(printf '%s' "$config" | "$PYTHON" -c '
import json, sys
for v in json.load(sys.stdin)["services"]["edge"].get("volumes") or []:
    print(v.get("source", "").replace("\\", "/"), v.get("target", ""))')"
  case "$edge_mount" in
  */edge' /etc/nginx/edge') ok "$file: the edge mounts the edge/ directory" ;;
  *) fail "$file: the edge mounts '$edge_mount', not the edge/ directory" ;;
  esac

  # The frontend reads the replica lists from the directory the deploy writes them into, read-only:
  # a list written where nginx does not look would leave every retiring replica in rotation.
  frontend_mount="$(printf '%s' "$config" | "$PYTHON" -c '
import json, sys
for v in json.load(sys.stdin)["services"]["frontend"].get("volumes") or []:
    print(v.get("type"), v.get("source", "").replace("\\", "/"), v.get("target", ""), v.get("read_only", False))')"
  case "$frontend_mount" in
  'bind '*'/edge/rotation /etc/nginx/rotation True') ok "$file: the frontend mounts edge/rotation read-only as /etc/nginx/rotation" ;;
  *) fail "$file: the frontend mounts '$frontend_mount', not edge/rotation read-only at /etc/nginx/rotation" ;;
  esac

  # Every service the frontend nginx routes to by a list has, in the image, the list a workstation
  # reads - by the same name and on the port its label declares.
  while read -r svc _ _ rot; do
    rot="${rot%$'\r'}" # a Windows Python ends its lines with CR
    [ "${rot%%:*}" = frontend ] || continue
    if grep -qF "upstream $svc {" "$FRONTEND_NGINX" && grep -qF "server $svc:${rot#*:} resolve;" "$FRONTEND_NGINX"; then
      ok "$file: $svc is an upstream of the frontend nginx on port ${rot#*:}"
    else
      fail "$file: $svc is routed through the frontend on port ${rot#*:}, but the frontend image declares no such upstream"
    fi
    if grep -qE "set \\\$upstream_[a-z_]+ $svc:[0-9]+;" "$FRONTEND_NGINX"; then
      fail "$file: the frontend nginx still names $svc with a port - DNS, not its replica list"
    fi
  done <<<"$plan"

  # The edge is HEALTHY only once it LISTENS, and by the same test the rolling fixture proves: a
  # pinned service with no healthcheck is believed at `running`, before nginx has opened its port
  # (cicd.md#the-edge-is-ready-when-it-listens-not-when-it-runs).
  edge_health="$(printf '%s' "$config" | edge_healthcheck)"
  if [ -n "$edge_health" ] && [ "$edge_health" = "$fixture_edge_health" ]; then
    ok "$file: the edge's healthcheck is the rolling fixture's (it waits for the listener)"
  else
    fail "$file: the edge's healthcheck '${edge_health:-none}' is not the fixture's '${fixture_edge_health:-none}'"
  fi

  # The fixture proves the lists on the nginx this estate's edge RUNS, digest included: a list a newer
  # nginx parses differently is a list the fixture never tested (2026-11-01 review: 1.30.6 vs 1.31.8).
  edge_image() { "$PYTHON" -c 'import json, sys; print(json.load(sys.stdin)["services"]["edge"]["image"])'; }
  estate_edge="$(printf '%s' "$config" | edge_image)"
  fixture_edge="$(printf '%s' "$fixture_config" | edge_image)"
  if [ -n "$estate_edge" ] && [ "$estate_edge" = "$fixture_edge" ]; then
    ok "$file: the rolling fixture's edge runs this estate's edge image ($estate_edge)"
  else
    fail "$file: the edge runs '$estate_edge', the rolling fixture's '$fixture_edge'"
  fi
done

# ── 2. The validator refuses what two replicas cannot honour ──────────────────
refuses() {
  local label="$1" json="$2" expect="$3" out
  if out="$(printf '%s' "$json" | "$PYTHON" "$MODES" "own/" 2>&1)"; then
    fail "refuses $label (it accepted: $out)"
  elif printf '%s' "$out" | grep -q "$expect"; then
    ok "refuses $label"
  else
    fail "refuses $label, but says: $out"
  fi
}
HC='"healthcheck":{"test":["CMD","true"],"start_interval":"2s"}'
L='"labels":{"canari.deploy.replace"'
refuses "a service with no mode" '{"services":{"a":{"image":"own/a:1"}}}' 'no canari.deploy.replace label'
refuses "an unknown mode" '{"services":{"a":{'"$L"':"rolling"},"image":"own/a:1"}}}' 'is not one of'
refuses "overlap on a host port" '{"services":{"a":{'"$L"':"overlap"},"image":"own/a:1",'"$HC"',"ports":[{"target":80,"published":"8081"}]}}}' 'host port'
refuses "overlap on a volume" '{"services":{"a":{'"$L"':"overlap"},"image":"own/a:1",'"$HC"',"volumes":[{"type":"volume","source":"d","target":"/d"}]}}}' 'mounts a volume'
R='"canari.deploy.rotation":"p:80"'
P='"p":{'"$L"':"pinned"},"image":"x"}'
refuses "overlap with no rotation" '{"services":{"a":{'"$L"':"overlap"},"image":"own/a:1",'"$HC"'}}}' 'no canari.deploy.rotation'
refuses "a rotation through no service" '{"services":{"a":{'"$L"':"overlap",'"$R"'},"image":"own/a:1",'"$HC"'}}}' 'names no other service'
refuses "a rotation on an exclusive service" '{"services":{"a":{'"$L"':"exclusive",'"$R"'},"image":"own/a:1"},'"$P"'}}' 'never taken out of rotation'
refuses "overlap on a writable bind mount" '{"services":{"a":{'"$L"':"overlap",'"$R"'},"image":"own/a:1",'"$HC"',"volumes":[{"type":"bind","source":"/d","target":"/d"}]},'"$P"'}}' 'mounts a volume'
if printf '%s' '{"services":{"a":{'"$L"':"overlap",'"$R"'},"image":"own/a:1",'"$HC"',"volumes":[{"type":"bind","source":"/d","target":"/d","read_only":true}]},'"$P"'}}' |
  "$PYTHON" "$MODES" own/ | grep -qx 'a overlap no p:80'; then
  ok "accepts overlap on a read-only bind mount, and prints its rotation"
else
  fail "refuses overlap on a read-only bind mount, or prints no rotation"
fi
refuses "overlap with no healthcheck" '{"services":{"a":{'"$L"':"overlap"},"image":"own/a:1"}}}' 'no healthcheck'
refuses "overlap with no start_interval" '{"services":{"a":{'"$L"':"overlap"},"image":"own/a:1","healthcheck":{"test":["CMD","true"]}}}}' 'start_interval'
refuses "pinned on an image this repository builds" '{"services":{"a":{'"$L"':"pinned"},"image":"own/a:1"}}}' 'built by this repository'
refuses "a depends_on cycle" '{"services":{"a":{'"$L"':"exclusive"},"image":"x","depends_on":{"b":{}}},"b":{'"$L"':"exclusive"},"image":"y","depends_on":{"a":{}}}}}' 'cycle'

order="$(printf '%s' '{"services":{"z":{'"$L"':"pinned"},"image":"x"},"a":{'"$L"':"exclusive"},"image":"y","depends_on":{"z":{}}}}}' |
  "$PYTHON" "$MODES" own/ | cut -d' ' -f1 | tr '\n' ' ')"
if [ "$order" = "z a " ]; then
  ok "a service comes after what it depends on, whatever the names"
else
  fail "dependency order is '$order', expected 'z a '"
fi

# ── 3. The replica lists are written where the proxies read them ──────────────
# shellcheck disable=SC2016 # the literal line of deploy-environment.sh, unexpanded on purpose
if grep -qF 'ROTATION_DIR="$DEPLOY_PATH/infrastructure/edge/rotation"' "$DEPLOY"; then
  ok "deploy-environment.sh writes the replica lists into infrastructure/edge/rotation"
else
  fail "deploy-environment.sh writes the replica lists somewhere neither proxy mounts"
fi
if grep -qF 'include /etc/nginx/edge/rotation/edge.conf;' "$EDGE_NGINX" && grep -qF 'proxy_pass frontend;' "$EDGE_NGINX"; then
  ok "the edge chooses a frontend replica from its list"
else
  fail "the edge does not read edge/rotation/edge.conf, or does not proxy to it"
fi
if grep -qF 'include /etc/nginx/rotation/frontend.conf;' "$FRONTEND_NGINX" && grep -qF 'include /etc/nginx/rotation/frontend.conf;' "$FIXTURE_NGINX"; then
  ok "the frontend nginx and the fixture both read /etc/nginx/rotation/frontend.conf"
else
  fail "the frontend nginx or the fixture does not include /etc/nginx/rotation/frontend.conf"
fi
if git -C "$REPO" check-ignore -q infrastructure/edge/rotation/frontend.conf && [ -f "$REPO/infrastructure/edge/rotation/.gitignore" ]; then
  ok "the lists' directory exists in every checkout and the lists are never tracked"
else
  fail "infrastructure/edge/rotation is missing, or a written list would be tracked"
fi

# THE RESTING FORM IS THE LIST THE FRONTEND IMAGE BAKES: between deploys a list names each service by
# its DNS name, exactly as an estate with no such deploy reads it, so the seed and the image can never
# disagree about what "no replacement in progress" looks like.
baked="$(sed -n "s|^RUN mkdir -p /etc/nginx/rotation && printf '\\(.*\\)' > /etc/nginx/rotation/frontend.conf\$|\\1|p" "$FRONTEND_NGINX")"
baked="$(printf '%b' "$baked")"
resting="$(
  # shellcheck source=../../../infrastructure/lib/rolling.sh
  . "$ROLLING"
  rotation_routes_set <<<"$PROD_PLAN"
  printf '%s\n' "$ROTATION_ROUTES" | while read -r svc via port; do
    [ "$via" = frontend ] && rotation_block "$svc" "$port"
  done
)"
missing=""
for svc in $(printf '%s\n' "$resting" | sed -n 's/^upstream \([^ ]*\) {$/\1/p'); do
  block="$(printf '%s\n' "$resting" | awk -v s="upstream $svc {" '$0 == s { on = 1 } on { print } on && $0 == "}" { exit }')"
  case "$baked" in *"$block"*) ;; *) missing="$missing $svc" ;; esac
done
if [ -n "$resting" ] && [ -z "$missing" ] &&
  [ "$(printf '%s\n' "$baked" | grep -c '^upstream ')" = "$(printf '%s\n' "$resting" | grep -c '^upstream ')" ]; then
  ok "the frontend image bakes, block for block, the resting list rolling.sh writes"
else
  fail "the frontend image's baked list differs from the resting list rolling.sh writes (differs for:${missing:- the count of blocks})"
fi

# THE RESOLVER LIFETIME, ONE NUMBER: the lists' `valid=`, the frontend's own, the fixtures', and the
# wait of the library an older release ships - a rollback runs that library against these lists.
ttl="$(sed -n 's/^ROLLING_RESOLVER_TTL_SECONDS=\([0-9]*\)$/\1/p' "$ROLLING")"
frozen_ttl="$(sed -n 's/^ROLLING_RESOLVER_TTL_SECONDS=\([0-9]*\)$/\1/p' "$FIXTURE_DIR/rolling-pre-rotation.sh")"
others="$(grep -ho 'resolver 127.0.0.11 valid=[0-9]*s' "$FRONTEND_NGINX" "$FIXTURE_NGINX" "$FIXTURE_DIR/frontend-pre-rotation.conf" |
  sed 's/.*valid=\([0-9]*\)s/\1/' | sort -u | tr '\n' ' ')"
if [ -n "$ttl" ] && [ "$ttl" = "$frozen_ttl" ] && [ "$others" = "$ttl " ]; then
  ok "one resolver lifetime (${ttl}s) in rolling.sh, the frozen older library, the frontend image and both fixture configurations"
else
  fail "the resolver lifetimes disagree: rolling.sh '$ttl', the older library '$frozen_ttl', the configurations '$others'"
fi

for directive in 'proxy_connect_timeout 2s;' 'proxy_next_upstream error timeout;'; do
  if grep -qF "    $directive" "$FRONTEND_NGINX" && grep -qF "    $directive" "$FIXTURE_NGINX"; then
    ok "the frontend nginx and the fixture both carry '$directive'"
  else
    fail "'$directive' is not in both the frontend nginx and the fixture - the fixture would prove a configuration production does not run"
  fi
done
if grep -q 'proxy_next_upstream on;' "$EDGE_NGINX" && grep -q 'proxy_connect_timeout 2s;' "$EDGE_NGINX"; then
  ok "the edge fails a refused connect over to the next replica"
else
  fail "the edge has no connect failover"
fi

base_of() { grep -m1 -E '^FROM ' "$1" | awk '{ print $2 }'; }
if [ "$(base_of "$FRONTEND_NGINX")" = "$(base_of "$FIXTURE_DIR/frontend.Dockerfile")" ]; then
  ok "the rolling fixture's frontend is built on the frontend image's base ($(base_of "$FRONTEND_NGINX"))"
else
  fail "the frontend image is built on '$(base_of "$FRONTEND_NGINX")', the fixture's on '$(base_of "$FIXTURE_DIR/frontend.Dockerfile")'"
fi

# ── 4. The deploy replaces nothing the old way ────────────────────────────────
# shellcheck disable=SC2016 # the literal line of deploy-environment.sh, unexpanded on purpose
if grep -qF 'if ! replace_services <<<"$REPLACE_PLAN"; then' "$DEPLOY"; then
  ok "deploy-environment.sh replaces the estate through rolling.sh"
else
  fail "deploy-environment.sh does not call replace_services"
fi
# Every `dc up` after the database's must be unable to recreate a service: either `--no-recreate`, or
# rolling.sh's own. A plain `dc up -d` here would put the outage back.
stray="$(grep -n '^dc up ' "$DEPLOY" | grep -v '^[0-9]*:dc up -d postgres$' | grep -v -- '--no-recreate' || true)"
if [ -z "$stray" ]; then
  ok "no other 'dc up' in deploy-environment.sh can recreate a service"
else
  fail "deploy-environment.sh recreates services outside rolling.sh: $stray"
fi

# The lists exist before anything that includes them starts: a fresh host, or a lost directory, would
# otherwise leave the frontend and the edge unable to start (2026-11-01 review).
# shellcheck disable=SC2016 # the literal line of deploy-environment.sh, unexpanded on purpose
seed_line="$(grep -n '^rotation_seed <<<"\$REPLACE_PLAN"' "$DEPLOY" | head -1 | cut -d: -f1)"
first_up="$(grep -n '^dc up ' "$DEPLOY" | head -1 | cut -d: -f1)"
if [ -n "$seed_line" ] && [ -n "$first_up" ] && [ "$seed_line" -lt "$first_up" ]; then
  ok "deploy-environment.sh seeds the replica lists (line $seed_line) before its first 'dc up' (line $first_up)"
else
  fail "deploy-environment.sh does not seed the replica lists before its first 'dc up' (seed ${seed_line:-absent}, up ${first_up:-absent})"
fi

# ── 5. The rotation library, against a Docker it can only ask ─────────────────
# Every function below reads Docker through DOCKER_CLI; here that is a stub describing an estate, so
# each rule is asserted on the input that breaks it, with no daemon. The OUTCOME of the same code on
# a real estate is deploy-rolling.test.sh. A subshell, counted here through "ok|fail <message>".
ended=no
# Each assertion is a string `verdict` evals, so its `$` are expanded there, not here (SC2016); the
# stub and the variables it reads are used through rolling.sh, which shellcheck cannot see doing so
# (SC2034, SC2329).
# shellcheck disable=SC2016,SC2034,SC2329
while read -r verdict message; do
  if [ "$verdict" = ok ]; then ok "$message"; else fail "$message"; fi
  [ "$message" = "the rotation library's checks ran to their end" ] && ended=yes
done < <(
  ROT="$(mktemp -d)"
  trap 'rm -rf "$ROT"' EXIT
  # The estate the stub describes: api has an old and a new replica, both healthy; its sibling `sib`
  # has one replica that is UNHEALTHY; no proxy container runs, so nothing is reloaded.
  fake_docker() {
    case "$1" in
    inspect)
      case "${*: -1}" in
      api-old) echo 'running healthy /p-api-1' ;;
      api-new) echo 'running healthy /p-api-2' ;;
      api-sick) echo 'running unhealthy /p-api-3' ;;
      sib-1) echo 'running unhealthy /p-sib-1' ;;
      *) return 1 ;;
      esac
      ;;
    ps) ;;
    *) return 1 ;;
    esac
  }
  DOCKER_CLI=fake_docker
  PROJECT=p
  ROTATION_DIR="$ROT"
  # shellcheck source=../../../infrastructure/lib/rolling.sh
  . "$ROLLING"
  verdict() { if eval "$2"; then echo "ok $1"; else echo "fail $1"; fi; }
  block_of() { rotation_existing_block "$ROT/front.conf" "$1" | grep '^    server ' | tr -s ' ' | tr '\n' '|'; }
  PLAN='api overlap no front:3000
sib overlap no front:3001
front overlap no edge:80
edge pinned yes -'

  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed writes every list, each service by its DNS name" \
    '[ "$(block_of api)" = " server api:3000 resolve;|" ] && [ "$(block_of sib)" = " server sib:3001 resolve;|" ] && grep -qx "    server front:80 resolve;" "$ROT/edge.conf"'

  # The sibling as a deploy killed mid-replacement leaves it: named by a container.
  rotation_write front sib "$(rotation_block sib 3001 p-sib-1)"
  rotation_take_out api api-new >/dev/null
  verdict "taking a replica out names the new one alone" '[ "$(block_of api)" = " server p-api-2:3000 resolve;|" ]'
  verdict "a sibling that is unhealthy is carried over as it was, never re-read and dropped" \
    '[ "$(block_of sib)" = " server p-sib-1:3001 resolve;|" ]'
  verdict "the service being replaced is refused when none of the replicas meant to stay is healthy" \
    '! rotation_take_out api api-sick 2>/dev/null'
  rotation_restore api >/dev/null
  verdict "rotation_restore puts the service back on its DNS name, the sibling untouched" \
    '[ "$(block_of api)" = " server api:3000 resolve;|" ] && [ "$(block_of sib)" = " server p-sib-1:3001 resolve;|" ]'
  rotation_restore api >/dev/null
  verdict "a restore that changes nothing reports no change (so nothing is reloaded)" '[ "$ROTATION_CHANGED" = no ]'
  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed puts a list a killed deploy left mid-replacement back at rest" \
    '[ "$(block_of sib)" = " server sib:3001 resolve;|" ]'
  rm -f "$ROT"/*.conf
  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed writes the lists again when the directory lost them" '[ -f "$ROT/front.conf" ] && [ -f "$ROT/edge.conf" ]'

  # auth_request: which upstream connections are subrequests, read from `nginx -T`.
  rotation_routes_set <<<'core-service overlap no frontend:3012
chat-gateway overlap no frontend:3000'
  DUMP='# configuration file /etc/nginx/conf.d/default.conf:
    location = /internal/auth/verify {
    internal;
    set $upstream_auth core-service;
    proxy_pass http://$upstream_auth/api/auth/verify;
    }
    location = /internal/other {
    proxy_pass http://auth:3001/x;
    }
    location /api/ {
    auth_request /internal/auth/verify;
    auth_request /internal/other;
    set $upstream_gateway chat-gateway;
    }'
  verdict "rotation_subrequest_ports reads a bare service name through its route, and a host:port as written" \
    '[ "$(printf "%s\n" "$DUMP" | rotation_subrequest_ports frontend | tr "\n" " ")" = "3001 3012 " ]'
  verdict "rotation_subrequest_ports refuses an auth_request whose target it cannot place" \
    '! printf "    auth_request /nowhere;\n" | rotation_subrequest_ports frontend 2>/dev/null >/dev/null'
  verdict "a proxy naming every routed service by DNS, with no list, is a proxy from before the lists" \
    'printf "set \$a core-service:3012;\nset \$b chat-gateway:3000;\n" | rotation_is_legacy frontend'
  verdict "a proxy that names one routed service by nothing is refused, not taken for one from before the lists" \
    '! printf "set \$a core-service:3012;\n" | rotation_is_legacy frontend'
  verdict "a proxy that includes some rotation file is never taken for one from before the lists" \
    '! printf "# configuration file /x/rotation/other.conf:\nset \$a core-service:3012;\nset \$b chat-gateway:3000;\n" | rotation_is_legacy frontend'

  # The pairing check's join. Worker 10 holds one client connection (local :80, a listened port) and
  # one ESTABLISHED upstream connection to :3012 - the shape of a request still in its auth_request.
  TABLE='S 10 111
S 10 222
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 900 1
   1: 0200A8C0:0050 0300A8C0:D431 01 00000000:00000000 00:00000000 00000000     0        0 111 1
   2: 0200A8C0:A1B2 0400A8C0:0BC4 01 00000000:00000000 00:00000000 00000000     0        0 222 1'
  verdict "an upstream connection to a subrequest port pairs nothing: the request has not chosen yet" \
    '[ "$(printf "%s\n" "$TABLE" | awk -v skip=" 0BC4" "$ROTATION_PAIRS_AWK")" = 1 ]'
  verdict "an upstream connection elsewhere pairs its client: the request has chosen" \
    '[ "$(printf "%s\n" "$TABLE" | awk -v skip="" "$ROTATION_PAIRS_AWK")" = 0 ]'
  verdict "an unreadable TCP table is unknown to the pairing check, never clean" \
    '[ "$(printf "S 10 111\n" | awk -v skip="" "$ROTATION_PAIRS_AWK")" = "?" ]'
  verdict "an unreadable TCP table is unknown to the queue read, never clean" \
    '[ "$(printf "" | awk "$QUEUE_AWK")" = "? ?" ]'
  # wait_unqueued against a replica whose exec fails: unknown at every read, then a failure.
  fake_docker() { return 1; }
  ROLLING_QUIESCE_READS=3
  verdict "a replica whose sockets cannot be read is never retired as clean" '! wait_unqueued api api-old 2>/dev/null >/dev/null'
  # A check that never printed is a check that never ran: this line is the subshell reaching its end.
  echo "ok the rotation library's checks ran to their end"
)
[ "$ended" = yes ] || fail "the rotation library's checks stopped before their end"

printf '\ndeploy-replace: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
