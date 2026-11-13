#!/usr/bin/env bash
#
# Asserts the release's MiConnect deploy (`infrastructure/authentik/deploy-stack.sh`), its decisions
# (`release-lib.sh`) and the daily drift reports (`infrastructure/deploy/image-drift-report.sh`,
# `infrastructure/authentik/blueprint-drift.sh`).
#
# THE DECISIONS ARE PURE FUNCTIONS AND ARE ASSERTED AS SUCH: restart or not (from the running images
# and the `.env` line, never a clock), refuse a downgrade, retag or restore on a rollback, Docker's
# health verdict, the drift verdicts. THE DEPLOY IS DRIVEN AGAINST A FAKE `docker` AND `curl` that
# play a stack: a no-op, a recorded tag, a refused `.env`, an upgrade that passes, one that fails
# before migrating (retag only) and one that fails after (the dump restored). No host, no network.
#
# Run by `make test-ci-scripts` and by CI.
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
root="$(pwd)"

failures=0
checks=0
pass() { checks=$((checks + 1)); echo "  ok   $1"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); echo "  FAIL  $1"; }
eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# shellcheck source-path=SCRIPTDIR
# shellcheck source=../../../infrastructure/authentik/release-lib.sh
. infrastructure/authentik/release-lib.sh
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../../../infrastructure/deploy/image-drift-report.sh
. infrastructure/deploy/image-drift-report.sh
# The report sets `-e` for itself; a test counts failures instead of stopping at the first.
set +e

P=ghcr.io/goauthentik/server:2026.8.5
O=ghcr.io/goauthentik/server:2026.8.0

echo "the pin is read from the repository's compose file, and must be one literal image:"
eq "the repository pins one literal authentik image" "$(ak_pin_image infrastructure/authentik/compose.yml | grep -cE '^ghcr\.io/goauthentik/server:[0-9]+(\.[0-9]+)+$')" 1
# shellcheck disable=SC2016 # a compose file's own `${...}` is the fixture, written literally.
printf 'services:\n  server:\n    image: ${IMG:-x}:${TAG:-1}\n  worker:\n    image: ${IMG:-x}:${TAG:-1}\n' >"$tmp/interp.yml"
if ak_pin_image "$tmp/interp.yml" >/dev/null 2>&1; then fail "an interpolated pin is accepted"; else pass "an interpolated pin is refused (Dependabot cannot read it)"; fi
printf 'services:\n  server:\n    image: a:1\n  worker:\n    image: a:2\n' >"$tmp/split.yml"
if ak_pin_image "$tmp/split.yml" >/dev/null 2>&1; then fail "server and worker on different pins are accepted"; else pass "server and worker on different pins are refused"; fi
eq "a tag is read through a registry port and a digest" "$(ak_tag_of 'reg:5000/a/b:2026.8.5@sha256:ab')" 2026.8.5
eq "an untagged reference has no tag" "$(ak_tag_of 'reg:5000/a/b')" ""

echo "what the release does is decided from what RUNS and what .env says:"
eq "both on the pin, .env agrees: nothing" "$(ak_decide "$P" "$P" "$P" 2026.8.5)" noop
eq "both on the pin, .env says another tag: record the line, restart nothing" "$(ak_decide "$P" "$P" "$P" 2026.8.0)" record
eq "older running: upgrade" "$(ak_decide "$P" "$O" "$O" 2026.8.0)" upgrade
eq "one of two behind: upgrade" "$(ak_decide "$P" "$P" "$O" 2026.8.5)" upgrade
eq "another registry, same version: upgrade (the reference is the pin's)" "$(ak_decide "$P" docker.io/authentik/server:2026.8.5 "$P" 2026.8.5)" upgrade
case "$(ak_decide "$O" "$P" "$P" 2026.8.5)" in refuse:DOWNGRADE*) pass "a newer running version is a refused DOWNGRADE" ;; *) fail "a downgrade is not refused" ;; esac
case "$(ak_decide "$P" "" "" "")" in refuse:*) pass "a stack that is not running is refused, never created" ;; *) fail "an absent stack is not refused" ;; esac
case "$(ak_decide "$P" ghcr.io/goauthentik/server:latest "$P" "")" in refuse:*) pass "a running tag that is not a version is refused" ;; *) fail "an unorderable running tag is not refused" ;; esac
eq "versions order numerically, not as text" "$(ak_version_gt 2026.10.0 2026.8.5 && echo y)" y

