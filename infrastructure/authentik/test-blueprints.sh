#!/usr/bin/env bash
# Builds a FRESH MiConnect from this directory's compose.yml and proves the blueprints on it:
#   1. they apply to an empty authentik, every !Find and !Env resolving;
#   2. applying them a SECOND time changes nothing (0 change(s)) - a blueprint that keeps rewriting
#      a field would rewrite it on production at every release.
# With PREVIOUS_REF=<git ref>, step 1 starts from that ref's blueprints instead of an empty instance,
# so every RENAME entry actually runs, and the applier refuses one that leaves its old object.
#
# Run by CI (job `test-miconnect-blueprints`) and runnable on any machine with Docker. It uses the
# real compose.yml under a throwaway project name, so the file production runs is what boots here,
# and it removes its containers and volume on exit.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
project="miconnect-blueprint-test"
work="$(mktemp -d)"

cleanup() {
  docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

cp "$here/compose.yml" "$work/compose.yml"
# Throwaway values. The secret key only has to be long; the CAS secret only has to be SET, since
# this instance never talks to the CAS.
cat >"$work/.env" <<EOF
PG_PASS=blueprint-test
AUTHENTIK_SECRET_KEY=blueprint-test-$(date +%s)-0123456789abcdef0123456789abcdef
MIGALLERY_AVATAR_SIGNING_KEY=blueprint-test
MICONNECT_CAS_CONSUMER_SECRET=blueprint-test
AUTHENTIK_PUBLISH=127.0.0.1:0
EOF

echo "starting a fresh MiConnect ($(grep -o 'AUTHENTIK_TAG:-[^}]*' "$work/compose.yml" | head -1))"
docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" up -d --quiet-pull

worker="${project}-worker-1"
# READY MEANS authentik's OWN blueprints have all applied - ours !Find its default flows, stages
# and mappings. The loop ends on that state; the job's timeout is what bounds a boot that hangs.
echo "waiting for authentik's default blueprints"
probe="from authentik.blueprints.models import BlueprintInstance as B
n = B.objects.count()
ok = B.objects.filter(status='successful').count()
print(f'READY {ok}/{n}' if n and ok == n else f'WAIT {ok}/{n}')"
while :; do
  # Empty while the worker is still migrating its schema, which is expected and not an error.
  state="$(docker exec "$worker" ak shell -c "$probe" 2>/dev/null | grep -E '^(READY|WAIT) ' || true)"
  case "$state" in READY*) break ;; esac
  echo "  ${state:-worker not answering yet}"
  sleep 5
done
echo "  $state"

if [ -n "${PREVIOUS_REF:-}" ]; then
  # The UPGRADE path, which is the one production takes: build the instance from the blueprints at
  # PREVIOUS_REF (CI passes main), then apply these over it. A fresh instance alone never runs a
  # rename entry, since no old name exists on it.
  mkdir -p "$work/previous/blueprints"
  # From the repository ROOT: run inside a subdirectory, `git archive` prefixes even a `ref:path`
  # tree with that subdirectory and extracts nothing.
  root="$(git -C "$here" rev-parse --show-toplevel)"
  git -C "$root" archive "$PREVIOUS_REF:infrastructure/authentik/blueprints" | tar -x -C "$work/previous/blueprints"
  if ! compgen -G "$work/previous/blueprints/*.yaml" >/dev/null; then
    echo "::error::$PREVIOUS_REF has no infrastructure/authentik/blueprints/*.yaml to upgrade from"
    exit 1
  fi
  echo "previous apply: builds the instance from $PREVIOUS_REF's blueprints"
  BLUEPRINTS_DIR="$work/previous/blueprints" bash "$here/apply-blueprints.sh" apply "$worker"
  echo "first apply: upgrades it to these blueprints"
else
  echo "first apply: builds everything"
fi
bash "$here/apply-blueprints.sh" apply "$worker"

echo "second apply: must change nothing"
second="$(bash "$here/apply-blueprints.sh" apply "$worker" 2>&1 | tee >(cat >&2) | grep -E '^\[miconnect-blueprints\] [0-9]+ change\(s\)$')"
if [ "$second" != "[miconnect-blueprints] 0 change(s)" ]; then
  echo "::error::the blueprints are not idempotent - a second apply reported: ${second:-no change count at all}"
  exit 1
fi
echo "blueprints apply to a fresh instance and are idempotent"
