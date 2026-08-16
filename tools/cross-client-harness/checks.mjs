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
 */

/** Devices a phase needs. `W1`/`W2` are the two Chrome profiles; `A1` is the phone over adb. */
export const PHASES = {
  MSG: {
    title: 'the plain path',
    scripts: ['msg1.mjs', 'msg1.mjs --cold', 'msg1b.mjs', 'msg2.mjs', 'msg3.mjs', 'msg4.mjs',
      'msg5.mjs', 'msg67.mjs', 'msg8.mjs', 'msg8b.mjs', 'msg9.mjs', 'msg10.mjs'],
    needs: ['W1', 'W2', 'A1'],
  },
  TYPE: { title: 'typing indicators', scripts: ['type.mjs'], needs: ['W1', 'W2'] },
  READ: { title: 'receipts and unread counts', scripts: ['read.mjs'], needs: ['W1', 'W2', 'A1'] },
  MUT: {
    title: 'editing, deleting, reacting, pinning',
    scripts: ['mut.mjs'],
    needs: ['W1', 'W2'],
  },
  SEARCH: { title: 'finding a message', scripts: ['search.mjs'], needs: ['W1', 'W2'] },
  MENTION: { title: 'mentions and what they trigger', scripts: ['mention.mjs'], needs: ['W1', 'W2'] },
  FWD: { title: 'forwarding', scripts: ['fwd.mjs', 'fwd345.mjs', 'fwd5.mjs'], needs: ['W1', 'W2', 'A1'] },
  GRP: { title: 'group membership and invitations', scripts: ['grp-traffic.mjs'], needs: ['W1', 'W2'] },
  // `tab236.mjs` is named for the three checks it implements and selects ONE of them from `argv[2]`,
  // defaulting to '2' - so the bare entry ran a third of the script its own filename advertises.
  TAB: {
    title: 'tabs and windows',
    scripts: ['tab236.mjs 2', 'tab236.mjs 3', 'tab236.mjs 6', 'tab4.mjs', 'tab5.mjs'],
    needs: ['W1', 'W2'],
  },
  // `life.mjs` implements seven states (2-8) and defaulted to '2', so the LIFE phase covered one of
  // them. LIFE-5 is deliberately NOT here and that is the only omission: it REBOOTS the phone, and
  // the unlock after a reboot needs the pattern, which no adb call can answer - it is a human check
  // and belongs on the device-verification ladder, not in an automated phase. LIFE-6 must run over
  // USB: the wireless transport rides the wifi that check switches off.
  LIFE: {
    title: 'Android lifecycle',
    scripts: ['life.mjs 2', 'life.mjs 3', 'life.mjs 4', 'life.mjs 6', 'life.mjs 7', 'life.mjs 8'],
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
    scripts: ['notif.mjs 4', 'notif.mjs 9', 'notif.mjs 10', 'notif7.mjs bg', 'notif7.mjs killed'],
    needs: ['W1', 'W2', 'A1'],
  },
  HEAL: {
    title: 'does a broken group repair itself',
    scripts: ['heal.mjs', 'heal-a1.mjs', 'heal-w2.mjs', 'heal-web.mjs'],
    needs: ['W1', 'W2', 'A1'],
  },

  // Named so `run.mjs --list` reports them as ZERO COVERAGE rather than leaving them out. A phase
  // that is absent from a listing reads as "done"; a phase listed with no script reads as what it
  // is. The dashboard carries 22 COMM checks, 6 MULTI, 20 CALL and 10 CORRUPT, none of them written.
  COMM: { title: 'communities, channels, roles', scripts: [], needs: ['W1', 'W2'] },
  MULTI: { title: 'one user, two devices', scripts: [], needs: ['W1', 'W2', 'A1'] },
  CALL: { title: 'audio and video', scripts: [], needs: ['W1', 'W2', 'A1'] },
  CORRUPT: { title: 'deliberate store damage', scripts: [], needs: ['W1', 'W2'] },
  DEL: { title: 'deleting a conversation, crossed', scripts: [], needs: ['W1', 'W2'] },
  PIN: { title: 'the encryption PIN', scripts: [], needs: ['W1', 'W2'] },
};

/**
 * `recon.mjs` is deliberately NOT a phase. It is the only instrument that can see the loss class at
 * all, and it reads the STORES rather than the screen - so it is run after a phase, over the traffic
 * that phase produced, not as one more check among them.
 */
export const RECON = 'recon.mjs';
