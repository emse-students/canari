#!/usr/bin/env bash
#
# The daily half of the 90-day ceiling on technical logs (docs/wiki/infrastructure/logging.md).
#
# Run by `scheduled.yml`'s `log-retention` job on the self-hosted runner, as the account that
# deploys - so `$HOME/deploy-log-archive` is the directory the deploys wrote. Two things, per estate:
#
#  1. ENFORCED: archives of the deploy-log archive older than LOG_ARCHIVE_WINDOW_DAYS are deleted
#     (prune_log_archive). The deploy prunes too, but a deploy is not a clock: a month without one
#     would otherwise keep a month too much.
#  2. REPORTED: a container whose live log holds a line older than LOG_LIVE_MAX_DAYS turns the run
#     red, naming it (report_live_log_age). Only recreating the container deletes that line, and
#     that is a production change left to a human.
#
# Exit 0 when nothing is at stake, 1 when anything was found or could not be read.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=../lib/archive-logs.sh
. "$HERE/../lib/archive-logs.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/log-retention.sh
. "$HERE/../lib/log-retention.sh"

DOCKER_CLI="${DOCKER_CLI:-docker}"
# shellcheck disable=SC2086 # DOCKER_CLI may be "sudo docker"
if ! $DOCKER_CLI info >/dev/null 2>&1; then
  printf '::error::log-retention: cannot reach the Docker daemon as %s - nothing was checked\n' "$(whoami)" >&2
  exit 1
fi

status=0
printf 'log-retention: archive root %s, archives kept %s days, live lines reported past %s days, promise %s days\n' \
  "$LOG_ARCHIVE_ROOT" "$LOG_ARCHIVE_WINDOW_DAYS" "$LOG_LIVE_MAX_DAYS" "$LOG_PROMISE_DAYS"
for project in $LOG_RETENTION_PROJECTS; do
  printf '\n=== %s ===\n' "$project"
  prune_log_archive "$LOG_ARCHIVE_ROOT" "$project" || status=1
  report_live_log_age "$DOCKER_CLI" "$project" || status=1
done
exit "$status"
