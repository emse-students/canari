#!/usr/bin/env bash
#
# Deploys ONE Canari estate on the machine it runs on. Production and dev.canari-emse.fr differ by
# the arguments below and by nothing else.
#
# WHY IT IS A SCRIPT AND NOT A WORKFLOW STEP. `cd.yml`'s deploy job is ~780 lines of shell embedded
# in YAML, which can be run by exactly one thing: a push to `main` that deploys production. So it has
# never been tested, only used - and a second environment could not reuse a line of it without
# copying it, which is how `cd-dev.yml` reached 734 lines that had never worked. As a script it takes
# the environment as an argument and can be read, linted (`shellcheck -x`, in CI) and reasoned about.
#
# THE ORDER OF THE TWO SCRIPTS IN THIS DIRECTORY IS LOAD-BEARING. `render-env.sh` runs FIRST and
# refuses to write anything if a required secret is missing; only then does this script start
# containers. That way an incomplete environment fails while the previous deployment is still up,
# rather than starting a half-configured estate. This script therefore does NOT render: it requires
# the file, so the secrets never need to be in its own environment.
#
# WHAT IT IS NOT. It does not build images, it does not decide what changed, and it does not move the
# deployed-commit tag - all three need credentials or context that belong to the workflow. It takes a
# tag that already exists in the registry and makes the estate run it.
#
# Usage:
#   deploy-environment.sh --environment prod|dev --path /home/canari/canari --tag latest \
#     [--pull-services "core-service frontend"] [--registry ghcr.io] [--image-prefix owner/repo]
#
# GHCR_USERNAME and GHCR_TOKEN are read from the environment when present; without them the script
# assumes the daemon is already authenticated and says so.

set -euo pipefail

ENVIRONMENT=""
DEPLOY_PATH=""
TAG=""
PULL_SERVICES=""
REGISTRY="ghcr.io"
IMAGE_PREFIX="emse-students/canari"

while [ $# -gt 0 ]; do
  case "$1" in
  --environment)
    ENVIRONMENT="${2:-}"
    shift 2
    ;;
  --path)
    DEPLOY_PATH="${2:-}"
    shift 2
    ;;
  --tag)
    TAG="${2:-}"
    shift 2
    ;;
  --pull-services)
    PULL_SERVICES="${2:-}"
    shift 2
    ;;
  --registry)
    REGISTRY="${2:-}"
    shift 2
    ;;
  --image-prefix)
    IMAGE_PREFIX="${2:-}"
    shift 2
    ;;
  *)
    printf 'deploy-environment: unknown argument %s\n' "$1" >&2
    exit 2
    ;;
  esac
done

case "$ENVIRONMENT" in
prod)
  COMPOSE_FILE="infrastructure/docker-compose.prod.yml"
  # The host port the estate's nginx is published on. Read from .env below when it says otherwise;
  # this is only the fallback, and it matches the compose file's own default.
  DEFAULT_FRONTEND_PORT=80
  ;;
dev)
  COMPOSE_FILE="infrastructure/docker-compose.dev.yml"
  DEFAULT_FRONTEND_PORT=3080
  ;;
*)
  printf 'deploy-environment: --environment must be prod or dev (got "%s")\n' "$ENVIRONMENT" >&2
  exit 2
  ;;
esac

[ -n "$DEPLOY_PATH" ] || {
  printf 'deploy-environment: --path is required\n' >&2
  exit 2
}
# The compose files require TAG with `${TAG:?}`, so an empty one fails at `up` with a message about
# a variable rather than about a deployment. Refuse here, where the message can say what to pass.
[ -n "$TAG" ] || {
  printf 'deploy-environment: --tag is required - the compose files have no default\n' >&2
  exit 2
}

cd "$DEPLOY_PATH" || {
  printf 'deploy-environment: %s does not exist\n' "$DEPLOY_PATH" >&2
  exit 1
}

