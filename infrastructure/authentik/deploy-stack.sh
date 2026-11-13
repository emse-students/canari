#!/usr/bin/env bash
# THE RELEASE DEPLOYS MICONNECT'S VERSION (owner, 2026-11-13: "Pourquoi on a du authentik dans notre
# repo si ce n'est pour ça ?"). A pre-release puts the test stack on the authentik image this tree
# pins, a stable puts production on it - the image of `server` and `worker` in compose.yml, a literal
# Dependabot moves. Until this script, the tag lived only in each stack's `.env` on the host, and
# production ran 2026.8.0 while this repository said 2026.8.5.
#
#   deploy-stack.sh deploy --project <compose project> [--compose <pinning compose.yml>] [--oidc-slug canari]
#   deploy-stack.sh health --project <compose project> [--compose <pinning compose.yml>] [--oidc-slug canari]
#
# deploy: decides from the RUNNING images and the `.env` tag line (release-lib.sh, ak_decide) and
#   restarts only when they differ from the pin. Before a change: the image is pulled, compose proves
#   it would run the pin, the migration count is read and the database is dumped (and the dump read
#   back). Then the `.env` line is rewritten in place and `server` and `worker` alone are recreated
#   (`--no-deps`: postgres keeps running). After: Docker's own health verdict for both, both running
#   the pin, `/-/health/live/`, `/-/health/ready/` and the OIDC discovery document. A failure rolls
#   back - the old tag, and the dump restored when the schema moved - and exits non-zero.
# health: the same after-checks alone, changing nothing (serve-prod runs it after the blueprints).
#
# WHAT IT DOES NOT DEPLOY: the stack's compose.yml and `.env` beyond that one line. The stack's
# directory, compose files and project are read from the running containers' compose labels, so no
# host path is written in this public repository. The host's compose must interpolate AUTHENTIK_TAG -
# proved before anything changes, by `docker compose config --images`.
#
# THE RUNNER ACCOUNT MUST READ AND WRITE THE STACK'S `.env` (compose reads its secrets from it), and
# the job REFUSES naming the command when it cannot - infrastructure/MIGRATION.md, "MiConnect".
#
# Exit: 0 done or nothing to do; 1 refused or rolled back (the stack runs what it ran before);
#       2 the rollback itself failed (the stack needs a human NOW - the message says how).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=release-lib.sh
. "$here/release-lib.sh"

mode="${1:-}"
shift || true
project=""
compose="$here/compose.yml"
oidc_slug="canari"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --compose) compose="$2"; shift 2 ;;
    --oidc-slug) oidc_slug="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
case "$mode" in deploy | health) ;; *)
  echo "usage: deploy-stack.sh deploy|health --project <name> [--compose <file>] [--oidc-slug <slug>]" >&2
  exit 64
  ;;
esac
[ -n "$project" ] || { echo "::error::--project is required" >&2; exit 64; }

poll_seconds="${AK_POLL_SECONDS:-10}"
# A FLOOR UNDER THE WORST CASE, never the verdict: Docker's healthcheck answers within its start
# period plus three intervals (~4 min for authentik's). Reaching this deadline FAILS, it never passes.
deadline_seconds="${AK_HEALTH_DEADLINE_SECONDS:-900}"
dump_root="${AK_DUMP_DIR:-$HOME/authentik-release-dumps}"
# The release's own words go to the job log; nothing here prints `.env` content.
unset AUTHENTIK_TAG AUTHENTIK_IMAGE

log() { echo "[miconnect-deploy:$project] $*"; }
err() { echo "::error title=MiConnect ($project)::$*" >&2; }

pin="$(ak_pin_image "$compose")" || { err "cannot read the pinned image from $compose"; exit 1; }
pin_tag="$(ak_tag_of "$pin")"

# container_of <service> - the ONE running container of a service of this project, or empty.
container_of() {
  local ids
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1")"
  if [ "$(printf '%s\n' "$ids" | grep -c .)" -gt 1 ]; then
    err "more than one running $1 container in project $project"
    exit 1
  fi
  printf '%s\n' "$ids"
}
image_of() { [ -n "$1" ] && docker inspect -f '{{.Config.Image}}' "$1" || true; }
label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }

