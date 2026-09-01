#!/usr/bin/env bash
#
# Asserts two things about every compose file that describes a DEPLOYED estate: that no
# container-to-container address uses a HOST-side port, and that every NestJS service is told it is
# in production. Both are wiring, both were wrong in the same file, and both fail silently.
#
# WHY THIS EXISTS. `infrastructure/docker-compose.dev.yml` was written in April 2026 by offsetting
# every port so a dev stack could sit beside production on one machine - and the offsets were applied
# to the CONTAINER-side addresses as well as the host bindings: `redis://redis:6380`,
# `postgres://...@postgres:5433/auth_db`, `http://core-service:3112`, `DB_PORT: "5433"`. Inside a
# compose network a service answers on the port it LISTENS on; the number left of the colon in
# `ports:` exists only on the host and is invisible to peers. Every one of those URLs pointed at a
# closed port, so the file had never worked - and nothing said so, because nothing ever started it.
#
# The check is DERIVED, not a list: it reads each service's own listening ports out of the file
# (`expose:` and the `PORT:` it is told to bind) and then holds every address in the file against
# that map. A service added later is covered by whoever declares it, and a port changed later moves
# the expectation with it. That is the same shape as `ceiling.test.sh`, and for the same reason - a
# hand-written list of what to check fails by omission, silently.
#
# THE SECOND CHECK, added 2026-09-01 after the rewrite of the dev file left it out. Production sets
# `NODE_ENV` on all four NestJS services; the rewritten dev file set it on neither frontend nor any
# service, and the consequence was not cosmetic. With `NODE_ENV` unset a NestJS app is not in
# production mode, and `auth.controller.ts` then decided the refresh cookie's `secure` and `sameSite`
# from the request's own `Origin` header - so a client sending `Origin: http://localhost` to an
# HTTPS-served environment would have been handed an insecure cookie. The dev environment is
# explicitly required to keep production's cookie attributes.
#
# The service list is DERIVED from `apps/*/package.json` declaring `@nestjs/core`, not written here:
# the two Rust services must NOT be required to set it, and the next NestJS app must be, on the day
# it is created rather than on the day someone remembers this file.
#
# Run by `make test-ci-scripts` and by CI whenever a compose file or this script changes.

set -euo pipefail

cd "$(dirname "$0")/../../.."

failures=0
checks=0

