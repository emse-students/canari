#!/usr/bin/env bash
# Sourced, never run: `run_ak_shell <container>` runs the Python program on its stdin inside
# authentik's `ak shell`, locally or through AK_REMOTE (e.g. AK_REMOTE="ssh portail-etu-direct").
# The ONE transport of apply-blueprints.sh and migrate-profile.sh, so a program travels on stdin and
# nothing is mounted into or copied onto the authentik host.

ak_shell_program='import sys; exec(sys.stdin.read())'

run_ak_shell() {
  local container="$1"
  if [ -n "${AK_REMOTE:-}" ]; then
    # ssh hands its arguments to the REMOTE shell as one string, which strips one level of quoting.
    # AK_REMOTE is a command and its arguments, so it is split on purpose.
    # shellcheck disable=SC2086
    $AK_REMOTE docker exec -i "$container" ak shell -c "'$ak_shell_program'"
  else
    docker exec -i "$container" ak shell -c "$ak_shell_program"
  fi
}
