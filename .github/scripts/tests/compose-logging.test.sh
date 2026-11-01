#!/usr/bin/env bash
#
# Does every service of every deployed compose file carry the bounded-log stanza, and does the
# deploy keep a container's log past the container it recreates?
#
# WHY THIS EXISTS. Measured 2026-10-08 on the shared host: every container ran json-file with an
# empty config (no max-size, no max-file), and a deploy recreates containers, deleting each log with
# its container - production's only observability, erased by every release
# (docs/wiki/infrastructure/logging.md). Two halves, two assertions:
#
#  1. DERIVED, not listed: the services are read out of each compose file, so the next service is
#     covered the day it is declared. Each must reference the `x-logging` anchor, and the anchor must
#     name json-file with BOTH a max-size and a max-file (one without the other is no ceiling).
#  2. FUNCTIONAL: `archive_logs` is run against a `docker` stub. It must keep one file per
#     container, skip an unreadable one WITHOUT losing the others, do nothing on a first deploy,
#     keep only the newest N deploys, reach back no further than the retention window, and delete
#     an archive older than that window whatever the count (the privacy policy's 90 days,
#     docs/wiki/infrastructure/logging.md). And `deploy-environment.sh` must call it BEFORE its
#     first `up -d`, the last moment the old containers exist.
#
# Run by `make test-ci-scripts`.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
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

FILES="infrastructure/docker-compose.prod.yml infrastructure/docker-compose.dev.yml infrastructure/authentik/compose.yml"

# ── 1. every service carries the stanza ─────────────────────────────────────
for f in $FILES; do
  path="$REPO/$f"
  # Emit "<service> <has-logging>" for each service header between `services:` and the next
  # top-level key; the service owns every line up to the next two-space header.
  report="$(awk '
    /^[a-z]/ { insvc = ($0 ~ /^services:/); if (!insvc && svc != "") { print svc, has; svc = "" } }
    insvc && /^  [a-zA-Z0-9_-]+:[[:space:]]*$/ { if (svc != "") print svc, has; svc = $1; sub(":", "", svc); has = 0; next }
    insvc && /^    logging:[[:space:]]*\*logging[[:space:]]*$/ { has = 1 }
    END { if (svc != "") print svc, has }
  ' "$path")"
  total="$(printf '%s\n' "$report" | grep -c .)"
  [ "$total" -gt 0 ] || {
    fail "$f: no service found (the derivation is blind)"
    continue
  }
  missing="$(printf '%s\n' "$report" | awk '$2 == 0 { print $1 }' | tr '\n' ' ')"
  if [ -z "$missing" ]; then ok "$f: all $total services carry logging: *logging"; else fail "$f: no logging stanza on: $missing"; fi

  anchor="$(awk '/^x-logging:[[:space:]]*&logging/ { on = 1; print; next } on && /^[a-z]/ { exit } on { print }' "$path")"
  if printf '%s\n' "$anchor" | grep -q 'driver: json-file' &&
    printf '%s\n' "$anchor" | grep -Eq 'max-size: [0-9]+[kmg]' &&
    printf '%s\n' "$anchor" | grep -Eq 'max-file: "?[0-9]+"?'; then
    ok "$f: x-logging is json-file with max-size AND max-file"
  else
    fail "$f: x-logging anchor missing or without driver/max-size/max-file"
  fi
done

# ── 2. archive_logs, against a docker stub ──────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/archive-logs.sh
. "$REPO/infrastructure/lib/archive-logs.sh"

# The stub: `ps` lists $STUB_IDS, `inspect` names a container after its id, `logs` prints a line,
# and fails for the id in $STUB_BAD.
cat >"$TMP/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_CALLS"
case "$1" in
ps) printf '%s\n' $STUB_IDS ;;
inspect) printf '/%s\n' "${@: -1}" ;;
logs) [ "${@: -1}" = "$STUB_BAD" ] && exit 1; printf 'line from %s\n' "${@: -1}" ;;
esac
EOF
chmod +x "$TMP/docker"
export STUB_CALLS="$TMP/calls"

ROOT="$TMP/archive"
STUB_IDS="" archive_logs "$TMP/docker" proj "$ROOT" 3 >/dev/null 2>&1
if [ ! -d "$ROOT/proj" ]; then ok "a first deploy (no container) creates nothing"; else fail "a first deploy created an archive"; fi

export STUB_IDS="aaa bbb ccc" STUB_BAD="bbb"
archive_logs "$TMP/docker" proj "$ROOT" 3 >/dev/null 2>&1
d="$(find "$ROOT/proj" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sed -n 1p)"
if [ -f "$ROOT/proj/$d/aaa.log.gz" ] && [ -f "$ROOT/proj/$d/ccc.log.gz" ]; then
  ok "one gzip file per readable container"
