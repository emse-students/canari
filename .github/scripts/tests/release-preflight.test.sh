#!/usr/bin/env bash
# =================================================================================================
# MAY THIS RELEASE START - the two decisions, on inputs the API will not produce on demand.
#
# `release-preflight.sh` is the only thing standing between a published release and a deployment to
# production, and its two judgements live in `lib/release-preconditions.sh` so they can be exercised
# here rather than by publishing releases:
#
#   release_kind           the hyphen IS the definition of a pre-release, and the same rule decides
#                          the target estate and the store version band. Getting it wrong sends an
#                          alpha to production.
#   classify_on_main       gate 2: the commit is on `main` - containment only, since no release
#                          pushes to `main` any more (2026-10-30).
#   classify_prerelease_currency  gate 2 for a pre-release: nothing with a higher store build
#                          number was released already - a rerun of a stale alpha would move dev back.
#   classify_dev_coverage  whether the dev estate has already served the commit being shipped. An
#                          inverted reading here reports a lagging estate as healthy, which is the
#                          one thing the check exists to prevent.
#
# Both fail CLOSED: an unreadable answer is a refusal, never permission. That half is what a live
# run never reaches, and it is most of what is asserted below.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `source-path` IS PER-COMMAND AND NOT PER-FILE - shellcheck answers SC1091 without this copy.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/release-preconditions.sh
source "$HERE/../lib/release-preconditions.sh"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

# kind <version> <expected verdict> <what it means>
kind() {
  local got
  got="$(release_kind "$1")"
  if [ "$got" = "$2" ]; then pass "$3"; else fail "$3 - expected '$2', got '$got'"; fi
}

# cover <payload> <expected verdict> <what it means>
#
# `printf '%s\n'` and not `printf '%s'`: the classifier reads with `read`, which needs the last line
# TERMINATED, and the caller renders it the same way. A payload whose final line has no newline is a
# different input.
cover() {
  local got
  got="$(printf '%s\n' "$1" | classify_dev_coverage)"
  if [ "$got" = "$2" ]; then pass "$3"; else fail "$3 - expected '$2', got '$got'"; fi
}

# onmain <compare status> <expected verdict> <what it means>
onmain() {
  local got
  got="$(classify_on_main "$1")"
  if [ "$got" = "$2" ]; then pass "$3"; else fail "$3 - expected '$2', got '$got'"; fi
}

printf '\nthe hyphen is the definition of a pre-release\n'
# =================================================================================================
kind '0.15.0'          'stable'               'a bare major.minor.patch is a stable release'
kind 'v0.15.0'         'stable'               'a leading v is stripped, because a tag carries one and an input does not'
kind '0.15.0-alpha.1'  'prerelease alpha.1'   'a hyphen makes it a pre-release, and the label is carried out'
kind '1.0.0-beta.12'   'prerelease beta.12'   'the label is not assumed to be alpha - nothing here restricts it'
kind '0.15.0-rc1'      'prerelease rc1'       'a label with no dot is still a label'

printf '\nand a version that is not one is refused, never guessed at\n'
# =================================================================================================
# A TYPO MUST NOT REACH THE STORE BAND. `(major*1e6 + minor*1e3 + patch)*100 + rank` is computed
# from these numbers and Play refuses a code it has already accepted, so a malformed version that
# was "interpreted" costs a release slot permanently.
kind ''                'invalid version is empty'                             'an empty version is refused'
kind '0.15'            'invalid 0.15 is not major.minor.patch[-label]'         'two components are not three'
kind '0.15.0.1'        'invalid 0.15.0.1 is not major.minor.patch[-label]'     'four components are not three'
kind '0.15.0-'         'invalid 0.15.0- is not major.minor.patch[-label]'      'a hyphen with no label is refused'
kind 'x'               'invalid x is not major.minor.patch[-label]'            'a word is not a version'
kind '0.15.0 '         'invalid 0.15.0  is not major.minor.patch[-label]'      'a trailing space is refused rather than trimmed'

