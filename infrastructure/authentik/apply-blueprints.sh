#!/usr/bin/env bash
# Applies infrastructure/authentik/blueprints/ to a running MiConnect, through apply-blueprints.py.
#
#   apply-blueprints.sh dry-run|apply|snapshot [container]
#
# The container defaults to `miconnect-worker-1`. The blueprints are sent on stdin, base64-encoded,
# together with the program, so the host needs neither a mount nor a copy of this directory.
#
# From a workstation rather than on the host, prefix the transport:
#   AK_REMOTE="ssh portail-etu-direct" apply-blueprints.sh snapshot
#
# BLUEPRINTS_DIR names another directory of blueprints - test-blueprints.sh applies main's first.
set -euo pipefail

mode="${1:?usage: apply-blueprints.sh dry-run|apply|snapshot [container]}"
container="${2:-miconnect-worker-1}"
case "$mode" in dry-run | apply | snapshot) ;; *)
  echo "unknown mode: $mode" >&2
  exit 2
  ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
shopt -s nullglob
dir="${BLUEPRINTS_DIR:-$here/blueprints}"
files=("$dir"/*.yaml)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no blueprint in $dir" >&2
  exit 2
fi

program='import sys; exec(sys.stdin.read())'
# ssh hands its arguments to the REMOTE shell as one string, which strips one level of quoting.
run_ak_shell() {
  if [ -n "${AK_REMOTE:-}" ]; then
    # AK_REMOTE is a command and its arguments, so it is split on purpose.
    # shellcheck disable=SC2086
    $AK_REMOTE docker exec -i "$container" ak shell -c "'$program'"
  else
    docker exec -i "$container" ak shell -c "$program"
  fi
}

{
  echo "import base64"
  echo "MODE = '$mode'"
  echo "BLUEPRINTS = []"
  for file in "${files[@]}"; do
    printf "BLUEPRINTS.append(('%s', base64.b64decode('%s').decode('utf-8')))\n" \
      "$(basename "$file")" "$(base64 -w0 "$file")"
  done
  cat "$here/apply-blueprints.py"
} | run_ak_shell
