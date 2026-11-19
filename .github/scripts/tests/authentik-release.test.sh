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
# before migrating (retag only), one that fails after Django's migrations or after authentik's own
# system migrations alone (the dump restored), a `.env` put back by its backup during a rollback,
# compose messages that name host paths, and the retention of the copies. No host, no network, no
# clock: "now" is injected (AK_NOW).
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
printf 'services:\n  server:\n    image: g/s:2026.8.5@sha256:ab\n  worker:\n    image: g/s:2026.8.5@sha256:ab\n' >"$tmp/digest.yml"
if ak_pin_image "$tmp/digest.yml" >/dev/null 2>&1; then fail "a digest pin is accepted"; else pass "a digest pin is refused (the host's compose builds the reference from the tag alone)"; fi
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
eq "an 'export AUTHENTIK_TAG=' line is read" "$(printf 'A=1\nexport AUTHENTIK_TAG=2026.8.0\n' | ak_env_tag)" 2026.8.0
eq "  and rewritten in place, its export kept, never duplicated" "$(printf 'A=1\nexport AUTHENTIK_TAG=2026.8.0\n' | ak_env_set_tag 2026.8.5 | tr '\n' '|')" "A=1|export AUTHENTIK_TAG=2026.8.5|"
eq "a variable merely ending in AUTHENTIK_TAG is not the line" "$(printf 'OLD_AUTHENTIK_TAG=1\n' | ak_env_set_tag 2026.8.5 | tr '\n' '|')" "OLD_AUTHENTIK_TAG=1|AUTHENTIK_TAG=2026.8.5|"

echo "a rollback restores the database only when it MOVED, and never on a guess:"
eq "no migration ran: retag" "$(ak_rollback_plan 774:12 774:12)" retag
eq "Django migrations ran: restore" "$(ak_rollback_plan 774:12 777:13)" restore
eq "only authentik's system migrations ran (a new version row): restore" "$(ak_rollback_plan 774:12 774:13)" restore
eq "the state after is unreadable: unknown, never restore" "$(ak_rollback_plan 774:12 '')" unknown
eq "the state before is unreadable: unknown" "$(ak_rollback_plan '' 774:12)" unknown
eq "a state that is not two numbers: unknown" "$(ak_rollback_plan 774:12 'ERROR')" unknown
eq "a bare Django count is not a state: unknown" "$(ak_rollback_plan 774 774)" unknown

echo "the rollback copies: three of each kind and none older than 30 days, from the stamp in the name:"
now=20261119T120000Z
copies="$(printf '%s\n' \
  20261119T110000Z-2026.8.0-to-2026.8.5.dump 20261115T000000Z-2026.8.0-to-2026.8.5.dump \
  20261110T000000Z-2026.8.0-to-2026.8.5.dump 20261101T000000Z-2026.7.0-to-2026.8.0.dump \
  20261020T120000Z-miconnect.env 20261020T115959Z-miconnect.env \
  20260901T000000Z-pg.log 20261118T000000Z-pg.log 20260901T000000Z-compose.log \
  notes.txt 20260901T000000Z-other.txt .env-next.abc123 20260901T000000Z-miconnect.env.keep)"
eq "  the 4th newest dump goes, and every copy older than 30 days; nothing else is a candidate" \
  "$(ak_prune_select "$now" 3 30 <<<"$copies" | LC_ALL=C sort | tr '\n' ' ')" \
  "20260901T000000Z-compose.log 20260901T000000Z-pg.log 20261020T115959Z-miconnect.env 20261101T000000Z-2026.7.0-to-2026.8.0.dump "
eq "  exactly 30 days old is kept, one second more is not" \
  "$(printf '20261020T120000Z-a.dump\n20261020T115959Z-b.dump\n' | ak_prune_select "$now" 3 30)" 20261020T115959Z-b.dump
eq "  the age crosses a month and a leap day correctly" \
  "$(printf '20280130T000000Z-a.dump\n20280131T000000Z-b.dump\n' | ak_prune_select 20280301T000000Z 3 30)" 20280130T000000Z-a.dump
eq "  even the only copy expires (the bound is the owner's, not the release's)" \
  "$(printf '20260101T000000Z-a.dump\n' | ak_prune_select "$now" 3 30)" 20260101T000000Z-a.dump
