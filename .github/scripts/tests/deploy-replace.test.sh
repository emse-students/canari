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
MESH_NGINX="$REPO/infrastructure/edge/mesh.conf"
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

# mesh_routes - prints "<port> <target variable>" for every `server` of the mesh: the port it listens on
# and the `$target_<service>` its `proxy_pass` reads, `$` left out.
mesh_routes() {
  # shellcheck disable=SC2016 # an awk program
  awk '$1 == "listen" { p = $2; sub(/;$/, "", p) }
    $1 == "proxy_pass" { t = $2; sub(/;$/, "", t); sub(/^http:\/\/\$/, "", t); print p, t }' "$MESH_NGINX"
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
  if grep -qE '^edge pinned yes - [^ ]+$' <<<"$plan"; then
    ok "$file: the edge is pinned"
  else
    fail "$file: the edge is not 'pinned yes -'"
  fi
  if grep -qE '^frontend overlap no edge:80 [^ ]*/frontend:[^ ]+$' <<<"$plan"; then
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
  'bind '*'/edge/targets /etc/nginx/targets True') ok "$file: the frontend mounts edge/targets read-only as /etc/nginx/targets" ;;
  *) fail "$file: the frontend mounts '$frontend_mount', not edge/targets read-only at /etc/nginx/targets" ;;
  esac

  # Every service the frontend nginx routes to by a list has, in the image, the target a workstation
  # reads - by its variable and on the port its label declares - and is proxied to through it alone.
  # Every service the MESH routes to has its own `server` there, on the port its label declares,
  # proxying to its target; and the mesh proxies to nothing else.
  mesh_want=""
  while read -r svc _ _ rots _; do
    rots="${rots%$'\r'}" # a Windows Python ends its lines with CR
    for rot in ${rots//,/ }; do
      var="target_${svc//-/_}"
      case "${rot%%:*}" in
      frontend)
        if grep -qF "map \"\" \$$var { default $svc:${rot#*:}; }" "$FRONTEND_NGINX" && grep -qF "proxy_pass http://\$$var" "$FRONTEND_NGINX"; then
          ok "$file: $svc is proxied to through \$$var, $svc:${rot#*:} at rest in the frontend image"
        else
          fail "$file: $svc is routed through the frontend on port ${rot#*:}, but the frontend image has no \$$var at rest, or proxies through none"
        fi
        if grep -qE "set \\\$upstream_[a-z_]+ $svc(:[0-9]+)?;" "$FRONTEND_NGINX"; then
          fail "$file: the frontend nginx still names $svc by itself in a set - a request there would never leave by its target"
        fi
        ;;
      mesh) mesh_want="$mesh_want${rot#*:} $var"$'\n' ;;
      esac
    done
  done <<<"$plan"
  mesh_got="$(mesh_routes)"
  if [ -n "$mesh_want" ] && [ "$(printf '%s' "$mesh_want" | sort)" = "$(printf '%s\n' "$mesh_got" | sort)" ]; then
    ok "$file: the mesh has one server per service routed through it, on its label's port, proxying to its target alone ($(printf '%s' "$mesh_want" | tr '\n' ',' | sed 's/,$//'))"
  else
    fail "$file: the mesh's servers ($(printf '%s\n' "$mesh_got" | tr '\n' ',')) are not the routes the labels declare ($(printf '%s' "$mesh_want" | tr '\n' ','))"
  fi

  # THE MESH IS PINNED, ON THE EDGE'S IMAGE AND MOUNT, AND HEALTHY ONLY ONCE IT LISTENS ON EVERY PORT.
  # Pinned is what closes the gap: a mesh a release replaced would be the exposure it removes.
  if grep -qE '^mesh pinned no - [^ ]+$' <<<"$plan"; then
    ok "$file: the mesh is pinned and publishes no host port"
  else
    fail "$file: the mesh is not 'pinned no -'"
  fi
  mesh_facts="$(printf '%s' "$config" | "$PYTHON" -c '
import json, sys
s = json.load(sys.stdin)["services"]
m = s.get("mesh") or {}
print(m.get("image") == s["edge"]["image"])
print(" ".join(v.get("source", "").replace("\\", "/").rsplit("/", 1)[-1] + ">" + v.get("target", "") for v in m.get("volumes") or []))
print(" ".join(m.get("command") or []))
print(" ".join((m.get("healthcheck") or {}).get("test") or []))
print(" ".join(sorted(str(p) for p in m.get("expose") or [])))' | tr -d '\r')"
  {
    read -r same_image
    read -r mesh_mounts
    read -r mesh_command
    read -r mesh_health
    read -r mesh_expose
  } <<<"$mesh_facts"
  if [ "$same_image" = True ] && [ "$mesh_mounts" = "edge>/etc/nginx/edge" ] && [ "$mesh_command" = "nginx -c /etc/nginx/edge/mesh.conf -g daemon off;" ]; then
    ok "$file: the mesh runs the edge's image, mounts the edge/ directory, and loads edge/mesh.conf"
  else
    fail "$file: the mesh runs the edge's image: $same_image; mounts '$mesh_mounts'; runs '$mesh_command'"
  fi
  health_ok=yes
  case "$mesh_health" in "CMD-SHELL test -s /var/run/nginx.pid "*) ;; *) health_ok=no ;; esac
  for port in $(printf '%s' "$mesh_want" | awk '{ print $1 }'); do
    grep -qF "$(printf ' 00000000:%04X 00000000:0000 0A ' "$port")" <<<"$mesh_health" || health_ok=no
  done
  if [ "$health_ok" = yes ] && [ "$mesh_expose" = "$(printf '%s' "$mesh_want" | awk '{ print $1 }' | sort | tr '\n' ' ' | sed 's/ $//')" ]; then
    ok "$file: the mesh exposes every routed port and is healthy only once it listens on each"
  else
    fail "$file: the mesh exposes '$mesh_expose' and its healthcheck '$mesh_health' does not read the LISTEN row of every routed port"
  fi

  # NO SERVICE FALLS BACK, IN ITS OWN CODE, TO A ROTATED PEER BY ITS DNS NAME: every such default in
  # the sources has a variable this estate sets (replace-modes.py holds the value set).
  while read -r verdict message; do
    if [ "$verdict" = ok ]; then ok "$message"; else fail "$message"; fi
  done < <(printf '%s' "$config" | "$PYTHON" "$REPO/.github/scripts/tests/internal-url-defaults.py" "$REPO" "$file" | tr -d '\r')

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
  elif grep -q "$expect" <<<"$out"; then
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
  "$PYTHON" "$MODES" own/ | grep -x 'a overlap no p:80 own/a:1' >/dev/null; then
  ok "accepts overlap on a read-only bind mount, and prints its rotation and its image"
