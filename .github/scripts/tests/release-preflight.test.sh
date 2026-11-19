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
#   classify_stable_source gate 4 for a stable: it builds EXACTLY its latest pre-release's commit,
#                          whatever `main` holds (owner, 2026-11-14).
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

printf '\na stable builds exactly its latest pre-release, whatever main holds\n'
# =================================================================================================
# OWNER, 2026-11-14: "La stable devrait toujours etre build depuis la derniere alpha, independamment
# de main." The resolve step of release.yml derives the commit; before this gate nothing asserted it,
# so main's head (what the stable's own tag names when typed against main) passed gates 2 and 4.
ALPHA=fa1bc265595c88c0a864e0f97168a8383c498c92
MAIN_HEAD=640aa34b2e09a2d55fe0eac8e87021839d41dab0
source_of() {
  local want="$1" what="$2"; shift 2
  local got; got="$(classify_stable_source "$@")"
  if [ "$got" = "$want" ]; then pass "$what"; else fail "$what - expected '$want', got '$got'"; fi
}
if ! declare -F classify_stable_source >/dev/null; then
  fail 'classify_stable_source does not exist - nothing asserts which commit a stable builds'
  classify_stable_source() { printf 'missing\n'; }
fi
source_of "exact v1.6.12-alpha.2" "the latest alpha's own commit is what the stable builds" \
  "$ALPHA" v1.6.12-alpha.2 "$ALPHA"
source_of "mismatch v1.6.12-alpha.2 $ALPHA" "main's head is refused, even though main contains the alpha" \
  "$MAIN_HEAD" v1.6.12-alpha.2 "$ALPHA"
source_of 'undecidable no pre-release of this version exists' 'a stable with no alpha is refused' \
  "$ALPHA" '' ''
source_of 'undecidable the commit of v1.6.12-alpha.2 could not be read (nothing)' \
  'an unreadable alpha commit is not permission' "$ALPHA" v1.6.12-alpha.2 ''
source_of 'undecidable the target fa1bc265 is not a full commit sha' \
  'a short target is not compared by prefix' fa1bc265 v1.6.12-alpha.2 "$ALPHA"
# AND THE PREFLIGHT ASKS IT: a classifier nothing calls asserts nothing.
# shellcheck disable=SC2016 # the pattern is the script's literal text
if grep -qF 'SOURCE="$(classify_stable_source "$TARGET_SHA" "$ALPHA_TAG" "$ALPHA_SHA")"' \
  "$HERE/../release-preflight.sh"; then
  pass "release-preflight.sh asks gate 4's first question of every stable"
else
  fail "release-preflight.sh never compares the stable's commit with its latest pre-release's"
fi

printf '\nand its tag was published on that commit, so the workflow files come from the alpha too\n'
# =================================================================================================
# LEAD, 2026-11-14. GitHub runs a release event's workflow files (and every workflow_call callee)
# from the commit the tag named AT PUBLICATION. v1.6.12 was typed against main, so its production
# deploy ran main's serve-prod.yml around the alpha's tree. The same classifier judges the published
# commit (github.sha, handed in as PUBLISHED_SHA), and anything but the alpha's commit is refused.
source_of "mismatch v1.6.12-alpha.2 $ALPHA" 'a stable tag typed against main is refused (the v1.6.12 case)' \
  "$MAIN_HEAD" v1.6.12-alpha.2 "$ALPHA"
source_of 'undecidable the target (empty) is not a full commit sha' \
  'a published commit nobody handed in is not permission' '' v1.6.12-alpha.2 "$ALPHA"
# shellcheck disable=SC2016 # the patterns are the files' literal text
if grep -qF 'PUBLISHED="$(classify_stable_source "${PUBLISHED_SHA:-}" "$ALPHA_TAG" "$ALPHA_SHA")"' \
  "$HERE/../release-preflight.sh" &&
  grep -qF 'gh release create v$VERSION --target $ALPHA_SHA --generate-notes' "$HERE/../release-preflight.sh"; then
  pass 'release-preflight.sh judges the published commit and names the --target command to type'
