#!/usr/bin/env bash
# WAS MICONNECT EDITED BY HAND SINCE THE LAST STABLE APPLIED ITS BLUEPRINTS?
#
#   blueprint-drift.sh <released apply-blueprints.sh> [worker container]
#
# Runs the RELEASED tree's `apply-blueprints.sh dry-run` against production - one transaction, rolled
# back, nothing written (the same call serve-dev makes on every pre-release) - and judges its change
# count (release-lib.sh, ak_blueprint_drift_verdict). The released blueprints were applied by the
# stable, so any change they would make now is an object somebody edited in the admin UI since, and
# the next stable will overwrite it. 2026-11-13: `1.6.11` overwrote a provider whose MinoWiki
# callbacks had been edited by hand, and nothing had said the edit existed. Run daily by
# `scheduled.yml` (job `drift`); docs/wiki/infrastructure/authentik.md.
#
# Exit: 0 clean; 1 drift (the changes are printed) or no verdict.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=release-lib.sh
. "$here/release-lib.sh"

applier="${1:?usage: blueprint-drift.sh <released apply-blueprints.sh> [worker container]}"
container="${2:-miconnect-worker-1}"

output="$(bash "$applier" dry-run "$container" 2>&1)" || {
  printf '%s\n' "$output"
  echo "::error title=MiConnect blueprint drift::the dry run itself failed, so whether production was edited by hand is unknown"
  exit 1
}
printf '%s\n' "$output"
verdict="$(printf '%s\n' "$output" | ak_blueprint_drift_verdict)"
case "$verdict" in
  clean)
    echo "MiConnect matches the released blueprints: no hand edit for the next stable to overwrite"
    ;;
  drift:*)
    echo "::error title=MiConnect blueprint drift::${verdict#drift:} object field(s) differ from the released blueprints (listed above) - an edit by hand that the next stable release WILL overwrite. Write it into infrastructure/authentik/blueprints/ in a pull request, or undo it."
    exit 1
    ;;
  *)
    echo "::error title=MiConnect blueprint drift::the dry run printed no change count, so no verdict"
    exit 1
    ;;
esac