echo "the .env line is the release's and nothing else in the file is:"
printf 'PG_PASS=s3cret\nAUTHENTIK_TAG=2026.8.0\nX=1\nAUTHENTIK_TAG="2026.7.0"\n' >"$tmp/env"
eq "the last AUTHENTIK_TAG wins, quotes stripped" "$(ak_env_tag <"$tmp/env")" 2026.7.0
eq "set: one line rewritten in place, duplicates dropped, the rest untouched" "$(ak_env_set_tag 2026.8.5 <"$tmp/env" | tr '\n' '|')" "PG_PASS=s3cret|AUTHENTIK_TAG=2026.8.5|X=1|"
eq "set: appended when absent" "$(printf 'A=1\n' | ak_env_set_tag 2026.8.5 | tr '\n' '|')" "A=1|AUTHENTIK_TAG=2026.8.5|"

echo "a rollback restores the database only when the schema moved or cannot be read:"
eq "no migration ran: retag" "$(ak_rollback_plan 774 774)" retag
eq "migrations ran: restore" "$(ak_rollback_plan 774 777)" restore
eq "the count is unreadable: restore" "$(ak_rollback_plan 774 '')" restore

echo "Docker's verdict decides health, and a crash loop is a failure, not a wait:"
eq "healthy" "$(ak_health_verdict running healthy 0)" healthy
eq "starting is a wait" "$(ak_health_verdict running starting 0)" waiting
case "$(ak_health_verdict running starting 2)" in failed:*) pass "a restart while starting fails" ;; *) fail "a crash loop waits for ever" ;; esac
case "$(ak_health_verdict running unhealthy 0)" in failed:*) pass "unhealthy fails" ;; *) fail "unhealthy does not fail" ;; esac
case "$(ak_health_verdict exited '' 0)" in failed:*) pass "an exited container fails" ;; *) fail "an exited container waits" ;; esac
case "$(ak_health_verdict running '' 0)" in failed:*) pass "no healthcheck at all fails rather than waiting" ;; *) fail "no healthcheck waits" ;; esac

echo "the blueprint drift verdict reads the dry run's change count:"
eq "0 changes: clean" "$(printf '[miconnect-blueprints] applied 50-providers.yaml\n[miconnect-blueprints] 0 change(s)\n' | ak_blueprint_drift_verdict)" clean
eq "2 changes: drift" "$(printf '[miconnect-blueprints] CHANGED x\n[miconnect-blueprints] 2 change(s)\n' | ak_blueprint_drift_verdict)" drift:2
eq "no count: unknown, never clean" "$(printf '[miconnect-blueprints] ERROR boom\n' | ak_blueprint_drift_verdict)" unknown

echo "the image drift report compares the released pins with what runs:"
cat >"$tmp/c.yml" <<'EOF'
services:
  postgres:
    image: postgres:18-alpine@sha256:aa
  garage:
    image: "dxflrs/garage:v2.5.0"
  core-service:
    image: ${REGISTRY:-ghcr.io}/${IMAGE_PREFIX:-emse-students/canari}/core-service:${TAG:-latest}
  server:
    image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${AUTHENTIK_TAG:-2026.8.5}
volumes:
  data:
    image: not-a-service
EOF
eq "third-party pins only, defaults resolved, the repository's own images left out" \
  "$(drift_pins "$tmp/c.yml" | tr '\n' '|')" "postgres postgres:18-alpine@sha256:aa|garage dxflrs/garage:v2.5.0|server ghcr.io/goauthentik/server:2026.8.5|"
drift_pins "$tmp/c.yml" >"$tmp/pins"
printf 'postgres postgres:18-alpine@sha256:aa\ngarage dxflrs/garage:v2.5.0\nserver ghcr.io/goauthentik/server:2026.8.5\ncore-service x\n' >"$tmp/run-ok"
if drift_compare "$tmp/pins" "$tmp/run-ok" >/dev/null; then pass "everything on its pin: no drift"; else fail "a matching estate is reported"; fi
printf 'postgres postgres:16-alpine\ngarage dxflrs/garage:v2.5.0\n' >"$tmp/run-bad"
out="$(drift_compare "$tmp/pins" "$tmp/run-bad")"
st=$?
eq "a drift and an absence fail the report" "$st" 1
eq "the drift names running and pinned" "$(grep -c '^DRIFT postgres running=postgres:16-alpine pinned=postgres:18-alpine@sha256:aa$' <<<"$out")" 1
eq "a pinned service not running is ABSENT" "$(grep -c '^ABSENT server' <<<"$out")" 1

