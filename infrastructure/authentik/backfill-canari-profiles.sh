#!/usr/bin/env bash
# Copies every MiConnect profile into Canari's `users` rows, in ONE transaction, so the accounts that
# will never sign in again are reached too (WP3, docs/wiki/profiles-and-access.md). The OIDC
# callback then keeps each row current at the person's own sign-ins.
#
#   backfill-canari-profiles.sh dry-run|apply [authentik-container] [postgres-container]
#
# `dry-run` runs the whole UPDATE and ROLLS BACK, printing how many rows it touched. Idempotent: the
# values written are a function of the profile alone. The same rules as the callback
# (`apps/core-service/src/users/miconnect-profile.ts`): promo/formation are the first cursus entry
# and a missing one clears them.
#
# From a workstation: AK_REMOTE="ssh portail-etu-direct" PG_REMOTE="ssh portail-etu-direct". The
# postgres container is selected by COMPOSE LABEL, never by name: a dev copy holds the same data
# (docs/wiki/infrastructure/databases.md).
set -euo pipefail

mode="${1:?usage: backfill-canari-profiles.sh dry-run|apply [authentik-container] [postgres-container]}"
case "$mode" in dry-run | apply) ;; *)
  echo "unknown mode: $mode" >&2
  exit 2
  ;;
esac
container="${2:-miconnect-worker-1}"

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=ak-shell.sh
. "$here/ak-shell.sh"

rows="$(run_ak_shell "$container" <"$here/export-profiles.py" | sed -n 's/^PROFILE //p')"
[ -n "$rows" ] || {
  echo "no profile exported - refusing to write" >&2
  exit 1
}
json="$(printf '%s\n' "$rows" | paste -sd, -)"
# shellcheck disable=SC2016
if printf '%s' "$json" | grep -q '\$canari\$'; then
  echo "the export contains the SQL quote tag - refusing" >&2
  exit 1
fi

end=COMMIT
[ "$mode" = dry-run ] && end=ROLLBACK
# shellcheck disable=SC2086
pgc="${3:-$(${PG_REMOTE:-} docker ps --filter label=com.docker.compose.project=canari-prod --filter label=com.docker.compose.service=postgres --format '{{.Names}}')}"
[ -n "$pgc" ] || {
  echo "no canari-prod postgres container found" >&2
  exit 1
}
echo "postgres container: $pgc (mode: $mode)" >&2

sql="BEGIN;
WITH src AS (
  SELECT * FROM jsonb_to_recordset(\$canari\$[$json]\$canari\$::jsonb) AS t(uid text, uuid text, profile jsonb)
), done AS (
  UPDATE users u SET
    \"miconnectUuid\" = src.uuid,
    campus = src.profile->>'campus',
    cursus = COALESCE(src.profile->'cursus', '[]'::jsonb),
    posts = COALESCE(ARRAY(SELECT jsonb_array_elements_text(src.profile->'posts')), '{}'),
    promo = (src.profile->'cursus'->0->>'promo')::int,
    formation = src.profile->'cursus'->0->>'formation'
  FROM src WHERE u.id = src.uid
  RETURNING u.id
)
SELECT count(*) AS updated, (SELECT count(*) FROM src) AS exported, (SELECT count(*) FROM users) AS canari_users FROM done;
$end;"

# shellcheck disable=SC2086
printf '%s\n' "$sql" | ${PG_REMOTE:-} docker exec -i "$pgc" psql -U canari -d auth_db -v ON_ERROR_STOP=1