if ak_prune_select 2026-11-19 3 30 </dev/null >/dev/null 2>&1; then fail "  a malformed now is accepted"; else pass "  a malformed now is refused, nothing selected"; fi

echo "Docker's verdict decides health, and a crash loop is a failure, not a wait:"
eq "healthy" "$(ak_health_verdict running healthy 0)" healthy
eq "starting is a wait" "$(ak_health_verdict running starting 0)" waiting
case "$(ak_health_verdict running starting 2)" in failed:*) pass "a restart while starting fails" ;; *) fail "a crash loop waits for ever" ;; esac
case "$(ak_health_verdict running unhealthy 0)" in failed:*) pass "unhealthy fails" ;; *) fail "unhealthy does not fail" ;; esac
case "$(ak_health_verdict running unhealthy 0 no)" in failed:*) pass "unhealthy with the migrations still fails" ;; *) fail "unhealthy waits with no migration running" ;; esac
eq "unhealthy while the migrations still rise is a wait" "$(ak_health_verdict running unhealthy 0 yes)" waiting
case "$(ak_health_verdict running unhealthy 1 yes)" in failed:*) pass "  but not once it restarted" ;; *) fail "a restart during migrations waits" ;; esac
case "$(ak_health_verdict exited '' 0)" in failed:*) pass "an exited container fails" ;; *) fail "an exited container waits" ;; esac
case "$(ak_health_verdict running '' 0)" in failed:*) pass "no healthcheck at all fails rather than waiting" ;; *) fail "no healthcheck waits" ;; esac
eq "a count that grew is rising" "$(ak_migrations_rising 774 775 && echo y)" y
eq "a flat count is not" "$(ak_migrations_rising 775 775 || echo n)" n
eq "an unreadable count is not" "$(ak_migrations_rising '' 775 || echo n)" n

echo "the dump has room, and compose's dry run says whether the up changes more than the tag:"
eq "twice the database fits: room" "$(ak_space_ok 1048576 2048 && echo y)" y
eq "less than twice: no room" "$(ak_space_ok 1048577 2048 || echo n)" n
eq "an unreadable size: no room" "$(ak_space_ok '' 2048 || echo n)" n
eq "a stack left running: no recreate" "$(printf ' DRY-RUN MODE -  Container m-server-1  Running\n' | ak_dry_run_recreates || echo n)" n
eq "a recreate is seen" "$(printf ' DRY-RUN MODE -  Container m-server-1  Recreate\n DRY-RUN MODE -  Container m-server-1  Recreated\n' | ak_dry_run_recreates && echo y)" y

echo "the public log names what drifted and never its values:"
redacted="$(printf '%s\n' \
  '[miconnect-blueprints] applied 50-providers.yaml' \
  '[miconnect-blueprints] CHANGED  50-providers.yaml#03 authentik_providers_oauth2.oauth2provider .redirect_uris: ["https://secret.example/cb"] -> []' \
  '[miconnect-blueprints] FAILED to apply 60-x.yaml' \
  '[miconnect-blueprints]   field value "private-thing" is invalid' \
  'Traceback: value=private-thing' \
  '[miconnect-blueprints] 1 change(s)' | ak_redact_blueprint_output)"
eq "  the object and field of a change are kept" "$(grep -cxF '[miconnect-blueprints] CHANGED  50-providers.yaml#03 authentik_providers_oauth2.oauth2provider .redirect_uris' <<<"$redacted")" 1
eq "  its values are not" "$(grep -c 'secret.example' <<<"$redacted")" 0
eq "  validation lines and foreign lines are withheld and counted" "$(grep -c 'private-thing' <<<"$redacted")/$(grep -c '2 other line(s) withheld' <<<"$redacted")" 0/1
eq "  the change count still reaches the verdict" "$(ak_blueprint_drift_verdict <<<"$redacted")" drift:1

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

