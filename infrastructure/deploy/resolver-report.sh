#!/usr/bin/env bash
#
# The daily count of the DNS failures the two nginx in front of the estate logged
# (infrastructure/lib/resolver-report.sh, docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
#
# Run by `scheduled.yml`'s `resolver` job on the self-hosted runner, which reads the local daemon.
# Exit 0 when every failure found is explained, 1 when one is not or a log could not be read.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/resolver-report.sh
. "$HERE/../lib/resolver-report.sh"

DOCKER_CLI="${DOCKER_CLI:-docker}"
# shellcheck disable=SC2086 # DOCKER_CLI may be "sudo docker"
if ! $DOCKER_CLI info >/dev/null 2>&1; then
  printf '::error::resolver: cannot reach the Docker daemon as %s - nothing was read\n' "$(whoami)" >&2
  exit 1
fi

status=0
printf 'resolver: the proxies (%s) of %s, the last %sh\n' "$RESOLVER_REPORT_PROXIES" "$RESOLVER_REPORT_PROJECTS" "$RESOLVER_REPORT_HOURS"
for project in $RESOLVER_REPORT_PROJECTS; do
  printf '\n=== %s ===\n' "$project"
  report_resolver_failures "$DOCKER_CLI" "$project" || status=1
done
exit "$status"