else
  fail "refuses overlap on a read-only bind mount, or prints no rotation or no image"
fi
R2='"canari.deploy.rotation":"p:80,m:80"'
M='"m":{'"$L"':"pinned"},"image":"x"}'
if printf '%s' '{"services":{"a":{'"$L"':"overlap",'"$R2"'},"image":"own/a:1",'"$HC"'},'"$P"','"$M"'}}' |
  "$PYTHON" "$MODES" own/ | grep -x 'a overlap no p:80,m:80 own/a:1' >/dev/null; then
  ok "accepts a rotation through two proxies, and prints both"
else
  fail "refuses a rotation through two proxies, or does not print both"
fi
refuses "a rotation naming one proxy twice" '{"services":{"a":{'"$L"':"overlap","canari.deploy.rotation":"p:80,p:81"},"image":"own/a:1",'"$HC"'},'"$P"'}}' 'names one proxy twice'
refuses "a second route through no service" '{"services":{"a":{'"$L"':"overlap",'"$R2"'},"image":"own/a:1",'"$HC"'},'"$P"'}}' 'names no other service'
# THE CALL AROUND THE ROTATION (2026-11-07): a service whose environment names a rotated service by
# its DNS name reaches the retiring replica until it stops. Refused, whatever the scheme or path; a
# caller naming a proxy of the rotation is accepted.
refuses "a service calling a rotated one by its DNS name" \
  '{"services":{"a":{'"$L"':"overlap",'"$R2"'},"image":"own/a:1",'"$HC"'},'"$P"','"$M"',"c":{'"$L"':"pinned"},"image":"x","environment":{"PEER_URL":"http://a:80/api"}}}}' \
  'PEER_URL=http://a:80/api calls a by Docker'"'"'s DNS, around its rotation'
if printf '%s' '{"services":{"a":{'"$L"':"overlap",'"$R2"'},"image":"own/a:1",'"$HC"'},'"$P"','"$M"',"c":{'"$L"':"pinned"},"image":"x","environment":{"PEER_URL":"http://m:80","DB":"postgres://u:p@db:5432/x"}}}}' |
  "$PYTHON" "$MODES" own/ >/dev/null 2>&1; then
  ok "accepts a service calling a rotated one through its proxy, and an address of a service with no rotation"
else
  fail "refuses a service calling a rotated one through its proxy"
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
if grep -qF 'ROTATION_DIR="$DEPLOY_PATH/infrastructure/edge/targets"' "$DEPLOY"; then
  ok "deploy-environment.sh writes the target lists into infrastructure/edge/targets"
else
  fail "deploy-environment.sh writes the target lists somewhere neither proxy mounts"
fi
# shellcheck disable=SC2016 # nginx text, unexpanded on purpose
if grep -qF 'include /etc/nginx/edge/targets/edge.conf;' "$EDGE_NGINX" && grep -qF 'proxy_pass $target_frontend;' "$EDGE_NGINX"; then
  ok "the edge sends a connection to the frontend target its list sets"
else
  fail "the edge does not read edge/targets/edge.conf, or does not proxy to \$target_frontend"
fi
# shellcheck disable=SC2016 # nginx text, unexpanded on purpose
if grep -qF 'include /etc/nginx/edge/targets/mesh.conf;' "$MESH_NGINX" && [ "$(grep -cE '^ *proxy_pass http://\$target_[a-z_]+;$' "$MESH_NGINX")" = "$(grep -cE '^ *proxy_pass ' "$MESH_NGINX")" ]; then
  ok "the mesh reads edge/targets/mesh.conf and proxies every call to a target its list sets"
else
  fail "the mesh does not read edge/targets/mesh.conf, or proxies somewhere no list sets"
fi
# ONE REQUEST PER CALLER CONNECTION AND NO CACHED UPSTREAM ONE: a reload's old worker closes an idle
# keep-alive connection a caller may be writing into, and a cached upstream one would pass the pairing
# check for a chosen request (edge/mesh.conf says both).
if grep -qE '^    keepalive_timeout 0;$' "$MESH_NGINX" && ! grep -qE '^[[:space:]]*upstream[[:space:]]' "$MESH_NGINX"; then
  ok "the mesh keeps no idle connection to a caller, and declares no upstream block"