echo "a known drift, with a date, is a warning until that date and red after it:"
printf '# comment\nstack postgres postgres:16-alpine 2026-12-31 backlog/x.md\n' >"$tmp/known"
printf 'postgres postgres:16-alpine\ngarage dxflrs/garage:v2.5.0\nserver ghcr.io/goauthentik/server:2026.8.5\n' >"$tmp/run-known"
out="$(drift_compare "$tmp/pins" "$tmp/run-known" stack "$tmp/known" 2026-12-31)"
eq "  on its last day: passes" "$?" 0
eq "  printed KNOWN with its date and its reason" "$(grep -c '^KNOWN postgres running=postgres:16-alpine pinned=postgres:18-alpine@sha256:aa until 2026-12-31 (backlog/x.md)$' <<<"$out")" 1
out="$(drift_compare "$tmp/pins" "$tmp/run-known" stack "$tmp/known" 2027-01-01)"
eq "  the day after: red" "$?" 1
eq "  saying the exemption expired" "$(grep -c '^DRIFT postgres .*has expired' <<<"$out")" 1
drift_compare "$tmp/pins" "$tmp/run-known" other-stack "$tmp/known" 2026-12-01 >/dev/null
eq "  another project's same drift: red" "$?" 1
printf 'postgres postgres:15-alpine\ngarage dxflrs/garage:v2.5.0\nserver ghcr.io/goauthentik/server:2026.8.5\n' >"$tmp/run-other"
drift_compare "$tmp/pins" "$tmp/run-other" stack "$tmp/known" 2026-12-01 >/dev/null
eq "  another running image of the same service: red" "$?" 1
eq "  the repository's own exemption file names a date on every row" \
  "$(grep -vE '^[[:space:]]*(#|$)' infrastructure/deploy/image-drift-known.txt | awk '$4 !~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ || NF < 5' | wc -l | tr -d ' ')" 0

