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
#   deploy-stack.sh prune  --project <compose project>
#
# deploy: decides from the RUNNING images and the `.env` tag line (release-lib.sh, ak_decide) and
#   restarts only when they differ from the pin. Before a change: the image is pulled; compose, in a
#   scrubbed environment, proves it would run the pin AND (dry run, with the tag each container runs)
#   that nothing else differs between the host's files and what runs; the free space is checked, the
#   database dumped and the dump read IN FULL; the database's state is read (db_state: Django's
#   migration count AND authentik's own version row, which its system migrations add). Then `.env` is backed up and
#   its line rewritten, and `server` and `worker` alone are recreated (`--no-deps`: postgres keeps
#   running). After: Docker's own health verdict for both, both running the pin, `/-/health/live/`,
#   `/-/health/ready/` and the OIDC discovery document. A failure rolls back - server and worker
#   stopped, the state read again, the old tag, the dump restored only when the state MOVED - and
#   exits non-zero. The same after-checks also close the no-restart outcomes.
# health: the same after-checks alone, changing nothing (serve-prod runs it after the blueprints).
# access: is the stack's `.env` readable and writable by this account - the precondition, probed
#   read-only by the daily `drift` job so a lost permission is seen before a release meets it.
# prune: the retention alone (owner, 2026-11-19: "3 copies et 30 jours au plus"): per kind, the three
#   newest copies and none taken more than 30 days ago (release-lib.sh, ak_prune_select). The deploy
#   prunes on every outcome that keeps the stack (no-op, record, upgrade); the daily `drift` job
#   prunes too, so a copy expires on time when no release comes.
#
# WHAT IT DOES NOT DEPLOY: the stack's compose.yml and `.env` beyond that one line. The stack's
# directory, compose files and project are read from the running containers' compose labels, so no
# host path is written in this public repository - and none is PRINTED: the job log is public, so the
# dumps are named relative to the dump directory (`<dumps>`, `~/authentik-release-dumps` of the runner
# account), the account is never named, pg_restore's messages, which can quote rows, go to a 0600
# log beside the dump, and so do docker compose's, which name the stack's files by their host path.
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
case "$mode" in deploy | health | access | prune) ;; *)
  echo "usage: deploy-stack.sh deploy|health|access|prune --project <name> [--compose <file>] [--oidc-slug <slug>]" >&2
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
# THE ONE READ OF THE CLOCK: it names this run's copies and is the "now" their age is measured from.
# AK_NOW (a stamp) replaces it in the tests, which never assert a wall clock.
now_stamp="${AK_NOW:-$(date -u +%Y%m%dT%H%M%SZ)}"
# The owner's bound on the rollback copies (2026-11-19), which hold every MiConnect account.
keep_copies=3
max_copy_days=30
# The release's own words go to the job log; nothing here prints `.env` content.
unset AUTHENTIK_TAG AUTHENTIK_IMAGE

