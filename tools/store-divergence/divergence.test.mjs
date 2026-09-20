/**
 * THE CLASSIFICATION, TESTED WITHOUT EITHER STORE.
 *
 * WHAT IS WORTH TESTING HERE. The HTTP calls cannot be exercised off App Store Connect and the Play
 * Developer API, and mocking them would assert that this file's fake matches this file's
 * expectations. What CAN be got wrong, silently, is the verdict: a report that calls a busy Apple
 * queue "rejected" cries wolf every morning until nobody reads it, and one that calls a never-sent
 * submission "pending" recreates the three-day silence it was written to end.
 *
 * THE ARM THAT MATTERS MOST IS `unknown`. A credential that expires must not turn this whole file
 * into a green light, so a missing answer is asserted to need a human, exactly like a refusal.
 *
 * Run: bun tools/store-divergence/divergence.test.mjs
 */

import { matchesVersion, classifyAppStore, classifyPlay, verdict, NEEDS_A_HUMAN } from './divergence.mjs';

let pass = 0;
let fail = 0;
const ok = (what) => {
  pass += 1;
  process.stdout.write(`  ok    ${what}\n`);
};
const no = (what, got) => {
  fail += 1;
  process.stdout.write(`  FAIL  ${what}${got === undefined ? '' : ` - got ${JSON.stringify(got)}`}\n`);
};
const eq = (what, actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(what) : no(what, actual);

const V = (versionString, appStoreState) => ({ id: 'x', attributes: { versionString, appStoreState } });
const asState = (wanted, versions) => classifyAppStore({ wanted, versions }).state;

{
  process.stdout.write('\na Play release name has TWO formats, and both were measured on the real tracks\n');
  // production name="0.16.5"  |  beta name="10012 (0.10.12)"  -- measured 2026-09-07.
  eq('the pipeline writes the bare version', matchesVersion('0.16.5', '0.16.5'), true);
  eq("Play's own default naming parenthesises it", matchesVersion('10012 (0.10.12)', '0.10.12'), true);
  // A substring match alone would say yes here, and report a version live that is not.
  eq('0.16.5 is NOT carried by a release named 0.16.50', matchesVersion('0.16.50', '0.16.5'), false);
  eq('nor by a different version entirely', matchesVersion('0.16.4', '0.16.5'), false);
  eq('a missing name matches nothing', matchesVersion(undefined, '0.16.5'), false);
}

{
  process.stdout.write('\nthe App Store: five causes, and they are not the same errand\n');
  eq('READY_FOR_SALE is live', asState('0.16.5', [V('0.16.5', 'READY_FOR_SALE')]), 'live');
  eq('PENDING_APPLE_RELEASE is live too', asState('0.16.5', [V('0.16.5', 'PENDING_APPLE_RELEASE')]), 'live');

  // THE ARM THAT MUST NOT CRY WOLF. Apple reviews in days; a daily report that calls this a problem
  // is a report its reader learns to skip, and the next real one goes with it.
  eq('WAITING_FOR_REVIEW is pending, not a problem', asState('0.16.5', [V('0.16.5', 'WAITING_FOR_REVIEW')]), 'pending');
  eq('IN_REVIEW likewise', asState('0.16.5', [V('0.16.5', 'IN_REVIEW')]), 'pending');
  eq('and so is PENDING_DEVELOPER_RELEASE', asState('0.16.5', [V('0.16.5', 'PENDING_DEVELOPER_RELEASE')]), 'pending');

  // THE DEFERRAL, WHICH IS THE WHOLE REASON THIS FILE EXISTS. A version created and never sent is
  // what an occupied slot leaves behind now that the submission is allowed to be green.
  eq('PREPARE_FOR_SUBMISSION is not-submitted', asState('0.16.5', [V('0.16.5', 'PREPARE_FOR_SUBMISSION')]), 'not-submitted');
  eq('READY_FOR_REVIEW is not-submitted - attached to a submission nobody sent', asState('0.16.5', [V('0.16.5', 'READY_FOR_REVIEW')]), 'not-submitted');
  eq(
    'and a version that does not exist, with the slot free, is not-submitted',
    asState('0.16.5', [V('0.16.4', 'READY_FOR_SALE')]),
    'not-submitted'
  );

  // THE ARM THAT WAS WRONG FOR FOUR DAYS. Absent is not one cause: from 2026-09-16 every stable
  // read `no version was ever created for it`, which accuses the pipeline, while the truth was that
  // an earlier version held Apple's one slot and `submit.mjs` had correctly refused to touch it.
  // The two want opposite errands - a re-run, and a decision in App Store Connect - so the report
  // may not answer them with the same sentence.
  const held = classifyAppStore({
    wanted: '0.18.14',
    versions: [V('0.18.13', 'WAITING_FOR_REVIEW'), V('0.18.12', 'READY_FOR_SALE')],
  });
  eq('absent because an earlier version is WITH Apple is slot-held, not not-submitted', held.state, 'slot-held');
  eq(
    'and it names the occupant and its state, or the reader has to go and look',
    held.why.includes('0.18.13') && held.why.includes('WAITING_FOR_REVIEW'),
    true
  );
  // A RE-RUN IS THE WRONG ERRAND HERE and saying so is the whole point of the new state.
  eq('the errand it states is App Store Connect', held.why.includes('App Store Connect'), true);

  // AN OCCUPANT THAT IS STILL EDITABLE IS THE OTHER CASE: the next iOS run renames it, so the
  // errand really is a re-run and the state stays `not-submitted`.
  const renameable = classifyAppStore({ wanted: '0.16.5', versions: [V('0.16.4', 'PREPARE_FOR_SUBMISSION')] });
  eq('an editable occupant is still not-submitted', renameable.state, 'not-submitted');
  eq('and the line says a re-run resolves it', renameable.why.includes('re-running'), true);

  // TWO OCCUPANTS CONTRADICT APPLE'S OWN RULE. Nothing here can pick between them, and a re-run
  // will not either, so it reads as a held slot rather than a deferral.
  eq(
    'several occupants at once is slot-held',
    asState('0.16.5', [V('0.16.4', 'PREPARE_FOR_SUBMISSION'), V('0.16.3', 'IN_REVIEW')]),
    'slot-held'
  );

  // APPLE SAID NO. A different errand from "nobody asked": one needs a fix, the other a re-run.
  for (const st of ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']) {
    eq(`${st} is rejected, never merely not-submitted`, asState('0.16.5', [V('0.16.5', st)]), 'rejected');
  }

  eq('no list at all is unknown, never live', asState('0.16.5', undefined), 'unknown');
  eq('a version with no state is unknown', asState('0.16.5', [V('0.16.5', undefined)]), 'unknown');

  // The refusal has to name what a human needs in order to act, or it is an alarm without an errand.
  const r = classifyAppStore({ wanted: '0.16.5', versions: [V('0.16.5', 'PREPARE_FOR_SUBMISSION')] });
  eq('and it names the version AND the state', r.why.includes('0.16.5') && r.why.includes('PREPARE_FOR_SUBMISSION'), true);
}

{
  process.stdout.write('\nGoogle Play: the production track, and only that one\n');
  const T = (track, releases) => ({ track, releases });
  const playState = (wanted, tracks) => classifyPlay({ wanted, tracks }).state;

  eq(
    'a completed production release is live',
    playState('0.16.5', [T('production', [{ name: '0.16.5', status: 'completed' }])]),
    'live'
  );
  eq(
    'a rolling-out one is pending',
    playState('0.16.5', [T('production', [{ name: '0.16.5', status: 'inProgress' }])]),
    'pending'
  );

  // A STABLE GOES TO `production` ALONE. Finding it on `internal` proves a pre-release shipped, not
  // that this stable did - and reading the wrong track is how a report says yes to the wrong question.
  eq(
    'the same version on internal does NOT count as shipped',
    playState('0.16.5', [
      T('production', [{ name: '0.16.4', status: 'completed' }]),
      T('internal', [{ name: '0.16.5', status: 'completed' }]),
    ]),
    'not-submitted'
  );
  eq('no track list is unknown', playState('0.16.5', undefined), 'unknown');
  eq('no production track is unknown', playState('0.16.5', [T('internal', [])]), 'unknown');

  // The report must say what the track DOES hold, or a human has to go and look anyway.
  const r = classifyPlay({ wanted: '0.16.5', tracks: [T('production', [{ name: '0.16.4', status: 'completed' }])] });
  eq('and a miss names what production actually carries', r.why.includes('0.16.4'), true);
}

{
  process.stdout.write('\nthe verdict, and what it lets pass\n');
  const both = (a, b) => verdict({ 'App Store': { state: a, why: '' }, 'Google Play': { state: b, why: '' } });

  eq('two live stores need nobody', both('live', 'live').ok, true);
  eq('and neither does a store still with Apple', both('pending', 'live').ok, true);
  eq('a never-sent submission needs a human', both('not-submitted', 'live').ok, false);
  eq('and it is named, so the report has an errand', both('not-submitted', 'live').acting, ['App Store']);
  eq('a refusal needs a human', both('rejected', 'live').ok, false);
  eq('so does a slot nobody here may free', both('slot-held', 'live').ok, false);
  eq('slot-held is in the set that needs a human', NEEDS_A_HUMAN.has('slot-held'), true);
  eq('both halves can need one at once', both('rejected', 'not-submitted').acting, ['App Store', 'Google Play']);

  // NEVER SILENTLY GREEN. A credential that expires answers nothing, and an answerless report that
  // exits 0 is worse than no report - it is a green light nobody asked for.
  eq('and NOT LOOKING is not a pass', both('unknown', 'live').ok, false);
  eq('unknown is in the set that needs a human', NEEDS_A_HUMAN.has('unknown'), true);
}

process.stdout.write('\n');
if (fail !== 0) {
  process.stdout.write(`${fail} of ${pass + fail} assertions FAILED\n`);
  process.exit(1);
}
process.stdout.write(`all ${pass} assertions passed\n`);
