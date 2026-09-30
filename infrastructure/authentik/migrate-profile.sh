#!/usr/bin/env bash
# Writes the WP1 profile (`attributes.profile`) for every MiConnect account that has none, through
# migrate-profile.py.
#
#   migrate-profile.sh dry-run|apply [container]
#
# The container defaults to `miconnect-worker-1`; from a workstation, AK_REMOTE="ssh portail-etu-direct".
# Check that day's `authentik_db` dump before `apply` (docs/wiki/infrastructure/backup.md).
set -euo pipefail

mode="${1:?usage: migrate-profile.sh dry-run|apply [container]}"
container="${2:-miconnect-worker-1}"
case "$mode" in dry-run | apply) ;; *)
  echo "unknown mode: $mode" >&2
  exit 2
  ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=ak-shell.sh
. "$here/ak-shell.sh"

{
  echo "MODE = '$mode'"
  cat "$here/migrate-profile.py"
} | run_ak_shell "$container"