else
  fail "readable containers were not archived: $(ls "$ROOT/proj/$d")"
fi
if [ ! -e "$ROOT/proj/$d/bbb.log.gz" ]; then ok "an unreadable container is skipped without losing the others"; else fail "an unreadable container left a file"; fi
if [ "$(gzip -dc "$ROOT/proj/$d/aaa.log.gz")" = "line from aaa" ]; then ok "the archived content is the container's log"; else fail "archived content differs"; fi

if grep -q -- "--since $((LOG_ARCHIVE_WINDOW_DAYS * 24))h" "$TMP/calls"; then
  ok "an archive reaches back $LOG_ARCHIVE_WINDOW_DAYS days into a log, no further"
else
  fail "archive_logs did not pass --since $((LOG_ARCHIVE_WINDOW_DAYS * 24))h to docker logs: $(grep logs "$TMP/calls" | sed -n 1p)"
fi

# Retention by COUNT: five more deploys inside the age window, KEEP=3, distinct stamps (the stamp
# has one-second resolution). Dated relative to now, so the age bound does not decide this one.
for i in 1 2 3 4 5; do
  mkdir -p "$ROOT/proj/$(log_stamp_days_ago "$i")"
done
archive_logs "$TMP/docker" proj "$ROOT" 3 >/dev/null 2>&1
n="$(find "$ROOT/proj" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$n" = "3" ]; then ok "only the newest 3 deploys survive"; else fail "retention left $n directories"; fi
if [ -d "$ROOT/proj/$d" ]; then ok "the newest archive is the one kept"; else fail "retention dropped the newest archive"; fi

# Retention by AGE, whatever the count: the privacy policy's ceiling (docs/wiki/infrastructure/logging.md).
AGE="$TMP/age"
inside="$(log_stamp_days_ago $((LOG_ARCHIVE_WINDOW_DAYS - 1)))"
outside="$(log_stamp_days_ago $((LOG_ARCHIVE_WINDOW_DAYS + 1)))"
mkdir -p "$AGE/proj/$inside" "$AGE/proj/$outside" "$AGE/proj/not-a-stamp"
prune_log_archive "$AGE" proj >/dev/null 2>&1
pruned=$?
if [ ! -e "$AGE/proj/$outside" ]; then ok "an archive older than $LOG_ARCHIVE_WINDOW_DAYS days is deleted"; else fail "an archive past the window survived the prune"; fi
if [ -d "$AGE/proj/$inside" ]; then ok "an archive inside the window is kept"; else fail "the prune deleted an archive inside the window"; fi
if [ -d "$AGE/proj/not-a-stamp" ] && [ "$pruned" -ne 0 ]; then
  ok "an entry that is not a stamp is left in place AND reported (allowlist)"
else
  fail "a foreign entry was removed or went unreported (exists=$([ -d "$AGE/proj/not-a-stamp" ] && echo yes || echo no) status=$pruned)"
fi
mkdir -p "$AGE/proj/$outside"
archive_logs "$TMP/docker" proj "$AGE" 10 >/dev/null 2>&1
if [ ! -e "$AGE/proj/$outside" ]; then ok "a deploy prunes by age too, with room left under its count"; else fail "archive_logs kept an archive past the window because the count allowed it"; fi

# The window, end to end, stays under the promise with slack for missed daily runs.
if [ $((2 * LOG_ARCHIVE_WINDOW_DAYS)) -lt "$LOG_PROMISE_DAYS" ]; then
  ok "an archived line lives at most $((2 * LOG_ARCHIVE_WINDOW_DAYS)) days, under the $LOG_PROMISE_DAYS promised"
else
  fail "2 x LOG_ARCHIVE_WINDOW_DAYS ($((2 * LOG_ARCHIVE_WINDOW_DAYS))) is not under LOG_PROMISE_DAYS ($LOG_PROMISE_DAYS)"
fi

# ── the deploy calls it before its first `up -d` ─────────────────────────────
DEPLOY="$REPO/infrastructure/deploy/deploy-environment.sh"
call="$(grep -n '^archive_logs ' "$DEPLOY" | sed -n 1p | cut -d: -f1)"
up="$(grep -n '^dc up -d' "$DEPLOY" | sed -n 1p | cut -d: -f1)"
if [ -n "$call" ] && [ -n "$up" ] && [ "$call" -lt "$up" ]; then
  ok "deploy-environment.sh archives logs before its first up -d"
else
  fail "deploy-environment.sh does not call archive_logs before the first up -d (call=$call up=$up)"
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