[ -f "$COMPOSE_FILE" ] || {
  printf 'deploy-environment: %s not found under %s - is this the right checkout?\n' \
    "$COMPOSE_FILE" "$DEPLOY_PATH" >&2
  exit 1
}

# The estate is identified by the compose file's own `name:`, not by the directory or by a `-p` this
# script passes. Read it back and SAY it: the two deployed files sit in one directory, and a missing
# `name:` used to mean dev silently joined production's project and its volumes.
PROJECT="$(grep -E '^name:[[:space:]]*' "$COMPOSE_FILE" | head -1 |
  sed 's/^name:[[:space:]]*//; s/[[:space:]]*$//' || true)"
[ -n "$PROJECT" ] || {
  printf 'deploy-environment: %s declares no top-level "name:" - refusing, because its project would then be named after its directory, which is shared with the other deployed estate\n' \
    "$COMPOSE_FILE" >&2
  exit 1
}

ENV_FILE="infrastructure/.env"
[ -f "$ENV_FILE" ] || {
  printf '::error::%s/%s is missing - render-env.sh must run before this script\n' \
    "$DEPLOY_PATH" "$ENV_FILE" >&2
  exit 1
}

printf '\n=== deploying the %s estate ===\n' "$ENVIRONMENT"
printf '  path      %s\n' "$DEPLOY_PATH"
printf '  compose   %s\n' "$COMPOSE_FILE"
printf '  project   %s\n' "$PROJECT"
printf '  tag       %s\n' "$TAG"
printf '  commit    %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf '  user      %s\n\n' "$(whoami)"

# ── Docker access ────────────────────────────────────────────────────────────
# The runner user may or may not be in the docker group; both estates deploy the same way.
if docker info >/dev/null 2>&1; then
  DOCKER_CLI="docker"
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER_CLI="sudo docker"
else
  printf 'deploy-environment: cannot reach the Docker daemon as %s\n' "$(whoami)" >&2
  id >&2 || true
  ls -l /var/run/docker.sock >&2 || true
  printf 'The runner user must be in the docker group or have passwordless sudo for docker.\n' >&2
  exit 1
fi
printf 'docker access: %s\n' "$DOCKER_CLI"

