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
ROLLING="$REPO/infrastructure/lib/rolling.sh"
DEPLOY="$REPO/infrastructure/deploy/deploy-environment.sh"
FRONTEND_NGINX="$REPO/infrastructure/local/Dockerfile.frontend"
EDGE_NGINX="$REPO/infrastructure/edge/nginx.conf"
FIXTURE_NGINX="$REPO/.github/scripts/tests/rolling-fixture/frontend.conf"
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
fixture_edge_health="$(TAG=v0 EDGE_DIR=/edge ROLLTEST_PORT=1 docker compose \
  -f "$REPO/.github/scripts/tests/rolling-fixture/compose.yml" config --format json | edge_healthcheck)"

# ── 1. Both deployed estates declare a mode the deploy can honour ─────────────
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
  if printf '%s\n' "$plan" | grep -qx 'edge pinned yes'; then
    ok "$file: the edge is pinned"
  else
    fail "$file: the edge is not 'pinned yes'"
  fi
  if printf '%s\n' "$plan" | grep -qx 'frontend overlap no'; then
    ok "$file: the frontend is replaced with overlap"
  else
    fail "$file: the frontend is not 'overlap no'"
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

  # The edge is HEALTHY only once it LISTENS, and by the same test the rolling fixture proves: a
  # pinned service with no healthcheck is believed at `running`, before nginx has opened its port
  # (cicd.md#the-edge-is-ready-when-it-listens-not-when-it-runs).
  edge_health="$(printf '%s' "$config" | edge_healthcheck)"
  if [ -n "$edge_health" ] && [ "$edge_health" = "$fixture_edge_health" ]; then
    ok "$file: the edge's healthcheck is the rolling fixture's (it waits for the listener)"
  else
    fail "$file: the edge's healthcheck '${edge_health:-none}' is not the fixture's '${fixture_edge_health:-none}'"
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

# ── 3. The numbers the replacement relies on agree everywhere they are written ──
ttl="$(sed -n 's/^ROLLING_RESOLVER_TTL_SECONDS=\([0-9][0-9]*\)$/\1/p' "$ROLLING")"
[ -n "$ttl" ] || fail "rolling.sh declares no ROLLING_RESOLVER_TTL_SECONDS"
for cfg in "$FRONTEND_NGINX" "$EDGE_NGINX" "$FIXTURE_NGINX"; do
  valid="$(grep -o 'resolver 127\.0\.0\.11 valid=[0-9]*s' "$cfg" | sed 's/.*valid=\([0-9]*\)s/\1/' | sort -u)"
  if [ "$valid" = "$ttl" ]; then
    ok "${cfg#"$REPO"/}: resolver valid=${ttl}s, the lifetime the deploy waits out"
  else
    fail "${cfg#"$REPO"/}: resolver valid=${valid:-none}s, but rolling.sh waits out ${ttl:-?}s"
  fi
done
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
# The image that takes a retiring replica out of rotation runs on the host at every deploy: pinned by
# digest like every third-party image, so a moved tag cannot change what it executes there.
if grep -qE "^ROLLING_NETNS_IMAGE='[^'@]+@sha256:[0-9a-f]{64}'$" "$ROLLING"; then
  ok "rolling.sh pins the image that takes a replica out of rotation by digest"
else
  fail "rolling.sh's ROLLING_NETNS_IMAGE is not pinned by digest"
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

printf '\ndeploy-replace: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
