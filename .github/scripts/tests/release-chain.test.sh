#!/usr/bin/env bash
# =================================================================================================
# THE SHAPE OF THE RELEASE CHAIN
#
# WHY A SHAPE TEST AND NOT A UNIT TEST. Nothing here can be executed off GitHub: the only way to
# find out what a workflow does is to publish a release, and the cost of getting it wrong is a
# deployment that goes to the wrong estate or does not happen at all. What CAN be asserted, cheaply
# and every time, is that the chain still has the shape the three human gestures require - because
# every defect this chain has actually had was a SHAPE defect:
#
#   * four workflows chained by `workflow_run`, each re-deriving the same three facts;
#   * each arm resolving `main` for itself, so a merge mid-release could hand a store a different
#     tree from production with no artefact carrying the commit to say so;
#   * and no gate on the tests at all - the chain required the BUMP to succeed, which is a different
#     statement, and `v0.15.0` shipped on a RED run.
#
# None of those needed a bug in a script. They were all "the pieces are wired the wrong way", which
# is exactly what a file can be read for.
#
# GREP AND NOT A YAML PARSER, deliberately: this suite runs from `make test-ci-scripts` alongside
# nine other shell tests, and adding a parser dependency to say "this line is present" would be a
# new thing that can break for reasons unrelated to the chain. `bump-staging.test.sh` reads
# `release.yml` the same way, for the same reason.
# =================================================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF="$(cd "$HERE/../../workflows" && pwd)"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

for f in release.yml deploy.yml android.yml ios.yml; do
  [ -r "$WF/$f" ] || { printf 'cannot read %s\n' "$WF/$f"; exit 1; }
done

printf '\none entry point, and it is the release event\n'
# =================================================================================================
# A second workflow listening for `release: published` would deploy in parallel with this one, and
# the two would race on the bump's push.
ENTRIES="$(grep -l -E '^  release:' "$WF"/*.yml 2>/dev/null | xargs -r -n1 basename | sort | tr '\n' ' ')"
if [ "$ENTRIES" = 'release.yml ' ]; then
  pass 'release.yml is the only workflow triggered by a published release'
else
  fail "workflows triggered by a release: ${ENTRIES:-none} - expected release.yml alone"
fi

if grep -qE '^  workflow_dispatch:' "$WF/release.yml"; then
  pass 'it keeps a hand-dispatched path for re-running a release after an infrastructure fault'
else
  fail 'the hand-dispatched path is gone - a release whose chain failed could only be re-run by deleting it'
fi

printf '\nthe old fan-out is gone\n'
# =================================================================================================
# `bump-version.yml` was the workflow the three arms listened for. Its disappearance is the whole
# point: if it comes back, so does every defect above.
if [ -e "$WF/bump-version.yml" ]; then
  fail 'bump-version.yml is back - the bump belongs to release.yml, or the arms have two masters'
else
  pass 'bump-version.yml is gone; the bump is a job of release.yml'
fi

for f in deploy.yml android.yml ios.yml; do
  # A trigger, not a mention: the comments in these files explain what `workflow_run` used to do.
  if grep -qE '^  workflow_run:' "$WF/$f"; then
    fail "$f still triggers on workflow_run - it must be called, not woken"
  else
    pass "$f has no workflow_run trigger"
  fi
done

printf '\nthe three arms are called workflows, and they take the same three facts\n'
# =================================================================================================
for f in deploy.yml android.yml ios.yml; do
  if grep -qE '^  workflow_call:' "$WF/$f"; then
    pass "$f is callable"
  else
    fail "$f is not callable, so release.yml cannot use it"
  fi

  missing=''
  for i in sha version prerelease; do
    grep -qE "^      $i:" "$WF/$f" || missing="$missing $i"
  done
  if [ -z "$missing" ]; then
    pass "$f declares sha, version and prerelease"
  else
    fail "$f is missing input(s):$missing - an arm that guesses one of these can ship to the wrong place"
  fi
done