else
  fail "release-preflight.sh never compares the stable tag's published commit with the alpha's"
fi
# shellcheck disable=SC2016 # a GitHub expression, not a shell one
if grep -qF 'PUBLISHED_SHA: ${{ github.sha }}' "$HERE/../../workflows/release.yml"; then
  pass 'release.yml hands the published commit (github.sha) to the gates'
else
  fail 'release.yml does not hand PUBLISHED_SHA to the gates, so the published-commit check reads nothing'
fi

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
if [ "$PARTIAL_EXIT" -ne 0 ] && grep -q 'REFUSE  could not tell whether a newer release exists - the tag list could not be read' <<<"$PARTIAL"; then
  pass 'a tag listing that fails after page one refuses the release'
else
  fail "a failed tag listing was not refused (exit $PARTIAL_EXIT): $PARTIAL"
fi
if grep -q 'page 2 lost' <<<"$PARTIAL"; then
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
if grep -q 'gh release create v1.5.2-alpha.1 --prerelease' <<<"$AFTER_STABLE"; then
  pass "after this version's stable shipped, the refusal names the next patch's alpha.1"
else
  fail "the refusal after the stable does not name v1.5.2-alpha.1: $AFTER_STABLE"
fi

# And the gate is WIRED: a classifier nobody calls protects nothing.
GATE2B="$(sed -n "/^if \[ \"\$KIND\" = 'prerelease' \]; then/,/^fi/p" "$HERE/../release-preflight.sh")"
for needle in 'matching-refs/tags/v' 'classify_prerelease_currency' 'scripts/bump-app-version.sh' 'cut a NEW pre-release'; do
  if grep -qF "$needle" <<<"$GATE2B"; then
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
  if grep -qF "$needle" <<<"$GATE3"; then
    pass "the 'never ran' refusal mentions: $needle"
  else
    fail "the 'never ran' refusal no longer mentions: $needle"
  fi
done

printf '\ngate 6: a held migration added since what production serves refuses the tag without the approval\n'
# =================================================================================================
# THE DEPLOY REFUSES IT ANYWAY, AT THE END. This asks the tree, before anything moves, through the
# deploy's own judge. A throwaway repository: the commit production serves (tagged v1.0.0 here; the
# preflight passes the prod-released commit), then a release adding files.
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
# An EDIT of a file production already applied: the deploy never re-applies it, so gate 6 must not
# judge it either (final review of #2873 - the first version diffed AMR and would have refused this).
printf -- '-- a comment added later\nALTER TABLE t DROP COLUMN old;\n' >"$GREPO/$MIG/001_history.sql"
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
  pass "an additive file passes, and a destructive file production already applied is not asked again, EDITED or not"
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
if grep -qF 'held_migrations_since "$PROD_SHA" HEAD' "$PREFLIGHT" && grep -qF 'infrastructure/lib/migration-hold.sh' "$PREFLIGHT"; then
  pass "release-preflight.sh asks gate 6 through this function and the deploy's hold library"
else
  fail "release-preflight.sh does not run gate 6"
fi
# THE BASE IS WHAT PRODUCTION SERVES, NOT THE LATEST STABLE TAG (review of #2873): a stable whose
# deploy failed is not in production's ledger, so diffing from its tag skipped its held files.
# `prod-released` is moved by the production deploy itself, after the migrations ran.
# shellcheck disable=SC2016 # the patterns are the script's literal text
if grep -qF 'PROD_SHA="$(gh api "repos/$REPO/git/ref/tags/prod-released" --jq '"'"'.object.sha'"'"')"' "$PREFLIGHT" &&
  ! grep -qE 'prerelease == false\) \| \.tag_name' "$PREFLIGHT"; then
  pass "gate 6 diffs from prod-released (what production's ledger has), not from the latest stable tag"
else
  fail "gate 6 does not diff from the prod-released marker"
