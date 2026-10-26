import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIT_ROWS } from './admitrows.mjs';
import { BIG_ROWS } from './bigrows.mjs';
import { LIST_RACE_ROWS } from './listracerows.mjs';
import { DEV_ROWS } from './devicerows.mjs';
import { FLOOR_ROWS } from './floorrows.mjs';
import { KILL_ROWS } from './killrows.mjs';
import { OFFLINE_ROWS } from './offlinerows.mjs';

const HARNESS = dirname(fileURLToPath(import.meta.url));
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
    scripts: [
      'msg1.mjs',
      'msg1.mjs --cold',
      'msg1b.mjs',
      'msg2.mjs',
      'msg3.mjs',
      'msg4.mjs',
      'msg5.mjs',
      'msg67.mjs',
      'msg8.mjs',
      'msg8b.mjs',
      'msg9.mjs',
      'msg10.mjs',
    ],
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
  MENTION: {
    title: 'mentions and what they trigger',
    scripts: only('mention.mjs', 1, 6),
    needs: ['W1', 'W2', 'A1'],
  },
  FWD: {
    title: 'forwarding',
    scripts: ['fwd.mjs', 'fwd345.mjs', 'fwd5.mjs'],
    needs: ['W1', 'W2', 'A1'],
  },
  // GRP WAS THE PHASE WITH A SCRIPT AND NO COVERAGE. It listed `grp-traffic.mjs` alone, which
  // recorded a `GRP-TRAFFIC` id matching no board row and opened a group name hard-coded on
  // 2026-08-15 that the 2026-08-21 estate sweep deleted - so the phase's only job would have thrown
  // on its first line, and its nine board rows had never been armed at all. `grp.mjs` covers them,
  // plus GRP-10, and that script is gone rather than kept beside it.
  GRP: {
    title: 'group membership and invitations',
    scripts: only('grp.mjs', 1, 10),
    needs: ['W1', 'W2'],
  },
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
      // 1b FIRST, AND IT WAS MISSING FROM THIS LIST UNTIL 2026-09-07 - the exact fault the paragraph
      // above describes, committed again one entry later. `notif.mjs` handles `1b`, the board names
      // NOTIF-1b, and the phase ran six of seven rows while announcing the phase. It is the P1 case
      // too: a BACKGROUNDED phone, the state a device is in most of the day, and the only row here
      // whose notification comes from the WebView rather than from a push.
      'notif.mjs 1b',
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
      // KILLS THE PHONE AND PUTS IT BACK, PIN INCLUDED, so it is placed among the other rows that
      // do - and before the venue rows below, which it must not leave a locked handset to. It also
      // PARKS the owner browsers, deliberately and for the whole run: a device of the owner left in
      // the conversation emits a read receipt, and a read receipt from self cancels the very
      // notification this row waits for. See the runner's docblock for the 80 ms that cost the
      // first attempt.
      'notif15.mjs',
      // LAST, because these are the only NOTIF rows that open the VENUE channel: doing so re-renders
      // the dead-mention chips MENTION-5 leaves behind, and a row that runs after them inherits
      // nothing while a row that runs before is unaffected either way. Both forgive those 404s.
      'notif14.mjs',
      'notif16.mjs',
      // LAST OF ALL: it MINTS a group, so it leaves the estate with one more conversation than
      // it found. `cleanup.mjs` sweeps it, but a row that runs after it would see a sidebar it
      // did not expect - and two NOTIF rows already count sidebar entries.
      'notif17b.mjs',
      // AFTER 17b, AND THE PAIRING IS THE POINT. 17b mints a GROUP while the phone is dead and
      // refuses, because a device offline when it is added is on no new group's roster; 18 mints a
      // public SALON, whose transport is the community group the handset already joined. Read side
      // by side they say which half of "first contact" the server owes a dead device. It also mints
      // and SWEEPS its own salon, so it leaves the estate as it found it.
      'notif18.mjs',
      // 18 WITH ONE COMMIT BETWEEN THE KILL AND THE SEND: W3 becomes a new device and joins the key
      // group, so the seed is sealed one epoch ahead of the phone and only the background catch-up
      // can open it. Last because it wipes W3, and it sweeps its salon like 18.
      'notif19.mjs',
      // 19 WITH THE SEED ON THE MESSAGE (channel-encryption section 19): the same advance, then the
      // first banner must be in clear with no hold, and a second message with the mirror removed must
      // be opened from its own frame. Wipes W3 and sweeps its salon like 19.
      'notif20.mjs',
      // 19's TWIN ON A DM (user, 2026-09-27: a DM and a salon behave the same): the same W3
      // advance, into the owner<->peer DM, and the bar is the same plaintext. Wipes W3; mints nothing.
      'notif2.mjs',
      // THE ADMITTER WELCOMES (channel-encryption section 20): W2 makes a fresh community and invites
      // the owner while the phone is dead; its key-group row must go active from the background
      // Welcome and the first message must be in clear. Mints and deletes its own community.
      'notif21.mjs',
    ],
    // W3 IS HERE BECAUSE `notif15.mjs` PARKS IT, AND FOR A DAY NOTHING SAID SO. That row kills the
    // phone and needs every OTHER owner device out of the conversation first - a read receipt from
    // self cancels the shade it measures - so it parks `['W1', 'W3']`. Declaring only W1/W2/A1 meant
    // the preflight never looked at the scratch browser: an absent W3 was recorded as `'unreachable'`,
    // which is not an accepted parked state, and the row graded `FAIL` on a product question about
    // push notifications. It cost three runs, each paying a phone kill and a PIN restore to discover
    // it. `checks-selftest.mjs` now sees the door - `PORTS[name]` is a computed access, invisible to
    // it until 2026-09-22 - and fails this phase if the declaration and the script ever part again.
    needs: ['W1', 'W2', 'A1', 'W3'],
  },
  HEAL: {
    title: 'does a broken group repair itself',
    // THE PRIMITIVE FIRST. `newdevice.mjs` IS HEAL-NEW-0, and every HEAL-NEW row below rests on the
    // facts it asserts - a fresh id, an id the server had never seen, the same account coming back.
    // A primitive believed rather than measured is how a whole rung's results end up describing the
    // instrument, so it runs before the rows that depend on it and its failure is worth seeing alone.
    //
    // THE ORDER PAIRS ARE ADJACENT ON PURPOSE (user, 2026-08-27: every configuration must be tested,
    // and all of them must pass the same way - that is the whole point of reconciliation). Row 3 and
    // row 11 are the same responder present from the start and arriving late; 2 and 12 likewise. Read
    // side by side, a difference in FINAL state is a FAIL for the pair and a difference in TIME is
    // dirt carrying a number - which is only legible if the two ran under the same fleet.
    //
    // 15 LAST of the web rows: it is the only one that clicks into a conversation while the sidebar is
    // still amber, so it leaves the client somewhere other than the list every other row starts from.
    scripts: [
      'newdevice.mjs',
      'healnew.mjs --row 1',
      'healnew.mjs --row 2',
      'healnew.mjs --row 12',
      'healnew.mjs --row 3',
      'healnew.mjs --row 11',
      'healnew.mjs --row 15',
      // THE REVOKED DEVICE, AFTER THE NEW ONE, because its assertion is an EQUALITY against a fresh
      // device and there is no point measuring the difference before the reference itself passes.
      // Each of these rows costs two enrolments and one revocation - it mints the victim, revokes it,
      // moves the world, brings it back, then mints a fresh device in the SAME world to compare
      // against - so they are the most expensive rows in the phase and none of them is cheap dirt.
      //
      // 7's two orders are adjacent for the same reason 3 and 11 are: read side by side, a difference
      // in final state is a FAIL for the pair and a difference in time is dirt carrying a number.
      'healrevoke.mjs --row 5',
      'healrevoke.mjs --row 8',
      'healrevoke.mjs --row 7 --order first',
      'healrevoke.mjs --row 7 --order last',
      // 9 LAST OF THE REVOKE ROWS, because it is the only one that severs a profile's link. It
      // restores it on every exit path and asserts the restoration, but a cut that outlived its row
      // would poison every row after it and the symptom would arrive hours from its cause - so it
      // runs where there is nothing left behind it to poison. It is also the only one that stops
      // before the return: it mints no reference device, because the DEFERRAL is its whole subject.
      'healrevoke.mjs --row 9',
      // THE FOUR LEGACY ROWS LAST, and `heal.mjs` most of all: it restores an MLS snapshot, which is a
      // ratchet REWIND over W1's real state. Everything that reached W1 since its snapshot is rolled
      // back out of the store, so a revoke row after it would be comparing two devices against a W1
      // that had forgotten the world they were both trying to catch up with.
      'heal.mjs',
      'heal-a1.mjs',
      'heal-w2.mjs',
      'heal-web.mjs',
    ],
    // W3 IS DECLARED BECAUSE SEVEN OF THESE ROWS WIPE IT, and A1 stays because two of them drive the
    // phone. Both are narrowed below: the union is the right answer for running the phase and the
    // wrong one for running one row of it.
    needs: ['W1', 'W2', 'A1', 'W3'],
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
    // W3 FOR COMM-12 ALONE (2026-10-22): its new-device arm wipes the scratch profile and signs it in
    // as a new device of the owner. `SCRATCH_SCRIPTS` narrows it, so no other COMM row asks for W3.
    needs: ['W1', 'W2', 'A1', 'W3'],
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
      // FOUR ROWS THAT READ THE MEMBERSHIP TABLE, added 2026-08-28 after a conversation lost both its
      // directions for 134 minutes. `multi.mjs` is about the phone as a second device; these are
      // about `dm_device_group_memberships`, which two hundred rows on this ladder never read - and
      // the one that does reads WHO is named rather than WHAT STATUS they hold.
      //
      // 10 FIRST, AND IT NEEDS NO CLIENT AT ALL. It is the whole-population invariant, so it is the
      // one row here that can fail because of something no other row touched - three of the ten
      // stranded memberships found on production had stood 25 days. Running it before the three that
      // build state means its count describes the database as the phase FOUND it.
      'roster.mjs --row 10',
      'roster.mjs --row 7',
      'roster.mjs --row 8',
      'roster.mjs --row 9',
    ],
    // W3 IS THE SECOND WEB DEVICE rows 8 and 9 enrol while the peer is away, and A1 stays for the six
    // phone rows. Both are narrowed below - no row here needs the two together.
    needs: ['W1', 'W2', 'A1', 'W3'],
  },
  CALL: { title: 'audio and video', scripts: [], needs: ['W1', 'W2', 'A1'] },
  // ONE OF TEN, AND THE COUNT IS HERE SO THE OTHER NINE STAY VISIBLE. `scripts: []` until
  // 2026-09-08: ten rows designed and nothing able to run one of them, which is the shape rule 22
  // exists to catch - a phase that reads as covered because its rows are written down.
  // ONE FILE PER ROW, and not because the rows are big. `corrupt.mjs` answers CORRUPT-3 and
  // `corrupt4.mjs` CORRUPT-4; a single script would take the second row down with the first on any
  // throw, and the phase would report one answer where two were owed - a rung reading green while
  // nothing ran half of it. The damage each remaining row needs is different again.
  // -5 and -7 can use `mlsdb.mjs truncate`, which -4 and -1 are the reason for writing (`--to 0` and
  // `--to N` are two different questions), and -2 has `flip`; -9 and -10 need A1.
  // THE PHONE ALONE: the camera tab, the app's own capture screen and the publish step are a
  // phone's, and every gesture they classify is an OS touch (`archive/reel.mjs`). Before CORRUPT
  // because CORRUPT runs last.
  REEL: {
    title: 'CanaReels - the camera tab and publishing a reel',
    scripts: only('reel.mjs', 1, 2),
    needs: ['A1'],
  },
  // A SALON ROW THE SERVER ALTERS (Graine v2, channel-encryption section 21): W1 writes, a database
  // edit relabels or moves the row, W2 re-reads history and must REFUSE it with its line. Edits are
  // undone in `finally`. GRAINE-AUTH-4 (a seed relayed from a departed member) has no runner, by
  // decision (no mutating dev hook). `--only 6` is an unsigned row the server stored, read from history
  // on W3; `--only 7` is the same row POSTed, refused at the door (channel-encryption 21.8). -5, the
  // live arm, needed the server to publish that row and has none since 21.8.
  GRAINE: {
    title: 'Graine v2 - an author that is proven',
    scripts: [...only('graineauth.mjs', 1, 3), 'graineauth.mjs --only 6', 'graineauth.mjs --only 7'],
    needs: ['W1', 'W2', 'W3'],
  },
  CORRUPT: {
    title: 'deliberate store damage',
    scripts: ['corrupt.mjs', 'corrupt1.mjs', 'corrupt2.mjs', 'corrupt4.mjs', 'corrupt6.mjs'],
    needs: ['W1', 'W2'],
  },
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
    scripts: [
      'del1.mjs',
      ...only('del.mjs', 2, 7),
      'del.mjs --only 9',
      'del.mjs --only 10',
      'del.mjs --only 8',
    ],
    needs: ['W1', 'W2', 'A1'],
  },
  PIN: {
    title: 'the encryption PIN',
    // REGISTERED 2026-09-07, AND IT WAS THE PHASE ITSELF THAT WAS INVISIBLE, NOT THE ROWS. This
    // entry read `scripts: []` while `archive/pinrows.mjs` already implemented six invocations, so
    // `run.mjs` printed "PIN 0 script(s) << NO COVERAGE" and the campaign page copied that gauge
    // into prose as a statement about the campaign. A runner nobody registers is the same defect as
    // a runner nobody wrote, except that it also lies about itself.
    //
    // ORDER IS THE COST ORDER, not the row order: 1, 3 and 11 leave the client exactly as they
    // found it, 8 cuts the server underneath the gate, 2 spends the wrong-PIN budget and 9 CLOSES
    // THE BROWSER and reopens it. `pinrows.mjs` leaves W1 unlocked whichever row ran.
    scripts: [
      'pinrows.mjs --row 1',
      'pinrows.mjs --row 3',
      'pinrows.mjs --row 11',
      'pinrows.mjs --row 8',
      'pinrows.mjs --row 2',
      'pinrows.mjs --row 9',
    ],
    needs: ['W1', 'W2'],
  },
  // THE 1.4.1 FLOOR (`docs/wiki/cross-client-campaign-1-4-1.md` section 4.2), browsers only. FLOOR-3 is
  // NOT here: it is class B (A1 and I1), its phone door is `openSeats` in `mlsrow.mjs`, which
  // `checks-selftest.mjs` cannot see, and the plan runs it by hand on the bench -
  // `bun archive/floor.mjs --row 3` with `A1_BUILD` set.
  FLOOR: {
    title: '1.4.1 - the floor re-proved on dev',
    scripts: ['floor.mjs --row 1', 'floor.mjs --row 2'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // CONCURRENT COMMITS, browsers only. CC-5 is not here: it needs a fifth campaign account
  // (`ccrows.mjs` `CC5_PREMISE`).
  CC: {
    title: '1.4.1 - concurrent commits',
    scripts: ['cc.mjs --row 1', 'cc.mjs --row 2', 'cc.mjs --row 3', 'cc.mjs --row 4'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // THE SETTLEMENT (DUP, OFF-1/-2, TOK-1/-2), browsers only. DUP-3 records SKIPPED with the plan's
  // reason (Q2). TOK-3 is NOT here: it waits 61 min with the socket open, so it is run alone and
  // unattended - `bun archive/settle.mjs --row TOK-3`. DUP-7 is a devrows.mjs row (an invite with its answer lost) and is not a
  // settle.mjs row (`settlerows.mjs` `DUP7_ELSEWHERE`).
  SETTLE: {
    title: '1.4.1 - commit settlement: a lost, refused or late answer',
    scripts: [
      'settle.mjs --row DUP-1',
      'settle.mjs --row DUP-2',
      'settle.mjs --row DUP-3',
      'settle.mjs --row DUP-4',
      'settle.mjs --row DUP-5',
      'settle.mjs --row DUP-6',
      'settle.mjs --row OFF-1',
      'settle.mjs --row OFF-2',
      'settle.mjs --row TOK-1',
      'settle.mjs --row TOK-2',
    ],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // FRAMES OUT OF ORDER (GAP-1, GAP-2), browsers only. GAP-4 records SKIPPED (the shared-payload
  // writer stays off). GAP-3 is NOT here: it sends 2100 messages first, about forty minutes, so it
  // is run alone - `bun archive/gap.mjs --row GAP-3`.
  GAP: {
    title: '1.4.1 - frames ahead of their commits, and past-epoch frames again',
    scripts: ['gap.mjs --row GAP-1', 'gap.mjs --row GAP-2', 'gap.mjs --row GAP-4'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // A SEAT WITHOUT A WORKING LINK FOR A WHILE (OFF-3, NET-1..3, RM-8), browsers only. NET-2 alone is
  // five minutes. OFF-5 is NOT here: it is class B, played on A1 - `bun archive/offline.mjs --row OFF-5`.
  // OFF-4 is BLOCKED-ON-ACCOUNT and has no row to run.
  OFFLINE: {
    title: '1.4.1 - away while others move on, a slow link, a flapping socket, a captive portal',
    scripts: ['offline.mjs --row OFF-3', 'offline.mjs --row NET-1', 'offline.mjs --row NET-2', 'offline.mjs --row NET-3', 'offline.mjs --row RM-8'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // A PROCESS THAT DIES WITH A COMMIT OR A MESSAGE IN FLIGHT (KILL-1, KILL-2, KILL-3, KILL-5, RM-3),
  // browsers only. KILL-1 is twenty tab closes, KILL-2 ten browser relaunches and KILL-3 twelve, each
  // with its PIN. KILL-4 is NOT here: it is class B, played on A1 - `bun archive/kill.mjs --row KILL-4`.
  KILL: {
    title: '1.4.1 - a tab, a browser or a remover killed with a commit in flight',
    scripts: ['kill.mjs --row KILL-1', 'kill.mjs --row KILL-2', 'kill.mjs --row KILL-3', 'kill.mjs --row KILL-5', 'kill.mjs --row RM-3'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // A GROUP LINK AND ITS ASK (ADM-1..4, ADM-8..10), browsers only. ADM-5..7 are NOT here: they need A1 on
  // the v1.4.0 APK, installed by the operator - `bun archive/admit.mjs --row ADM-5|ADM-6|ADM-7`.
  ADMIT: {
    title: '1.4.1 - a group link: the ask, Add or Decline, and what a waiting seat may not do',
    scripts: ['admit.mjs --row ADM-1', 'admit.mjs --row ADM-2', 'admit.mjs --row ADM-3', 'admit.mjs --row ADM-4', 'admit.mjs --row ADM-8', 'admit.mjs --row ADM-9', 'admit.mjs --row ADM-10'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // A NEW DEVICE OF THE OWNER (DEV-1..4, DEV-6), browsers only: every row mints on W3 (and W6); DUP-7
  // rides here and invites W4 instead (an Add that really happens on 1.4.1),
  // so the phase is LAST in its session (plan section 5, step 6). DEV-7 needs A1 swiped away, run by
  // hand: `bun archive/devrows.mjs --row DEV-7 --variant cold|opened|stale`. DEV-5 is CORRUPT-8's.
  DEVICES: {
    title: '1.4.1 - a new device of the owner: seated, revoked online and offline, two at once, and its Welcome once',
    scripts: ['devrows.mjs --row DEV-1', 'devrows.mjs --row DEV-2', 'devrows.mjs --row DEV-3', 'devrows.mjs --row DEV-4', 'devrows.mjs --row DEV-6', 'devrows.mjs --row DUP-7'],
    needs: ['W1', 'W2', 'W3', 'W4', 'W6'],
  },
  // THE REMOVAL BOUND ON A SALON (RM-4..6), browsers only: each row mints its own community, joined by
  // link, and deletes it once its verdict is on disk.
  SALON: {
    title: '1.4.1 - a salon access list: two admins at once, a kick against a grant, and a removal beyond the actor',
    scripts: ['salon.mjs --row RM-4', 'salon.mjs --row RM-4b', 'salon.mjs --row RM-5', 'salon.mjs --row RM-6'],
    needs: ['W1', 'W2', 'W4', 'W5'],
  },
  // A LARGE GROUP (BIG-1..3), class B: every web seat and A1. Declared on 2026-10-26, when the first
  // `--file big.mjs` run was refused for belonging to no phase. The `-noI1` variants are the ones the
  // rig can play unattended. The full rows also need I1, which no preflight here arms, so they are
  // run by hand once the iPhone is wired: `bun archive/big.mjs --row BIG-1|BIG-2|BIG-3`.
  BIG: {
    title: '1.4.1 - a large group: twelve devices, a burst under commits, a community removal and newcomer',
    scripts: ['big.mjs --row BIG-1-noI1', 'big.mjs --row BIG-2-noI1', 'big.mjs --row BIG-3-noI1'],
    needs: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'A1'],
  },
  // A SALON HEARD OF LIVE WHILE ITS COMMUNITY'S LISTING IS HELD (LIST-RACE-1, 2026-10-26), browsers
  // only: the web row and its control. The `-A1` pair is class B and in no phase, preflighted with
  // the phone through `ROW_TABLES`: `bun run.mjs --file listrace.mjs --row LIST-RACE-1-A1`.
  LISTRACE: {
    title: "1.4.1 - a salon heard of live while its community's listing is held, and its control",
    scripts: ['listrace.mjs --row LIST-RACE-1-W', 'listrace.mjs --row LIST-RACE-1-W-CTL'],
    needs: ['W1', 'W4', 'W8'],
  },
};

/**
 * Inside a phase, the scripts that need MORE than the two browsers - read by `--file` so ONE script's
 * preflight asks for the devices THAT SCRIPT uses instead of the union its phase needs.
 *
 * A phase's `needs` is the union over its scripts. That is exactly right for running the phase and
 * wrong for running one of them: `bun run.mjs --file comm22.mjs` is a two-browser check and was
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
  // TWO OF ELEVEN. `heal.mjs` and `heal-a1.mjs` are the rows about a phone whose store was damaged;
  // the seven HEAL-NEW rows are a second WEB device and `heal-web.mjs`/`heal-w2.mjs` never leave the
  // browsers. Without this entry a `--file healnew.mjs --row 1` run was refused for want of a cable
  // it does not use, which is the refusal-with-no-reason that teaches an operator `--no-preflight`.
  HEAL: ['heal.mjs', 'heal-a1.mjs'],
  // SIX OF TEN. Every `multi.mjs` row is about the phone as the account's second device - the phase's
  // own comment says there is no MULTI row two browsers alone can answer, and that was true until the
  // four `roster.mjs` rows, which read a database table and never open A1.
  MULTI: ['multi.mjs'],
};

/**
 * The same narrowing for the SCRATCH device, and it is a separate map because it is a separate claim.
 *
 * W3 exists to be destroyed: `newdevice.mjs` wipes its origin, so every row built on that primitive
 * needs it and no other row in the campaign may have it demanded. Merging this into
 * {@link PHONE_SCRIPTS} would make one list mean "needs something extra" - and a list whose entries
 * mean different things cannot say that a row needs the phone but NOT the scratch profile, which is
 * exactly the distinction the two HEAL phone rows require.
 *
 * Read the same way and in both spellings, by the same function.
 */
export const SCRATCH_SCRIPTS = {
  // The primitive and the six rows that reuse it. `heal.mjs`, `heal-a1.mjs`, `heal-w2.mjs` and
  // `heal-web.mjs` break a device that already HELD the group, so none of them touches W3.
  HEAL: ['newdevice.mjs', 'healnew.mjs', 'healrevoke.mjs'],
  // MULTI-8 and MULTI-9 enrol a second web device of the owner; MULTI-7 and MULTI-10 do not, and
  // MULTI-10 opens no client at all.
  MULTI: ['roster.mjs --row 8', 'roster.mjs --row 9'],
  // GRAINE-AUTH-6 reads the injected v1 row on the owner's scratch device, which holds no session
  // the row could name; arms 1-3 read on W2 and arm 7 POSTs from W1, and none of them opens W3.
  GRAINE: ['graineauth.mjs --only 6'],
  // COMM-12's new-device arm: a new device of the owner asking for a `joined` community's history.
  COMM: ['comm12.mjs'],
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
 *   A file belonging to no phase gets the two browsers, and `phase: null` says so - and `run.mjs`
 *     REFUSES it through {@link fileRefusal}: a note was not enough (FLOOR-2, 2026-10-25).
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
/**
 * The row an invocation SELECTS, or null when it selects none and therefore runs them all.
 *
 * A string, not a number: it is compared only against another spelling of the same argument, and
 * `Number()` here would turn a typo into `NaN` and make every comparison false but one.
 *
 * TWO SPELLINGS, BECAUSE THE RIG HAS TWO. `--only` is what `del.mjs`, `read.mjs` and `multi.mjs` take;
 * `--row` is what `healnew.mjs`, `healrevoke.mjs` and `roster.mjs` take. A matcher that knew only the
 * first read every `--row` invocation as selecting NOTHING, which collapses to "this file's whole
 * declaration applies" - so `roster.mjs --row 10`, which opens no client at all, was preflighted for
 * the scratch device two rows 8 and 9 need. That is the safe direction and it is still the same fault
 * the narrowing exists to prevent: a flag the matcher was never shown. It degrades quietly, which is
 * why it is worth naming here rather than discovering from a refusal.
 *
 * A SELECTOR, NOT EVERY FLAG. `--destructive`, `--order`, `--stay` and `--settle` change what a run
 * may DO or how long it waits, never WHICH row it runs. Reading them here would make two invocations
 * of the same row look like two different rows.
 */
const SELECTORS = ['--only', '--row'];
const onlyOf = (words) => {
  for (const flag of SELECTORS) {
    const i = words.indexOf(flag);
    if (i !== -1) return words[i + 1];
  }
  return null;
};

/**
 * THE 1.4.1 ROW TABLES, by the script that plays them: each row names its own `devices`. A row that
 * names A1 is class B and is in NO phase (a phase is browsers only), so `--file <script> --row <id>`
 * used to preflight the phase's browsers alone - no phone read, no `a1Build` stamp, and the row then
 * recorded "bound a phone and carries no a1Build" (OFF-5, 2026-10-25). FLOOR is selected by number.
 */
export const ROW_TABLES = {
  'offline.mjs': OFFLINE_ROWS,
  'kill.mjs': KILL_ROWS,
  'admit.mjs': ADMIT_ROWS,
  'devrows.mjs': DEV_ROWS,
  'big.mjs': BIG_ROWS,
  'listrace.mjs': LIST_RACE_ROWS,
  'floor.mjs': Object.fromEntries(Object.entries(FLOOR_ROWS).map(([k, v]) => [k.replace(/^FLOOR-/, ''), v])),
};

/** The devices the row `--row` selects names in its own table, or null when there is no such row. */
export function rowDevices(file, args = []) {
  const i = args.indexOf('--row');
  const row = i === -1 ? null : ROW_TABLES[file]?.[args[i + 1]];
  return row?.devices ?? null;
}

export function devicesFor(file, args = []) {
  const named = rowDevices(file, args);
  const owner = Object.entries(PHASES).find(([, p]) =>
    p.scripts.some((s) => s.split(' ')[0] === file)
  );
  // A ROW THAT NAMES A1 IS PREFLIGHTED WITH A1, whatever its phase says - that is what stamps its
  // build. Only the PHONE is added: the browsers stay the phase's, which the preflight already covers.
  if (named?.includes('A1')) {
    const base = owner ? devicesFor(file, []).devices : ['W1', 'W2'];
    return { devices: [...new Set([...base.filter((d) => d !== 'A1'), ...named.filter((d) => d === 'A1' || /^W\d$/.test(d))])], phase: owner?.[0] ?? null };
  }
  if (!owner) return { devices: ['W1', 'W2'], phase: null };
  const [name, phase] = owner;
  const narrowed = PHONE_SCRIPTS[name];
  // COMPATIBLE, NEVER EQUAL - and equality is what silently unarmed the phone.
  //
  // The entry is `del.mjs --only 7`, and DEL-7 cannot be run without `--destructive`. Comparing the
  // whole invocation as a STRING therefore never matched the one invocation that exists: on
  // 2026-08-27 `--file del.mjs --only 7 --destructive` preflighted W1 and W2 alone, DEL-7 ran
  // against a phone nobody had armed, and it recorded INVALID blaming the group for never reaching
  // A1. That is the same fault, arriving through the same door, that this narrowing was written on
  // 2026-08-22 to stop costing MUT-18 six rows - a flag the matcher had never been shown was enough.
  //
  // So the only word compared is the one that SELECTS rows. `--destructive`, `--stay` and every
  // other flag change what a run may DO, never WHICH rows it runs, and a matcher that reads them as
  // part of the selection is a matcher that fails on the next flag anyone adds. The two nulls are
  // the two honest directions: a declaration naming no row covers every invocation of that file, and
  // an invocation narrowing to nothing runs EVERY row the script holds - the declared ones included,
  // which is why a bare `--file del.mjs` owes the cable that DEL-7 will need.
  const invOnly = onlyOf([file, ...args]);
  const isNamed = (list) =>
    !list ||
    list.some((entry) => {
      const words = entry.split(' ');
      if (words[0] !== file) return false;
      const declOnly = onlyOf(words);
      return declOnly === null || invOnly === null || declOnly === invOnly;
    });

  // Each optional device is dropped on its OWN answer. A single verdict would have made "not a phone
  // row" mean "not a scratch row" as well, so `healnew.mjs` - which needs W3 and not A1 - would have
  // kept both or lost both, and either way the preflight would be describing a different run.
  const keep = new Set(phase.needs);
  if (!isNamed(narrowed)) keep.delete('A1');
  if (!isNamed(SCRATCH_SCRIPTS[name])) keep.delete('W3');
  return { devices: [...keep], phase: name };
}

/**
 * Why `run.mjs --file <file>` must not start, or null when it may.
 *
 * A FILE NO PHASE DECLARES HAS NO KNOWN DEVICES, AND A PREFLIGHT THAT GUESSES THEM IS NOT A PREFLIGHT.
 * `devicesFor` answers such a file with W1 and W2 and `phase: null`, and until 2026-10-25 `run.mjs`
 * printed a note and ran it. That note was read by nobody: a chain spelt the name as a PATH,
 * `archive/floor.mjs`, which matches no `scripts` entry, so fourteen rows (FLOOR, ADM, DEV, DUP-7,
 * KILL, RM) were preflighted with W1 and W2 alone. FLOOR-2 then recorded VACUOUS because W5, never
 * preflighted, sat on a page without the conversation list - its Welcome had landed.
 *
 * So both spellings are refused, and each refusal names what lifts it: a path is rewritten as the
 * name `scripts` uses, and an undeclared script is declared in a phase, where `checks-selftest`
 * holds its `needs` to what the script drives.
 */
export function fileRefusal(file, args = []) {
  if (/[\\/]/.test(file)) {
    const name = file.split(/[\\/]/).pop();
    return `--file takes a script NAME as PHASES spells it, not a path: "${file}" matches no phase, so its preflight would guess W1 and W2. Write --file ${name}`;
  }
  if (devicesFor(file, args).phase === null) {
    return `${file} belongs to no phase in checks.mjs, so no preflight knows which devices it drives - declare it in a phase (its scripts and needs) before running it through run.mjs`;
  }
  return null;
}

/**
 * `recon.mjs` is deliberately NOT a phase. It is the only instrument that can see the loss class at
 * all, and it reads the STORES rather than the screen - so it is run after a phase, over the traffic
 * that phase produced, not as one more check among them.
 */
export const RECON = 'recon.mjs';

/**
 * WHERE A SCRIPT THIS MANIFEST NAMES ACTUALLY LIVES, now that the rig is split in two.
 *
 * The 2026-09-04 tidy moved the ROWS - the ~114 scripts that compose gestures into a question - into
 * `archive/`, and left the ATOMS at the harness root. This manifest names both kinds and should not
 * have to know which is which: a phase's `scripts` are rows, but an arming step like `newdevice.mjs`
 * is an atom, and both are spelt the same way here.
 *
 * TWO KNOWN PLACES, NOT A SEARCH AND NOT A FALLBACK. The set is closed and each entry means
 * something: root is an atom, `archive/` is a row. A name in neither is an error worth raising,
 * because the manifest has then drifted from the tree - which is exactly what `checks-selftest`
 * exists to catch.
 */
export function scriptPath(name) {
  for (const dir of [HARNESS, join(HARNESS, 'archive')]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `${name} is named by the manifest but exists neither at the harness root nor in archive/`
  );
}