printf '\nnothing on the release path resolves main for itself\n'
# =================================================================================================
# THE DEFECT THIS CLOSES. `main` is a MOVING reference and the bump's own push raises a `push`
# event, so CI runs on `main` while the release is still going; a pull request merged in those
# minutes lands inside the run. Every arm must build the SHA it was handed.
for f in deploy.yml android.yml ios.yml; do
  if grep -qE '^ +ref: main$' "$WF/$f"; then
    fail "$f checks out 'ref: main' - it would build whatever landed while the release was running"
  else
    pass "$f never checks out main by name"
  fi
done

if grep -qE '^ +ref: \$\{\{ inputs\.sha \}\}$' "$WF/deploy.yml"; then
  pass 'deploy.yml checks out the commit it was given'
else
  fail 'deploy.yml does not check out inputs.sha'
fi

# And the caller must hand all three the SAME commit, which is the bump's output.
# shellcheck disable=SC2016  # `${{ ... }}` is GitHub Actions syntax and must reach grep
# verbatim; expanding it in the shell would search for an empty string.
ARMS_WITH_SHA="$(grep -c 'sha: \${{ needs.bump.outputs.sha }}' "$WF/release.yml")"
if [ "$ARMS_WITH_SHA" -eq 3 ]; then
  pass 'all three arms are given needs.bump.outputs.sha - one commit, one release'
else
  fail "$ARMS_WITH_SHA of 3 arms receive the bump's SHA - the others would disagree about what shipped"
fi

printf '\nthe gates run BEFORE the bump, and the bump before every arm\n'
# =================================================================================================
# THE ORDER IS THE FAIL-SAFE. Every arm needs the bump and the bump needs the preflight, so a
# refusal in the preflight refuses the deployment, both store uploads and the version bump itself.
if grep -qE '^    needs: preflight$' "$WF/release.yml"; then
  pass 'the bump needs the preflight'
else
  fail 'the bump does not need the preflight - the gates would run beside the release, not before it'
fi

ARM_NEEDS="$(grep -c '^    needs: \[preflight, bump\]$' "$WF/release.yml")"
if [ "$ARM_NEEDS" -eq 3 ]; then
  pass 'all three arms need the preflight AND the bump'
else
  fail "$ARM_NEEDS of 3 arms declare 'needs: [preflight, bump]' - see below, this is not cosmetic"
fi

# A JOB CAN ONLY READ `needs.<job>` FOR A JOB IT DECLARES, and the failure is an EMPTY STRING rather
# than an error. This was live for the length of one commit: the three arms declared `needs: bump`
# and read `needs.preflight.outputs.prerelease`, so every arm would have received `prerelease: ''`.
# For a stable that is accidentally the right answer; for an ALPHA it is catastrophic and silent -
# `ios.yml` and `android.yml` would have taken the `else` branch, baked the PRODUCTION origin into a
# tester build, and passed their own "is this pointing at the right estate" assertion while doing it.
# Green run, tester build against production.
#
# The patterns are anchored to the `with:` block's indentation on purpose: `needs.preflight.outputs.
# version` also appears inside the bump job's own steps, where it is legitimate, and an unanchored
# count would mix the two and mean nothing.
for ref in \
  '^      version: \$\{\{ needs\.preflight\.outputs\.version \}\}$' \
  '^      prerelease: \$\{\{ needs\.preflight\.outputs\.prerelease \}\}$' \
  '^      sha: \$\{\{ needs\.bump\.outputs\.sha \}\}$'; do
  n="$(grep -cE "$ref" "$WF/release.yml")"
  if [ "$n" -eq 3 ]; then
    pass "all three arms are handed ${ref##*outputs\.}, from a job they declare"
  else
    fail "$n of 3 arms are handed ${ref##*outputs\.} - an arm reading a job it does not need gets an EMPTY STRING, silently"
  fi
done

if grep -qE 'bash \.github/scripts/release-preflight\.sh' "$WF/release.yml"; then
  pass 'the preflight script is actually invoked, not merely present in the tree'
else
  fail 'release.yml does not run release-preflight.sh - the four gates would be dead code'
fi

printf '\nand the preflight still asks the question that makes the lag impossible\n'
# =================================================================================================
# A gate can be deleted by deleting one `case` arm, and the release would go on being green. This
# names the arm.
PF="$HERE/../release-preflight.sh"
if grep -q 'dev-deployed' "$PF" && grep -q 'classify_dev_coverage' "$PF"; then
  pass 'it reads the dev-deployed marker and classifies coverage'
