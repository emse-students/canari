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

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