fail() {
  printf '  FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

pass() {
  checks=$((checks + 1))
}

# ─────────────────────────────────────────────────────────────────────────────
# For one compose file: emit "<service> <port>" for every port that service
# LISTENS on inside the network. Two independent sources, because neither is
# complete on its own - `expose:` is absent on the frontends, and `PORT:` is
# absent on the datastores.
# ─────────────────────────────────────────────────────────────────────────────
listening_ports() {
  awk '
    # A service header: exactly two spaces, a name, a colon, nothing else.
    /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ {
      svc = $1; sub(/:$/, "", svc); next
    }
    # Leaving the services block.
    /^[a-zA-Z]/ { svc = ""; next }

    svc == "" { next }

    # expose:
    #   - "3000"
    /^    expose:[[:space:]]*$/ { inexpose = 1; next }
    inexpose && /^      - / {
      p = $2; gsub(/"/, "", p)
      if (p ~ /^[0-9]+$/) print svc, p
      next
    }
    /^    [a-zA-Z]/ { inexpose = 0 }

    # PORT: "3010"  /  PORT: 3010
    /^      PORT:[[:space:]]/ {
      p = $2; gsub(/[",'"'"']/, "", p)
      if (p ~ /^[0-9]+$/) print svc, p
      next
    }
  ' "$1" | sort -u
}

# ─────────────────────────────────────────────────────────────────────────────
# Emit "<line-number> <service> <port>" for every `scheme://[creds@]service:port`
# found anywhere in the file. Only the host:port pair is of interest, so the
# scheme and any credentials are discarded.
#
# COMMENT LINES ARE SKIPPED, and that is not a convenience: the rewritten dev
# file QUOTES the broken addresses it replaced, so a check that read comments
# would fail on the very explanation of why it exists.
# ─────────────────────────────────────────────────────────────────────────────
referenced_addresses() {
  grep -nE '[a-z]+://[^[:space:]"]*[a-zA-Z0-9_-]+:[0-9]+' "$1" |
    grep -vE '^[0-9]+:[[:space:]]*#' |
    sed -E 's|^([0-9]+):.*|\1 &|' |
    awk '{
      line = $1
      # Pull every scheme://...host:port out of the rest of the line.
      rest = $0
      while (match(rest, /[a-z]+:\/\/[^[:space:]"]*/)) {
        url = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        # Strip scheme and any user:pass@ prefix.
        sub(/^[a-z]+:\/\//, "", url)
        sub(/^[^@\/]*@/, "", url)
        # Keep host:port, drop any path.
        sub(/\/.*$/, "", url)
        if (url ~ /^[a-zA-Z0-9_-]+:[0-9]+$/) {
          split(url, hp, ":")
          print line, hp[1], hp[2]
        }
      }
    }'
}

check_file() {
  local file="$1"
  printf '\n%s\n' "$file"

  local map
  map=$(listening_ports "$file")
  if [ -z "$map" ]; then
    fail "no listening ports could be derived - the parser and the file have diverged"
    return
  fi

  # Every service that appears as a target must be reachable on the port named.
  local line svc port expected
  while read -r line svc port; do
    [ -n "${svc:-}" ] || continue
    expected=$(echo "$map" | awk -v s="$svc" '$1 == s { print $2 }' | tr '\n' ' ')
    # A host that is not a service in this file is an external address (an API, a
    # registry, a localhost tool port) and is none of this check's business.
    [ -n "$expected" ] || continue

    if echo " $expected " | grep -q " $port "; then
      pass
    else
      fail "$file:$line addresses $svc on $port, but it listens on: ${expected% }"
    fi
  done <<EOF
$(referenced_addresses "$file")
EOF

  # The split host/port pairs, which no URL check can see.
  local pair
  for pair in "REDIS_HOST:REDIS_PORT" "DB_HOST:DB_PORT"; do
    local hostkey="${pair%%:*}" portkey="${pair##*:}"
    # Every declared value of the port key, with the service the host key names.
    while read -r line svc port; do
      [ -n "${svc:-}" ] || continue
      expected=$(echo "$map" | awk -v s="$svc" '$1 == s { print $2 }' | tr '\n' ' ')
      [ -n "$expected" ] || continue
      if echo " $expected " | grep -q " $port "; then
        pass
      else
        fail "$file:$line sets $portkey=$port for $hostkey=$svc, which listens on: ${expected% }"
      fi
    done <<EOF
$(awk -v hk="$hostkey" -v pk="$portkey" '
      $1 == hk":" { host = $2; gsub(/"/, "", host); hostline = NR }
      $1 == pk":" {
        p = $2; gsub(/"/, "", p)
        if (host != "" && p ~ /^[0-9]+$/) print NR, host, p
      }
    ' "$file")
EOF
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# Every compose file that describes a DEPLOYED estate. `infrastructure/local/`
# is excluded on purpose: it is a laptop stack, it publishes everything, and a
# developer reaching a service on a host port there is the intended use.
# ─────────────────────────────────────────────────────────────────────────────
printf 'Compose wiring: container-to-container addresses must use LISTENING ports\n'

for file in infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml; do
  if [ ! -f "$file" ]; then
    fail "$file is missing"
    continue
  fi
  check_file "$file"
done

# ─────────────────────────────────────────────────────────────────────────────
# Every NestJS service in a deployed compose file is told it is in production
# ─────────────────────────────────────────────────────────────────────────────
printf '\nevery NestJS service in a deployed estate declares NODE_ENV:\n'

# A NestJS app is one whose package declares the framework. Derived, so the two Rust services are
# not required to set a variable they never read, and the next NestJS app is covered on creation.
nest_apps=""
for dir in apps/*/; do
  [ -f "$dir/package.json" ] || continue
  if grep -q '"@nestjs/core"' "$dir/package.json"; then
    nest_apps="$nest_apps $(basename "$dir")"
  fi
done

if [ -z "$nest_apps" ]; then
  fail "no NestJS app could be derived from apps/*/package.json - the parse is broken, not the compose"
else
  count=$(echo "$nest_apps" | wc -w | tr -d ' ')
  if [ "$count" -lt 4 ]; then
    fail "only $count NestJS app(s) derived; this repository has at least four"
  else
    pass
    printf '  derived %s NestJS app(s):%s\n' "$count" "$nest_apps"
  fi
fi

# The value of NODE_ENV for one service in one file, or nothing when the service does not set it.
service_node_env() {
  awk -v want="$2" '
    /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ { svc = $1; sub(/:$/, "", svc); next }
    svc != want { next }
    /^      NODE_ENV:[[:space:]]/ { v = $2; gsub(/"/, "", v); print v; exit }
  ' "$1"
}

for file in infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml; do
  [ -f "$file" ] || continue
  for app in $nest_apps; do
    # A service the file does not run at all is not this check's business; only a service that is
    # there and silent about NODE_ENV is.
    if ! grep -qE "^  $app:[[:space:]]*$" "$file"; then
      continue
    fi
    value=$(service_node_env "$file" "$app")
    # Production writes `${NODE_ENV:-production}` so the value can be overridden from `.env`, and
    # that whole literal is what the parse returns. What this check is about is the EFFECTIVE value,
    # so a `${VAR:-default}` wrapper is reduced to its default before being judged - which is also
    # what makes `${NODE_ENV:-development}` fail rather than pass on a technicality.
    effective=$(printf '%s' "$value" | sed -E 's/^[$][{][A-Za-z_][A-Za-z0-9_]*:-([^}]*)[}]$/\1/')
    case "$effective" in
    "")
      fail "$file runs $app and does not set NODE_ENV - it would not be in production mode, and the refresh cookie's attributes would then be decided by the request's Origin header"
      ;;
    production)
      pass
      ;;
    *)
      fail "$file sets NODE_ENV=$value for $app; a deployed estate must be in production mode"
      ;;
    esac
  done
done

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