else
  fail 'the dev-coverage gate is gone from release-preflight.sh - production could go ahead of dev again'
fi

if grep -q 'PRODUCTION CANNOT BE AHEAD OF DEV' "$PF"; then
  pass 'and it says what to do about it, which is the half a refusal is useless without'
else
  fail 'the refusal no longer tells the reader to publish a pre-release first'
fi


printf '\nand the first gesture merges itself, with the credential that keeps the chain working\n'
# =================================================================================================
# THE TRAP THIS NAMES. Auto-merge merges as whoever armed it, and a merge made by `GITHUB_TOKEN`
# raises NO `push` event - so `ci.yml` would never run on `main`, the merge commit would carry no
# `CI passed` check, and the preflight's third gate would then refuse EVERY release on a commit that
# had in fact been tested. Someone "simplifying" auto-merge.yml to the default token would break the
# release chain from a file that has nothing to do with releasing.
AM="$WF/pull-request.yml"
if [ -e "$WF/auto-merge.yml" ]; then
  fail 'auto-merge.yml is back as its own workflow - the sequence a human reads on opening a pull request is then split across two files listening for the same event'
else
  pass 'auto-merge is a job of pull-request.yml, not a second workflow on the same event'
fi

if [ -r "$AM" ]; then
  if grep -q 'create-github-app-token' "$AM"; then
    pass 'auto-merge.yml mints the App token, whose merge raises a push event'
  else
    fail 'auto-merge.yml no longer mints an App token - a GITHUB_TOKEN merge raises no push, so main gets no CI run and every release is then refused'
  fi

  # SCOPED TO THE MERGE JOB, AND IT USED TO BE A FILE-WIDE GREP. That was right while the merge was
  # the only thing in this file holding a token, and it broke the day `dependency-ceiling` landed -
  # a job that legitimately reads with `github.token`, has nothing to do with merging, and tripped
  # a check about the merge credential. **A predicate that named the last incident is not the
  # predicate that names the next one**: the property is "the ARMING does not use GITHUB_TOKEN",
  # not "this file never mentions it", and the two stopped agreeing as soon as the file grew.
  if sed -n '/^  arm-auto-merge:$/,/^  [a-z][a-z-]*:$/p' "$AM" |
    grep -qE 'GH_TOKEN: \$\{\{ (secrets\.)?GITHUB_TOKEN \}\}|GH_TOKEN: \$\{\{ github\.token \}\}'; then
    fail 'arm-auto-merge arms with GITHUB_TOKEN - see above, this silently refuses every later release'
  else
    pass 'it does not merge with GITHUB_TOKEN'
  fi

  if grep -q "!= 'dependabot\[bot\]'" "$AM"; then
    pass 'Dependabot is excluded, so its own ceiling is not bypassed'
  else
    fail 'auto-merge.yml no longer excludes Dependabot - native auto-merge walks past the ceiling that exists because postgres 18 merged green and took production down'
  fi
else
  fail 'pull-request.yml is gone - a green pull request would wait for a human who decides nothing'
fi

# THE ARMING MUST NOT DEPEND ON THE TESTS. `--auto` hands the decision to GitHub; a `needs:` on the
# suite would hold a runner for its whole length and would still have to re-read the checks, and a
# job that merges on its own reading of green is a second opinion about which jobs matter.
if sed -n '/^  arm-auto-merge:$/,/^  [a-z][a-z-]*:$/p' "$AM" | grep -qE '^    needs:'; then
  fail 'arm-auto-merge declares needs: - it must run in PARALLEL with the suite, because it declares intent rather than reading a verdict'
else
  pass 'arm-auto-merge runs in parallel with the suite, which is what --auto is for'
fi

# And it must not try to arm on a `push` to main, where there is no pull request at all.
if sed -n '/^  arm-auto-merge:$/,/^  [a-z][a-z-]*:$/p' "$AM" | grep -q "github.event_name == 'pull_request'"; then
  pass "it only arms on a pull_request event, since this workflow also runs on push to main"
else
  fail 'arm-auto-merge is not restricted to pull_request events - on a push to main it would read a null pull request'