# =================================================================================================
echo "the deploy, against a fake stack:"
# THE FAKES ARE PROGRAMS ON PATH, not exported functions: the deploy runs compose under `env -i`,
# which drops every exported function - and every exported variable, which is the point. So the
# stack's state directory is written INTO the fake, and the fake records what compose was handed.
S="$tmp/stack"
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
S=__STATE__
echo "$*" >>"$S/calls"
envtag="$(sed -n 's/^AUTHENTIK_TAG=//p' "$S/dir/.env" | tail -n 1)"
# compose lets its caller's AUTHENTIK_TAG override the .env line, as the real one does.
tag="${AUTHENTIK_TAG:-$envtag}"
if [ "${1:-}" = compose ]; then env | grep -E '^(PG_|POSTGRES_)' | cut -d= -f1 >>"$S/leak"; fi
# the test's own "send a signal to the deploy while this call runs"
if [ -f "$S/signal-on" ] && grep -qF -- "$(cat "$S/signal-on")" <<<"$*"; then rm -f "$S/signal-on"; kill -TERM "$PPID"; fi
case "$*" in
  "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=server") [ -s "$S/server" ] && [ ! -f "$S/stopped" ] && echo server-id ;;
  "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=worker") [ -s "$S/worker" ] && [ ! -f "$S/stopped" ] && echo worker-id ;;
  "ps -q --filter label=com.docker.compose.project=miconnect --filter label=com.docker.compose.service=postgresql") echo pg-id ;;
  *"{{.Config.Image}}"*) id="${*: -1}"; cat "$S/${id%-id}" ;;
  *working_dir*) echo "$S/dir" ;;
  *config_files*) echo "$S/dir/compose.yml" ;;
  *State.Status*) echo running ;;
  *State.Health*)
    if [ "${*: -1}" = server-id ] && [ -s "$S/slow" ] && [ "$(cat "$S/slow")" -gt 0 ]; then
      n="$(cat "$S/slow")"; echo $((n - 1)) >"$S/slow"
      echo $(($(cat "$S/migrations") + 1)) >"$S/migrations"
      if [ "$n" = 3 ]; then echo starting; else echo unhealthy; fi
    elif grep -qx "$(sed 's/.*://' "$S/server")" "$S/broken"; then echo unhealthy
    else echo healthy; fi
    ;;
  *RestartCount*) echo 0 ;;
  "port server-id 9000/tcp") echo 127.0.0.1:9000 ;;
  pull*) ;;
  *"compose"*"config --images"*)
    if [ -f "$S/configfail" ]; then echo "open $S/dir/compose.yml: no such file or directory" >&2; exit 1; fi
    echo "ghcr.io/goauthentik/server:$tag"; echo postgres:18
    ;;
  *"compose"*"--dry-run up"*)
    svc="${*: -1}"
    if [ -f "$S/confdrift" ]; then echo " DRY-RUN MODE -  Container miconnect-$svc-1  Recreate"; else echo " DRY-RUN MODE -  Container miconnect-$svc-1  Running"; fi
    ;;
  *"compose"*"up -d --no-deps server worker"*)
    # compose's own words name the stack's files by their host path
    if [ -f "$S/upfail-once" ]; then rm -f "$S/upfail-once"; echo "error while interpolating $S/dir/compose.yml" >&2; exit 1; fi
    rm -f "$S/stopped"
    old="$(sed 's/.*://' "$S/server")"
    echo "ghcr.io/goauthentik/server:$tag" >"$S/server"
    echo "ghcr.io/goauthentik/server:$tag" >"$S/worker"
    if [ -f "$S/migrate" ] && [ "$old" != "$tag" ] && [ "$tag" != 2026.8.0 ]; then echo 777 >"$S/migrations"; fi
    # authentik's system migrations: a new version adds its row before any Django migration runs
    if [ -f "$S/sysmigrate" ] && [ "$old" != "$tag" ] && [ "$tag" != 2026.8.0 ]; then echo $(($(cat "$S/vh") + 1)) >"$S/vh"; fi
    ;;
  *"compose"*"stop server worker"*)
    [ -f "$S/stopfail" ] && { echo "cannot stop" >&2; exit 1; }
    echo stopped >>"$S/events"; touch "$S/stopped"
    # from here on, the rollback cannot write a temporary copy of the .env (the fake mktemp)
    if [ -f "$S/envwritefail" ]; then touch "$S/mktemp-fails"; fi
    ;;
  *"exec pg-id"*authentik_version_history*)
    if [ -f "$S/unreadable-after-stop" ] && [ -f "$S/events" ]; then exit 1; fi
    echo "$(cat "$S/migrations"):$(cat "$S/vh")"
    ;;
  *"exec pg-id"*"django_migrations"*)
    if [ -f "$S/unreadable-after-stop" ] && [ -f "$S/events" ]; then exit 1; fi
    cat "$S/migrations"
    ;;
  *"exec pg-id"*pg_database_size*) if [ -f "$S/hugedb" ]; then echo 1000000000000000; else echo 1000; fi ;;
  *"exec pg-id"*pg_dump*) echo DUMPDATA ;;
  *"exec -i pg-id pg_restore --list"*) cat >/dev/null; printf ';\n1; TABLE a\n2; TABLE b\n' ;;
  *"exec -i pg-id pg_restore -f /dev/null"*)
    cat >/dev/null
    if [ -f "$S/baddump" ]; then echo "pg_restore: error: COPY failed near row (secret-row)" >&2; exit 1; fi
    ;;
  *"exec -i pg-id"*dropdb*)
    if [ -f "$S/restorefail" ]; then cat >/dev/null; echo "ERROR: duplicate key (secret-row)" >&2; exit 1; fi
    cat >"$S/restored"; echo 774 >"$S/migrations"; echo 12 >"$S/vh"
    ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
EOF
sed -i "s|__STATE__|'$S'|" "$tmp/bin/docker"
printf '#!/usr/bin/env bash\ncase "$*" in *openid-configuration*) echo %s ;; esac\n' "'{\"issuer\":\"i\",\"authorization_endpoint\":\"a\"}'" >"$tmp/bin/curl"
# mktemp fails for the .env's temporary copy once the fake stack says so, and says where (as the
# real one does), so the test also proves that path stays out of the public log.
cat >"$tmp/bin/mktemp" <<EOF
#!/usr/bin/env bash
case "\$*" in *.env-next.*) [ -f '$S/mktemp-fails' ] && { echo "mktemp: failed to create file via template '\$1'" >&2; exit 1; } ;; esac
exec '$(command -v mktemp)' "\$@"
EOF
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/mktemp"

