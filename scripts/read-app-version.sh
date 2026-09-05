#!/usr/bin/env bash
# Prints the Canari app semver from frontend/package.json (canonical app version for clients).
#
# BUN, NEVER NODE (user, 2026-09-04: "Jamais node, toujours bun"). `bun` has no `-p`, so the print
# is explicit: `-e` with a `console.log`.
#
# AND THE PATH IS RELATIVE TO A `cd`, NOT INTERPOLATED. The old line passed `$ROOT` into `require()`
# as an absolute path, which under MSYS on Windows is `/f/Programmation/...` - a shape no Windows
# runtime resolves, so the helper only ever worked on Linux. CI is Linux, which is exactly why it
# could stay broken: the release path reads this, and a workstation asking it the same question got
# `Cannot find module`. Resolving from the working directory works on both.
set -euo pipefail
cd "$(dirname "$0")/.."
bun -e "console.log(require('./frontend/package.json').version)"