fi

printf '\nthe release package tells a pre-release from a stable by the EVENT, and refuses a mismatch\n'
# =================================================================================================
# THE TRAP THIS CLOSES. The version string and the "Set as a pre-release" checkbox are two
# independent statements a human makes on one form, and until 2026-09-03 only the version was read -
# `published` fires for both kinds, so the checkbox was invisible. Ticking it on a `v0.17.0`
# silently deployed PRODUCTION; forgetting it on a `v0.17.0-alpha.1` silently pushed a tester build
# to the production channels. Neither is visible in a green run, and the French guide could only
# warn about it in prose.
#
# `prereleased` and `released` fire for exactly one kind each, so both statements now arrive and can
# be compared.
RY="$WF/release.yml"
if grep -qE '^    types: \[prereleased, released\]$' "$RY"; then
  pass 'release.yml listens for the two event types GitHub tells apart'
else
  fail 'release.yml no longer listens for [prereleased, released] - with the published event the checkbox is invisible again and only the version speaks'
fi

if grep -q 'github.event.action' "$RY"; then
  pass 'it reads the event action, which is the checkbox as GitHub read it'
else
  fail 'release.yml does not read github.event.action - it cannot know what the checkbox said'
fi

for phrase in 'flagged PRE-RELEASE but its version' 'NOT flagged as a pre-release but its version'; do
  if grep -qF "$phrase" "$RY"; then
    pass "a mismatch is refused and names both sides ($phrase...)"
  else
    fail "release.yml no longer refuses the mismatch '$phrase' - the estate would be chosen by whichever statement it happens to read"
  fi
done

# A CORRECT CHECK THAT PRINTS NOTHING CANNOT BE TOLD FROM ONE THAT NEVER RAN. Measured on the
# `v0.16.0-alpha.2` run: the preflight log carried an `ok` line for each of the five gates and
# NOTHING for this cross-check, which refuses loudly and passed in silence - so a reader of a green
# run had no way to tell the two statements had been compared rather than skipped by a fall-through.
if grep -qE '^ +AGREEMENT=' "$RY" && grep -qE '^ +echo "  ok +.AGREEMENT"' "$RY"; then
  pass 'the cross-check REPORTS its verdict, so a green run shows that it ran'
else
  fail 'the cross-check produces no output when it passes - indistinguishable from a check that was skipped, which is what the report rule exists to forbid'
fi

# AND EVERY PASSING ARM MUST SET IT. The report reads the variable under `set -u`, so an arm that
# forgets it turns a perfectly good release into an unbound-variable failure on the step's last
# line - after the version has been resolved and before anything has been built.
AGREEMENT_ARMS="$(grep -cE '^ +AGREEMENT=' "$RY")"
if [ "$AGREEMENT_ARMS" -eq 3 ]; then
  pass 'all three passing arms set it - dispatch, prereleased, released'
else
  fail "$AGREEMENT_ARMS arm(s) set AGREEMENT, expected 3 - an arm that does not set it fails the step under set -u instead of releasing"
fi

printf '\nno step in an arm is gated on an event that can never happen there\n'
# =================================================================================================
# THE DEFECT THIS EXISTS FOR, AND IT WAS MINE. Collapsing the chain into one run made four steps
# permanently unreachable in a single stroke: `if: github.event_name == 'workflow_run'` guarded both
# "Upload to Release" steps, the TestFlight upload and the Play publish - and in a `workflow_call`
# workflow `github.event_name` is the CALLER's event, which is `release` or `workflow_dispatch` and
# never `workflow_run`. The build would have succeeded, the run would have been green, and NO STORE
# WOULD HAVE RECEIVED ANYTHING.
#
# The shape test as first written did not catch it, because it asked about triggers and inputs and
# not about the conditions on steps. A condition that cannot be true is the same class of defect as
# a required check that is always skipped: invisible, green, and load-bearing.
for f in deploy.yml android.yml ios.yml; do
  if grep -qE "^\s+if:.*github\.event_name\s*==\s*'workflow_run'" "$WF/$f"; then
    fail "$f gates a step on github.event_name == 'workflow_run', which is NEVER true in a called workflow - the step is dead and its run stays green"
  else
    pass "$f has no step gated on a workflow_run event"
  fi

  if grep -qE "^\s+if:.*github\.event\.workflow_run\." "$WF/$f"; then
    fail "$f reads github.event.workflow_run.*, which does not exist on the caller's event"
  else
    pass "$f reads no workflow_run event payload"
  fi