log() { echo "[miconnect-deploy:$project] $*"; }
err() { echo "::error title=MiConnect ($project)::$*" >&2; }
# shown <path> - a path under the dump directory as the public log may name it.
shown() { case "$1" in "$dump_root"/*) printf '<dumps>/%s' "${1#"$dump_root"/}" ;; "") printf 'none' ;; *) printf '%s' "$1" ;; esac; }

# prune_copies - deletes this stack's rollback copies beyond the owner's bound (ak_prune_select
# decides, from the stamp in each name; only the names this script writes are candidates).
prune_copies() {
  local dir="$dump_root/$project" doomed name n=0
  [ -d "$dir" ] || { log "rollback copies: none kept for $project"; return 0; }
  doomed="$(find "$dir" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | ak_prune_select "$now_stamp" "$keep_copies" "$max_copy_days")" ||
    { err "the rollback copies of $project could not be listed, so none was pruned"; return 1; }
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -f -- "${dir:?}/$name" 2>/dev/null || { err "the rollback copy $(shown "$dir/$name") could not be deleted"; return 1; }
    n=$((n + 1))
  done <<<"$doomed"
  log "rollback copies: $n deleted (kept: the $keep_copies newest of each kind, none older than $max_copy_days days)"
}

if [ "$mode" = prune ]; then
  prune_copies || exit 1
  exit 0
fi

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
image_of() { if [ -n "$1" ]; then docker inspect -f '{{.Config.Image}}' "$1" || true; fi; }
label_of() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }

server_id="$(container_of server)"
worker_id="$(container_of worker)"
pg_id="$(container_of postgresql)"

# DOCKER'S RestartCount IS CUMULATIVE over a container's life, so a restart weeks ago would fail every
# later check. What judges THIS run is the increase from the count each container had when the run
# began; a container this run creates has a new id, and starts from 0.
declare -A restarts_at_start=()
restart_count() { docker inspect -f '{{.RestartCount}}' "$1"; }
for id in $server_id $worker_id; do restarts_at_start[$id]="$(restart_count "$id" || true)"; done

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

# migrations - django_migrations' row count, or empty when it cannot be read. What the health wait
# watches rise while a migration runs.
migrations() {
  [ -n "$pg_id" ] || return 0
  docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM django_migrations"' 2>/dev/null | tr -d '[:space:]' || true
}

# db_state - `<django_migrations rows>:<newest authentik_version_history id>`, or empty when either
# cannot be read. Whether the DATABASE moved (ak_rollback_plan): authentik's system migrations
# (lifecycle/migrate.py) run before Django's and, on a new version, add a version row - a release that
# reached them and no further changed the database without moving the Django count. chr(58) is `:`,
# spelled so to stay out of the shell's quoting.
db_state() {
  [ -n "$pg_id" ] || return 0
  docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT count(*) FROM django_migrations)::text || chr(58) || COALESCE((SELECT max(id) FROM authentik_version_history), 0)::text"' 2>/dev/null | tr -d '[:space:]' || true
}

# restarts_since_start <id> - how many times the container restarted during this run, or `unreadable`
# (which ak_health_verdict fails on, as it is not 0).
restarts_since_start() {
  local now base="${restarts_at_start[$1]:-0}"
  now="$(restart_count "$1" || true)"
  if [[ "$now" =~ ^[0-9]+$ ]] && [[ "$base" =~ ^[0-9]+$ ]]; then echo $((now - base)); else echo unreadable; fi
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
        "$(restarts_since_start "$id")" \
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
env_before="$(cat -- "$env_file" 2>/dev/null)" || { err "the stack's .env could not be read - nothing was changed"; exit 1; }
env_tag="$(printf '%s\n' "$env_before" | ak_env_tag)"
decision="$(ak_decide "$pin" "$old_server" "$old_worker" "$env_tag")"
log "pinned $pin; running server=$old_server worker=${old_worker:-none}; .env tag=${env_tag:-unset} -> $decision"

# EVERY FILE THIS RUN WRITES (dump, `.env` backup, logs) is the runner's, mode 0600, in a 0700 tree.
umask 077
dump_dir="$dump_root/$project"
mkdir -p -- "$dump_dir" 2>/dev/null || { err "the dump directory <dumps>/$project could not be created - nothing was changed"; exit 1; }
stamp="$now_stamp"
dump=""
env_backup=""
state_before=""
# THE RUN'S PRIVATE LOG: docker compose's own messages and those of the file tools (cp, df, the
# dump's redirection) name the stack's files by their HOST path: they go here, 0600, and the public
# log names this file as `<dumps>/...` (shown).
compose_log="$dump_dir/$stamp-compose.log"

# WHAT AN INTERRUPTION LEAVES, said rather than discovered. `phase` is what a signal finds: before
# `changing`, nothing was touched; after it, the stack may be half-way and a human takes it.
phase=preflight
manual_steps() {
  echo "By hand, on the host, in the stack's directory: (1) the .env as it was is $(shown "$env_backup") - put it back, or set the line AUTHENTIK_TAG=$old_tag; (2) ONLY if the database moved - django_migrations' row count and authentik_version_history's newest id no longer read ${state_before:-<unread>} (count:id): server and worker stopped, the database dropped, recreated and restored from $(shown "$dump") with pg_restore; (3) docker compose up -d --no-deps server worker (docs/wiki/infrastructure/authentik.md, 'When the rollback fails')."
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
  if [ "$phase" = record ]; then
    err "INTERRUPTED ($1) while the .env line was being set to the tag the stack already runs, nothing restarted: $(state_now). The .env as it was is $(shown "$env_backup"); check the stack answers (deploy-stack.sh health)."
    exit 2
  fi
  err "INTERRUPTED ($1) during $phase: $(state_now). $(manual_steps)"
  exit 2
}
arm_traps() { trap 'on_signal INT' INT; trap 'on_signal TERM' TERM; }
arm_traps

# backup_env - a byte-for-byte copy of `.env`, 0600, beside the dumps; read back before it is trusted.
backup_env() {
  env_backup="$dump_dir/$stamp-$project.env"
  if ! cp -- "$env_file" "$env_backup" 2>>"$compose_log" || ! cmp -s -- "$env_file" "$env_backup"; then
    err "the .env could not be backed up to $(shown "$env_backup") (the messages: $(shown "$compose_log")) - nothing was changed"
    exit 1
  fi
}

# write_env <content> - the new `.env`, verified. Not a rename: the stack's directory is not the
# runner's to write, and a rename would hand the file to the runner account; the file is rewritten IN
# PLACE (inode, owner, mode kept) from a temporary copy that is complete before the one write, the
# write is read back byte for byte, and signals are ignored while it happens.
#   0 written; 1 not written and the file is the BACKUP again (byte for byte the `.env` before this
#   run); 2 neither (the file is damaged).
# EVERY failure ends on the backup, the temporary copy's included: a 1 that left the file untouched
# would mean "as before this run" in the change and "still on the failed tag" in the rollback.
# Their messages name host paths, so they are not relayed to the public log.
write_env() {
  local tmp="" rc=0
  trap '' INT TERM
  if tmp="$(mktemp "$dump_dir/$stamp-env-next.XXXXXX" 2>/dev/null)" &&
    { printf '%s\n' "$1" >"$tmp"; } 2>/dev/null &&
    { cat -- "$tmp" >"$env_file"; } 2>/dev/null &&
    cmp -s -- "$tmp" "$env_file"; then
    :
  else
    rc=1
    { cat -- "$env_backup" >"$env_file"; } 2>/dev/null && cmp -s -- "$env_backup" "$env_file" || rc=2
  fi
  [ -z "$tmp" ] || rm -f -- "$tmp"
  arm_traps
  return "$rc"
}

case "$decision" in
  noop)
    log "nothing to restart"
    after_checks "$pin_tag" || { err "$project runs $pin, but its checks fail - this run changed nothing"; exit 1; }
    prune_copies || err "the retention failed (above); the daily drift job's prune fails red until it is fixed"
    exit 0
    ;;
  keep-newer:*)
    echo "::warning title=MiConnect ($project)::$project runs authentik ${decision#keep-newer:}, NEWER than the pin $pin_tag of this release - left untouched (authentik's migrations do not run backwards; a rerun of an older release, or of one whose estate deploy failed, meets exactly this). The release goes on; pin ${decision#keep-newer:} or newer again on main."
    after_checks "${decision#keep-newer:}" || { err "$project runs authentik ${decision#keep-newer:} (newer than the pin) and its checks fail - this run changed nothing"; exit 1; }
    prune_copies || err "the retention failed (above); the daily drift job's prune fails red until it is fixed"
    exit 0
    ;;
  record)
    backup_env
    phase=record
    st=0
    write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$pin_tag")" || st=$?
    case "$st" in
      0) ;;
      1) err "the .env line could not be written; the file is as it was - nothing was changed"; exit 1 ;;
      *) err "the .env could not be written NOR put back: compose will misread the stack's secrets on its next start. Put $(shown "$env_backup") back by hand."; exit 2 ;;
    esac
    log "the stack already runs $pin; the .env line now says so too (nothing restarted)"
    after_checks "$pin_tag" || { err "$project runs $pin, but its checks fail - this run restarted nothing"; exit 1; }
    prune_copies || err "the retention failed (above); the daily drift job's prune fails red until it is fixed"
    exit 0
    ;;
  refuse:*)
    err "${decision#refuse:}. Nothing was changed."
    exit 1
    ;;
esac

# compose_cmd [--log | --errlog] [AUTHENTIK_TAG=<tag>] <compose arguments> - docker compose on this
# stack's files, in a SCRUBBED environment: compose lets the caller's environment override `.env`, so
# a runner exporting PG_PASS, POSTGRES_* or AUTHENTIK_* would leak into what it renders and starts.
# Only the variables the docker CLI itself needs pass, and the tag when one is given.
# --log sends compose's output and messages, --errlog its messages only, to the 0600 compose log:
# they name the stack's files by their host path, and the job log is public. THE REDIRECTION IS ON
# THE DOCKER COMMAND ITSELF, never on a call of this function: a signal's trap runs inside the
# redirections of the command it interrupts, and the INT/TERM report must reach the job log.
compose_cmd() {
  local envs=("PATH=$PATH" "HOME=$HOME") args=(--project-name "$project" --project-directory "$stack_dir") f files v to=""
  case "${1:-}" in --log | --errlog) to="$1"; shift ;; esac
  case "${1:-}" in AUTHENTIK_TAG=*) envs+=("$1"); shift ;; esac
  for v in DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY XDG_RUNTIME_DIR; do
    if [ -n "${!v:-}" ]; then envs+=("$v=${!v}"); fi
  done
  IFS=',' read -r -a files <<<"$config_files"
  for f in "${files[@]}"; do args+=(-f "$f"); done
  case "$to" in
    --log) env -i "${envs[@]}" docker compose "${args[@]}" "$@" >>"$compose_log" 2>&1 ;;
    --errlog) env -i "${envs[@]}" docker compose "${args[@]}" "$@" 2>>"$compose_log" ;;
    *) env -i "${envs[@]}" docker compose "${args[@]}" "$@" ;;
  esac
}
[ -n "$pg_id" ] || { err "no running postgresql container - nothing to dump, so nothing is changed"; exit 1; }

# 1. Everything that can fail without touching the stack, first.
log "pulling $pin"
docker pull --quiet "$pin" >/dev/null || { err "cannot pull $pin - nothing was changed"; exit 1; }
images="$(compose_cmd --errlog "AUTHENTIK_TAG=$pin_tag" config --images)" ||
  { err "docker compose cannot read the stack's configuration (its messages: $(shown "$compose_log")) - nothing was changed"; exit 1; }
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
  st=0
  plan="$(compose_cmd "AUTHENTIK_TAG=$running_tag" --dry-run up -d --no-deps --pull never "$service" 2>&1)" || st=$?
  printf '%s\n' "$plan" >>"$compose_log"
  [ "$st" -eq 0 ] || { err "docker compose's dry run of $service failed (its messages: $(shown "$compose_log")) - nothing was changed"; exit 1; }
  if ak_dry_run_recreates <<<"$plan"; then
    err "with the tag $service already runs ($running_tag), compose would still recreate it: the host's compose file or .env differ from what runs, and the upgrade would apply that difference too. Recreate the stack on its current version by hand first (docker compose up -d in its directory), or bring its files back to what runs. Nothing was changed."
    exit 1
  fi
done
state_before="$(db_state)"
[[ "$state_before" =~ ^[0-9]+:[0-9]+$ ]] ||
  { err "cannot read django_migrations and authentik_version_history - the database is not answering, or is not an authentik database of a version this release knows; nothing is changed"; exit 1; }

# 2. The dump: room for it first, then read back IN FULL before it is trusted.
db_bytes="$(docker exec "$pg_id" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT pg_database_size(current_database())"' 2>/dev/null | tr -d '[:space:]' || true)"
avail_kb="$(df -Pk "$dump_dir" 2>>"$compose_log" | awk 'NR == 2 { print $4 }')"
if ! ak_space_ok "$db_bytes" "$avail_kb"; then
  err "no room for the dump: the database is ${db_bytes:-?} bytes and the dump directory has ${avail_kb:-?} KiB free (twice the database is asked) - nothing is changed"
  exit 1
fi
dump="$dump_dir/$stamp-$old_tag-to-$pin_tag.dump"
restore_log="$dump_dir/$stamp-pg.log"
log "dumping the database to $(shown "$dump")"
# THE REDIRECTIONS ARE INSIDE THE BRACES, so bash's own message when one fails (it names the host
# path) reaches the private log too.
{ docker exec "$pg_id" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$dump"; } 2>"$restore_log" ||
  { err "pg_dump failed (its messages: $(shown "$restore_log")) - nothing is changed"; exit 1; }
entries="$({ docker exec -i "$pg_id" pg_restore --list <"$dump"; } 2>>"$restore_log" | grep -c '^[0-9]' || true)"
if [ ! -s "$dump" ] || [ "${entries:-0}" -eq 0 ]; then
  err "the dump $(shown "$dump") is empty or its table of contents unreadable ($entries entries) - nothing is changed"
  exit 1
fi
# The table of contents proves the header; this reads every data block, as a restore would.
if ! { docker exec -i "$pg_id" pg_restore -f /dev/null <"$dump"; } 2>>"$restore_log"; then
  err "the dump $(shown "$dump") does not read back in full (pg_restore's messages: $(shown "$restore_log")) - nothing is changed"
  exit 1
fi
log "dump: $(wc -c <"$dump") bytes, $entries entries, read back in full; database state $state_before (migrations:version row)"
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
  # STOPPED BEFORE THE STATE IS READ, so nothing is still migrating while it is.
  compose_cmd --log stop server worker ||
    rollback_failed "server and worker could not be stopped (compose's messages: $(shown "$compose_log"))"
  after="$(db_state)"
  plan="$(ak_rollback_plan "$state_before" "$after")"
  log "database state (migrations:version row) $state_before -> ${after:-unreadable}: $plan"
  if [ "$plan" = unknown ]; then
    rollback_failed "the database's state cannot be read, so whether it moved is unknown and nothing is restored on a guess; server and worker are STOPPED"
  fi
  write_env "$(printf '%s\n' "$env_before" | ak_env_set_tag "$old_tag")"
  st=$?
  case "$st" in
    0) ;;
    # WRITTEN BACK, by the other route: the file is byte for byte the .env before this run. Compose is
    # handed the old tag below either way, so the start does not depend on which route wrote it.
    1) err "the .env line could not be rewritten to $old_tag, so the .env was put back byte for byte as it was before this run ($(shown "$env_backup"))" ;;
    *) rollback_failed "the .env could not be put back on $old_tag NOR restored from $(shown "$env_backup")" ;;
  esac
  if [ "$plan" = restore ]; then
    phase=restore
    trap '' INT TERM
    { docker exec -i "$pg_id" sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error' <"$dump"; } >>"$restore_log" 2>&1
    st=$?
    arm_traps
    phase=rollback
    [ "$st" -eq 0 ] || rollback_failed "the dump could not be restored (pg_restore's messages, which can quote rows, are in $(shown "$restore_log"))"
  fi
  compose_cmd --log "AUTHENTIK_TAG=$old_tag" up -d --no-deps server worker ||
    rollback_failed "compose could not start server and worker on $old_server (its messages: $(shown "$compose_log"))"
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
compose_cmd --log up -d --no-deps server worker || rollback "compose up failed (its messages: $(shown "$compose_log"))"
after_checks "$pin_tag" || rollback "the checks after the restart failed"
phase=finished

# 4. The owner's bound: three of each kind and none older than 30 days. The dump exists for THIS
# change's rollback, and the nightly backup is what keeps history.
prune_copies || err "the retention failed (above); the daily drift job's prune fails red until it is fixed"
log "$project now runs $pin (was $old_server); dump kept at $(shown "$dump")"