printf '\nhas dev already served the commit being shipped?\n'
# =================================================================================================
# THE BASE IS THE COMMIT BEING SHIPPED AND THE HEAD IS DEV, so GitHub's own words read the way a
# person would say them. These two assertions are what that choice buys, and they are the pair an
# inverted implementation gets backwards.
cover 'identical
0
0' 'covered identical' 'dev at exactly this commit is the normal, intended case'

cover 'ahead
2
0' 'covered ahead 2' 'dev further on has been through this code, so it is covered'

cover 'behind
0
3' 'uncovered behind 3' 'dev missing 3 commits this release carries is the refusal that matters'

cover 'diverged
1
2' 'uncovered diverged 1 2' 'neither containing the other is not coverage either'

printf '\na zero count is a count, not an absence\n'
# =================================================================================================
# `0` is falsy in most languages a reader might have in mind, and a guard written as "if the count
# is set" would turn a real verdict into undecidable.
cover 'ahead
0
0' 'covered ahead 0' 'ahead by 0 still resolves to a verdict rather than to undecidable'

printf '\nand every malformed payload is a REFUSAL, not permission\n'
# =================================================================================================
# UNDECIDABLE IS A VERDICT. What must never happen is a malformed payload reading as covered, which
# would let a release past on no evidence at all.
cover ''            'undecidable payload has no ahead_by line'   'a compare that could not be read is refused'
cover 'identical'   'undecidable payload has no ahead_by line'   'one line is not three'
cover 'identical
0'                  'undecidable payload has no behind_by line'  'two lines are not three'
cover 'identical
0
0
extra'              'undecidable payload has more than three lines' 'a fourth line means this is not the payload the caller rendered'
cover '
0
0'                  'undecidable status is empty'                'an empty status is refused rather than defaulted'
cover 'unknown
0
0'                  'undecidable unknown status unknown'         'a status the API has never returned is refused by name'
cover 'identical
x
0'                  'undecidable ahead_by/behind_by are not both numeric' 'a count that is not a number is refused'
cover 'identical
x
x'                  'undecidable ahead_by/behind_by are not both numeric' 'the counts are validated even for a status that does not read them'

if [ "$(printf '' | classify_dev_coverage)" = 'undecidable empty payload' ]; then
  pass 'no input at all is refused as an empty payload'
else
  fail "no input at all: got '$(printf '' | classify_dev_coverage)'"
fi

printf '\nthe CRLF payload, refused rather than misread (measured 2026-09-03)\n'
# =================================================================================================
# A REAL INCIDENT. The first caller rendered the payload with python, and python on Windows writes
# its newlines as CRLF; the carriage return survived `read` and arrived as part of the status, so a
# pair that was measured perfectly well came back as an unknown status. The caller renders with
# `gh --jq` now.
#
# THE REFUSAL IS THE RIGHT ANSWER AND THAT IS WHAT IS ASSERTED. Trimming the CR here would have
# hidden a broken renderer instead, and a renderer nobody knows is broken breaks something else next.
CRLF_VERDICT="$(printf 'identical\r\n0\r\n0\r\n' | classify_dev_coverage)"
case "$CRLF_VERDICT" in
  'undecidable'*) pass 'a CRLF payload is refused, not silently misread' ;;
  *)              fail "a CRLF payload resolved to '$CRLF_VERDICT' - it must not be readable" ;;
esac

printf '\ngate 2 asks containment, and main moving on after the cut refuses nothing\n'
# =================================================================================================
# THE CASE THIS GATE USED TO REFUSE. Until 2026-10-30 a pre-release bump pushed to `main`, so
# `ahead` (something merged after the cut) refused it - `v1.5.1-alpha.3` here, `v1.5.1-alpha.5`
# at the push itself. Every bump goes to `release/vX.Y.Z` now, so `ahead` is the ordinary case.
onmain identical 'on-main identical' 'main IS the released commit'
onmain ahead 'on-main ahead' \
  'main moved on after the cut - a pull request merging meanwhile no longer refuses the release'
onmain behind 'off-main behind' 'a commit main does not contain has not been through a pull request'
onmain diverged 'off-main diverged' 'nor has one on a history main never carried'
onmain '' 'undecidable status is empty' \
  'an empty status is an unreadable compare, which is never permission'