# =================================================================================================
echo "the deploy, against a fake stack:"
S="$tmp/stack"
export S
fake_reset() {
  rm -rf "$S"
  mkdir -p "$S/dir"
  printf 'PG_PASS=s3cret\nAUTHENTIK_TAG=%s\n' "$2" >"$S/dir/.env"
  echo "$1" >"$S/server"
  echo "$1" >"$S/worker"
  echo 774 >"$S/migrations"
  : >"$S/calls"
  : >"$S/broken"
}
docker() {
  echo "$*" >>"$S/calls"
  local envtag
  envtag="$(sed -n 's/^AUTHENTIK_TAG=//p' "$S/dir/.env" | tail -n 1)"
  case "$*" in
    "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=server") [ -s "$S/server" ] && echo server-id ;;
    "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=worker") [ -s "$S/worker" ] && echo worker-id ;;
    "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=postgresql") echo pg-id ;;
    *"{{.Config.Image}}"*) local id="${*: -1}"; cat "$S/${id%-id}" ;;
    *working_dir*) echo "$S/dir" ;;
    *config_files*) echo "$S/dir/compose.yml" ;;
    *State.Status*) echo running ;;
    *State.Health*) if grep -qx "$(sed 's/.*://' "$S/server")" "$S/broken"; then echo unhealthy; else echo healthy; fi ;;
    *RestartCount*) echo 0 ;;
    "port server-id 9000/tcp") echo 127.0.0.1:9000 ;;
    pull*) ;;
    *"compose"*"config --images"*) echo "ghcr.io/goauthentik/server:${AUTHENTIK_TAG:-$envtag}"; echo postgres:18 ;;
    *"compose"*"up -d --no-deps server worker"*)
      local old
      old="$(sed 's/.*://' "$S/server")"
      echo "ghcr.io/goauthentik/server:$envtag" >"$S/server"
      echo "ghcr.io/goauthentik/server:$envtag" >"$S/worker"
      if [ -f "$S/migrate" ] && [ "$old" != "$envtag" ] && [ "$envtag" = 2026.8.5 ]; then echo 777 >"$S/migrations"; fi
      ;;
    *"compose"*"stop server worker"*) echo stopped >>"$S/events" ;;
    *"exec pg-id"*"django_migrations"*) cat "$S/migrations" ;;
    *"exec pg-id"*pg_dump*) echo DUMPDATA ;;
    *"exec -i pg-id pg_restore --list"*) printf ';\n1; TABLE a\n2; TABLE b\n' ;;
    *"exec -i pg-id"*dropdb*) cat >"$S/restored"; echo 774 >"$S/migrations" ;;
    *) echo "unexpected docker $*" >&2; return 1 ;;
  esac
}
curl() { case "$*" in *openid-configuration*) echo '{"issuer":"i","authorization_endpoint":"a"}' ;; esac; }
export -f docker curl

run_deploy() {
  AK_POLL_SECONDS=0 AK_HEALTH_DEADLINE_SECONDS=0 AK_DUMP_DIR="$tmp/dumps" \
    bash infrastructure/authentik/deploy-stack.sh deploy --project miconnect --compose infrastructure/authentik/compose.yml >"$tmp/out" 2>&1
}

pin="$(ak_pin_image infrastructure/authentik/compose.yml)"
pin_tag="$(ak_tag_of "$pin")"

fake_reset "$pin" "$pin_tag"
run_deploy; st=$?
eq "on the pin with .env agreeing: exit 0" "$st" 0
eq "  and nothing is pulled, dumped or recreated" "$(grep -cE '^(pull|compose|exec)' "$S/calls")" 0