fi

printf '\ngate 7: a stable is refused while an advisory touches what it ships (owner, 2026-11-17)\n'
# =================================================================================================
# THE AUDIT'S THREE EXITS, AND ONLY ONE OF THEM IS PERMISSION. An outage is not a clean tree: a
# stable whose shipped closure nobody audited has no evidence, so it is refused like an advisory,
# and anything the script never returns is undecidable - a refusal too.
shipped() {
  local got
  got="$(classify_shipped_audit "$1")"
  if [ "$got" = "$2" ]; then pass "$3"; else fail "$3 - expected '$2', got '$got'"; fi
}
shipped 0 'clean'          'exit 0 is a clean production closure, the only permission'
shipped 1 'advisory'       'exit 1 is an advisory in what ships'
shipped 2 'unanswered'     'exit 2 is an unanswered registry, told apart so the refusal says why'
shipped 127 'undecidable 127' 'any other exit decides nothing'
shipped '' 'undecidable nothing' 'no exit at all decides nothing'
# shellcheck disable=SC2016 # the patterns are the script's literal text
if grep -qF 'source "$HERE/lib/audit-trees.sh"' "$PREFLIGHT" && grep -qxF '  shipped_closure_gate' "$PREFLIGHT"; then
  pass "release-preflight.sh asks gate 7 through shipped_closure_gate and the pull-request audit's own table"
else
  fail "release-preflight.sh does not run gate 7 from lib/audit-trees.sh"
fi

# THE LOOP ITSELF, against a fake audit: what it refuses, what evidence it prints, and how few
# attempts an outage costs after the first tree. The fake answers per tree from a file
# (`<tree> <exit> <one output line>`) and logs the AUDIT_ATTEMPTS each call was given.
# shellcheck source-path=SCRIPTDIR source=../lib/audit-trees.sh
source "$HERE/../lib/audit-trees.sh"
G7="$(mktemp -d)"
cat >"$G7/audit.sh" <<'FAKE'
#!/usr/bin/env bash
line="$(grep -m 1 -F "$1 " "$G7_ANSWERS")"
printf '%s attempts=%s\n' "$1" "${AUDIT_ATTEMPTS:-default}" >>"$G7_CALLS"
rest="${line#* }"
printf '%s\n' "${rest#* }"
exit "${rest%% *}"
FAKE
# gate7 <answers file content>: runs the loop with stub printers, sets G7_OUT and G7_REFUSED.
gate7() {
  printf '%s\n' "$1" >"$G7/answers"
  : >"$G7/calls"
  G7_OUT="$(
    FAILED=0
    ok() { printf 'OK %s\n' "$1"; }
    refuse() { FAILED=1; printf 'REFUSE %s\n' "$1"; }
    hint() { printf 'HINT %s\n' "$1"; }
    G7_ANSWERS="$G7/answers" G7_CALLS="$G7/calls" GITHUB_RUN_ID=4242 AUDIT_SCRIPT="$G7/audit.sh" shipped_closure_gate
    printf 'FAILED=%s\n' "$FAILED"
  )"
}
# answers <index> <exit> <line>: every tree clean except the one at <index> (-1: none).
answers() {
  local i=0 t
  for t in "${AUDIT_TREES[@]}"; do
    if [ "$i" -eq "$1" ]; then printf '%s %s %s\n' "$t" "$2" "$3"; else printf '%s 0 No vulnerabilities found\n' "$t"; fi
    i=$((i + 1))
  done
}

gate7 "$(answers -1 0 none)"
if grep -qx 'FAILED=0' <<<"$G7_OUT" && [ "$(grep -c '^OK ' <<<"$G7_OUT")" -eq "${#AUDIT_TREES[@]}" ] && ! grep -q '^HINT' <<<"$G7_OUT"; then
  pass "every tree clean: gate 7 passes, one ok per tree, no evidence printed"
else
  fail "a clean table did not pass cleanly: $G7_OUT"
fi