onmain weird 'undecidable unknown status weird' 'and a status this does not know is not a guess'

printf '\nwhich pre-release a stable ships\n'
latest() { printf '%s\n' "${@:2}" | latest_prerelease_tag "$1"; }
check_latest() {
  local want="$1" ver="$2"; shift 2
  local got; got="$(latest "$ver" "$@")"
  if [ "$got" = "$want" ]; then PASS=$((PASS + 1)); printf '  ok    %s\n' "latest of $ver -> ${want:-none}"
  else FAIL=$((FAIL + 1)); printf '  FAIL  latest of %s: wanted %s, got %s\n' "$ver" "${want:-none}" "$got"; fi
}
check_latest v1.0.1-alpha.10 1.0.1 v1.0.1-alpha.2 v1.0.1-alpha.10 v1.0.1-alpha.9
check_latest v1.0.1-alpha.2 1.0.1 v1.0.1-alpha.2 v1.0.2-alpha.7 v1.0.10-alpha.1 v1.0.1
check_latest '' 1.0.1 v1.0.2-alpha.1 v1.0.1 v1.0.11-alpha.1
check_latest '' 1.0.1

printf '\na pre-release older than one already released is refused, not redeployed\n'
# =================================================================================================
# THE GAP THE OLD GATE 2 CLOSED BY ACCIDENT. `main still points at it` refused any stale alpha; with
# the bump off `main` (2026-10-30) a rerun of a refused `alpha.5` after `alpha.6` shipped would move
# `release/vX.Y.Z` and `dev-deployed` back and upload a lower store build. The order is the store
# band, read from the real `bump-app-version.sh --code`.
BUMP_SCRIPT="$HERE/../../../scripts/bump-app-version.sh"
currency() {
  local want="$1" ver="$2" what="$3"; shift 3
  local got; got="$(printf '%s\n' "$@" | classify_prerelease_currency "$ver" "$BUMP_SCRIPT")"
  if [ "$got" = "$want" ]; then pass "$what"; else fail "$what - expected '$want', got '$got'"; fi
}
currency 'stale v1.5.1-alpha.6' 1.5.1-alpha.5 \
  'a rerun of alpha.5 after alpha.6 shipped is refused' \
  v1.5.0 v1.5.1-alpha.4 v1.5.1-alpha.5 v1.5.1-alpha.6 dev-deployed
currency 'current' 1.5.1-alpha.6 'the latest alpha of the newest version passes' \
  v1.5.0 v1.5.1-alpha.4 v1.5.1-alpha.5 v1.5.1-alpha.6
currency 'stale v1.5.1-alpha.10' 1.5.1-alpha.9 'alpha.10 ranks above alpha.9 (band order, not text)' \
  v1.5.1-alpha.9 v1.5.1-alpha.10
currency 'superseded v1.5.2-alpha.1' 1.5.1-alpha.6 \
  'a higher store number on ANOTHER version refuses it too' \
  v1.5.1-alpha.6 v1.5.2-alpha.1
currency 'superseded v1.5.1' 1.5.1-alpha.6 "and so does this version's own stable" \
  v1.5.1-alpha.6 v1.5.1
currency 'current' 1.5.2-alpha.1 'a tag the band cannot parse orders nothing' \
  v1.5.1 v1.5.2-alpha.1 v9.9.9-beta.1 vNOT
currency 'undecidable no tag was listed' 1.5.2-alpha.1 'an empty tag list is unreadable, never permission'
currency 'undecidable 1.5.2-rc.1 has no store band' 1.5.2-rc.1 'a version with no store band is refused' \
  v1.5.2-rc.1
currency 'undecidable v1.5.1-alpha.5 itself is not in the tag list, so the list is incomplete' \
  1.5.1-alpha.5 "a list missing the release's own tag is partial, never permission" \
  v1.5.0 v1.5.1-alpha.4

