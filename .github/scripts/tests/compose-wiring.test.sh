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

# ─────────────────────────────────────────────────────────────────────────────
# Every deployed compose file declares its own project name, and no two agree
#
# THE HAZARD THIS CLOSES IS THE WORST ONE IN THIS FILE'S HISTORY, and it was live until 2026-09-01.
# A compose project with no `name:` is named after the DIRECTORY the file sits in - and both deployed
# files sit in `infrastructure/`. Production's volumes on the server really are
# `infrastructure_postgres_data`, `infrastructure_redis_data` and so on, measured. So the dev file,
# run the obvious way with `-f` and no `-p`, would have joined production's project: dev's
# `postgres_data` resolves to production's live database and dev's network to production's network.
# The dev file's own header promised isolation "under a distinct compose project name" while nothing
# in it produced one. A precondition that lives in a caller's memory is not a precondition.
# ─────────────────────────────────────────────────────────────────────────────
printf '\nevery deployed estate declares its own compose project name:\n'

declared_names=""
for file in infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml; do
  [ -f "$file" ] || continue
  # Top-level key: no indentation. A `name:` nested under a service is a different key entirely.
  # `|| true` because a missing key is the case this assertion EXISTS for, and under `pipefail`
  # grep's exit 1 would otherwise kill the script before it could say so - failing the suite with no
  # diagnostic at all, which is how a guard costs more than it buys.
  project="$(grep -E '^name:[[:space:]]*' "$file" 2>/dev/null | head -1 |
    sed 's/^name:[[:space:]]*//; s/[[:space:]]*$//' || true)"
  if [ -z "$project" ]; then
    fail "$file declares no top-level 'name:', so its project is the directory it sits in - which is the same directory as the other deployed estate"
    continue
  fi
  pass
  printf '  ok    %s -> project %s\n' "$file" "$project"
  declared_names="$declared_names $project"
done

# shellcheck disable=SC2086 # deliberate word splitting: the accumulator is a space-separated list
dupe="$(printf '%s\n' $declared_names | sort | uniq -d)"
if [ -n "$dupe" ]; then
  fail "two deployed estates declare the same project name ($dupe), so they share every named volume and their networks"
else
  pass
  printf '  ok    no two deployed estates share a project name\n'
fi

printf '\n'
# ─────────────────────────────────────────────────────────────────────────────
# THE THIRD CHECK, added 2026-09-02: an environment KEY production forwards to a
# service must be forwarded to that same service by the LOCAL compose file.
#
# `infrastructure/.env` holding a value proves nothing - the compose file has to
# pass it. Measured that day: production forwarded 17 keys the local file did
# not, and three of them (the AUTHENTIK_* trio) were why no local login could
# ever complete. All three sat correctly in `.env` the whole time, so no amount
# of reading that file could have found it; a real login did, by answering 401
# on every authenticated route after a successful OIDC callback.
#
# Keys only. A key present in both may still hold a wrong value - a different
# question, and not one a static check can answer. A key MISSING is a defect no
# value can fix, and that is what this asserts.
#
# The exceptions are NAMED, with reasons, because an unexplained skip list is
# how a check like this rots into always passing.
# ─────────────────────────────────────────────────────────────────────────────
PROD_COMPOSE=infrastructure/docker-compose.prod.yml
LOCAL_COMPOSE=infrastructure/local/docker-compose.yml

# Services production declares that the local estate deliberately does not run.
# `frontend` / `frontend-ssr`: the app is served by `bun run dev` on the host.
# `adminer`: a database UI nobody needs locally, psql being right there.
LOCAL_ABSENT_BY_DESIGN="frontend frontend-ssr adminer"

# "<service> <KEY>" for every environment key a compose file forwards, taken by
# indentation: a service is two spaces, `environment:` four, a key six.
env_keys() {
  awk '
    /^  [a-z][a-z0-9-]*:[[:space:]]*$/ { svc = $1; sub(":", "", svc); in_env = 0; next }
    svc == "" { next }
    /^    environment:[[:space:]]*$/ { in_env = 1; next }
    /^    [^[:space:]]/ { in_env = 0; next }
    in_env && /^      [A-Z][A-Z0-9_]*:/ { key = $1; sub(":", "", key); print svc, key }
  ' "$1"
}

printf '\nthe local estate forwards what production forwards:\n'
prod_pairs="$(env_keys "$PROD_COMPOSE")"
local_pairs="$(env_keys "$LOCAL_COMPOSE")"

for svc in $(printf '%s\n' "$prod_pairs" | awk '{print $1}' | sort -u); do
  case " $LOCAL_ABSENT_BY_DESIGN " in
    *" $svc "*)
      pass
      printf '  ok    %s is absent locally by design, so its keys are not owed\n' "$svc"
      continue
      ;;
  esac
  if ! printf '%s\n' "$local_pairs" | grep -q "^$svc "; then
    fail "production declares '$svc' with an environment block and the local compose has no such service - wire it, or name it in LOCAL_ABSENT_BY_DESIGN with a reason"
    continue
  fi
  missing=""
  for key in $(printf '%s\n' "$prod_pairs" | awk -v s="$svc" '$1 == s {print $2}' | sort -u); do
    if ! printf '%s\n' "$local_pairs" | grep -qx "$svc $key"; then
      missing="$missing $key"
    fi
  done
  if [ -n "$missing" ]; then
    fail "$svc: production forwards these and the local estate does not -$missing"
  else
    pass
    printf '  ok    %s forwards every key production does\n' "$svc"
  fi
done

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf 'FAILED: %d problem(s) across %d assertion(s)\n' "$failures" "$((checks + failures))"
  exit 1
fi
printf 'all %d assertions passed\n' "$checks"