gate7 "$(answers 1 1 'high: typeorm > tinyglobby > picomatch GHSA-zzzz')"
if grep -qx 'FAILED=1' <<<"$G7_OUT" && grep -qF 'HINT   | high: typeorm > tinyglobby > picomatch GHSA-zzzz' <<<"$G7_OUT"; then
  pass "an advisory refuses, and its WHOLE output (package and path) is the evidence"
else
  fail "an advisory refusal lost its evidence: $G7_OUT"
fi

gate7 "$(answers 2 1 'error: something nobody has seen before')"
if grep -qx 'FAILED=1' <<<"$G7_OUT" && grep -qF 'HINT   | error: something nobody has seen before' <<<"$G7_OUT"; then
  pass "an exit 1 that names no advisory still refuses WITH what it printed"
else
  fail "an unrecognised exit 1 refused without evidence: $G7_OUT"
fi

gate7 "$(answers 0 7 'Segmentation fault')"
if grep -qx 'FAILED=1' <<<"$G7_OUT" && grep -qF 'exited 7, which is no verdict' <<<"$G7_OUT" && grep -qF 'HINT   | Segmentation fault' <<<"$G7_OUT"; then
  pass "an exit that is no verdict refuses, with its output"
else
  fail "an undecidable exit was not refused with evidence: $G7_OUT"
fi

gate7 "$(answers 0 2 'error: POST advisories/bulk - 503')"
first_attempts="$(sed -n 1p "$G7/calls")"
later_attempts="$(sed -n '2,$p' "$G7/calls" | grep -vc 'attempts=1$')"
if grep -qx 'FAILED=1' <<<"$G7_OUT" && grep -qF 'gh run rerun 4242' <<<"$G7_OUT" &&
  [ "$first_attempts" = "${AUDIT_TREES[0]} attempts=default" ] && [ "$later_attempts" -eq 0 ]; then
  pass "an outage refuses naming 'gh run rerun <run>', and every later tree is asked ONCE"
else
  fail "the outage path: first '$first_attempts', later calls not at 1: $later_attempts; $G7_OUT"
fi
rm -rf "$G7"

printf '\ngate 8: a stable is refused unless production MiConnect would take its pin (review of #3486, 2026-11-19)\n'
# =================================================================================================
# THE MORNING'S VERDICT, CARRIED TO THE PREFLIGHT: its MiConnect step runs after both stores took the
# version, so a refusal there ships half a stable. Only a SUCCESS on the very pin this stable ships is
# permission; another pin says nothing, an absent run is no evidence, an unreadable pin decides nothing.
mic() {
  local got
  got="$(classify_miconnect_preflight "$1" "$2" "$3")"
  if [ "$got" = "$4" ]; then pass "$5"; else fail "$5 - expected '$4', got '$got'"; fi
}
mic success g/s:2026.8.5 g/s:2026.8.5 'passed' 'a success on this very pin is the only permission'
mic failure g/s:2026.8.5 g/s:2026.8.5 'failed failure' 'a failure on this pin refuses'
mic cancelled g/s:2026.8.5 g/s:2026.8.5 'failed cancelled' 'a run that did not finish refuses'
mic success g/s:2026.8.0 g/s:2026.8.5 'stale g/s:2026.8.0' 'a success on ANOTHER pin is stale, never permission'
mic '' g/s:2026.8.5 g/s:2026.8.5 'absent' 'no run is no evidence'
case "$(classify_miconnect_preflight success '' g/s:2026.8.5)" in
  undecidable*) pass 'a pin the run judged that cannot be read decides nothing' ;;
  *) fail 'an unreadable judged pin was taken as an answer' ;;
esac
if grep -qxF '  miconnect_preflight_gate' "$PREFLIGHT"; then
  pass 'release-preflight.sh asks gate 8 through miconnect_preflight_gate'
else
  fail 'release-preflight.sh does not run gate 8'
fi