# A PAGINATION THAT FAILS AFTER PAGE ONE. Refs come back in name order, so `v1.10.*` sits on an
# earlier page than `v1.5.*` and a lost page can hold the higher release. The real preflight runs
# against a stub `gh` whose tag listing prints a partial page and then fails: it must refuse, and
# say why, rather than classify what arrived.
STUB="$(mktemp -d)"
cat > "$STUB/gh" <<'STUBGH'
#!/usr/bin/env bash
case "$*" in
  *matching-refs*) printf 'v1.5.1-alpha.5\n'; echo 'HTTP 502: page 2 lost' >&2; exit 1 ;;
  *compare*)       printf 'identical\n' ;;
  *check-runs*)    printf 'success\n' ;;
  *)               exit 1 ;;
esac
STUBGH
chmod +x "$STUB/gh"
PARTIAL="$(PATH="$STUB:$PATH" VERSION=1.5.1-alpha.5 TARGET_SHA=0123456789abcdef REPO=o/r \
  bash "$HERE/../release-preflight.sh" 2>&1)"
PARTIAL_EXIT=$?
rm -rf "$STUB"
if [ "$PARTIAL_EXIT" -ne 0 ] && printf '%s' "$PARTIAL" | grep -q 'REFUSE  could not tell whether a newer release exists - the tag list could not be read'; then
  pass 'a tag listing that fails after page one refuses the release'
else
  fail "a failed tag listing was not refused (exit $PARTIAL_EXIT): $PARTIAL"
fi
if printf '%s' "$PARTIAL" | grep -q 'page 2 lost'; then
  pass "and the refusal carries gh's own error"
else
  fail "the refusal dropped gh's error: $PARTIAL"
fi

# When the newer tag is this version's own STABLE, no alpha of it can follow: the hint names the next
# patch's first pre-release.
STUB="$(mktemp -d)"
cat > "$STUB/gh" <<'STUBGH'
#!/usr/bin/env bash
case "$*" in
  *matching-refs*) printf 'v1.5.1\nv1.5.1-alpha.6\n' ;;
  *compare*)       printf 'identical\n' ;;
  *check-runs*)    printf 'success\n' ;;
  *)               exit 1 ;;
esac
STUBGH
chmod +x "$STUB/gh"
AFTER_STABLE="$(PATH="$STUB:$PATH" VERSION=1.5.1-alpha.6 TARGET_SHA=0123456789abcdef REPO=o/r \
  bash "$HERE/../release-preflight.sh" 2>&1)"
rm -rf "$STUB"
if printf '%s' "$AFTER_STABLE" | grep -q 'gh release create v1.5.2-alpha.1 --prerelease'; then
  pass "after this version's stable shipped, the refusal names the next patch's alpha.1"
else
  fail "the refusal after the stable does not name v1.5.2-alpha.1: $AFTER_STABLE"
fi

# And the gate is WIRED: a classifier nobody calls protects nothing.
GATE2B="$(sed -n "/^if \[ \"\$KIND\" = 'prerelease' \]; then/,/^fi/p" "$HERE/../release-preflight.sh")"
for needle in 'matching-refs/tags/v' 'classify_prerelease_currency' 'scripts/bump-app-version.sh' 'cut a NEW pre-release'; do
  if printf '%s' "$GATE2B" | grep -qF "$needle"; then
    pass "the preflight's pre-release currency check carries: $needle"
  else
    fail "the preflight's pre-release currency check no longer carries: $needle"
  fi
done

# THE EMERGENCY PATH IS WORDED WHERE SOMEBODY REACHING FOR IT WILL READ IT. `gh pr merge --admin`
# skips `CI passed` on the pull request, and gate 3 then refuses until main's own CI has run on the
# commit - zero minutes bought, one refused run spent (measured 2026-09-06). The refusal says what to
# wait for and that a rerun, not a new tag, is the way through.
printf '\ngate 3 explains the admin-merge refusal\n'
PREFLIGHT="$HERE/../release-preflight.sh"
GATE3="$(sed -n "/never ran on/,/^    ;;/p" "$PREFLIGHT")"
for needle in 'ADMIN-MERGED' 'own CI' 'gh run list --branch main' 'gh run rerun' 'no new tag'; do
  if printf '%s' "$GATE3" | grep -qF "$needle"; then
    pass "the 'never ran' refusal mentions: $needle"
  else
    fail "the 'never ran' refusal no longer mentions: $needle"
  fi