else
  fail "the mesh keeps caller connections alive, or declares an upstream block"
fi
# IT DECIDES NOTHING, AN ANSWER'S HEADERS INCLUDED: nginx's 4 KB header buffer would turn a peer's
# larger answer into a 502 the peer never sent - the frontend's @ssr location carries the same lines
# for the same reason.
for directive in 'proxy_buffer_size 32k;' 'proxy_buffers 8 32k;' 'proxy_busy_buffers_size 64k;'; do
  if grep -qxF "    $directive" "$MESH_NGINX" && grep -qF "    $directive" "$FRONTEND_NGINX"; then
    ok "the mesh and the frontend's @ssr location both carry '$directive'"
  else
    fail "'$directive' is not in both the mesh and the frontend nginx - a large answer header would be a 502 the service never sent"
  fi
done
if grep -qF 'include /etc/nginx/targets/frontend.conf;' "$FRONTEND_NGINX" && grep -qF 'include /etc/nginx/targets/frontend.conf;' "$FIXTURE_NGINX"; then
  ok "the frontend nginx and the fixture both read /etc/nginx/targets/frontend.conf"
else
  fail "the frontend nginx or the fixture does not include /etc/nginx/targets/frontend.conf"
fi
# Both directories: targets/ is this library's, rotation/ the `upstream` lists of 1.6.2, which a
# frontend of that release reads on the first deploy carrying the targets and its library rewrites on
# a rollback - a checkout without the directory would leave that frontend's mount empty.
for dir in targets rotation; do
  if git -C "$REPO" check-ignore -q "infrastructure/edge/$dir/frontend.conf" && [ -f "$REPO/infrastructure/edge/$dir/.gitignore" ]; then
    ok "edge/$dir exists in every checkout and its lists are never tracked"
  else
    fail "infrastructure/edge/$dir is missing, or a written list would be tracked"
  fi
done

# ONE LINE PER SERVICE, THE SAME IN BOTH CONTEXTS: `map` exists in `http {}` and `stream {}` with the
# same syntax, and no list declares an `upstream` block - the one construct that caches an idle
# connection (`keepalive`), which the pairing check would count as a chosen request.
line_of() {
  (
    # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/rolling.sh
    . "$ROLLING"
    rotation_block "$@"
  )
}
# shellcheck disable=SC2016 # nginx text, unexpanded on purpose
if [ "$(line_of chat-gateway 3000)" = 'map "" $target_chat_gateway { default chat-gateway:3000; }' ] &&
  [ "$(line_of chat-gateway 3000 canari-chat-gateway-2)" = 'map "" $target_chat_gateway { default canari-chat-gateway-2:3000; }' ]; then
  ok "a target is one map line: the DNS name at rest, the container's name during a take-out"
else
  fail "rotation_block renders '$(line_of chat-gateway 3000)' / '$(line_of chat-gateway 3000 canari-chat-gateway-2)'"
fi

# THE RESTING FORM IS THE LIST THE FRONTEND IMAGE BAKES: between deploys a list names each service by
# its DNS name, exactly as an estate with no such deploy reads it, so the seed and the image can never
# disagree about what "no replacement in progress" looks like.
baked="$(sed -n "s|^RUN mkdir -p /etc/nginx/targets && printf '\\(.*\\)' > /etc/nginx/targets/frontend.conf\$|\\1|p" "$FRONTEND_NGINX")"
baked="$(printf '%b' "$baked" | sort)"
resting="$(
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/rolling.sh
  . "$ROLLING"
  rotation_routes_set <<<"$PROD_PLAN"
  printf '%s\n' "$ROTATION_ROUTES" | while read -r svc via port; do
    [ "$via" = frontend ] && rotation_block "$svc" "$port"
  done | sort
)"
if [ -n "$resting" ] && [ "$baked" = "$resting" ]; then
  ok "the frontend image bakes, line for line, the resting list rolling.sh writes"
else
  fail "the frontend image's baked list differs from the resting list rolling.sh writes: $(diff <(printf '%s\n' "$baked") <(printf '%s\n' "$resting") | grep '^[<>]' | tr '\n' ' ')"
fi

# THE RESOLVER LIFETIME, ONE NUMBER: the resolver both proxies resolve a resting target with, the
# fixtures', and the wait of the libraries older releases ship - a rollback runs one against these lists.
ttl="$(sed -n 's/^ROLLING_RESOLVER_TTL_SECONDS=\([0-9]*\)$/\1/p' "$ROLLING")"
frozen_ttl="$(sed -n 's/^ROLLING_RESOLVER_TTL_SECONDS=\([0-9]*\)$/\1/p' "$FIXTURE_DIR/rolling-pre-rotation.sh" "$FIXTURE_DIR/rolling-upstream-lists.sh" | sort -u | tr '\n' ' ')"
others="$(grep -ho 'resolver 127.0.0.11 valid=[0-9]*s' "$FRONTEND_NGINX" "$EDGE_NGINX" "$MESH_NGINX" "$FIXTURE_NGINX" \
  "$FIXTURE_DIR/frontend-pre-rotation.conf" "$FIXTURE_DIR/frontend-upstream-lists.conf" "$FIXTURE_DIR/edge-upstream-lists.conf" |
  sed 's/.*valid=\([0-9]*\)s/\1/' | sort -u | tr '\n' ' ')"
