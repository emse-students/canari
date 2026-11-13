#!/usr/bin/env bash
# Install apt packages on a hosted runner without letting one unreachable mirror fail the job.
# Usage: apt-install.sh <package>...
#
# The runner's apt sources name azure.archive.ubuntu.com and security.ubuntu.com; when either host
# does not resolve (it did, three times on 2026-11-11) a plain `apt-get install` exits 100. Retries
# cover a blip; a mirror that stays dark is replaced by archive.ubuntu.com, which is reached through
# a different name. See docs/wiki/cicd.md.
set -euo pipefail

opts=(-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

run() {
  sudo apt-get "${opts[@]}" update && sudo apt-get "${opts[@]}" install -y "$@"
}

if run "$@"; then
  exit 0
fi

echo "::warning::apt failed against the runner's default mirror; retrying against archive.ubuntu.com"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources /etc/apt/apt-mirrors.txt; do
  [ -f "$f" ] && sudo sed -i -E 's#https?://(azure\.archive|[a-z]{2}\.archive|security)\.ubuntu\.com#http://archive.ubuntu.com#g' "$f"
done
run "$@"
