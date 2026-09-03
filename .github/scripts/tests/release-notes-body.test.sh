#!/usr/bin/env bash
# =================================================================================================
# THE BODY OF A GITHUB RELEASE, COMPOSED FROM THE NOTES THAT WENT TO THE STORES
#
# `release-notes-body.sh` is a pure function of two files, so unlike the workflow around it it can
# be run - and the branches worth asserting are the ones a live release never produces: a body
# somebody edited between two runs, a body carrying a STALE block, a body with markers and nothing
# between them.
#
# THE ONE PROPERTY THAT IS SILENT WHEN WRONG IS IDEMPOTENCE. A composer that appends instead of
# replacing produces a release body that grows by one copy of the notes per re-run, and a release
# is re-run exactly when something else already went wrong - so the failure lands on top of another
# failure and reads as its consequence.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/../release-notes-body.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

BEGIN='<!-- canari-release-notes -->'
END='<!-- /canari-release-notes -->'

printf 'Ligne une des notes.\nLigne deux.' > "$TMP/notes"

compose() { bash "$SUT" "$1" "$TMP/notes"; }

printf '\nan empty body gets the notes and nothing else\n'
: > "$TMP/empty"
out="$(compose "$TMP/empty")"
expected="$(printf '%s\nLigne une des notes.\nLigne deux.\n%s' "$BEGIN" "$END")"
if [ "$out" = "$expected" ]; then
  pass 'an empty body becomes exactly the marked block'
else
  fail "an empty body produced something else:
$out"
fi

printf '\nwhat a human wrote is kept, and the notes go under it\n'
printf 'Texte ecrit a la main.\n' > "$TMP/human"
out="$(compose "$TMP/human")"
case "$out" in
  'Texte ecrit a la main.'*) pass 'the human text is still the first line' ;;
  *) fail "the human text was lost: $out" ;;
esac
if printf '%s' "$out" | grep -qF 'Ligne une des notes.'; then
  pass 'and the notes are present'
else
  fail 'the notes are missing'
fi

printf '\nIDEMPOTENCE - the property that is silent when wrong\n'
# =================================================================================================
# Compose twice, feeding the first output back in, which is exactly what a re-run of the release
# workflow does: it reads the body LIVE, so the second pass sees the block the first pass wrote.
once="$(compose "$TMP/human")"
printf '%s\n' "$once" > "$TMP/once"
twice="$(compose "$TMP/once")"
if [ "$once" = "$twice" ]; then
  pass 'composing twice gives the same body'
else
  fail "composing twice changed the body - a re-run would append a second copy of the notes:
--- once ---
$once
--- twice ---
$twice"
fi
copies="$(printf '%s\n' "$twice" | grep -cF 'Ligne une des notes.')"
if [ "$copies" -eq 1 ]; then
  pass 'and the notes appear exactly once'
else
  fail "the notes appear $copies times after two passes"
fi

printf '\na STALE block is replaced, not kept beside the new one\n'
# =================================================================================================
# The case that matters on a re-release: the body carries notes for the PREVIOUS version. Keeping
# them would publish two changelogs, and the older one is the one a reader believes - it is on top.
{
  printf 'Texte ecrit a la main.\n\n'
  printf '%s\n' "$BEGIN"
  printf 'VIEILLES notes de 0.15.0\n'
  printf '%s\n' "$END"
} > "$TMP/stale"
out="$(compose "$TMP/stale")"
if printf '%s' "$out" | grep -qF 'VIEILLES notes'; then
  fail 'the stale block survived - the release would carry two changelogs, the wrong one first'
else
  pass 'the stale block is gone'
fi
if printf '%s' "$out" | grep -qF 'Texte ecrit a la main.' &&
  printf '%s' "$out" | grep -qF 'Ligne une des notes.'; then
  pass 'and the human text and the new notes are both there'
else
  fail "one of the two is missing: $out"
fi

printf '\nthe degenerate bodies a live release never produces\n'
# =================================================================================================
# MARKERS WITH NOTHING BETWEEN THEM, which is what an interrupted run can leave. Read as "the block
# is present", a composer that only APPENDS when the markers are absent would then never write the
# notes at all - green, and the release documents nothing.
{
  printf '%s\n' "$BEGIN"
  printf '%s\n' "$END"
} > "$TMP/hollow"
out="$(compose "$TMP/hollow")"
if printf '%s' "$out" | grep -qF 'Ligne une des notes.'; then
  pass 'an empty block is filled rather than treated as already done'
else
  fail 'an empty marked block was left empty - the release would document nothing, and green'
fi
# A body that is ONLY whitespace must not push the notes down a blank line on every release.
printf '   \n\n\t\n' > "$TMP/blank"
out="$(compose "$TMP/blank")"
case "$out" in
  "$BEGIN"*) pass 'a whitespace-only body counts as empty' ;;
  *) fail "a whitespace-only body was kept as content: $(printf '%s' "$out" | head -3)" ;;
esac

printf '\nunreadable arguments are refused rather than guessed\n'
if bash "$SUT" "$TMP/does-not-exist" "$TMP/notes" >/dev/null 2>&1; then
  fail 'a missing body file was accepted - the release body would be silently replaced by the notes alone'
else
  pass 'a missing body file is refused'
fi
if bash "$SUT" "$TMP/empty" "$TMP/no-notes-here" >/dev/null 2>&1; then
  fail 'a missing notes file was accepted - the release would get an empty block'
else
  pass 'a missing notes file is refused'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%d of %d assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %d assertions passed\n' "$PASS"