done

printf '\ngate 6: a held migration added since the latest stable refuses the tag without the approval\n'
# =================================================================================================
# THE DEPLOY REFUSES IT ANYWAY, AT THE END. This asks the tree, before anything moves, through the
# deploy's own judge. A throwaway repository: a stable with the history, then a release adding files.
HOLD_LIB="$HERE/../../../infrastructure/lib/migration-hold.sh"
GREPO="$(mktemp -d)"
trap 'rm -rf "$GREPO"' EXIT
MIG='apps/core-service/src/migrations'
# No hook and no signing from the machine's own configuration: this repository is a fixture.
gitq() { git -C "$GREPO" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1 || printf 'fixture git %s failed\n' "$1" >&2; }
gitq init -q
mkdir -p "$GREPO/$MIG" "$GREPO/infrastructure"
printf 'ALTER TABLE t DROP COLUMN old;\n' >"$GREPO/$MIG/001_history.sql"
printf '# approvals\n' >"$GREPO/infrastructure/migration-approvals.txt"
gitq add -A
gitq commit -qm stable
gitq tag v1.0.0
printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a int;\n' >"$GREPO/$MIG/002_additive.sql"
printf -- '-- canari:hold-for-owner\nUPDATE t SET a = 1;\n' >"$GREPO/$MIG/003_backfill.sql"
gitq add -A
gitq commit -qm release
held() { # -> sets $hout, $hrc
  # shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/migration-hold.sh
  hout="$(cd "$GREPO" && . "$HOLD_LIB" && held_migrations_since v1.0.0 HEAD)"
  hrc=$?
}
held
if [ "$hrc" = 1 ] && grep -q "^refused $MIG/003_backfill.sql [0-9a-f]\{64\} it carries the hold marker$" <<<"$hout"; then
  pass "a held file added since the stable, with no approval, is REFUSED by name and checksum"
else
  fail "the unapproved held file was not refused (rc $hrc): $hout"
fi
if grep -q "^plain $MIG/002_additive.sql$" <<<"$hout" && ! grep -q '001_history' <<<"$hout"; then
  pass "an additive file passes, and a destructive file the stable already shipped is not asked again"
else
  fail "the comparison judged the wrong files: $hout"
fi
sum="$(sha256sum "$GREPO/$MIG/003_backfill.sql" | cut -d' ' -f1)"
printf '%s %s\n' "$MIG/003_backfill.sql" "$sum" >>"$GREPO/infrastructure/migration-approvals.txt"
held
if [ "$hrc" = 0 ] && grep -q "^approved $MIG/003_backfill.sql$" <<<"$hout"; then
  pass "once the approvals file of the released tree names its content, it passes"
else
  fail "an approved held file was refused (rc $hrc): $hout"
fi
# shellcheck source-path=SCRIPTDIR source=../../../infrastructure/lib/migration-hold.sh
hout="$(cd "$GREPO" && . "$HOLD_LIB" && held_migrations_since v0.0.0-missing HEAD 2>/dev/null)"
hrc=$?
if [ "$hrc" = 2 ] && grep -q '^undecidable ' <<<"$hout"; then
  pass "a comparison git cannot make is UNDECIDABLE - refused by the gate, never permission"
else
  fail "a missing base was not undecidable (rc $hrc): $hout"
fi
hout="$(cd "$GREPO" && held_migrations_since v1.0.0 HEAD)"
hrc=$?
if [ "$hrc" = 2 ]; then
  pass "without the hold library loaded it decides nothing (undecidable)"
else
  fail "it judged without the deploy's own judge (rc $hrc)"
fi
# shellcheck disable=SC2016 # the pattern is the script's literal text, variables unexpanded
if grep -qF 'held_migrations_since "$BASE_TAG" HEAD' "$PREFLIGHT" && grep -qF 'infrastructure/lib/migration-hold.sh' "$PREFLIGHT"; then
  pass "release-preflight.sh asks gate 6 through this function and the deploy's hold library"
else
  fail "release-preflight.sh does not run gate 6"
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