if [ -n "$ttl" ] && [ "$frozen_ttl" = "$ttl " ] && [ "$others" = "$ttl " ] &&
  [ "$(grep -c 'resolver 127.0.0.11 valid=' "$EDGE_NGINX")" = 1 ]; then
  ok "one resolver lifetime (${ttl}s) in rolling.sh, both frozen older libraries, the frontend image, the edge, the mesh and every fixture configuration"
else
  fail "the resolver lifetimes disagree: rolling.sh '$ttl', the older libraries '$frozen_ttl', the configurations '$others'"
fi

# THE CALLERS' OWN DNS CACHE, THE SAME NUMBER (2026-11-07 review of the mesh). Bun's `fetch` keeps a
# resolved address for 30 s by default, so when the mesh is recreated (an nginx digest bump, shared
# with the edge) every Bun caller kept dialling the removed container's address for up to 30 s:
# measured, failures until t=30 s. Every service that runs on Bun and calls the mesh sets
# BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS to the resolver lifetime, as does the fixture's caller, whose
# case 2d in deploy-rolling.test.sh measures the gap with and without it.
for file in docker-compose.prod.yml docker-compose.dev.yml; do
  while read -r verdict message; do
    if [ "$verdict" = ok ]; then ok "$file: $message"; else fail "$file: $message"; fi
  done < <(docker compose -f "$REPO/infrastructure/$file" config --no-interpolate --format json 2>/dev/null |
    "$PYTHON" -c '
import json, os, sys
ttl = sys.argv[1]
seen = 0
for name, s in sorted(json.load(sys.stdin)["services"].items()):
    env = s.get("environment") or {}
    if not any("://mesh:" in str(v) for v in env.values()):
        continue
    # The image this repository builds for the service: its build section, or (the dev estate pulls
    # the images production built and declares none) the Dockerfile named after it.
    b = s.get("build") or {}
    dockerfile = os.path.join(b.get("context", ""), b.get("dockerfile", "")) if b else os.path.join(sys.argv[2], "infrastructure", "local", "Dockerfile." + name)
    froms = [l.split()[1] for l in open(dockerfile, encoding="utf8") if l.upper().startswith("FROM ")] if dockerfile and os.path.isfile(dockerfile) else []
    if not froms or not froms[-1].startswith("oven/bun"):
        continue
    seen += 1
    got = str(env.get("BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS"))
    if got == ttl:
        print("ok", name, "runs on Bun and calls the mesh, and keeps a resolved address", ttl, "s")
    else:
        print("fail", name, "runs on Bun and calls the mesh, but BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS is", got, "not", ttl, "- a recreated mesh would be dialled at its old address for 30 s")
if seen == 0:
    print("fail no service both runs on Bun and calls the mesh - the check reads nothing")
' "$ttl" "$REPO" | tr -d '\r')
done
fixture_bun_ttl="$(printf '%s' "$fixture_config" | "$PYTHON" -c 'import json, sys; print((json.load(sys.stdin)["services"]["caller"].get("environment") or {}).get("BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS"))' | tr -d '\r')"
if [ "$fixture_bun_ttl" = "$ttl" ]; then
  ok "the fixture's caller keeps a resolved address ${ttl}s, as production's Bun callers do"
else
  fail "the fixture's caller keeps a resolved address '$fixture_bun_ttl' s, not the ${ttl}s production's Bun callers keep"
fi

# THE RESOLVER'S BOUND (2026-11-02 review): every target at rest is looked up for its request, so a
# resolver that does not answer holds that request for `resolver_timeout` - 30 s by default. Each
# configuration that resolves a target must bound it, once per resolver.
for conf in "$FRONTEND_NGINX" "$EDGE_NGINX" "$MESH_NGINX" "$FIXTURE_NGINX"; do
  resolvers="$(grep -c 'resolver 127.0.0.11 valid=' "$conf")"
  bounds="$(grep -cE '^ *resolver_timeout 2s;' "$conf")"
  if [ "$resolvers" -ge 1 ] && [ "$bounds" = "$resolvers" ]; then
    ok "$(basename "$conf"): each of its $resolvers resolver(s) is bounded by 'resolver_timeout 2s'"
  else
    fail "$(basename "$conf"): $resolvers resolver(s) but $bounds 'resolver_timeout 2s' - a silent DNS would hold every request for 30 s"
  fi
done

for directive in 'proxy_connect_timeout 2s;' 'proxy_next_upstream error timeout;'; do
  if grep -qF "    $directive" "$FRONTEND_NGINX" && grep -qF "    $directive" "$FIXTURE_NGINX" && grep -qF "    $directive" "$MESH_NGINX"; then
    ok "the frontend nginx, the fixture and the mesh all carry '$directive'"
  else
    fail "'$directive' is not in the frontend nginx, the fixture and the mesh alike - the fixture would prove a configuration production does not run"
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
# The two pinned proxies read their configuration from the checkout, so the release reloads each after
# replacing the estate - tested first, so a broken file keeps the running one.
replace_line="$(grep -n '^if ! replace_services <<<' "$DEPLOY" | cut -d: -f1)"
reloads=""
for p in "edge nginx.conf" "mesh mesh.conf"; do
  read -r proxy conf <<<"$p"
  t="$(grep -n "^dc exec -T $proxy nginx -t -c /etc/nginx/edge/$conf\$" "$DEPLOY" | cut -d: -f1)"
  r="$(grep -n "^dc exec -T $proxy nginx -s reload -c /etc/nginx/edge/$conf\$" "$DEPLOY" | cut -d: -f1)"
  { [ -n "$t" ] && [ -n "$r" ] && [ -n "$replace_line" ] && [ "$replace_line" -lt "$t" ] && [ "$t" -lt "$r" ]; } || reloads="$reloads $proxy"
done
if [ -z "$reloads" ]; then
  ok "deploy-environment.sh tests then reloads the edge and the mesh after replacing the estate"
else
  fail "deploy-environment.sh does not test-then-reload, after the replacement:$reloads"
fi
# A MESH ROUTING NOWHERE MUST NOT DEPLOY GREEN (2026-11-07 review): every route the plan gives the mesh
# is asked through it after the reload, and a failure fails the deploy like the edge's checks do.
mesh_reload_line="$(grep -n '^dc exec -T mesh nginx -s reload ' "$DEPLOY" | cut -d: -f1)"
# shellcheck disable=SC2016 # deploy-environment.sh text, unexpanded on purpose
mesh_check_line="$(grep -n '^  retry_http "the mesh routes port \$route_port to \$route_service" .*"mesh_route_status \$route_service \$route_port"$' "$DEPLOY" | cut -d: -f1)"
# shellcheck disable=SC2016 # deploy-environment.sh text, unexpanded on purpose
if [ -n "$mesh_reload_line" ] && [ -n "$mesh_check_line" ] && [ "$mesh_reload_line" -lt "$mesh_check_line" ] &&
  grep -qxF 'done <<<"$ROTATION_ROUTES"' "$DEPLOY" && grep -qF "fetch('http://mesh:\$2/api/health')" "$DEPLOY"; then
  ok "deploy-environment.sh asks every mesh route for its service's health, through the mesh, after reloading it"
else
  fail "deploy-environment.sh does not check every mesh route through the mesh after reloading it - a dead mesh would deploy green"
fi

# The lists exist before anything that includes them starts: a fresh host, or a lost directory, would
# otherwise leave the frontend and the edge unable to start (2026-11-01 review).
# shellcheck disable=SC2016 # the literal line of deploy-environment.sh, unexpanded on purpose
seed_line="$(grep -n '^rotation_seed <<<"\$REPLACE_PLAN"' "$DEPLOY" | sed -n 1p | cut -d: -f1)"
first_up="$(grep -n '^dc up ' "$DEPLOY" | sed -n 1p | cut -d: -f1)"
if [ -n "$seed_line" ] && [ -n "$first_up" ] && [ "$seed_line" -lt "$first_up" ]; then
  ok "deploy-environment.sh seeds the replica lists (line $seed_line) before its first 'dc up' (line $first_up)"
else
  fail "deploy-environment.sh does not seed the replica lists before its first 'dc up' (seed ${seed_line:-absent}, up ${first_up:-absent})"
fi
# Whatever ends the deploy puts a list taken out back at rest: an EXIT trap, and every signal a
# cancelled job or a dropped session sends turned into an exit, so that trap runs for it too.
trap_line="$(grep -n "^trap 'rotation_restore_in_flight .*' EXIT\$" "$DEPLOY" | sed -n 1p | cut -d: -f1)"
signals=""
for sig in HUP INT TERM; do grep -qE "^trap 'exit [0-9]+' $sig\$" "$DEPLOY" || signals="$signals $sig"; done
if [ -n "$trap_line" ] && [ -n "$seed_line" ] && [ "$trap_line" -lt "$seed_line" ] && [ -z "$signals" ]; then
  ok "deploy-environment.sh restores the service in flight on exit, a HUP, an INT or a TERM included"
else
  fail "deploy-environment.sh lacks the exit trap before the seed, or a signal turned into an exit:${signals:- none missing}"
fi
# Those traps fire only if the signal reaches the script: the job's shell must BE the deploy (exec),
# not its parent, which a cancelled job signals before killing the tree.
unexeced=""
for wf in serve-prod serve-dev; do
  grep -qE '^ +exec bash infrastructure/deploy/deploy-environment\.sh ' "$REPO/.github/workflows/$wf.yml" || unexeced="$unexeced $wf"
done
if [ -z "$unexeced" ]; then
  ok "both serve workflows exec the deploy, so a cancelled job's signal reaches its traps"
else
  fail "a serve workflow runs the deploy as a child, so a cancelled job's signal never reaches its traps:$unexeced"
fi

# ── 5. The rotation library, against a Docker it can only ask ─────────────────
# Every function below reads Docker through DOCKER_CLI; here that is a stub describing an estate, so
# each rule is asserted on the input that breaks it, with no daemon. The OUTCOME of the same code on
# a real estate is deploy-rolling.test.sh. A subshell, counted here through "ok|fail <message>".
ended=no
# Each assertion is a string `verdict` evals, so its `$` are expanded there, not here (SC2016); the
# stub and the variables it reads are used through rolling.sh, which shellcheck cannot see doing so
# (SC2034, SC2329).
# shellcheck disable=SC2016,SC2034,SC2317,SC2329
while read -r verdict message; do
  if [ "$verdict" = ok ]; then ok "$message"; else fail "$message"; fi
  [ "$message" = "the rotation library's checks ran to their end" ] && ended=yes
done < <(
  ROT="$(mktemp -d)"
  trap 'rm -rf "$ROT"' EXIT
  # The estate the stub describes: api has an old and a new replica, both healthy, and one that has
  # exited; its sibling `sib` has one replica that is UNHEALTHY. `inspect` answers status, health and
  # container name, as rotation_take_out asks. The proxy `front` runs no container, so nothing is
  # reloaded.
  fake_docker() {
    case "$1" in
    inspect)
      case "${*: -1}" in
      api-old) echo 'running healthy /p-api-1' ;;
      api-new) echo 'running healthy /p-api-2' ;;
      api-sick) echo 'running unhealthy /p-api-3' ;;
      api-exited) echo 'exited none /p-api-4' ;;
      sib-1) echo 'running unhealthy /p-sib-1' ;;
      call-new) echo 'running healthy /p-call-2' ;;
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
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/rolling.sh
  . "$ROLLING"
  verdict() { if eval "$2"; then echo "ok $1"; else echo "fail $1"; fi; }
  # The target a list sets for a service: `api:3000`, or a replica's `p-api-2:3000`.
  block_of() { rotation_existing_block "$ROT/front.conf" "$1" | sed -n 's/^map "" \$[a-z_]* { default \(.*\); }$/\1/p'; }
  PLAN='api overlap no front:3000