done

# And what replaced that reasoning is DATA. `publish` is passed by the caller instead of inferred
# from an event the called workflow cannot see: `release.yml` takes the callable default `true`, and
# a hand dispatch of an arm defaults it to `false`.
#
# WHY AN ARM IS HAND-DISPATCHABLE AT ALL, since one entry point is the whole point of this file: it
# is the ONLY way to compile Swift, ObjC or Kotlin from the Windows workstation this project is
# developed on. A Swift `guard` body that falls through, a Kotlin nested type in a companion object,
# a plugin command missing from its ACL - none is visible to `cargo clippy`, `bun run check` or any
# gate that runs locally. Collapsing the chain removed that trigger for a commit, which would have
# taken the capability away silently; `publish: false` is what makes it a compile check rather than
# a second door to the stores.
for f in android.yml ios.yml; do
  if grep -qE "^  workflow_dispatch:$" "$WF/$f"; then
    pass "$f can be dispatched by hand, which is the only native compiler available off macOS"
  else
    fail "$f cannot be dispatched - there is then no way to compile Swift or Kotlin without publishing a release"
  fi

  # THE DISPATCH MUST DEFAULT TO SHIPPING NOTHING. A compile check that reached a store would be
  # worse than no compile check, and the default is the whole guard: nobody types `publish: false`.
  if grep -A3 -E "^      publish:" "$WF/$f" | grep -qE "^        default: false$"; then
    pass "$f's dispatch defaults publish to false, so a compile check ships nothing"
  else
    fail "$f's hand dispatch does not default publish to false - a compile check would reach a real store"
  fi

  # Every step that reaches outward reads that input. An ungated one turns the compile check into a
  # release, and the run would be green either way.
  OUTWARD="$(grep -cE "^\s+if: inputs\.publish" "$WF/$f")"
  if [ "$OUTWARD" -ge 2 ]; then
    pass "$f gates its outward steps on inputs.publish ($OUTWARD of them)"
  else
    fail "$f has $OUTWARD step(s) gated on inputs.publish - a hand-dispatched compile check would publish"
  fi

  # And attaching an artefact to a release that does not exist would CREATE one, which would publish
  # a release, which would start the whole chain again. So that one step needs BOTH conditions.
  if grep -qE "^\s+if: inputs\.publish && github\.event_name == 'release'$" "$WF/$f"; then
    pass "$f attaches its artefact only on a real published release"
  else
    fail "$f no longer guards its release upload - a hand-dispatched run would CREATE a release and restart the chain"
  fi
done
printf '\nthe store is served BEFORE the release asset, in both arms\n'
# =================================================================================================
# WHAT THIS COST, MEASURED ON `v0.16.0`. `Upload to Release` sat before the store steps in both
# arms. On the stable it was refused a release update - `Resource not accessible by integration`,
# with `Contents: write` granted and printed by the runner - and `Upload to TestFlight` and the App
# Store submission were both `skipped` behind it. Production and Google Play received 0.16.0; Apple
# received nothing. The Android arm had the identical ordering and merely happened to succeed,
# which is a race that heals cleanly and is still a defect.
#
# A GITHUB RELEASE ASSET IS A CONVENIENCE; THE STORE IS THE DELIVERABLE. The assertion is on the
# ORDER and not on a `continue-on-error`, because swallowing the failure would hide it - a refusal
# there must still fail the job, and now it fails one having already shipped.
#
# `grep -n` and not a parser: the line NUMBER is the ordering, and that is the whole property.
order_ok() {
  local file="$1" store_step="$2" asset_step="$3" label="$4" store asset
  store="$(grep -nF "      - name: $store_step" "$file" | head -1 | cut -d: -f1)"
  asset="$(grep -nF "      - name: $asset_step" "$file" | head -1 | cut -d: -f1)"
  if [ -z "$store" ] || [ -z "$asset" ]; then
    fail "$label - one of the two steps is gone (store=${store:-missing} asset=${asset:-missing})"
  elif [ "$store" -lt "$asset" ]; then
    pass "$label (store at line $store, release asset at $asset)"
  else
    fail "$label - the release asset is at line $asset, BEFORE the store step at $store: a refusal there skips the store, which is how 0.16.0 reached production and Google Play but not Apple"
  fi
}