# THE READING, against a fake `gh`: the stable's own commit first, then main's newest commits; the
# check run's conclusion and link; the compose file of the commit it ran on.
G8="$(mktemp -d)"
mkdir -p "$G8/bin" "$G8/tree/infrastructure/authentik"
cat >"$G8/bin/gh" <<'FAKE'
#!/usr/bin/env bash
all="$*"
case "$all" in
  *"commits?sha=main"*) cat "$G8_DIR/main" ;;
  *"/check-runs"*) sha="${all#*commits/}"; sha="${sha%%/*}"; if [ -f "$G8_DIR/check-$sha" ]; then cat "$G8_DIR/check-$sha"; fi ;;
  *"/contents/"*) sha="${all#*ref=}"; sha="${sha%% *}"; cat "$G8_DIR/compose-$sha" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$G8/bin/gh"
compose_pinning() { printf 'services:\n  server:\n    image: g/s:%s\n  worker:\n    image: g/s:%s\n' "$1" "$1"; }
compose_pinning 2026.8.5 >"$G8/tree/infrastructure/authentik/compose.yml"
# gate8: runs the loop from the released tree with stub printers, sets G8_OUT.
gate8() {
  G8_OUT="$(
    cd "$G8/tree" || exit 1
    FAILED=0
    ok() { printf 'OK %s\n' "$1"; }
    refuse() { FAILED=1; printf 'REFUSE %s\n' "$1"; }
    hint() { printf 'HINT %s\n' "$1"; }
    PATH="$G8/bin:$PATH" G8_DIR="$G8" REPO=o/r TARGET_SHA=target GITHUB_RUN_ID=4242 miconnect_preflight_gate
    printf 'FAILED=%s\n' "$FAILED"
  )"
}
printf 'm1\nm2\n' >"$G8/main"
printf 'success\thttps://run/1\n' >"$G8/check-m2"
compose_pinning 2026.8.5 >"$G8/compose-m2"
gate8
if grep -qx 'FAILED=0' <<<"$G8_OUT" && grep -qF 'https://run/1' <<<"$G8_OUT"; then
  pass "the morning run on main, on this pin, green: gate 8 passes, naming the run"
else
  fail "a green morning run on this pin did not pass: $G8_OUT"
fi
printf 'failure\thttps://run/2\n' >"$G8/check-m1"
compose_pinning 2026.8.5 >"$G8/compose-m1"
gate8
if grep -qx 'FAILED=1' <<<"$G8_OUT" && grep -qF 'https://run/2' <<<"$G8_OUT" && grep -qF 'gh run rerun 4242' <<<"$G8_OUT"; then
  pass "the NEWEST run is read: a red one refuses, naming it and the remedy"
else
  fail "a newer red run did not refuse: $G8_OUT"
fi
printf 'success\thttps://run/3\n' >"$G8/check-target"
compose_pinning 2026.8.5 >"$G8/compose-target"
gate8
if grep -qx 'FAILED=0' <<<"$G8_OUT" && grep -qF 'https://run/3' <<<"$G8_OUT"; then
  pass "a run dispatched on the stable's own commit is read first"
else
  fail "the stable's own commit was not read first: $G8_OUT"
fi
rm -f "$G8/check-target" "$G8/check-m1"
compose_pinning 2026.8.0 >"$G8/compose-m2"
gate8
if grep -qx 'FAILED=1' <<<"$G8_OUT" && grep -qF 'judged g/s:2026.8.0, not the g/s:2026.8.5' <<<"$G8_OUT"; then
  pass "a green run on ANOTHER pin refuses as stale"
else
  fail "a run on another pin was taken as permission: $G8_OUT"
fi
rm -f "$G8/check-m2"
gate8
if grep -qx 'FAILED=1' <<<"$G8_OUT" && grep -qF "no completed 'MiConnect production preflight' run" <<<"$G8_OUT"; then
  pass "no run at all refuses, saying none was found"
else
  fail "an absent run did not refuse: $G8_OUT"
fi
rm -rf "$G8"

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