sib overlap no front:3001
front overlap no edge:80
edge pinned yes -'

  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed writes every list, each service by its DNS name" \
    '[ "$(block_of api)" = api:3000 ] && [ "$(block_of sib)" = sib:3001 ] && grep -qxF "map \"\" \$target_front { default front:80; }" "$ROT/edge.conf"'

  # The sibling as a deploy killed mid-replacement leaves it: set to one replica's name.
  rotation_write front sib "$(rotation_block sib 3001 p-sib-1)"
  rotation_take_out api api-new >/dev/null
  verdict "taking a replica out sets its service to the new one's CONTAINER NAME, never an address" \
    '[ "$(block_of api)" = p-api-2:3000 ]'
  verdict "a sibling that is unhealthy is carried over as it was, never re-read and dropped" \
    '[ "$(block_of sib)" = p-sib-1:3001 ]'
  verdict "the service being replaced is refused when the replica meant to stay is not healthy" \
    '! rotation_take_out api api-sick 2>/dev/null'
  verdict "a replica that has exited, or is gone, is refused, the list untouched" \
    '! rotation_take_out api api-exited 2>/dev/null && ! rotation_take_out api api-gone 2>/dev/null && [ "$(block_of api)" = p-api-2:3000 ]'
  rotation_restore api >/dev/null
  verdict "rotation_restore puts the service back on its DNS name, the sibling untouched" \
    '[ "$(block_of api)" = api:3000 ] && [ "$(block_of sib)" = p-sib-1:3001 ]'
  rotation_restore api >/dev/null
  verdict "a restore that changes nothing reports no change (so nothing is reloaded)" '[ "$ROTATION_CHANGED" = no ]'
  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed puts a list a killed deploy left mid-replacement back at rest" \
    '[ "$(block_of sib)" = sib:3001 ]'
  rm -f "$ROT"/*.conf
  rotation_seed <<<"$PLAN" >/dev/null
  verdict "rotation_seed writes the lists again when the directory lost them" '[ -f "$ROT/front.conf" ] && [ -f "$ROT/edge.conf" ]'
  # A list at rest ON DISK says nothing of what nginx runs (a restore whose reload failed): the seed
  # reloads every proxy, its list changed or not.
  applied="$(
    rotation_apply() { echo "$1:$2"; }
    rotation_seed <<<"$PLAN" | grep -v '^rotation: '
  )"
  verdict "rotation_seed reloads every proxy even when its list on disk is already at rest" \
    '[ "$(printf "%s\n" "$applied" | sort | tr "\n" " ")" = "edge:plain front:plain " ]'
  # A deploy that ends between a take-out and its restore: the exit trap puts the list back.
  rotation_take_out api api-new >/dev/null
  ROTATION_IN_FLIGHT=api
  rotation_restore_in_flight "a test" 2>/dev/null
  verdict "a service still in flight when the deploy ends is put back at rest, and is no longer in flight" \
    '[ "$(block_of api)" = api:3000 ] && [ -z "$ROTATION_IN_FLIGHT" ]'
  verdict "with nothing in flight, the exit trap does nothing" '[ -z "$(rotation_restore_in_flight "a test" 2>&1)" ]'
  # The restore at the end of a replacement writes the file at rest, then its reload fails: the exit
  # trap finds the file unchanged and must STILL reload, or nginx keeps naming the container.
  retried="$(
    APPLIES="$ROT/applies"
    : >"$APPLIES"
    rotation_apply() {
      echo "$1:$2" >>"$APPLIES"
      [ "$(wc -l <"$APPLIES")" -gt 1 ]
    }
    rotation_take_out api api-new >/dev/null
    : >"$APPLIES"
    ROTATION_IN_FLIGHT=api
    rotation_restore api >/dev/null 2>&1 && echo first-restore-passed
    rotation_restore_in_flight "a test" 2>/dev/null && [ -z "$ROTATION_IN_FLIGHT" ] && printf 'trap-cleared '
    tr '\n' ' ' <"$APPLIES"
  )"
  verdict "after a restore whose reload failed, the exit trap reloads again though the file is already at rest" \
    '[ "$retried" = "trap-cleared front:plain front:plain " ]'

  # A SERVICE OTHER SERVICES CALL IS ROUTED THROUGH TWO PROXIES (2026-11-07): the frontend for what
  # members send, the mesh for what services call. Its take-out sets both lists, each proven retiring in
  # turn, and stops at the first that fails; its restore puts both back at rest even when the first
  # reload fails - a proxy left on a container's name is the 502 a rollback would cause.
  mesh_of() { rotation_existing_block "$ROT/mesh.conf" "$1" | sed -n 's/^map "" \$[a-z_]* { default \(.*\); }$/\1/p'; }
  PLAN2="$PLAN
call overlap no front:3002,mesh:3002
mesh pinned no -"
  rotation_seed <<<"$PLAN2" >/dev/null
  verdict "rotation_seed writes a list for every proxy, the second route included" \
    '[ "$(block_of call)" = call:3002 ] && [ "$(mesh_of call)" = call:3002 ] && [ -z "$(mesh_of api)" ]'
  taken="$(
    rotation_apply() { echo "$1:$2"; }
    rotation_take_out call call-new
  )"
  verdict "a service routed through two proxies is taken out of each, each reloaded as retiring" \
    '[ "$(printf "%s\n" "$taken" | tr "\n" " ")" = "front:retiring mesh:retiring " ] && [ "$(block_of call)" = p-call-2:3002 ] && [ "$(mesh_of call)" = p-call-2:3002 ]'
  stopped_at="$(
    rotation_apply() { echo "$1:$2"; [ "$1" != front ]; }
    rotation_take_out call call-new || echo refused
  )"
  verdict "a take-out whose first proxy fails is refused before the second is touched" \
    '[ "$(printf "%s\n" "$stopped_at" | tr "\n" " ")" = "front:retiring refused " ]'
  restored="$(
    rotation_apply() { echo "$1:$2"; [ "$1" != front ]; }
    rotation_restore call || echo failed
  )"
  verdict "a restore puts every proxy back at rest though the first reload failed, and says it failed" \
    '[ "$(printf "%s\n" "$restored" | tr "\n" " ")" = "front:plain mesh:plain failed " ] && [ "$(block_of call)" = call:3002 ] && [ "$(mesh_of call)" = call:3002 ]'
  rotation_seed <<<"$PLAN" >/dev/null

  # A proxy replica that is not running (restarting, paused) cannot be exec-ed into: a plain reload
  # skips it with a warning rather than stopping the deploy that may be the fix; a retiring one refuses.
  stopped="$(
    fake_docker() {
      case "$1" in
      ps) echo fe-1 ;;
      inspect) echo restarting ;;
      *) return 1 ;;
      esac
    }
    rotation_apply front plain 2>&1 | grep '^::warning title=A proxy replica that is not running::front: fe-1 is restarting' >/dev/null && echo plain-skipped
    rotation_apply front plain >/dev/null 2>&1 && echo plain-passed
    rotation_apply front retiring >/dev/null 2>&1 || echo retiring-refused
  )"
  verdict "a plain reload skips a proxy replica that is not running, with a warning, and goes on" \
    '[ "$(printf "%s\n" "$stopped" | tr "\n" " ")" = "plain-skipped plain-passed retiring-refused " ]'
  # The subrequest ports feed the pairing check alone, which a plain reload does not run.
  ports_read="$(
    fake_docker() {
      case "$1" in
      ps) echo fe-1 ;;
      inspect) echo running ;;
      exec) printf '# configuration file /etc/nginx/targets/front.conf:\n# render %s\n' "$ROTATION_TOKEN" ;;
      *) return 1 ;;
      esac
    }
    rotation_subrequest_ports() { echo read >&2; }
    rotation_reload() { echo "reload:$3:$4"; }
    rotation_apply front plain 2>&1
    rotation_apply front retiring 2>&1
  )"
  verdict "a plain reload reads no subrequest port, a retiring one does" \
    '[ "$(printf "%s\n" "$ports_read" | tr "\n" " ")" = "reload:plain: read reload:retiring: " ]'

  # A DUMP LARGER THAN THE PIPE BUFFER (64 KiB) IS STILL READ. `nginx -T` of the real edge grew past
  # it, and `printf "$dump" | grep -q` then failed under pipefail precisely when the marker WAS found
  # (grep exits on its first match, the writer takes SIGPIPE): the dev deploy of v1.6.4-alpha.1 was
  # refused with "not the one just written". The matches sit at the TOP, so grep leaves early. Linux
  # delivers that SIGPIPE; MSYS bash does not, so a local green proves little and CI is the reading.
  big_dump="$(
    fake_docker() {
      case "$1" in
      ps) echo fe-1 ;;
      inspect) echo running ;;
      exec)
        printf '# configuration file /etc/nginx/targets/front.conf:\n# render %s\n' "$ROTATION_TOKEN"
        head -c 300000 /dev/zero | tr '\0' 'x' | fold -w 100
        echo
        ;;
      *) return 1 ;;
      esac
    }
    rotation_reload() { echo "reload:$3"; }
    rotation_apply front plain 2>&1
  )"
  verdict "a configuration dump of 300 KB is matched on its first lines, not refused by a SIGPIPE" \
    '[ "$big_dump" = "reload:plain" ]'
  # The same dump with the marker near its END: nothing leaves early, so this one passes on any
  # platform and pins that the match is found wherever it sits.
  big_dump_end="$(
    fake_docker() {
      case "$1" in
      ps) echo fe-1 ;;
      inspect) echo running ;;
      exec)
        head -c 300000 /dev/zero | tr '\0' 'x' | fold -w 100
        echo
        printf '# configuration file /etc/nginx/targets/front.conf:\n# render %s\n' "$ROTATION_TOKEN"
        ;;
      *) return 1 ;;
      esac
    }
    rotation_reload() { echo "reload:$3"; }
    rotation_apply front plain 2>&1
  )"
  verdict "a configuration dump of 300 KB is matched on its last lines too" \
    '[ "$big_dump_end" = "reload:plain" ]'

  # A proxy that reads no list is a TRANSITION only when it runs the previous release's image.
  legacy="$(
    fake_docker() {
      case "$1" in
      ps) echo fe-1 ;;
      exec) printf '# configuration file /etc/nginx/conf.d/default.conf:\nset $a api:3000;\nset $b sib:3001;\n' ;;
      inspect) case "$3" in '{{.State.Status}}') echo running ;; *) echo sha256:running ;; esac ;;
      image) echo "$WANTED" ;;
      *) return 1 ;;
      esac
    }
    rotation_routes_set <<<'api overlap no front:3000 own/api:2
sib overlap no front:3001 own/sib:2
front overlap no edge:80 own/front:2'
    WANTED=sha256:running
    rotation_apply front plain >/dev/null 2>&1 || echo own-image-refused
    WANTED=sha256:newer
    rotation_apply front plain 2>&1 | grep '^::warning title=A proxy from before the target lists::' >/dev/null && echo older-image-drained
  )"
  verdict "a proxy reading no list that runs THIS release's own image is refused, not taken for a transition" \
    'grep -qx own-image-refused <<<"$legacy"'
  verdict "a proxy reading no list that runs the previous release's image is drained the old way, with a warning" \
    'grep -qx older-image-drained <<<"$legacy"'

  # auth_request: which upstream connections are subrequests, read from `nginx -T`.
  rotation_routes_set <<<'core-service overlap no frontend:3012
chat-gateway overlap no frontend:3000'
  DUMP='# configuration file /etc/nginx/conf.d/default.conf:
    location = /internal/auth/verify {
    internal;
    proxy_pass http://$target_core_service/api/auth/verify;
    }
    location = /internal/other {
    proxy_pass http://auth:3001/x;
    }
    location /api/ {
    auth_request /internal/auth/verify;
    auth_request /internal/other;
    proxy_pass http://$target_chat_gateway;
    }'
  verdict "rotation_subrequest_ports reads a \$target_<service> through its route, and a host:port as written" \
    '[ "$(printf "%s\n" "$DUMP" | rotation_subrequest_ports frontend | tr "\n" " ")" = "3001 3012 " ]'
  verdict "rotation_subrequest_ports refuses an auth_request whose target it cannot place" \
    '! printf "    auth_request /nowhere;\n" | rotation_subrequest_ports frontend 2>/dev/null >/dev/null'
  verdict "rotation_subrequest_ports refuses a \$target_ no service routed through the proxy is named by" \
    '! printf "    location = /a {\n    proxy_pass http://\$target_media_service/x;\n    }\n    auth_request /a;\n" | rotation_subrequest_ports frontend 2>/dev/null >/dev/null'
  verdict "a proxy naming every routed service by DNS, with no list, is a proxy from before the lists" \
    'printf "set \$a core-service:3012;\nset \$b chat-gateway:3000;\n" | rotation_is_legacy frontend'
  verdict "a proxy that names one routed service by nothing is refused, not taken for one from before the lists" \
    '! printf "set \$a core-service:3012;\n" | rotation_is_legacy frontend'
  verdict "a proxy of 1.6.2, its upstream list at rest, is a proxy from before the target lists" \
    'printf "# configuration file /etc/nginx/rotation/frontend.conf:\n    server core-service:3012 resolve;\n    server chat-gateway:3000 resolve;\n" | rotation_is_legacy frontend'
  verdict "a proxy of 1.6.2 whose upstream list names a container is refused - it would keep choosing it" \
    '! printf "# configuration file /etc/nginx/rotation/frontend.conf:\n    server canari-core-service-2:3012 resolve;\n    server chat-gateway:3000 resolve;\n" | rotation_is_legacy frontend'
  verdict "a proxy that includes some target file is never taken for one from before the lists" \
    '! printf "# configuration file /x/targets/other.conf:\nset \$a core-service:3012;\nset \$b chat-gateway:3000;\n" | rotation_is_legacy frontend'

  # The pairing check's join. Worker 10 holds one client connection (local :80, a listened port) and
  # one ESTABLISHED upstream connection to :3012 - the shape of a request still in its auth_request.
  TABLE='S 10 111
S 10 222
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 900 1
   1: 0200A8C0:0050 0300A8C0:D431 01 00000000:00000000 00:00000000 00000000     0        0 111 1
   2: 0200A8C0:A1B2 0400A8C0:0BC4 01 00000000:00000000 00:00000000 00000000     0        0 222 1'
  verdict "an upstream connection to a subrequest port pairs nothing: the request has not chosen yet" \
    '[ "$(printf "%s\n" "$TABLE" | awk -v skip=" 0BC4" "$ROTATION_PAIRS_AWK")" = "1 1 0 1 0BC4.01x1" ]'
  verdict "an upstream connection elsewhere pairs its client: the request has chosen" \
    '[ "$(printf "%s\n" "$TABLE" | awk -v skip="" "$ROTATION_PAIRS_AWK")" = "0 1 1 0 0BC4.01x1" ]'
  verdict "the pairing read's other sockets are said by decimal port and TCP state" \
    '[ "$(rotation_sockets_said "0BC4.01x1,0BB8.08x2")" = "3012/ESTABLISHEDx1, 3000/CLOSE_WAITx2" ] && [ "$(rotation_sockets_said -)" = none ]'
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
