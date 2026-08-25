/**
 * THE MANIFEST: which script covers which phase, and what each phase needs to be meaningful.
 *
 * It exists because the mapping lived nowhere. The dashboard
 * (`docs/wiki/cross-client-testing.md`) names every check and its prerequisites but never names the
 * script that runs it; the scripts name their check ids but never their prerequisites. Neither could
 * answer "what do I run to exercise READ, and what has to be plugged in first" - so every session
 * rediscovered it by reading files, and got it wrong often enough to matter.
 *
 * `needs` is not decoration. Most first-run failures in this harness were never defects and never
 * even harness bugs: they were a client that was locked, absent, or on the wrong route. `run.mjs`
 * refuses to start a phase whose devices are not ready, because a check run against a locked client
 * does not fail honestly - it reports on whatever was left on screen.
 *
 * KEEP THIS IN STEP WITH THE DASHBOARD. When a phase gains a script, add it here in the same commit.
 *
 * ONE JOB PER CHECK, WHEREVER THE SCRIPT CAN SELECT ONE. Rule 19 of
 * `docs/wiki/testing-methodology.md`: a job that owns a whole phase fails as one unit, so a single
 * throw takes every verdict downstream of it in that process - which is how a phase reports one
 * defect and eleven silences. The five multi-check scripts all accept `--only N` already and each
 * check is a self-contained function, so this costs nothing but a line per row and buys per-check
 * isolation, a per-check server window, and the ability to re-run exactly what failed. TAB and LIFE
 * were expanded first, for the narrower reason that their bare entry silently ran ONE of the checks
 * its filename advertised.
 *
 * The price is one preflight per job, which is a deadline and not a delay: a client already ready
 * answers on the first sample and pays nothing.
 */