# wait_healthy <service> - Docker's verdict, polled until it is one (ak_health_verdict).
wait_healthy() {
  local service="$1" waited=0 id verdict
  while :; do
    id="$(container_of "$service")"
    if [ -z "$id" ]; then
      verdict="failed:no running container"
    else
      verdict="$(ak_health_verdict \
        "$(docker inspect -f '{{.State.Status}}' "$id")" \
        "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" \
        "$(docker inspect -f '{{.RestartCount}}' "$id")")"
    fi
    case "$verdict" in
      healthy) log "$service healthy"; return 0 ;;
      failed:*) err "$service: ${verdict#failed:}"; return 1 ;;
    esac
    if [ "$waited" -ge "$deadline_seconds" ]; then
      err "$service: no health verdict after ${deadline_seconds}s"
      return 1
    fi
    sleep "$poll_seconds"
    waited=$((waited + poll_seconds))
  done
}

# after_checks <expected-tag> - both containers healthy, both on the tag, the endpoints answering.
after_checks() {
  local expected="$1" service id running address port body
  for service in server worker; do
    wait_healthy "$service" || return 1
    running="$(image_of "$(container_of "$service")")"
    if [ "$(ak_tag_of "$running")" != "$expected" ]; then
      err "$service runs $running, expected the tag $expected - the host's compose.yml does not take AUTHENTIK_TAG"
      return 1
    fi
  done
  id="$(container_of server)"
  # The first IPv4 binding; awk reads to the end, so no writer is cut off under pipefail.
  address="$(docker port "$id" 9000/tcp | awk '!/^\[/ && !seen++')"
  [ -n "$address" ] || { err "the server publishes no port 9000"; return 1; }
  port="${address##*:}"
  for path in /-/health/live/ /-/health/ready/; do
    if ! curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$port$path"; then
      err "GET $path did not answer 2xx"
      return 1
    fi
  done
  body="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/application/o/$oidc_slug/.well-known/openid-configuration" || true)"
  case "$body" in
    *'"issuer"'*'"authorization_endpoint"'* | *'"authorization_endpoint"'*'"issuer"'*) ;;
    *) err "the OIDC discovery document of '$oidc_slug' is missing or has no issuer"; return 1 ;;
  esac
  log "checks passed: server and worker healthy on $expected, health endpoints and OIDC discovery answer"
}

server_id="$(container_of server)"
worker_id="$(container_of worker)"

if [ "$mode" = health ]; then
  [ -n "$server_id" ] || { err "no running server container"; exit 1; }
  after_checks "$(ak_tag_of "$(image_of "$server_id")")" || exit 1
  exit 0
fi

[ -n "$server_id" ] || { err "no running server container in project $project - the release upgrades a running stack, it never creates one"; exit 1; }
stack_dir="$(label_of "$server_id" com.docker.compose.project.working_dir)"
config_files="$(label_of "$server_id" com.docker.compose.project.config_files)"
env_file="$stack_dir/.env"

# THE ONE PRECONDITION THE OWNER OWES, refused by name rather than skipped.
if [ ! -r "$env_file" ] || [ ! -w "$env_file" ]; then
  err "the runner account ($(id -un)) cannot read and write $project's .env, which compose reads its secrets from and which holds the AUTHENTIK_TAG line this release owns. One-off, on the host: sudo chgrp $(id -gn) <the stack's .env> && sudo chmod 0660 <the stack's .env> (infrastructure/MIGRATION.md, MiConnect). Nothing was changed."
  exit 1
fi

old_server="$(image_of "$server_id")"
old_worker="$(image_of "$worker_id")"
env_before="$(cat "$env_file")"
env_tag="$(printf '%s\n' "$env_before" | ak_env_tag)"
decision="$(ak_decide "$pin" "$old_server" "$old_worker" "$env_tag")"
log "pinned $pin; running server=$old_server worker=${old_worker:-none}; .env tag=${env_tag:-unset} -> $decision"

write_env() { printf '%s\n' "$1" >"$env_file"; } # in place: the inode, owner and mode are kept

case "$decision" in
  noop)
    log "nothing to do"
    exit 0
    ;;
  record)
    write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$pin_tag")"
    log "the stack already runs $pin; the .env line now says so too (nothing restarted)"
    exit 0
    ;;
  refuse:*)
    err "${decision#refuse:}. Nothing was changed."
    exit 1
    ;;