order_ok "$WF/ios.yml" 'Upload to TestFlight / App Store Connect' 'Upload to Release' \
  'iOS reaches TestFlight before it touches the GitHub release'
order_ok "$WF/ios.yml" 'Create the App Store version, attach the build, and submit for review' 'Upload to Release' \
  'and it submits for review before it touches the GitHub release'
order_ok "$WF/android.yml" 'Publish to Google Play' 'Upload to Release' \
  'Android reaches Google Play before it touches the GitHub release'

# AND NEITHER MAY BE MADE NON-FATAL INSTEAD. `continue-on-error` on the asset upload would pass the
# ordering assertion above while re-introducing exactly the invisibility the ordering removes.
for f in ios android; do
  if sed -n '/^      - name: Upload to Release$/,/^      - name:/p' "$WF/$f.yml" | grep -qE '^ +continue-on-error:'; then
    fail "$f.yml makes the release asset upload non-fatal - a swallowed refusal is worse than the skipped store it replaced"
  else
    pass "$f.yml still fails loudly if the release asset cannot be attached"
  fi
done

printf '\nevery arm is granted what it asks for, because a caller CAPS a called workflow\n'
# =================================================================================================
# THE DEFECT THIS EXISTS FOR, and it killed the first real release. A called workflow cannot be
# granted more than its caller grants it, and exceeding that is a STARTUP FAILURE: no job runs, no
# log is produced, and the API returns neither an annotation nor an error message. `release.yml`
# declares `permissions: contents: read` at the workflow level - right for `preflight` and for
# `bump`, which pushes with an App token rather than `GITHUB_TOKEN` - and that silently capped all
# three arms. `v0.16.0-alpha.1` was published and the run died before its first job.
#
# IT IS CREATED BY THE COLLAPSE. As four independently triggered workflows there was no caller to
# cap anything and each simply got what it declared; turning them into called workflows introduced a
# ceiling that had never existed, and nothing in the tree said so.
#
# SO THIS IS DERIVED FROM BOTH SIDES rather than typed: it reads every `<scope>: write` each callee
# asks for and demands the same line inside the caller's job for it. Adding a scope to an arm fails
# this test until the caller grants it, which is the only ordering that cannot ship broken.
for pair in 'deploy deploy.yml' 'android android.yml' 'ios ios.yml'; do
  job="${pair%% *}"
  wf="${pair##* }"

  # The scopes the callee asks for, anywhere in it: `permissions:` blocks are per job there.
  WANTED="$(grep -oE '^ +[a-z-]+: write$' "$WF/$wf" | tr -d ' ' | sort -u)"
  # The caller's block for this job: from its key to the next job key at the same indentation.
  GRANTED="$(sed -n "/^  $job:\$/,/^  [a-z][a-z-]*:\$/p" "$WF/release.yml" \
    | grep -oE '^ +[a-z-]+: write$' | tr -d ' ' | sort -u)"

  if [ -z "$WANTED" ]; then
    fail "$wf asks for no write scope at all - it cannot attach an artefact or move a marker"
    continue
  fi

  missing="$(comm -23 <(echo "$WANTED") <(echo "$GRANTED") | tr '\n' ' ')"
  if [ -z "${missing// /}" ]; then
    pass "release.yml grants $job everything $wf asks for ($(echo "$WANTED" | tr '\n' ' '))"
  else
    fail "$wf asks for $missing and release.yml's '$job' job does not grant it - THE RUN WILL FAIL AT STARTUP, with no log and no annotation"
  fi
done

