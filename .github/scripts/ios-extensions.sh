#!/usr/bin/env bash
#
# Asserts that a built iOS app carries EXACTLY its two app extensions - the Notification Service
# Extension and the Share Extension - in `PlugIns/`.
#
#   bash .github/scripts/ios-extensions.sh <path/to/Canari.app>
#
# WHY AN ASSERTION. An extension is embedded by a copy phase of the hand-maintained
# `project.pbxproj`, and an app without one still builds, signs, uploads and launches: Canari simply
# stops decrypting killed-app pushes, or disappears from the share sheet, and only a phone shows it.
# Both `ios.yml` builds (the store archive and the unsigned bench build) run this on the bundle they
# produced. `EXPECTED` is pinned against the pbxproj's product names by
# `frontend/src/lib/mobile/iosShareExtension.test.ts`.
set -euo pipefail

EXPECTED=(
  'CanariNotifications.appex'
  'CanariShare.appex'
)

app="${1:-}"
if [[ -z "$app" || ! -d "$app" ]]; then
  echo "::error::ios-extensions: '${app}' is not a directory - pass the built .app"
  exit 2
fi

found=()
if [[ -d "$app/PlugIns" ]]; then
  while IFS= read -r name; do
    found+=("$name")
  done < <(find "$app/PlugIns" -mindepth 1 -maxdepth 1 -name '*.appex' -exec basename {} \; | LC_ALL=C sort)
fi

want="$(printf '%s\n' "${EXPECTED[@]}" | LC_ALL=C sort)"
have="$(printf '%s\n' "${found[@]+"${found[@]}"}" | sed '/^$/d')"
if [[ "$have" != "$want" ]]; then
  echo "::error::the app embeds [${have//$'\n'/, }] but must embed exactly [${want//$'\n'/, }] - an extension is missing from, or extra in, the pbxproj's Embed Foundation Extensions phase"
  exit 1
fi
echo "app extensions: ${want//$'\n'/, }"