fake_reset() {
  rm -rf "$S"
  mkdir -p "$S/dir"
  printf 'PG_PASS=s3cret\nAUTHENTIK_TAG=%s\n' "$2" >"$S/dir/.env"
  echo "$1" >"$S/server"
  echo "$1" >"$S/worker"
  echo 774 >"$S/migrations"
  echo 12 >"$S/vh"
  : >"$S/calls"
  : >"$S/broken"
  : >"$S/leak"
  rm -rf "$tmp/dumps"
}

# run_deploy [mode] - the real script, the fakes first on PATH, an ambient PG_*/POSTGRES_* that must
# never reach compose. `timeout` bounds a test whose fake would otherwise wait for ever.
run_deploy() {
  PATH="$tmp/bin:$PATH" PG_PASS=ambient POSTGRES_PASSWORD=ambient \
    AK_POLL_SECONDS=0 AK_HEALTH_DEADLINE_SECONDS="${deadline:-0}" AK_DUMP_DIR="$tmp/dumps" AK_NOW="${now:-}" \
    timeout 120 bash infrastructure/authentik/deploy-stack.sh "${1:-deploy}" --project miconnect --compose infrastructure/authentik/compose.yml >"$tmp/out" 2>&1
}
# changed - how many calls changed or dumped anything (reads of the migration count do not count).
changed() { grep -vF -- '--dry-run' "$S/calls" | grep -cE '^(pull|compose .*(up|stop))|pg_dump|dropdb'; }

pin="$(ak_pin_image infrastructure/authentik/compose.yml)"
pin_tag="$(ak_tag_of "$pin")"

fake_reset "$pin" "$pin_tag"
run_deploy; st=$?
eq "on the pin with .env agreeing: exit 0" "$st" 0
eq "  and nothing is pulled, dumped or recreated" "$(changed)" 0
eq "  but the checks still ran" "$(grep -c 'checks passed' "$tmp/out")" 1

fake_reset "$pin" "$pin_tag"; echo "$pin_tag" >"$S/broken"
run_deploy; st=$?
eq "on the pin but unhealthy: exit 1, not a silent success" "$st" 1

fake_reset "$pin" 2026.1.0
run_deploy; st=$?
eq "on the pin with a stale .env line: exit 0" "$st" 0
eq "  the line now names the pin" "$(ak_env_tag <"$S/dir/.env")" "$pin_tag"
eq "  the secrets beside it are untouched" "$(grep -c '^PG_PASS=s3cret$' "$S/dir/.env")" 1
eq "  and nothing restarted" "$(grep -c 'compose.*up' "$S/calls")" 0
eq "  the .env was backed up first, byte for byte" "$(find "$tmp/dumps/miconnect" -name '*.env' -exec grep -c '^AUTHENTIK_TAG=2026.1.0$' {} + 2>/dev/null)" 1
eq "  and the checks ran" "$(grep -c 'checks passed' "$tmp/out")" 1

fake_reset "$pin" 2026.1.0; echo "$pin_tag" >"$S/broken"
run_deploy; st=$?
eq "a stale line on a stack that fails its checks: exit 1" "$st" 1

fake_reset "$O" 2026.8.0
chmod 0400 "$S/dir/.env"
if [ -w "$S/dir/.env" ]; then
  pass "(skipped: this account can write a 0400 file, so the refused-.env case cannot be played here)"
else
  run_deploy; st=$?
  eq "a .env the runner cannot write: refused, exit 1" "$st" 1
  eq "  naming the one-off command" "$(grep -c 'chmod 0660' "$tmp/out")" 1
  eq "  and nothing touched" "$(changed)" 0
  run_deploy access; st=$?
  eq "  the drift job's read-only probe says so too, exit 1" "$st" 1
fi
chmod 0600 "$S/dir/.env"
run_deploy access; st=$?
eq "a .env the runner reads and writes: the probe passes" "$st" 0