# Every compose invocation in this script goes through this, so the file and the environment are
# named once. `--env-file` is explicit rather than relying on the cwd: compose's implicit `.env`
# lookup is relative to the compose file's directory, which happens to be right here and would
# silently become wrong if either file moved.
dc() {
  $DOCKER_CLI compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

export REGISTRY IMAGE_PREFIX TAG

# ── GHCR ─────────────────────────────────────────────────────────────────────
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USERNAME:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | $DOCKER_CLI login "$REGISTRY" -u "$GHCR_USERNAME" --password-stdin
  printf 'authenticated to %s\n' "$REGISTRY"
else
  printf 'no GHCR credentials passed - assuming the daemon is already authenticated to %s\n' "$REGISTRY"
fi

# ── The host port this estate answers on ─────────────────────────────────────
FRONTEND_HOST_PORT="$(grep -E '^FRONTEND_HOST_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
[ -n "$FRONTEND_HOST_PORT" ] || FRONTEND_HOST_PORT="$DEFAULT_FRONTEND_PORT"
printf 'frontend host port: %s\n' "$FRONTEND_HOST_PORT"

# ── Pull ─────────────────────────────────────────────────────────────────────
# Only what changed, when the caller knows. `latest`-style tags are mutable, so a service whose image
# did not change is already the right one; a service whose image did change must be re-pulled or
# `up -d` sees no reason to recreate it.
if [ -n "$PULL_SERVICES" ]; then
  printf '\npulling changed images: %s\n' "$PULL_SERVICES"
  # shellcheck disable=SC2086 # deliberate word splitting: the caller passes a service list
  dc pull $PULL_SERVICES
else
  printf '\nno service image changes were reported - not pulling\n'
fi

# ── Up, with the one retry that is a REPAIR and not a hope ───────────────────
# A stale container of THIS estate's own frontend can hold the host port after a previous deploy was
# killed. That is the only conflict this script may resolve by itself, and the allowlist is narrow on
# purpose: an image name under this registry and prefix, and this project's own label. Anything else
# on that port is somebody else's container and the deploy stops rather than removing it.
printf '\nbringing the estate up\n'
if ! dc up -d --remove-orphans; then
  printf '\nfirst attempt failed - looking for a stale container holding host port %s\n' "$FRONTEND_HOST_PORT"

  conflicts="$($DOCKER_CLI ps --filter "publish=$FRONTEND_HOST_PORT" \
    --format '{{.ID}} {{.Image}} {{.Names}} {{.Label "com.docker.compose.project"}}' || true)"
  foreign=0
  if [ -n "$conflicts" ]; then
    # fd 3 for the same reason as `apply_migrations` below: this body runs docker commands, and one
    # `compose exec` added here would silently eat the rest of the list. Safe today - `printf | awk`
    # gives awk its own stdin and `docker rm` reads none - and one edit away from not being.
    while IFS= read -r row <&3; do
      [ -z "$row" ] && continue
      cid="$(printf '%s' "$row" | awk '{print $1}')"
      image="$(printf '%s' "$row" | awk '{print $2}')"
      name="$(printf '%s' "$row" | awk '{print $3}')"
      owner="$(printf '%s' "$row" | awk '{print $4}')"

      if [ "$owner" = "$PROJECT" ] && printf '%s' "$image" | grep -q "^${REGISTRY}/${IMAGE_PREFIX}/frontend:"; then
        printf 'removing this estate'"'"'s own stale frontend: %s (%s)\n' "$name" "$cid"
        $DOCKER_CLI rm -f "$cid"
      else
        printf '::error::host port %s is held by %s (image %s, project %s) which this estate does not own\n' \
          "$FRONTEND_HOST_PORT" "$name" "$image" "${owner:-none}"
        foreign=1
      fi
    done 3<<<"$conflicts"
  fi

  if [ "$foreign" -ne 0 ]; then
    printf '::error::resolve the host port %s conflict and redeploy\n' "$FRONTEND_HOST_PORT" >&2
    exit 1
  fi

  printf 'retrying\n'
  dc up -d --remove-orphans
fi
printf 'containers started\n'

# ── Migrations ───────────────────────────────────────────────────────────────
# POSTGRES_USER comes from the .env this estate was just rendered with, not from a second copy of the
# secret: two sources for one value is two things to keep in step.
POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
[ -n "$POSTGRES_USER" ] || {
  printf '::error::POSTGRES_USER is absent from %s, so no migration can be run\n' "$ENV_FILE" >&2
  exit 1
}

printf '\nwaiting for PostgreSQL\n'
pg_ready=0
for i in $(seq 1 30); do
  if dc exec -T postgres pg_isready -U "$POSTGRES_USER" -d auth_db >/dev/null 2>&1; then
    pg_ready=1
    break
  fi
  printf '  not ready yet (%s/30)\n' "$i"
  sleep 2
done
if [ "$pg_ready" -ne 1 ]; then
  printf '::error::PostgreSQL did not accept a connection within 60s\n' >&2
  dc logs --tail 50 postgres || true
  exit 1
fi
printf 'PostgreSQL is ready\n'

psql() {
  dc exec -T postgres psql -U "$POSTGRES_USER" -d auth_db -v ON_ERROR_STOP=1 "$@"
}

# The ledger, keyed by repo-relative path. Without it every file replays on every deploy, which
# silently reverts admin changes made after a one-shot data backfill - migrations 004 and 016 are
# exactly that. Files must still be idempotent: a deploy that fails mid-run leaves the rest
# unrecorded, so the next one re-runs them. See infrastructure/MIGRATION.md.
# THE LOOP READS ON FD 3, AND THAT IS THE WHOLE POINT OF THIS FUNCTION. `psql` here is
# `docker compose exec -T`, which ATTACHES AND DRAINS STDIN whatever arguments follow it - so with
# the file list on the loop's own stdin, the ledger query in the FIRST iteration swallowed every
# remaining line and `read` met EOF. Measured on dev's first bootstrap, 2026-09-02: 80 migration
# files present, `migrations: 1 applied, 0 already recorded`, and two services crash-looping on
# `relation "platform_config" does not exist`. Production never saw it because production still runs
# its own inlined shell - which is exactly why this script had to be exercised on dev first.
#
# A dedicated descriptor fixes the CLASS rather than the instance: `</dev/null` on each inner call
# would work today and would have to be remembered by whoever adds the next one.
apply_migrations() {
  psql -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"

  local migrations applied skipped migration checksum recorded
  migrations="$(find apps/*/src/migrations -name '*.sql' 2>/dev/null | sort || true)"
  if [ -z "$migrations" ]; then
    printf 'no migration files found\n'
    return 0
  fi

  applied=0
  skipped=0
  while read -r migration <&3; do
    [ -z "$migration" ] && continue
    checksum="$(sha256sum "$migration" | cut -d' ' -f1)"
    recorded="$(psql -At -c "SELECT checksum FROM schema_migrations WHERE filename = '$migration'" || true)"

    if [ -n "$recorded" ]; then
      if [ "$recorded" != "$checksum" ]; then
        printf '::warning::%s changed after it was applied - the %s database still has the old version. Add a new migration instead of editing an applied one.\n' \
          "$migration" "$ENVIRONMENT"
        psql -q -c "UPDATE schema_migrations SET checksum = '$checksum' WHERE filename = '$migration'"
      fi
      skipped=$((skipped + 1))
      continue
    fi

    printf 'applying %s\n' "$migration"
    psql <"$migration"
    psql -q -c "INSERT INTO schema_migrations (filename, checksum) VALUES ('$migration', '$checksum') ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum"
    applied=$((applied + 1))
  done 3<<<"$migrations"
  printf 'migrations: %s applied, %s already recorded\n' "$applied" "$skipped"
}

apply_migrations

# ── Every service must be running ────────────────────────────────────────────
# THE LIST IS DERIVED FROM THE COMPOSE FILE, AND WHAT IS WRITTEN DOWN IS WHAT MAY BE ABSENT. The
# workflow this replaces named ten services by hand, and the shape of that list is the defect: on
# 2026-09-01 it named seven application services and none of the three datastores they all depend on,
# while a postgres major crossing crash-looped the only database for 33 minutes. The datastores were
# then added - and `frontend-ssr` was in NEITHER version, so an estate whose server-side renderer
# never came up would still have deployed green.
#
# Inverting it fixes the class rather than the instance: everything the compose file declares is
# required, and a service is exempt only by being named here. A service added later is covered on the
# day it is declared, by whoever declares it. `adminer` is the exemption production actually needs -
# a database console, whose absence breaks nothing a member can see.
NON_CRITICAL="adminer"

declared="$(dc config --services | sort)"
critical=""
for service in $declared; do
  exempt=0
  for skip in $NON_CRITICAL; do
    [ "$service" = "$skip" ] && exempt=1
  done
  [ "$exempt" -eq 0 ] && critical="$critical $service"
done
# shellcheck disable=SC2086
printf '\nrequiring %s service(s) to be running:%s\n' "$(printf '%s\n' $critical | wc -l | tr -d ' ')" "$critical"

# `Restarting` is fatal here and safe to treat as such: an ordinary `up -d` recreate goes
# Created -> Running, and Docker reports `Restarting` only after a non-zero exit brought the restart
# policy in. So it is never a transient state on a healthy deploy.
critical_pattern="$(printf '%s' "$critical" | tr ' ' '|' | sed 's/^|//; s/|$//')"

ready=0
for _ in $(seq 1 36); do
  running="$(dc ps --status running --services || true)"
  all="$(dc ps --all || true)"

  if printf '%s' "$all" | grep -E "($critical_pattern)" | grep -E 'Restarting|Exit|Dead|unhealthy' >/dev/null; then
    printf '::error::a required service is restarting, exited, dead or unhealthy\n' >&2
    printf '%s\n' "$all"
    exit 1
  fi

  missing=""
  for service in $critical; do
    printf '%s\n' "$running" | grep -qx "$service" || missing="$missing $service"
  done

  if [ -z "$missing" ]; then
    ready=1
    break
  fi
  sleep 5
done

if [ "$ready" -ne 1 ]; then
  printf '::error::timed out waiting for:%s\n' "$missing" >&2
  dc ps --all || true
  exit 1
fi
printf 'every required service is running\n'

# ── Health ───────────────────────────────────────────────────────────────────
# THE CONTAINERS STARTING IS NOT THE SITE ANSWERING, which is the house rule these four checks exist
# to honour. They go through this estate's own nginx on loopback, so they exercise the routing rather
# than the containers.
sleep 5

retry_http() {
  local label="$1" expected="$2" cmd="$3" attempts="${4:-12}" delay="${5:-3}" status="000"
  local i
  for i in $(seq 1 "$attempts"); do
    status="$(eval "$cmd" || true)"
    if printf '%s' "$status" | grep -Eq "$expected"; then
      printf 'ok   %s (HTTP %s)\n' "$label" "$status"
      return 0
    fi
    sleep "$delay"
  done
  printf '::error::%s failed after %s attempts (last HTTP %s)\n' "$label" "$attempts" "$status" >&2
  return 1
}

BASE="http://127.0.0.1:${FRONTEND_HOST_PORT}"
printf '\nhealth checks against %s\n' "$BASE"

retry_http "frontend answers" '^(2|3)[0-9][0-9]$' \
  "curl -s -o /dev/null -w '%{http_code}' $BASE/"

retry_http "chat-delivery-service liveness" '^200$' \
  "curl -s -o /dev/null -w '%{http_code}' $BASE/api/chat-delivery-health"

retry_http "media-service reachable" '^[1-5][0-9][0-9]$' \
  "curl -s -o /dev/null -w '%{http_code}' $BASE/api/media"

# ROUTE EXISTENCE, not merely reachability. The check above passes on ANY status, which is what let a
# media-service missing `POST /media/touch` deploy green while the endpoint answered 404 for a day.
# Unauthenticated, an existing route answers 401 and an absent one 404, so the two are
# distinguishable without a credential - and this asserts the image really carries the code.
retry_http "media-service /touch route present" '^401$' \
  "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"mediaIds\":[]}' $BASE/api/media/touch"

# AND THE ONE CHECK THE 2026-09-01 OUTAGE PROVED WAS MISSING. Every check above passes with the
# database on the floor: nginx answers `/`, and the liveness routes are deliberately anonymous.
# `/api/version` reads it, so this is the cheapest end-to-end statement that the estate is really
# serving - the frontend answered 200 throughout a 33-minute outage nobody was told about.
retry_http "api/version answers, which needs the database" '^200$' \
  "curl -s -o /dev/null -w '%{http_code}' $BASE/api/version"

# ── Housekeeping ─────────────────────────────────────────────────────────────
# HOST-WIDE, not per estate, and safe for both: `-a` removes only images no container references, so
# the other estate's running images are untouched. The build cache was never pruned and reached ~30
# GB before this existed.
printf '\npruning unused images and old build cache\n'
$DOCKER_CLI image prune -af --filter 'until=24h' >/dev/null || true
$DOCKER_CLI container prune -f >/dev/null || true
$DOCKER_CLI builder prune -af --filter 'until=168h' >/dev/null || true

dc ps
printf '\n=== the %s estate is deployed: %s at %s ===\n' "$ENVIRONMENT" "$TAG" "$BASE"
