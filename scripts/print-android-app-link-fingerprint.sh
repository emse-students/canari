#!/usr/bin/env bash
# Prints SHA-256 certificate fingerprints for Android App Links (assetlinks.json).
# Usage:
#   ./scripts/print-android-app-link-fingerprint.sh [path-to-release.jks]
# Requires keytool (JDK) and keystore.properties in frontend/src-tauri/gen/android/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="${ROOT}/frontend/src-tauri/gen/android"
KEYSTORE="${1:-${ANDROID_DIR}/release.jks}"
PROPS="${ANDROID_DIR}/keystore.properties"

if [[ ! -f "$KEYSTORE" ]]; then
  echo "Keystore not found: $KEYSTORE" >&2
  echo "Pass the release .jks path or decode ANDROID_KEYSTORE_BASE64 into that location." >&2
  exit 1
fi

if [[ ! -f "$PROPS" ]]; then
  echo "Missing $PROPS (keyAlias, storePassword, keyPassword)." >&2
  exit 1
fi

# DECLARED BEFORE THEY ARE SOURCED, AND CHECKED AFTER. shellcheck reported all three as
# "referenced but not assigned" - correctly, since it cannot see through a process substitution -
# and the warning is worth more than its noise here: a typo in a key name inside `keystore.
# properties` leaves the variable EMPTY, and `keytool -storepass ''` fails with a message about
# the keystore rather than about the name that was misspelt. This is the script that reads the
# signing key for an Android release.
keyAlias=""
storePassword=""
keyPassword=""

# shellcheck disable=SC1090
source <(grep -E '^(keyAlias|storePassword|keyPassword)=' "$PROPS" | sed 's/^/export /')

for required in keyAlias storePassword keyPassword; do
  if [[ -z "${!required}" ]]; then
    echo "$PROPS does not assign $required - check the spelling; an empty one fails later, as a keystore error." >&2
    exit 1
  fi
done

echo "SHA-256 fingerprints for package fr.emse.canari:"
echo "---"
keytool -list -v -keystore "$KEYSTORE" -alias "$keyAlias" -storepass "$storePassword" -keypass "$keyPassword" 2>/dev/null \
  | grep -E 'SHA256:' \
  | sed 's/.*SHA256: //' \
  | tr -d ' '

echo "---"
echo "Add to GitHub secret ANDROID_APP_LINK_SHA256 (comma-separated), then redeploy frontend."
echo "Example .env for local build:"
echo "VITE_ANDROID_APP_LINK_SHA256=<paste fingerprints above>"