fake_reset "$O" 2026.8.0; touch "$S/migrate"
run_deploy; st=$?
eq "an upgrade that passes its checks: exit 0" "$st" 0
eq "  runs the pin" "$(cat "$S/server")" "$pin"
eq "  .env names it" "$(ak_env_tag <"$S/dir/.env")" "$pin_tag"
eq "  the database was dumped first" "$(find "$tmp/dumps/miconnect" -name '*-2026.8.0-to-*.dump' | wc -l | tr -d ' ')" 1
eq "  and the dump was read back in full, not only its table of contents" "$(grep -c 'pg_restore -f /dev/null' "$S/calls")" 1
eq "  postgres was not recreated (--no-deps server worker)" "$(grep -c 'up -d --no-deps server worker' "$S/calls")" 1
eq "  compose saw none of the runner's PG_*/POSTGRES_* variables" "$(grep -c . "$S/leak")" 0
first_dump="$(grep -n 'pg_dump' "$S/calls" | cut -d: -f1)"
first_up="$(grep -n -m 1 'up -d --no-deps server worker' "$S/calls" | cut -d: -f1)"
if [ "$first_dump" -lt "$first_up" ]; then pass "  the dump is taken before the restart"; else fail "  the restart came before the dump"; fi
eq "  the public log names no absolute dump path" "$(grep -cF "$tmp/dumps" "$tmp/out")" 0
eq "  nor the account it runs as" "$(grep -cwF "$(id -un)" "$tmp/out")" 0

fake_reset "$O" 2026.8.0; touch "$S/migrate"; echo 3 >"$S/slow"
deadline=900 run_deploy; st=$?
eq "a migration outlasting the healthcheck (unhealthy while the count rises): waited, exit 0" "$st" 0
eq "  not rolled back" "$(grep -c 'rolling back' "$tmp/out")" 0

fake_reset "$O" 2026.8.0; touch "$S/confdrift"
run_deploy; st=$?
eq "the host's files differ from what runs beyond the tag: refused, exit 1" "$st" 1
eq "  nothing dumped or recreated" "$(changed | tr -d ' ')" 1 # the pull alone
eq "  saying why" "$(grep -c 'would still recreate it' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; touch "$S/hugedb"
run_deploy; st=$?
eq "no room for the dump: refused, exit 1" "$st" 1
eq "  nothing dumped" "$(grep -c pg_dump "$S/calls")" 0

fake_reset "$O" 2026.8.0; touch "$S/baddump"
run_deploy; st=$?
eq "a dump that does not read back in full: refused, exit 1" "$st" 1
eq "  nothing recreated" "$(grep -c 'up -d --no-deps server worker' "$S/calls")" 0
eq "  and pg_restore's row context stays out of the log" "$(grep -c 'secret-row' "$tmp/out")" 0

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
stop_at="$(grep -n -m 1 'stop server worker' "$S/calls" | cut -d: -f1)"
count_at="$(grep -n 'django_migrations' "$S/calls" | cut -d: -f1 | awk -v s="$stop_at" '$1 > s && !n++')"
if [ -n "$count_at" ] && [ -n "$stop_at" ]; then pass "  the migration count was read AFTER the stop"; else fail "  the count was not read after the stop"; fi

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/migrate" "$S/restorefail"
run_deploy; st=$?
eq "a restore that fails inside the rollback: exit 2, never 1" "$st" 2
eq "  saying THE ROLLBACK FAILED" "$(grep -c 'THE ROLLBACK FAILED' "$tmp/out")" 1
eq "  with the hand procedure, naming the dump" "$(grep -c 'By hand, on the host.*<dumps>/miconnect/.*\.dump' "$tmp/out")" 1
eq "  and pg_restore's row context stays out of the log" "$(grep -c 'secret-row' "$tmp/out")" 0

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/stopfail"
run_deploy; st=$?
eq "a stop that fails inside the rollback: exit 2" "$st" 2
eq "  saying THE ROLLBACK FAILED" "$(grep -c 'THE ROLLBACK FAILED' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/migrate"; echo 2026.8.0 >>"$S/broken"
run_deploy; st=$?
eq "a rollback whose old version is unhealthy too: exit 2" "$st" 2

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/migrate" "$S/unreadable-after-stop"
run_deploy; st=$?
eq "a migration count unreadable during the rollback: exit 2" "$st" 2
eq "  NOTHING restored on a guess" "$(grep -c dropdb "$S/calls")" 0
eq "  and it says so" "$(grep -c 'nothing is restored on a guess' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; echo "pull" >"$S/signal-on"
run_deploy; st=$?
eq "interrupted before any change: exit 1" "$st" 1
eq "  saying nothing was changed" "$(grep -c 'interrupted (TERM) before any change' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; echo "up -d --no-deps server worker" >"$S/signal-on"
run_deploy; st=$?
eq "interrupted while server and worker are recreated: exit 2" "$st" 2
eq "  with the state and the hand procedure" "$(grep -c 'INTERRUPTED (TERM) during changing: .env names.*By hand' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/migrate"; echo dropdb >"$S/signal-on"
run_deploy; st=$?
eq "a signal during the restore is ignored: the rollback completes, exit 1" "$st" 1
eq "  the dump was restored" "$(cat "$S/restored" 2>/dev/null)" DUMPDATA

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/sysmigrate"
run_deploy; st=$?
eq "an upgrade that fails after authentik's SYSTEM migrations alone (Django count flat): exit 1" "$st" 1
eq "  the dump was restored - the database says it is the new version" "$(cat "$S/restored" 2>/dev/null)" DUMPDATA
eq "  back on the old tag" "$(cat "$S/server")" "$O"