printf '\nboth stores are reached all the way, and iOS no longer stops at TestFlight\n'
# =================================================================================================
# THE ASYMMETRY THIS CLOSES. `altool --upload-app` hands Apple the binary and stops; the binary
# lands in TestFlight. For a stable that left the release one MANUAL gesture short of shipped -
# create the version, attach the build, press Submit - while the same release put Android on the
# Play `production` track by itself. Nothing asked for that gesture and nothing reported its
# absence, so a stable release was half-shipped by construction.
if grep -q 'node tools/app-store/submit\.mjs' "$WF/ios.yml"; then
  pass 'ios.yml submits the version for review after the upload'
else
  fail 'ios.yml no longer submits - a stable release would stop at TestFlight and wait for a human nothing reminds'
fi

# ONLY FOR A STABLE, and not as a policy: `versionString` is a marketing version and Apple refuses
# `0.15.0-alpha.1` outright. A pre-release's destination IS TestFlight.
if grep -qE "^\s+if: inputs\.publish && inputs\.prerelease == 'false' && steps\.testflight\.outputs\.uploaded == 'true'$" "$WF/ios.yml"; then
  pass 'and only for a publishing run, on a stable, whose upload actually happened'
else
  fail 'the submission is no longer gated on a stable with a completed upload - it would submit an alpha, which Apple refuses, or a build it never sent'
fi

# THE BUILD NUMBER MUST COME OFF THE ARCHIVE. Recomputing the store band here would be a second
# implementation of `scripts/bump-app-version.sh`'s formula, and the two would disagree silently:
# the submission would poll for a build number nobody uploaded until it gave up 45 minutes later.
if grep -q 'ApplicationProperties:CFBundleVersion' "$WF/ios.yml"; then
  pass 'the build number is read off the archive that was signed, not recomputed'
else
  fail 'ios.yml no longer reads CFBundleVersion from the archive - a recomputed band can name a build that does not exist'
fi

# And the notes gate must stay in the PREFLIGHT, where a refusal costs seconds rather than a
# production deploy, a Play publish and a twenty-minute macOS build.
if grep -q 'submit\.mjs --check-notes' "$PF"; then
  pass 'the release notes are checked before anything moves, by the same code that submits them'
else
  fail 'the preflight no longer checks the release notes - Apple would refuse the submission at the END of a release, after the other store had already shipped'
fi

printf '\nthe dependency ceiling is a CHECK, and it is binding\n'
# =================================================================================================
# WHAT THIS REPLACES, AND WHY IT HAD TO BECOME A CHECK. Until 2026-09-03 the ceiling was asked only
# inside `dependabot-auto-merge.yml`, a SECOND merge mechanism beside GitHub's own auto-merge - so a
# Dependabot pull request and a human's took different routes to `main`, and only one was visible
# where a human looks (user: *"le auto-merge et les CI doivent considerer toutes les PR, les
# miennes ou dependabot"*). #309 is the case: `postgres 15-alpine -> 18-alpine`, fully GREEN and
# correctly refused, open for days.
#
# AND IT CORRECTS THE FIRST VERSION OF THIS COMMENT, which said the refusal was recorded nowhere on
# the pull request. It was - as a `github-actions` comment naming the missing test. What a CHECK
# adds is that the refusal becomes BINDING: a comment is absent from the checks list, unreadable by
# the merge machinery, and outside `ci-passed`, the one check the ruleset requires.
if grep -qE '^  dependency-ceiling:$' "$AM"; then
  pass 'the ceiling is a job of the pull-request package'
else
  fail 'there is no dependency-ceiling job - the ceiling is invisible on the pull request again'
fi

# BINDING MEANS `ci-passed` READS IT. `ci-passed` is the one check the branch ruleset requires, so a
# ceiling job outside its `needs` is a red tick nothing enforces - strictly worse than the sweep it
# replaced, because it LOOKS enforced.
if sed -n '/^  ci-passed:$/,/^  [a-z][a-z-]*:$/p' "$AM" | grep -q 'dependency-ceiling'; then
  pass 'and ci-passed reads it, so an update with no gate cannot merge by ANY route'
else
  fail 'ci-passed does not read dependency-ceiling - the refusal would be advisory, and a red tick nothing enforces is worse than none because it looks enforced'
fi

