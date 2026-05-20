#!/usr/bin/env bash
# Prints the Canari app semver from frontend/package.json (canonical app version for clients).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node -p "require('${ROOT}/frontend/package.json').version"
