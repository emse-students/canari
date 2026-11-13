#!/usr/bin/env bash
# THE RELEASE DEPLOYS MICONNECT'S VERSION (owner, 2026-11-13: "Pourquoi on a du authentik dans notre
# repo si ce n'est pour ça ?"). A pre-release puts the test stack on the authentik image this tree
# pins, a stable puts production on it - the image of `server` and `worker` in compose.yml, a literal
# Dependabot moves. Until this script, the tag lived only in each stack's `.env` on the host, and
# production ran 2026.8.0 while this repository said 2026.8.5.
#
#   deploy-stack.sh deploy --project <compose project> [--compose <pinning compose.yml>] [--oidc-slug canari]
#   deploy-stack.sh health --project <compose project> [--compose <pinning compose.yml>] [--oidc-slug canari]
#   deploy-stack.sh access --project <compose project>
#
# deploy: decides from the RUNNING images and the `.env` tag line (release-lib.sh, ak_decide) and
#   restarts only when they differ from the pin. Before a change: the image is pulled; compose, in a
#   scrubbed environment, proves it would run the pin AND (dry run, with the tag each container runs)
#   that nothing else differs between the host's files and what runs; the free space is checked, the
#   database dumped and the dump read IN FULL; the migration count is read. Then `.env` is backed up and
#   its line rewritten, and `server` and `worker` alone are recreated (`--no-deps`: postgres keeps
#   running). After: Docker's own health verdict for both, both running the pin, `/-/health/live/`,
#   `/-/health/ready/` and the OIDC discovery document. A failure rolls back - server and worker
#   stopped, the migration count read, the old tag, the dump restored only when the count MOVED - and
#   exits non-zero. The same after-checks also close the no-restart outcomes.
# health: the same after-checks alone, changing nothing (serve-prod runs it after the blueprints).
# access: is the stack's `.env` readable and writable by this account - the precondition, probed
#   read-only by the daily `drift` job so a lost permission is seen before a release meets it.
#
# WHAT IT DOES NOT DEPLOY: the stack's compose.yml and `.env` beyond that one line. The stack's
# directory, compose files and project are read from the running containers' compose labels, so no
# host path is written in this public repository - and none is PRINTED: the job log is public, so the
# dumps are named relative to the dump directory (`<dumps>`, `~/authentik-release-dumps` of the runner
# account), the account is never named, and pg_restore's messages, which can quote rows, go to a 0600
# log beside the dump.
#
# THE RUNNER ACCOUNT MUST READ AND WRITE THE STACK'S `.env` (compose reads its secrets from it), and
# the job REFUSES naming the command when it cannot - infrastructure/MIGRATION.md, "MiConnect".
#
# Exit: 0 done or nothing to do; 1 refused or rolled back (the stack runs what it ran before);
#       2 the rollback itself failed, could not decide, or the run was interrupted mid-change (the
#         stack needs a human NOW - the message says what state it is in and what to do).
# docs/wiki/infrastructure/authentik.md, "The release deploys MiConnect's version".
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
case "$mode" in deploy | health | access) ;; *)
  echo "usage: deploy-stack.sh deploy|health|access --project <name> [--compose <file>] [--oidc-slug <slug>]" >&2
  exit 64
  ;;
esac
[ -n "$project" ] || { echo "::error::--project is required" >&2; exit 64; }

poll_seconds="${AK_POLL_SECONDS:-10}"
# A FLOOR UNDER THE WORST CASE, never the verdict: Docker's healthcheck answers within its start
# period plus three intervals (~4 min for authentik's), and a migration still running extends the
# wait up to here. Reaching this deadline FAILS, it never passes.
deadline_seconds="${AK_HEALTH_DEADLINE_SECONDS:-900}"
dump_root="${AK_DUMP_DIR:-$HOME/authentik-release-dumps}"
# The release's own words go to the job log; nothing here prints `.env` content.
unset AUTHENTIK_TAG AUTHENTIK_IMAGE