# THE TWO-STAGE ORDER IS LOAD-BEARING, AND THIS RECORDS WHICH STAGE THE SWEEP IS IN. Stage two is
# the sweep ARMING GitHub's auto-merge instead of merging it itself. Landing that while the ceiling
# was not yet a required check would merge `postgres 15-alpine -> 18-alpine` on a green suite - the
# exact update that cost 33 minutes of production on 2026-09-01. The two assertions above establish
# that the check exists and binds, so this pair can never read as "safe" without them passing.
SWEEP_SH="$HERE/../dependabot-auto-merge.sh"
if [ -r "$SWEEP_SH" ]; then
  if grep -qE 'pr merge [^|]*--auto' "$SWEEP_SH"; then
    pass 'stage 2: the sweep ARMS rather than merges, and the binding check above is what makes that safe'
  else
    pass 'stage 1: the sweep still merges on its own reading of green, which now INCLUDES this check'
  fi
else
  pass 'the sweep is gone entirely, so GitHub auto-merge is the only route to main'
fi

printf '\nthe sweep ARMS, and the identity it arms with is what keeps releases possible\n'
# =================================================================================================
# THE ONE PROPERTY OF STAGE 2 THAT IS SILENT WHEN WRONG, and it is not the arming - it is the TOKEN.
#
# Auto-merge merges as whoever ARMED it. A merge made with `GITHUB_TOKEN` raises no `push` event
# (GitHub's anti-recursion rule), so `main` would get no run of `pull-request.yml`, its merge commit
# would carry no `CI passed` check, and `release-preflight.sh`'s third gate - "the tests passed on
# the commit being released" - would refuse EVERY release, on commits that had in fact been tested.
# Nothing about the sweep would look broken: pull requests would merge, and releases would start
# failing a gate in a different file for a reason nobody would connect to this one.
#
# The old step merged with `GITHUB_TOKEN` and paid for it with a manual `gh workflow run` dispatch.
# Deleting that dispatch is only safe because the identity changed with it, so both are asserted.
SWEEP_WF="$WF/dependabot-auto-merge.yml"
if [ -r "$SWEEP_WF" ]; then
  ARM_STEP="$(sed -n "/^      - name: Arm GitHub's auto-merge on each\$/,/^      - name: /p" "$SWEEP_WF")"

  if printf '%s' "$ARM_STEP" | grep -q 'steps.app-token.outputs.token'; then
    pass 'the sweep arms with the App token, so the merge it causes raises a push'
  else
    fail 'the sweep does not arm with the App token - auto-merge merges as whoever armed it, so a GITHUB_TOKEN arming raises no push, main carries no CI passed, and EVERY later release is refused by a gate in another file'
  fi

  if printf '%s' "$ARM_STEP" | grep -qE 'GH_TOKEN: \$\{\{ (secrets\.)?GITHUB_TOKEN \}\}'; then
    fail 'the sweep arms with GITHUB_TOKEN - see above, this silently refuses every later release'
  else
    pass 'and it does not fall back to GITHUB_TOKEN for the arming'
  fi

  # The dispatch existed ONLY to compensate for the push that a GITHUB_TOKEN merge never raised.
  # Keeping it alongside an App-token arming would run CI twice on every merged combination.
  if grep -q 'gh workflow run pull-request.yml' "$SWEEP_WF"; then
    fail 'the sweep still dispatches CI by hand - that compensated for a push a GITHUB_TOKEN merge never raised, and an App-token merge raises it, so this now runs CI twice on every merge'
  else
    pass 'and the manual CI dispatch is gone, because the merge now raises the push itself'
  fi

  # A SECOND MERGE MECHANISM IS THE THING STAGE 2 REMOVED. A bare `gh pr merge` without `--auto`
  # would merge on the sweep's own reading of green - a second opinion about which jobs matter,
  # beside `CI passed`, which is the one the ruleset requires.
  if grep -qE 'pr merge [^|]*--squash' "$HERE/../dependabot-auto-merge.sh" &&
    ! grep -qE 'pr merge [^|]*--auto' "$HERE/../dependabot-auto-merge.sh"; then
    fail 'the sweep merges directly again - that is a second merge mechanism with its own opinion of "green", beside the CI passed the ruleset requires'
  else
    pass 'the sweep holds no opinion about green - --auto hands that to GitHub'
  fi
else
  pass 'the sweep workflow is gone entirely'
fi

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