/** `n..m` inclusive, as `script --only N` jobs - one job per check. */
const only = (script, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${script} --only ${from + i}`);

/** Devices a phase needs. `W1`/`W2` are the two Chrome profiles; `A1` is the phone over adb. */
export const PHASES = {
  MSG: {
    title: 'the plain path',
    scripts: ['msg1.mjs', 'msg1.mjs --cold', 'msg1b.mjs', 'msg2.mjs', 'msg3.mjs', 'msg4.mjs',
      'msg5.mjs', 'msg67.mjs', 'msg8.mjs', 'msg8b.mjs', 'msg9.mjs', 'msg10.mjs'],
    needs: ['W1', 'W2', 'A1'],
  },
  TYPE: { title: 'typing indicators', scripts: only('type.mjs', 1, 5), needs: ['W1', 'W2'] },
  // READ-5 records SKIPPED on its own - it needs a fourth reader, and there are two accounts - and it
  // is listed anyway: a skip that produces a row is a state, a skip that produces nothing is a hole.
  //
  // READ-10 IS ARMED HERE, and it was not until 2026-08-21. `--destructive` existed because the check
  // left a group behind on both sides and a dead conversation row in W1's profile FOR EVER - one per
  // run, each narrating itself on every later load. It now dismisses that row through the product's
  // own control, as part of its verdict, so the reason for the opt-in is gone. A flag kept after its
  // reason expires is how a check stays permanently SKIPPED in a campaign that must end green.
  READ: {
    title: 'receipts and unread counts',
    scripts: [...only('read.mjs', 1, 9), 'read.mjs --only 10 --destructive'],
    needs: ['W1', 'W2', 'A1'],
  },
  MUT: {
    title: 'editing, deleting, reacting, pinning',
    scripts: only('mut.mjs', 1, 21),
    // A1 BECAUSE MUT-18 DRIVES THE PHONE, and this said `W1 W2` until 2026-08-22 - so the preflight
    // never armed A1 for this phase, `sameAccountAs` found nothing on 9333, and MUT-18 recorded
    // `SKIPPED - second client not reachable` every time it was asked. A check cannot arm a device
    // the phase did not declare, and the skip named the symptom rather than the declaration.
    // Declaring it here is also what makes the phase carry `CANARI_A1_BUILD`, without which its rows
    // would land with no `a1Build` beside `build` - the fault found in MSG one day earlier.
    needs: ['W1', 'W2', 'A1'],
  },
  SEARCH: { title: 'finding a message', scripts: only('search.mjs', 1, 6), needs: ['W1', 'W2'] },
  // A1 IS DECLARED because MENTION-2/3 assert a real push on the owner's phone - it is a second
  // device of the OWNER's account, which is what lets the owner set their own level on W1 and have
  // W2 mention them. Declaring it is also what makes the phase carry `CANARI_A1_BUILD`.
  MENTION: { title: 'mentions and what they trigger', scripts: only('mention.mjs', 1, 6), needs: ['W1', 'W2', 'A1'] },
  FWD: { title: 'forwarding', scripts: ['fwd.mjs', 'fwd345.mjs', 'fwd5.mjs'], needs: ['W1', 'W2', 'A1'] },
  // GRP WAS THE PHASE WITH A SCRIPT AND NO COVERAGE. It listed `grp-traffic.mjs` alone, which
  // recorded a `GRP-TRAFFIC` id matching no board row and opened a group name hard-coded on
  // 2026-08-15 that the 2026-08-21 estate sweep deleted - so the phase's only job would have thrown
  // on its first line, and its nine board rows had never been armed at all. `grp.mjs` covers them,
  // plus GRP-10, and that script is gone rather than kept beside it.
  GRP: { title: 'group membership and invitations', scripts: only('grp.mjs', 1, 10), needs: ['W1', 'W2'] },
  // `tab236.mjs` is named for the three checks it implements and selects ONE of them from `argv[2]`,
  // defaulting to '2' - so the bare entry ran a third of the script its own filename advertises.
  TAB: {
    title: 'tabs and windows',
    scripts: [
      'tab1.mjs',
      'tab236.mjs 2',
      'tab236.mjs 3',
      'tab3b.mjs',
      'tab236.mjs 6',
      'tab4.mjs',
      'tab5.mjs',
      'tab7.mjs',
    ],
    needs: ['W1', 'W2'],
  },
  // `life.mjs` implements eight states (1-8) and defaulted to '2', so the LIFE phase covered one of
  // them. LIFE-1 RUNS FIRST because it is the control the other seven are read against: it enters no
  // state, so a failure there says the ordinary foreground path is broken and every verdict below it
  // would be measuring that instead of its own transition.
  // LIFE-5 is deliberately NOT here and that is the only omission: it REBOOTS the phone, and
  // the unlock after a reboot needs the pattern, which no adb call can answer - it is a human check
  // and belongs on the device-verification ladder, not in an automated phase. LIFE-6 must run over
  // USB: the wireless transport rides the wifi that check switches off.
  LIFE: {
    title: 'Android lifecycle',
    scripts: [
      'life.mjs 1',
      'life.mjs 2',
      'life.mjs 3',
      'life.mjs 4',
      'life.mjs 6',
      'life.mjs 7',
      'life.mjs 8',
    ],
    needs: ['W1', 'W2', 'A1'],
  },
  // EVERY RUN IS SPELT OUT, because both scripts here select ONE check from an argument and default
  // it: `notif.mjs` is `argv[2] || '4'` and `notif7.mjs` is `argv[2] || 'bg'`. Listed bare, the phase
  // announced NOTIF and silently ran 4 and bg only - two of five - and no output said so, because a
  // default is indistinguishable from a choice. Found 2026-08-16 while a run that claimed to be
  // NOTIF-10 never cut the radios. A manifest entry that relies on a default covers what the script
  // felt like doing, not what the phase claims.
  NOTIF: {
    title: 'notifications',
    scripts: [
      'notif.mjs 4',
      // 4b IMMEDIATELY AFTER 4, because it is the same gesture with the one precondition that makes
      // an unread-driven dismissal look correct removed - reading the two verdicts side by side is
      // what distinguishes a dismissal from a counter reaching zero.
      'notif.mjs 4b',
      'notif.mjs 9',
      'notif.mjs 11',
      // TEN MINUTES OF DELIBERATE OUTAGE, so it goes after every row that only needs seconds.
      'notif.mjs 10',
      'notif7.mjs bg',
      'notif7.mjs killed',
    ],
    needs: ['W1', 'W2', 'A1'],
  },
  HEAL: {
    title: 'does a broken group repair itself',
    scripts: ['heal.mjs', 'heal-a1.mjs', 'heal-w2.mjs', 'heal-web.mjs'],
    needs: ['W1', 'W2', 'A1'],
  },

  // Named so `run.mjs --list` reports them as ZERO COVERAGE rather than leaving them out. A phase
  // that is absent from a listing reads as "done"; a phase listed with no script reads as what it
  // is. The dashboard carries 25 COMM checks, 6 MULTI, 20 CALL and 10 CORRUPT; COMM reached all 25
  // on 2026-08-21 and is no longer partial - the entries below number twenty-four because
  // `comm910.mjs` answers two checks and `comm2324.mjs` is listed twice, once per check.
  //
  // SIX OF THEM WERE MISSING HERE until 2026-08-20 - comm4, comm6, comm7, comm15, comm20, comm21,
  // every one of them written and RUN by hand, and none of them reachable from `run.mjs COMM`. That
  // is rule 22 exactly: the files existed, the phase looked covered, and the campaign would have run
  // thirteen checks while the board showed nineteen. Add the script in the SAME commit that writes
  // it; the count in this comment is what makes the omission visible. TWENTY-FOUR scripts now.
  //
  // ORDERED SO THE PRIMITIVES RUN FIRST. `comm2.mjs` proves the invite link, which is the only
  // gesture in the product that puts a SECOND member into a community a check built itself - so
  // COMM-11, COMM-12 and COMM-19 all inherit whatever it proves, and a failure there is worth
  // seeing before the rows that depend on it.
  COMM: {
    title: 'communities, channels, roles',
    scripts: [
      'comm1.mjs',
      'comm2.mjs',
      'comm3.mjs',
      'comm4.mjs',
      'comm5.mjs',
      'comm6.mjs',
      'comm7.mjs',
      'comm8.mjs',
      'comm910.mjs',
      'comm11.mjs',
      'comm12.mjs',
      'comm13.mjs',
      // NEEDS THE PHONE TOO, and for a reason no other row has: what it asserts is that a push
      // DECISION reaches a person, and the only observer of that is A1's notification tray.
      'comm14.mjs',
      'comm15.mjs',
      'comm16.mjs',
      // NEEDS THE PHONE, as the account's SECOND device: the community order is per (user,
      // community) in `channel_members.sortOrder`, so "it reaches the other device" is a statement
      // about another DEVICE of the same account and W2 - a different account - cannot make it.
      'comm17.mjs',
      'comm19.mjs',
      'comm20.mjs',
      'comm21.mjs',
      'comm22.mjs',
      'comm2324.mjs 23',
      'comm2324.mjs 24',
      // NEEDS THE PHONE, and says so through the phase's `needs` below rather than by skipping
      // itself: A1 is one account's SECOND device, which is the whole subject of COMM-25, and a
      // runner that quietly passed with the phone absent would be describing a set of one.
      'comm25.mjs',
      // LAST, BECAUSE IT KILLS THE APP. What it measures is a COLD start, so the app must not be
      // running when the link is followed - and `am force-stop` puts it in Android's STOPPED state,
      // where FCM broadcasts are cancelled until something starts it explicitly. Any row after this
      // one would be measuring the kill rather than the product, and COMM-14's push row above it
      // most of all. It relaunches the app itself through the link, and the next phase's preflight
      // revives it either way.
      'comm18.mjs',
    ],
    needs: ['W1', 'W2', 'A1'],
  },
  // EVERY ROW SPELT OUT, and MULTI-6 LAST because it kills the app. Four of the six are automated and
  // the other two are recorded as `SKIPPED` by the script itself with the reason on the row - a phase
  // that simply omitted them would read as six-of-six covered. All four automated rows drive A1: the
  // phase's subject is the ACCOUNT, so there is no MULTI row that two browsers alone can answer, and
  // `PHONE_SCRIPTS` therefore has no entry narrowing it.
  MULTI: {
    title: 'one user, two devices',
    scripts: [
      'multi.mjs --only 1',
      'multi.mjs --only 2',
      'multi.mjs --only 3',
      'multi.mjs --only 4',
      'multi.mjs --only 5',
      'multi.mjs --only 6',
    ],
    needs: ['W1', 'W2', 'A1'],
  },
  CALL: { title: 'audio and video', scripts: [], needs: ['W1', 'W2', 'A1'] },
  CORRUPT: { title: 'deliberate store damage', scripts: [], needs: ['W1', 'W2'] },
  // ONE OF TEN, AND IT WAS WRITTEN BEFORE THIS MANIFEST EXISTED. `del1.mjs` covers DEL-1
  // (WP-HISTGHOST-1's regression check) and was reachable from nothing: the phase read as ZERO
  // coverage, the board read `pending`, and the script's verdict lived in a console line. Rule 22.
  // DEL-8 IS LAST ON PURPOSE, and it is the reason this list is written out rather than generated by
  // `only`. It restores an MLS snapshot, which is a ratchet REWIND over W1's real state: everything
  // that reached W1 between its snapshot and its restore is rolled back out of the store. Running it
  // before its neighbours would rewind THEIR groups too, so the destructive row goes at the end where
  // the window it opens closes with the phase. DEL-7 IS THE PHONE ROW - it kills A1 and wakes it, so
  // the phase needs A1 and `PHONE_SCRIPTS` names the one invocation that does, which is why that map
  // now matches arguments and not only file names.
  DEL: {
    title: 'deleting a conversation, crossed',
    scripts: ['del1.mjs', ...only('del.mjs', 2, 7), 'del.mjs --only 9', 'del.mjs --only 10',
      'del.mjs --only 8'],
    needs: ['W1', 'W2', 'A1'],
  },
  PIN: { title: 'the encryption PIN', scripts: [], needs: ['W1', 'W2'] },
};

/**
 * Inside a phase, the scripts that need MORE than the two browsers - read by `--file` so ONE script's
 * preflight asks for the devices THAT SCRIPT uses instead of the union its phase needs.
 *
 * A phase's `needs` is the union over its scripts. That is exactly right for running the phase and
 * wrong for running one of them: `node run.mjs --file comm22.mjs` is a two-browser check and was
 * refused on a phone that has nothing to do with it, because four OTHER COMM rows need one. **A
 * preflight that refuses a run it has no reason to refuse teaches its operator `--no-preflight`**,
 * and that flag disarms the one gate stopping a check from reporting on a locked client. Found
 * 2026-08-21, with the phone unauthorised and COMM-22 owed a ninth attempt.
 *
 * Only the EXCEPTIONS are named, and only for phases where they are known. A phase absent from here
 * keeps the union, which is the honest answer when nothing has declared per-script needs - the same
 * reasoning `--file` already applies to a script belonging to no phase at all. Each entry below is
 * justified beside the script itself in `PHASES`, and this list must not become the only statement of
 * it.
 */
export const PHONE_SCRIPTS = {
  // COMM-14 (a push decision reaching a tray), COMM-17 and COMM-25 (A1 as the account's SECOND
  // device), COMM-18 (a cold start through `am start`). The other twenty are W1 + W2.
  COMM: ['comm14.mjs', 'comm17.mjs', 'comm18.mjs', 'comm25.mjs'],
  // DEL-7 ALONE, AND IT IS WRITTEN WITH ITS ARGUMENT ON PURPOSE. Eight rows share `del.mjs` and only
  // this one takes the phone away; a bare `del.mjs` here would demand a cable for the seven that have
  // nothing to do with it.
  DEL: ['del.mjs --only 7'],
};

/**
 * The devices a single `--file` invocation must be preflighted with, and the phase that says so.
 *
 * LIVES HERE, BESIDE THE TWO MAPS IT READS, because the answer is a statement about the manifest and
 * it decides whether a check runs against an UNARMED phone. It was inline in `run.mjs`, where it was
 * untestable and where its vocabulary could drift from the maps by an edit to either side - and the
 * failure mode of that drift is not an error: it is MUT-18's, a check that skips for weeks with a
 * reason pointing at the cable instead of at the declaration one file away.
 *
 * THREE ANSWERS, AND THE MIDDLE ONE IS THE POINT.
 *   A file belonging to no phase gets the two browsers, and `phase: null` says so - the caller owes
 *     its operator that note, because a silent default is indistinguishable from a declaration.
 *   A file in a phase gets that phase's `needs`, which is the UNION over its scripts.
 *   ...UNLESS the phase narrowed its phone requirement with `PHONE_SCRIPTS` and this invocation is
 *     not one of the named ones, in which case A1 is dropped. A preflight that refuses a run it has
 *     no reason to refuse teaches its operator `--no-preflight`, which disarms the only gate standing
 *     between a check and a locked client.
 *
 * BOTH SPELLINGS OF A NARROWED ENTRY ARE MATCHED: a bare file name, and a whole invocation for a file
 * holding several rows of which only one needs the phone (`del.mjs --only 7`, one row in eight).
 *
 * @param file the script name, without arguments
 * @param args the arguments forwarded to it, as an array
 * @returns {{devices: string[], phase: string|null}}
 */
export function devicesFor(file, args = []) {
  const owner = Object.entries(PHASES).find(([, p]) =>
    p.scripts.some((s) => s.split(' ')[0] === file)
  );
  if (!owner) return { devices: ['W1', 'W2'], phase: null };
  const [name, phase] = owner;
  const narrowed = PHONE_SCRIPTS[name];
  const invocation = [file, ...args].join(' ');
  const named = !narrowed || narrowed.includes(file) || narrowed.includes(invocation);
  return {
    devices: named ? [...phase.needs] : phase.needs.filter((d) => d !== 'A1'),
    phase: name,
  };
}

/**
 * `recon.mjs` is deliberately NOT a phase. It is the only instrument that can see the loss class at
 * all, and it reads the STORES rather than the screen - so it is run after a phase, over the traffic
 * that phase produced, not as one more check among them.
 */
export const RECON = 'recon.mjs';
