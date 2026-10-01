#!/usr/bin/env bash
#
# Asserts that a built iOS app bundle carries the BENCH observables exactly when it should.
#
#   bash .github/scripts/bench-observables.sh <app-or-archive-dir> present|absent
#
# THE OBSERVABLES ARE COMPILED IN, NEVER SWITCHED ON. `ios.yml` builds them only for a `local_url`
# build - the Cargo feature `bench-observables` (the Rust `bench_native_store` command) and the
# `CANARI_BENCH` condition (the notification filing lines, Swift and Objective-C) - so a store
# archive must contain NONE of them, and that is asserted here on the binary that would ship rather
# than on the flags that were supposed to produce it (docs/wiki/cross-client-ios.md).
#
# `present` IS THE HALF THAT MAKES `absent` MEAN SOMETHING. Searching the wrong directory, or for a
# marker the compiler stopped emitting verbatim, finds nothing - which `absent` would read as a pass
# for ever. Every bench build therefore proves each marker IS findable in the bundle it produced,
# with the same search, before any store build's silence is believed.
#
# A marker is a byte string from the source: the command name Tauri dispatches on, and the literal
# head of each log line. A rename in the source must be made here too, and `present` is what fails
# when it is not.
set -euo pipefail

MARKERS=(
  'bench_native_store'
  '[CanariNSE] filed interruptionLevel='
  '[CanariPush] filed interruptionLevel='
)

dir="${1:-}"
want="${2:-}"
if [[ -z "$dir" || ! -d "$dir" ]]; then
  echo "::error::bench-observables: '${dir}' is not a directory - pass the built .app or archive"
  exit 2
fi
if [[ "$want" != present && "$want" != absent ]]; then
  echo "::error::bench-observables: expected 'present' or 'absent', got '${want}'"
  exit 2
fi

failed=0
for marker in "${MARKERS[@]}"; do
  # -r every file of the bundle (the app binary, the extension's, any framework), -a binary as
  # text, -F the bytes as written, -l the file names only: a match is reported by WHERE, never by
  # the line, which in a binary is noise.
  hits="$(grep -r -a -F -l -- "$marker" "$dir" || true)"
  if [[ "$want" == absent && -n "$hits" ]]; then
    echo "::error::a STORE build carries the bench observable '${marker}' in: ${hits//$'\n'/ }"
    failed=1
  elif [[ "$want" == present && -z "$hits" ]]; then
    echo "::error::the BENCH build does not carry '${marker}' - the observable is missing, or the marker no longer matches the source (fix it here)"
    failed=1
  else
    echo "bench observable '${marker}': ${want}"
  fi
done
exit "$failed"