esac

compose_cmd() {
  local args=(--project-name "$project" --project-directory "$stack_dir") f files
  IFS=',' read -r -a files <<<"$config_files"
  for f in "${files[@]}"; do args+=(-f "$f"); done
  docker compose "${args[@]}" "$@"
}
pg_id="$(container_of postgresql)"
[ -n "$pg_id" ] || { err "no running postgresql container - nothing to dump, so nothing is changed"; exit 1; }
migrations() {
  docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM django_migrations"' 2>/dev/null | tr -d '[:space:]' || true
}

# 1. Everything that can fail without touching the stack, first.
log "pulling $pin"
docker pull --quiet "$pin" >/dev/null || { err "cannot pull $pin - nothing was changed"; exit 1; }
images="$(AUTHENTIK_TAG="$pin_tag" compose_cmd config --images)" || { err "docker compose cannot read the stack's configuration - nothing was changed"; exit 1; }
if ! grep -qxF "$pin" <<<"$images"; then
  err "with AUTHENTIK_TAG=$pin_tag, the host's compose would not run $pin (it resolves: $(tr '\n' ' ' <<<"$images")). Its image line must be \${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:\${AUTHENTIK_TAG:-...} and its .env must not set another AUTHENTIK_IMAGE. Nothing was changed."
  exit 1
fi
migrations_before="$(migrations)"
[ -n "$migrations_before" ] || { err "cannot read django_migrations - the database is not answering, nothing is changed"; exit 1; }

# 2. The dump, read back before it is trusted.
umask 077
dump_dir="$dump_root/$project"
mkdir -p "$dump_dir"
dump="$dump_dir/$(date -u +%Y%m%dT%H%M%SZ)-$(ak_tag_of "$old_server")-to-$pin_tag.dump"
log "dumping the database to $dump"
docker exec "$pg_id" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump" ||
  { err "pg_dump failed - nothing is changed"; exit 1; }
entries="$(docker exec -i "$pg_id" pg_restore --list <"$dump" | grep -c '^[0-9]' || true)"
if [ ! -s "$dump" ] || [ "${entries:-0}" -eq 0 ]; then
  err "the dump $dump is empty or unreadable ($entries entries) - nothing is changed"
  exit 1
fi
log "dump: $(wc -c <"$dump") bytes, $entries entries, $migrations_before migrations"

# 3. The change.
rollback() {
  local why="$1" plan after
  after="$(migrations)"
  plan="$(ak_rollback_plan "$migrations_before" "$after")"
  err "$pin failed ($why); rolling back to $old_server - migrations $migrations_before -> ${after:-unreadable}, so: $plan"
  write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$(ak_tag_of "$old_server")")"
  if [ "$plan" = restore ]; then
    compose_cmd stop server worker
    docker exec -i "$pg_id" sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error' <"$dump"
  fi
  compose_cmd up -d --no-deps server worker
  if after_checks "$(ak_tag_of "$old_server")"; then
    err "ROLLED BACK: $project runs $old_server again ($plan). The release fails so the version is looked at; the dump stays at $dump."
    exit 1
  fi
  err "THE ROLLBACK FAILED: $project is not healthy on $old_server. By hand, on the host: the .env line AUTHENTIK_TAG=$(ak_tag_of "$old_server"), the dump $dump restored with pg_restore into a recreated database, then docker compose up -d --no-deps server worker in the stack's directory (docs/wiki/infrastructure/authentik.md)."
  exit 2
}

write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$pin_tag")"
log "recreating server and worker on $pin (postgres keeps running)"
compose_cmd up -d --no-deps server worker || rollback "compose up failed"
after_checks "$pin_tag" || rollback "the checks after the restart failed"

# 4. Only the three newest dumps of this stack are kept: the dump exists for THIS change's rollback,
# and the nightly backup is what keeps history.
find "$dump_dir" -maxdepth 1 -name '*.dump' -type f | sort -r | tail -n +4 | while read -r old; do rm -f -- "$old"; done
log "$project now runs $pin (was $old_server); dump kept at $dump"