log() { echo "[miconnect-deploy:$project] $*"; }
err() { echo "::error title=MiConnect ($project)::$*" >&2; }
# shown <path> - a path under the dump directory as the public log may name it.
shown() { case "$1" in "$dump_root"/*) printf '<dumps>/%s' "${1#"$dump_root"/}" ;; "") printf 'none' ;; *) printf '%s' "$1" ;; esac; }

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

server_id="$(container_of server)"
worker_id="$(container_of worker)"
pg_id="$(container_of postgresql)"

# THE ONE PRECONDITION THE OWNER OWES, refused by name rather than skipped. The account is not named:
# the log is public.
env_file=""
if [ -n "$server_id" ]; then
  stack_dir="$(label_of "$server_id" com.docker.compose.project.working_dir)"
  config_files="$(label_of "$server_id" com.docker.compose.project.config_files)"
  env_file="$stack_dir/.env"
fi
env_access_ok() { [ -n "$env_file" ] && [ -r "$env_file" ] && [ -w "$env_file" ]; }
env_access_refusal="the runner account cannot read and write $project's .env, which compose reads its secrets from and which holds the AUTHENTIK_TAG line this release owns. One-off, on the host: sudo chgrp <the runner account's group> <the stack's .env> && sudo chmod 0660 <the stack's .env> (infrastructure/MIGRATION.md, MiConnect)."

if [ "$mode" = access ]; then
  [ -n "$server_id" ] || { err "no running server container in project $project, so its .env cannot be found"; exit 1; }
  env_access_ok || { err "$env_access_refusal"; exit 1; }
  log "the runner account reads and writes the stack's .env"
  exit 0
fi

pin="$(ak_pin_image "$compose")" || { err "cannot read the pinned image from $compose"; exit 1; }
pin_tag="$(ak_tag_of "$pin")"

# migrations - django_migrations' row count, or empty when it cannot be read.
migrations() {
  [ -n "$pg_id" ] || return 0
  docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM django_migrations"' 2>/dev/null | tr -d '[:space:]' || true
}

# wait_healthy <service> - Docker's verdict, polled until it is one (ak_health_verdict). The migration
# count is read on every poll: while it still rises, `unhealthy` is a wait, not a verdict.
wait_healthy() {
  local service="$1" waited=0 id verdict count previous migrating
  previous="$(migrations)"
  while :; do
    id="$(container_of "$service")"
    count="$(migrations)"
    migrating=no
    if ak_migrations_rising "$previous" "$count"; then migrating=yes; fi
    previous="$count"
    if [ -z "$id" ]; then
      verdict="failed:no running container"
    else
      verdict="$(ak_health_verdict \
        "$(docker inspect -f '{{.State.Status}}' "$id")" \
        "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" \
        "$(docker inspect -f '{{.RestartCount}}' "$id")" \
        "$migrating")"
    fi
    case "$verdict" in
      healthy) log "$service healthy"; return 0 ;;
      failed:*) err "$service: ${verdict#failed:}"; return 1 ;;
    esac
    [ "$migrating" = yes ] && log "$service: migrations still running ($count applied), waiting"
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
  # The first IPv4 binding; awk reads to the end, so no writer is cut off under pipefail. Its PORT is
  # asked on loopback: the stacks publish on 127.0.0.1 (a binding on another address fails here,
  # loudly, rather than being probed somewhere else).
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

if [ "$mode" = health ]; then
  [ -n "$server_id" ] || { err "no running server container"; exit 1; }
  after_checks "$(ak_tag_of "$(image_of "$server_id")")" || exit 1
  exit 0
fi

[ -n "$server_id" ] || { err "no running server container in project $project - the release upgrades a running stack, it never creates one"; exit 1; }
env_access_ok || { err "$env_access_refusal Nothing was changed."; exit 1; }

old_server="$(image_of "$server_id")"
old_worker="$(image_of "$worker_id")"
old_tag="$(ak_tag_of "$old_server")"
env_before="$(cat "$env_file")"
env_tag="$(printf '%s\n' "$env_before" | ak_env_tag)"
decision="$(ak_decide "$pin" "$old_server" "$old_worker" "$env_tag")"
log "pinned $pin; running server=$old_server worker=${old_worker:-none}; .env tag=${env_tag:-unset} -> $decision"

# EVERY FILE THIS RUN WRITES (dump, `.env` backup, logs) is the runner's, mode 0600, in a 0700 tree.
umask 077
dump_dir="$dump_root/$project"
mkdir -p "$dump_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump=""
env_backup=""
migrations_before=""

# WHAT AN INTERRUPTION LEAVES, said rather than discovered. `phase` is what a signal finds: before
# `changing`, nothing was touched; after it, the stack may be half-way and a human takes it.
phase=preflight
manual_steps() {
  echo "By hand, on the host, in the stack's directory: (1) the .env as it was is $(shown "$env_backup") - put it back, or set the line AUTHENTIK_TAG=$old_tag; (2) ONLY if django_migrations no longer counts ${migrations_before:-<unread>} rows: server and worker stopped, the database dropped, recreated and restored from $(shown "$dump") with pg_restore; (3) docker compose up -d --no-deps server worker (docs/wiki/infrastructure/authentik.md, 'When the rollback fails')."
}
state_now() {
  local tag s w
  tag="$( (ak_env_tag <"$env_file") 2>/dev/null || true)"
  s="$( (image_of "$(container_of server)") 2>/dev/null || true)"
  w="$( (image_of "$(container_of worker)") 2>/dev/null || true)"
  echo ".env names ${tag:-?}; server runs ${s:-nothing}; worker runs ${w:-nothing}"
}
on_signal() {
  trap '' INT TERM
  if [ "$phase" = preflight ]; then
    err "interrupted ($1) before any change - nothing was changed. The dump, if taken: $(shown "$dump")"
    exit 1
  fi
  err "INTERRUPTED ($1) during $phase: $(state_now). $(manual_steps)"
  exit 2
}
arm_traps() { trap 'on_signal INT' INT; trap 'on_signal TERM' TERM; }
arm_traps

# backup_env - a byte-for-byte copy of `.env`, 0600, beside the dumps; read back before it is trusted.
backup_env() {
  env_backup="$dump_dir/$stamp-$project.env"
  if ! cp -- "$env_file" "$env_backup" || ! cmp -s -- "$env_file" "$env_backup"; then
    err "the .env could not be backed up to $(shown "$env_backup") - nothing was changed"
    exit 1
  fi
}

# write_env <content> - the new `.env`, verified. Not a rename: the stack's directory is not the
# runner's to write, and a rename would hand the file to the runner account; the file is rewritten IN
# PLACE (inode, owner, mode kept) from a temporary copy that is complete before the one write, the
# write is read back byte for byte, and signals are ignored while it happens.
#   0 written; 1 not written and the file is the backup again; 2 neither (the file is damaged).
write_env() {
  local tmp rc=0
  tmp="$(mktemp "$dump_dir/.env-next.XXXXXX")" || return 1
  if ! printf '%s\n' "$1" >"$tmp"; then rm -f -- "$tmp"; return 1; fi
  trap '' INT TERM
  { cat -- "$tmp" >"$env_file"; } 2>/dev/null && cmp -s -- "$tmp" "$env_file" || rc=1
  if [ "$rc" -ne 0 ]; then
    { cat -- "$env_backup" >"$env_file"; } 2>/dev/null && cmp -s -- "$env_backup" "$env_file" || rc=2
  fi
  rm -f -- "$tmp"
  arm_traps
  return "$rc"
}

case "$decision" in
  noop)
    log "nothing to restart"
    after_checks "$pin_tag" || { err "$project runs $pin, but its checks fail - this run changed nothing"; exit 1; }
    exit 0
    ;;
  record)
    backup_env
    st=0
    write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$pin_tag")" || st=$?
    case "$st" in
      0) ;;
      1) err "the .env line could not be written; the file is as it was - nothing was changed"; exit 1 ;;
      *) err "the .env could not be written NOR put back: compose will misread the stack's secrets on its next start. Put $(shown "$env_backup") back by hand."; exit 2 ;;
    esac
    log "the stack already runs $pin; the .env line now says so too (nothing restarted)"
    after_checks "$pin_tag" || { err "$project runs $pin, but its checks fail - this run restarted nothing"; exit 1; }
    exit 0
    ;;
  refuse:*)
    err "${decision#refuse:}. Nothing was changed."
    exit 1
    ;;
esac

# compose_cmd [AUTHENTIK_TAG=<tag>] <compose arguments> - docker compose on this stack's files, in a
# SCRUBBED environment: compose lets the caller's environment override `.env`, so a runner exporting
# PG_PASS, POSTGRES_* or AUTHENTIK_* would leak into what it renders and starts. Only the variables
# the docker CLI itself needs pass, and the tag when one is given.
compose_cmd() {
  local envs=("PATH=$PATH" "HOME=$HOME") args=(--project-name "$project" --project-directory "$stack_dir") f files v
  case "${1:-}" in AUTHENTIK_TAG=*) envs+=("$1"); shift ;; esac
  for v in DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY XDG_RUNTIME_DIR; do
    if [ -n "${!v:-}" ]; then envs+=("$v=${!v}"); fi
  done
  IFS=',' read -r -a files <<<"$config_files"
  for f in "${files[@]}"; do args+=(-f "$f"); done
  env -i "${envs[@]}" docker compose "${args[@]}" "$@"
}
[ -n "$pg_id" ] || { err "no running postgresql container - nothing to dump, so nothing is changed"; exit 1; }

# 1. Everything that can fail without touching the stack, first.
log "pulling $pin"
docker pull --quiet "$pin" >/dev/null || { err "cannot pull $pin - nothing was changed"; exit 1; }
images="$(compose_cmd "AUTHENTIK_TAG=$pin_tag" config --images)" || { err "docker compose cannot read the stack's configuration - nothing was changed"; exit 1; }
if ! grep -qxF "$pin" <<<"$images"; then
  err "with AUTHENTIK_TAG=$pin_tag, the host's compose would not run $pin (it resolves: $(tr '\n' ' ' <<<"$images")). Its image line must be \${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:\${AUTHENTIK_TAG:-...} and its .env must not set another AUTHENTIK_IMAGE. Nothing was changed."
  exit 1
fi
# THE UP CHANGES THE TAG AND NOTHING ELSE: asked with the tag each container already runs, compose's
# own dry run must leave both RUNNING. Its comparison is the one `up` makes (the config-hash label);
# `config --hash` is not, measured 2026-11-13 on the host's compose 2.26.1, where it differed from the
# label even for an untouched container.
for service in server worker; do
  running_tag="$(ak_tag_of "$(image_of "$(container_of "$service")")")"
  plan="$(compose_cmd "AUTHENTIK_TAG=$running_tag" --dry-run up -d --no-deps --pull never "$service" 2>&1)" ||
    { err "docker compose's dry run of $service failed - nothing was changed"; exit 1; }
  if ak_dry_run_recreates <<<"$plan"; then
    err "with the tag $service already runs ($running_tag), compose would still recreate it: the host's compose file or .env differ from what runs, and the upgrade would apply that difference too. Recreate the stack on its current version by hand first (docker compose up -d in its directory), or bring its files back to what runs. Nothing was changed."
    exit 1
  fi
done
migrations_before="$(migrations)"
[[ "$migrations_before" =~ ^[0-9]+$ ]] || { err "cannot read django_migrations - the database is not answering, nothing is changed"; exit 1; }

# 2. The dump: room for it first, then read back IN FULL before it is trusted.
db_bytes="$(docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT pg_database_size(current_database())"' 2>/dev/null | tr -d '[:space:]' || true)"
avail_kb="$(df -Pk "$dump_dir" | awk 'NR == 2 { print $4 }')"
if ! ak_space_ok "$db_bytes" "$avail_kb"; then
  err "no room for the dump: the database is ${db_bytes:-?} bytes and the dump directory has ${avail_kb:-?} KiB free (twice the database is asked) - nothing is changed"
  exit 1
fi
dump="$dump_dir/$stamp-$old_tag-to-$pin_tag.dump"
restore_log="$dump_dir/$stamp-pg.log"
log "dumping the database to $(shown "$dump")"
docker exec "$pg_id" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump" 2>"$restore_log" ||
  { err "pg_dump failed (its messages: $(shown "$restore_log")) - nothing is changed"; exit 1; }
entries="$(docker exec -i "$pg_id" pg_restore --list <"$dump" 2>>"$restore_log" | grep -c '^[0-9]' || true)"
if [ ! -s "$dump" ] || [ "${entries:-0}" -eq 0 ]; then
  err "the dump $(shown "$dump") is empty or its table of contents unreadable ($entries entries) - nothing is changed"
  exit 1
fi
# The table of contents proves the header; this reads every data block, as a restore would.
if ! docker exec -i "$pg_id" pg_restore -f /dev/null <"$dump" 2>>"$restore_log"; then
  err "the dump $(shown "$dump") does not read back in full (pg_restore's messages: $(shown "$restore_log")) - nothing is changed"
  exit 1
fi
log "dump: $(wc -c <"$dump") bytes, $entries entries, read back in full; $migrations_before migrations"
backup_env

# 3. The change.
rollback_failed() {
  err "THE ROLLBACK FAILED: $1. State: $(state_now). $(manual_steps)"
  exit 2
}

# rollback <why> - never dies on its own: every step is checked, and any failure ends at
# rollback_failed (exit 2) with the state and the hand procedure. `set -e` would otherwise kill it
# with status 1, which says "the stack runs what it ran before".
rollback() {
  set +e
  local why="$1" plan after st
  phase=rollback
  err "$pin failed ($why); rolling back to $old_server"
  # STOPPED BEFORE THE COUNT IS READ, so nothing is still migrating while it is.
  compose_cmd stop server worker || rollback_failed "server and worker could not be stopped"
  after="$(migrations)"
  plan="$(ak_rollback_plan "$migrations_before" "$after")"
  log "migrations $migrations_before -> ${after:-unreadable}: $plan"
  if [ "$plan" = unknown ]; then
    rollback_failed "the migration count cannot be read, so whether the schema moved is unknown and nothing is restored on a guess; server and worker are STOPPED"
  fi
  write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$old_tag")"
  st=$?
  [ "$st" -eq 0 ] || rollback_failed "the .env line could not be put back on $old_tag"
  if [ "$plan" = restore ]; then
    phase=restore
    trap '' INT TERM
    docker exec -i "$pg_id" sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error' <"$dump" >>"$restore_log" 2>&1
    st=$?
    arm_traps
    phase=rollback
    [ "$st" -eq 0 ] || rollback_failed "the dump could not be restored (pg_restore's messages, which can quote rows, are in $(shown "$restore_log"))"
  fi
  compose_cmd up -d --no-deps server worker || rollback_failed "compose could not start server and worker on $old_server"
  if after_checks "$old_tag"; then
    err "ROLLED BACK: $project runs $old_server again ($plan). The release fails so the version is looked at; the dump stays at $(shown "$dump")."
    exit 1
  fi
  rollback_failed "$project is not healthy on $old_server"
}

phase=changing
st=0
write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$pin_tag")" || st=$?
case "$st" in
  0) ;;
  1) err "the .env line could not be written; the file is as it was - nothing was changed"; exit 1 ;;
  *) rollback_failed "the .env could not be written NOR put back" ;;
esac
log "recreating server and worker on $pin (postgres keeps running)"
compose_cmd up -d --no-deps server worker || rollback "compose up failed"
after_checks "$pin_tag" || rollback "the checks after the restart failed"
phase=finished

# 4. Only the three newest of each kind are kept: the dump exists for THIS change's rollback, and the
# nightly backup is what keeps history.
for kind in dump env log; do
  find "$dump_dir" -maxdepth 1 -name "*.$kind" -type f | sort -r | tail -n +4 | while read -r old; do rm -f -- "$old"; done
done
log "$project now runs $pin (was $old_server); dump kept at $(shown "$dump")"
