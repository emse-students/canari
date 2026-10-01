#!/usr/bin/env bash
#
# Self-tests for `bench-observables.sh` - the assertion that a store iOS archive carries none of
# the bench rig's observables, and that a bench build carries all of them.
#
# Driven against FAKE bundles, because the two cases that matter are the ones a green release never
# shows: a store archive that DOES carry a marker, and a bench build missing one (which is what a
# marker drifting from its source looks like, and what would otherwise make `absent` pass for ever).
#
# Usage: bash .github/scripts/tests/bench-observables.test.sh   (no arguments, no network, no Xcode)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../bench-observables.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0

# A fake .app: a main binary and an extension binary, holding the given markers among binary noise.
make_app() {
  local name="$1"
  shift
  rm -rf "${work:?}/$name"
  mkdir -p "$work/$name/canari.app/PlugIns/canari_NSE.appex"
  printf '\x00\x01noise\x00' > "$work/$name/canari.app/canari"
  printf '\x00\x02noise\x00' > "$work/$name/canari.app/PlugIns/canari_NSE.appex/canari_NSE"
  for marker in "$@"; do
    case "$marker" in
      nse) printf '\x00[CanariNSE] filed interruptionLevel=\x00' >> "$work/$name/canari.app/PlugIns/canari_NSE.appex/canari_NSE" ;;
      *) printf '\x00%s\x00' "$marker" >> "$work/$name/canari.app/canari" ;;
    esac
  done
}

expect() {
  local label="$1" want_status="$2" dir="$3" mode="$4"
  local out status
  out="$(bash "$script" "$dir" "$mode" 2>&1)"
  status=$?
  if [[ "$status" -eq "$want_status" ]]; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label - exit ${status}, wanted ${want_status}: ${out}"
    failures=$((failures + 1))
  fi
}

ALL=(bench_native_store nse '[CanariPush] filed interruptionLevel=')

make_app clean
expect 'a store bundle with no marker passes absent' 0 "$work/clean" absent
expect 'the same bundle FAILS present - nothing to find is not a bench build' 1 "$work/clean" present

make_app bench "${ALL[@]}"
expect 'a bench bundle with every marker passes present' 0 "$work/bench" present
expect 'the same bundle FAILS absent - a store build may carry none' 1 "$work/bench" absent

make_app leaky bench_native_store
expect 'ONE marker in a store bundle is enough to fail absent' 1 "$work/leaky" absent
expect 'a bench bundle missing the extension marker fails present' 1 "$work/leaky" present

make_app nse_only nse
expect 'a marker inside the EXTENSION binary is found too' 1 "$work/nse_only" absent

expect 'a directory that does not exist is a usage error, never a pass' 2 "$work/absent" absent
expect 'an unknown mode is a usage error' 2 "$work/clean" maybe

if [[ "$failures" -gt 0 ]]; then
  echo "bench-observables: ${failures} FAILURE(S)"
  exit 1
fi
echo "bench-observables: all cases pass"
