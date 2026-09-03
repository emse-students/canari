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
AM="$WF/auto-merge.yml"
if [ -r "$AM" ]; then
  if grep -q 'create-github-app-token' "$AM"; then
    pass 'auto-merge.yml mints the App token, whose merge raises a push event'
  else
    fail 'auto-merge.yml no longer mints an App token - a GITHUB_TOKEN merge raises no push, so main gets no CI run and every release is then refused'
  fi

  if grep -qE 'GH_TOKEN: \$\{\{ (secrets\.)?GITHUB_TOKEN \}\}|GH_TOKEN: \$\{\{ github\.token \}\}' "$AM"; then
    fail 'auto-merge.yml merges with GITHUB_TOKEN - see above, this silently refuses every later release'
  else
    pass 'it does not merge with GITHUB_TOKEN'
  fi

  if grep -q "!= 'dependabot\[bot\]'" "$AM"; then
    pass 'Dependabot is excluded, so its own ceiling is not bypassed'
  else
    fail 'auto-merge.yml no longer excludes Dependabot - native auto-merge walks past the ceiling that exists because postgres 18 merged green and took production down'
  fi
else
  fail 'auto-merge.yml is gone - a green pull request would wait for a human who decides nothing'
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

printf '\n'
if [ "$FAIL" -ne 0 ]; then
  printf '%s of %s assertions FAILED\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'all %s assertions passed\n' "$PASS"