fake_reset "$O" 2026.8.0; echo "$pin_tag" >"$S/broken"; touch "$S/envwritefail"
run_deploy; st=$?
eq "a rollback whose .env line cannot be rewritten but whose backup is put back: exit 1, rolled back" "$st" 1
eq "  the .env is the backup again, on the old tag" "$(ak_env_tag <"$S/dir/.env")" 2026.8.0
eq "  its secrets intact" "$(grep -c '^PG_PASS=s3cret$' "$S/dir/.env")" 1
eq "  back on the old tag" "$(cat "$S/server")" "$O"
eq "  saying ROLLED BACK, not THE ROLLBACK FAILED" "$(grep -c 'ROLLED BACK' "$tmp/out")/$(grep -c 'THE ROLLBACK FAILED' "$tmp/out")" 1/0
eq "  and mktemp's host path stays out of the log" "$(grep -cF "$tmp/dumps" "$tmp/out")" 0

fake_reset "$O" 2026.8.0; touch "$S/upfail-once"
run_deploy; st=$?
eq "a compose up that fails: rolled back, exit 1" "$st" 1
eq "  compose's messages, which name the stack's host path, stay out of the public log" "$(grep -cF "$S/dir" "$tmp/out")" 0
eq "  they are in the 0600 compose log beside the dump" "$(cat "$tmp"/dumps/miconnect/*-compose.log 2>/dev/null | grep -cF "$S/dir")" 1
eq "  which the log names relatively" "$(grep -c '<dumps>/miconnect/[0-9TZ]*-compose.log' "$tmp/out")" 1

fake_reset "$O" 2026.8.0; touch "$S/configfail"
run_deploy; st=$?
eq "compose cannot read the stack's configuration: refused, exit 1" "$st" 1
eq "  its host path stays out of the public log" "$(grep -cF "$S/dir" "$tmp/out")" 0

# THE RETENTION RUNS ON A NO-OP TOO, so the copies expire without an upgrade. "now" is fixed.
seed_copies() {
  mkdir -p "$tmp/dumps/miconnect"
  for f in 20261001T000000Z-2026.7.0-to-2026.8.0.dump 20261101T000000Z-a-to-b.dump 20261105T000000Z-a-to-b.dump \
    20261110T000000Z-a-to-b.dump 20261115T000000Z-a-to-b.dump 20261020T115959Z-miconnect.env \
    20261020T120000Z-miconnect.env 20261001T000000Z-pg.log 20261001T000000Z-compose.log notes.txt; do
    echo x >"$tmp/dumps/miconnect/$f"
  done
}
kept_copies() { find "$tmp/dumps/miconnect" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort | tr '\n' ' '; }
want_kept="20261020T120000Z-miconnect.env 20261105T000000Z-a-to-b.dump 20261110T000000Z-a-to-b.dump 20261115T000000Z-a-to-b.dump notes.txt "

fake_reset "$pin" "$pin_tag"; seed_copies
now=20261119T120000Z run_deploy; st=$?
eq "a no-op run: exit 0" "$st" 0
eq "  and it pruned: the 3 newest dumps, nothing older than 30 days, a foreign file untouched" "$(kept_copies)" "$want_kept"