fake_reset "$pin" 2026.1.0
run_deploy; st=$?
eq "on the pin with a stale .env line: exit 0" "$st" 0
eq "  the line now names the pin" "$(ak_env_tag <"$S/dir/.env")" "$pin_tag"
eq "  the secrets beside it are untouched" "$(grep -c '^PG_PASS=s3cret$' "$S/dir/.env")" 1
eq "  and nothing restarted" "$(grep -c 'compose.*up' "$S/calls")" 0

fake_reset "$O" 2026.8.0
chmod 0400 "$S/dir/.env"
if [ -w "$S/dir/.env" ]; then
  pass "(skipped: this account can write a 0400 file, so the refused-.env case cannot be played here)"
else
  run_deploy; st=$?
  eq "a .env the runner cannot write: refused, exit 1" "$st" 1
  eq "  naming the one-off command" "$(grep -c 'chmod 0660' "$tmp/out")" 1
  eq "  and nothing touched" "$(grep -cE '^(pull|compose|exec)' "$S/calls")" 0
fi
chmod 0600 "$S/dir/.env"

fake_reset "$O" 2026.8.0; touch "$S/migrate"
run_deploy; st=$?
eq "an upgrade that passes its checks: exit 0" "$st" 0
eq "  runs the pin" "$(cat "$S/server")" "$pin"
eq "  .env names it" "$(ak_env_tag <"$S/dir/.env")" "$pin_tag"
eq "  the database was dumped first" "$(find "$tmp/dumps/miconnect" -name '*-2026.8.0-to-*.dump' | wc -l | tr -d ' ')" 1
eq "  postgres was not recreated (--no-deps server worker)" "$(grep -c 'up -d --no-deps server worker' "$S/calls")" 1
first_dump="$(grep -n 'pg_dump' "$S/calls" | cut -d: -f1)"
first_up="$(grep -n -m 1 'up -d' "$S/calls" | cut -d: -f1)"
if [ "$first_dump" -lt "$first_up" ]; then pass "  the dump is taken before the restart"; else fail "  the restart came before the dump"; fi

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"
run_deploy; st=$?
eq "an upgrade that fails BEFORE migrating: exit 1" "$st" 1
eq "  back on the old tag" "$(cat "$S/server")" "$O"
eq "  .env back on the old tag" "$(ak_env_tag <"$S/dir/.env")" 2026.8.0
eq "  the database was NOT restored (retag)" "$([ -f "$S/restored" ] && echo restored || echo kept)" kept
eq "  and the run says it rolled back" "$(grep -c 'ROLLED BACK' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/migrate"
run_deploy; st=$?
eq "an upgrade that fails AFTER migrating: exit 1" "$st" 1
eq "  the dump was restored" "$(cat "$S/restored" 2>/dev/null)" DUMPDATA
eq "  server and worker were stopped first" "$(cat "$S/events" 2>/dev/null)" stopped
eq "  back on the old tag" "$(cat "$S/server")" "$O"

fake_reset "$pin" "$pin_tag"
echo ghcr.io/goauthentik/server:2099.1.0 >"$S/server"; echo ghcr.io/goauthentik/server:2099.1.0 >"$S/worker"
run_deploy; st=$?
eq "a newer version running: refused, exit 1" "$st" 1
eq "  and nothing touched" "$(grep -cE '^(pull|compose|exec)' "$S/calls")" 0

echo "the blueprint drift report fails on a hand edit and passes on none:"
printf '#!/usr/bin/env bash\necho "[miconnect-blueprints] CHANGED miconnect-mino .redirect_uris"\necho "[miconnect-blueprints] 1 change(s)"\n' >"$tmp/applier-drift"
printf '#!/usr/bin/env bash\necho "[miconnect-blueprints] 0 change(s)"\n' >"$tmp/applier-clean"
bash infrastructure/authentik/blueprint-drift.sh "$tmp/applier-clean" >/dev/null 2>&1
eq "no change: exit 0" "$?" 0
out="$(bash infrastructure/authentik/blueprint-drift.sh "$tmp/applier-drift" 2>&1)"
eq "a change: exit 1" "$?" 1
eq "  the change is printed" "$(grep -c 'CHANGED miconnect-mino' <<<"$out")" 1

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures of $checks checks FAILED"
  exit 1
fi
echo "all $checks checks passed"
cd "$root" || true