fake_reset "$pin" "$pin_tag"; seed_copies
now=20261119T120000Z run_deploy prune; st=$?
eq "the daily prune alone: exit 0, the same verdict" "$st/$(kept_copies)" "0/$want_kept"
eq "  without asking docker anything" "$(grep -c . "$S/calls")" 0

fake_reset "$pin" "$pin_tag"
echo ghcr.io/goauthentik/server:2099.1.0 >"$S/server"; echo ghcr.io/goauthentik/server:2099.1.0 >"$S/worker"
run_deploy; st=$?
eq "a newer version running: refused, exit 1" "$st" 1
eq "  and nothing touched" "$(changed)" 0

echo "the workflows: MiConnect's version moves before any estate container, and the daily job mirrors the deploy:"
# step_line <workflow> <step name> - the line of that step, empty when it is absent.
step_line() { grep -nF -- "- name: $2" "$1" | sed -n 1p | cut -d: -f1; }
# before <workflow> <first step> <second step> - both present, the first above the second.
before() {
  local a b
  a="$(step_line "$1" "$2")"
  b="$(step_line "$1" "$3")"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
if before .github/workflows/serve-prod.yml "Put MiConnect on the pinned authentik version" "Deploy the production estate"; then
  pass "a stable upgrades MiConnect BEFORE it deploys the estate, so a failed upgrade stops it whole"
else fail "a stable deploys the estate before MiConnect's version: a failed upgrade leaves it half-shipped"; fi
if before .github/workflows/serve-dev.yml "Put the test MiConnect on the pinned authentik version" "Deploy the dev estate"; then
  pass "a pre-release upgrades the test MiConnect BEFORE it deploys dev"
else fail "a pre-release deploys dev before the test MiConnect's version"; fi
if before .github/workflows/serve-prod.yml "Put MiConnect on the pinned authentik version" "Apply MiConnect's blueprints"; then
  pass "  and still before the blueprints CI proved on that version"
else fail "  the blueprints are applied before the version they were proved on"; fi
# job_env <workflow> <job> - the environment a job runs in (`environment: x` or its `name:`).
job_env() {
  awk -v job="  $2:" '
    $0 == job { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { exit }
    in_job && /^    environment:/ {
      v = $0; sub(/^    environment:[[:space:]]*/, "", v)
      if (v == "") { getline; v = $0; sub(/^[[:space:]]*name:[[:space:]]*/, "", v) }
      print v; exit
    }
  ' "$1"
}
eq "the drift job runs in the environment of the production deploy it mirrors" \
  "$(job_env .github/workflows/scheduled.yml drift)/$(job_env .github/workflows/serve-prod.yml deploy-to-server)" production/production
eq "  and expires both stacks' rollback copies every day" \
  "$(grep -cF "deploy-stack.sh prune --project \"\$project\"" .github/workflows/scheduled.yml)" 1

echo "the blueprint drift report fails on a hand edit and passes on none:"
cat >"$tmp/applier-drift" <<'EOF'
#!/usr/bin/env bash
echo '[miconnect-blueprints] CHANGED  50-providers.yaml#04 authentik_providers_oauth2.oauth2provider .redirect_uris: ["https://private.example/cb"] -> []'
echo '[miconnect-blueprints] CHANGED  odd-shape: "private-value"'
echo '[miconnect-blueprints] 2 change(s)'
EOF
printf '#!/usr/bin/env bash\necho "[miconnect-blueprints] 0 change(s)"\n' >"$tmp/applier-clean"
bash infrastructure/authentik/blueprint-drift.sh "$tmp/applier-clean" >/dev/null 2>&1
eq "no change: exit 0" "$?" 0
out="$(bash infrastructure/authentik/blueprint-drift.sh "$tmp/applier-drift" 2>&1)"
eq "a change: exit 1" "$?" 1
eq "  the object and field that changed are printed" "$(grep -c 'CHANGED  50-providers.yaml#04 authentik_providers_oauth2.oauth2provider .redirect_uris$' <<<"$out")" 1
eq "  their values are not, nor a line of an unexpected shape" "$(grep -c 'private' <<<"$out")" 0

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures of $checks checks FAILED"
  exit 1
fi
echo "all $checks checks passed"
cd "$root" || true
