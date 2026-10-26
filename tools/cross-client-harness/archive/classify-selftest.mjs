/**
 * THE CLASSIFIER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN.
 *
 *   bun classify-selftest.mjs
 *
 * `report()` decides what breaks `clean`, and every triage this campaign does is an edit to it. Two
 * ways that goes wrong, both met on 2026-08-14:
 *
 *   - a pattern that cannot match. `NOTABLE`, `SEVERE`, `DECRYPT_CLASSIFIED` and `STATE_CHANGE` were
 *     tested against the RAW line while `BENIGN` was tested against the stripped one, so every
 *     `^`-anchored pattern in those four lists silently never matched a line the app had
 *     timestamped. `/^\[OUTBOX\] \d+ entr(y|ies) still queued/` had been in `NOTABLE` since it was
 *     written and still landed in `unexplained` on all three passes;
 *   - a pattern that matches too much, quietly moving a real signal into a bucket that does not
 *     break `clean`. That one has no symptom at all until a defect ships.
 *
 * Neither is visible from a passing run, so they are asserted here instead. Every line below is one
 * this campaign actually saw, kept verbatim WITH its `[HH:MM:SS]` prefix, because the prefix is what
 * the first bug turned on.
 */
import {
  consoleDump,
  CONTACT_DEVICE_NOTICE_NARRATION,
  DEVICE_PANEL_NARRATION,
  EVICTED_REJOIN_NARRATION,
  FRESH_CLIENT_NARRATION,
  FRESH_DEVICE_RESTORE_NARRATION,
  FRESH_DEVICE_SESSION_NARRATION,
  GROUP_CREATION_NARRATION,
  REVOKED_REFUSALS,
  REMOVE_NARRATION,
  ignoringExpectedLog,
  OWNER_DEVICE_NOTICE_NARRATION,
  PRIVACY_REFUSED_EXCEEDS_ACTOR_NARRATION,
  SIBLING_MINT_NARRATION,
  admissionJoinerNarration,
  admissionMemberNarration,
  REVOKED_SIGN_OUT_NARRATION,
  revokedLogoutOnce,
  signOutCount,
  PAGE_BOOT_NARRATION,
  REFUSED_FOR_LACK_OF_ROW_NARRATION,
  stripStamp,
  ignoringExpectedRefusal,
  ignoringOfflineCut,
  report,
  cspBlockedHashOf,
  DEV_EDGE_CSP_EXCEPTION,
  devEdgeCspDecision,
  gate,
} from '../watch.mjs';

/** A fake CDP buffer: one `Runtime.consoleAPICalled` per line, dated so the timeline is orderable. */
function cxOf(entries) {
  return {
    events: entries.map(([level, text], i) => ({
      method: 'Runtime.consoleAPICalled',
      params: { type: level, timestamp: 1_786_710_000_000 + i * 1000, args: [{ value: text }] },
    })),
  };
}

const CASES = [
  // [level, line, expected bucket]
  ['log', '[14:24:25] [OUTBOX] 1 entry still queued', 'notable'],
  ['log', '[14:59:42] [MLS_LOCK] a frame of 92c16968… is applied while the commit of b1ecb448… awaits its answer', 'notable'],
  ['log', '[14:59:42] [MLS_LOCK] a frame of 92c16968… waits for the commit of 92c16968… - put back, applied after it', 'notable'],
  ['log', '[14:59:42] [MLS_LOCK] refused to lend the MLS mutex for 92c16968: not the holder - only the commit holding it may lend it', 'unexplained'],
  ['log', '[14:59:42] [QUEUE] the commit of 59333a90... released the MLS lock - draining the 1 frame(s) it held back', 'notable'],
  ['log', '[14:24:25] [OUTBOX] 12 entries still queued', 'notable'],
  ['log', '[14:24:25] [OUTBOX] ef8eca5e… skipped, backing off for 4452ms (attempt 2)', 'notable'],
  // The two withdrawal branches, pinned TOGETHER because the risk in classifying them is that one
  // rule swallows both: they share a prefix, an id and the word "withdrawn", and they mean opposite
  // things about what the peers hold. Landed in `unexplained` on MUT-19's first green run.
  ['log', '[11:11:10] [OUTBOX] a721e695… withdrawn from the queue before it was ever sent', 'benign'],
  ['log', '[11:11:10] [OUTBOX] a721e695… withdrawn from the queue before this tab sent it', 'benign'],
  // A group exit settling its queue (GRP-6): clean only when nothing was lost.
  [
    'log',
    '[06:49:10] [OUTBOX] leave of 4271a303…: 1 of 1 queued entry sent before the server step, 0 lost',
    'benign',
  ],
  [
    'log',
    '[06:49:10] [OUTBOX] leave of 4271a303…: 0 of 1 queued entry sent before the server step, 1 lost (1 text)',
    'unexplained',
  ],
  [
    'log',
    '[06:49:10] [OUTBOX] 9e1c40aa… (control) not queued: this device owes the leave of 4271a303…, so nothing of it can be delivered',
    'benign',
  ],
  [
    'log',
    '[11:11:10] [OUTBOX] a721e695… withdrawn while it was already being sent - the peers will have it, so the delete has to travel as an event',
    'notable',
  ],
  ['log', '[14:24:06] [MLS] Frames are being lost in 642f389a… - reconciling this conversation', 'notable'],
  // THE KEY-PACKAGE ADDER'S TIMER, which belongs to no check and lands in every window - it was
  // NOTIF-18's entire web-side dirt on 2026-09-21. `benign` because both lines are the ordinary
  // record of a round: the census is the measurement, the second line is the decision it produced.
  ['log', '[15:53:07] [MLS] key package census - 7381 proven (7016 one-time, 365 last-resort); 0 expired, 0 undecodable; 1247 mint instant(s), largest batch 51', 'benign'],
  ['log', '[15:53:07] [MLS] key package round: pool full and last-resort valid - nothing to mint', 'benign'],
  // The discovery sweep reusing the connection sync's `keep` for the same pass (2026-10-14).
  ['log', '[17:56:04] [SYNC] 8 group(s) kept on the answer this connection pass already had - not asked again', 'benign'],
  // The census without the trailing batch clause, which is what a client that has minted nothing
  // prints - the rule makes that half optional, so a fixture has to hold it to that.
  ['log', '[15:53:07] [MLS] key package census - 50 proven (49 one-time, 1 last-resort); 0 expired, 0 undecodable; 0 mint instant(s)', 'benign'],
  // THE THREE MUTATION REFUSALS, one fixture each because the three mean different things: a peer
  // sending a frame it had no right to send, two edits crossing, and an edit landing on a tombstone.
  // The middle one is verbatim from the first MUT-18 run after the convergence fix shipped, where it
  // landed in `unexplained` and turned a PASS into PASS-DIRTY - the correct place for a line nobody
  // had classified, and the reason this fixture exists.
  [
    'log',
    '[03:52:42] [MLS] Dropped an edit of ad2d5d3b dated 1787363560648 - the row already holds a later one',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Dropped an edit of ad2d5d3b - the message is deleted and a tombstone is final',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Refused an edit of a message owned by a1b2c3d4 from e5f6a7b8 - only the author may mutate it',
    'notable',
  ],
  [
    'log',
    '[03:52:42] [MLS] Refused a delete of a message owned by a1b2c3d4 from e5f6a7b8 - only the author may mutate it',
    'notable',
  ],
  ['log', '[14:24:09] [HISTORY_REQ] 642f389a... same state as d82cd226… (7e5952f8…) - nothing to do', 'notable'],
  // The admission gate's not-drained decision (DUP-1, 2026-10-25), and a line that does not finish.
  ['debug', '[03:29:47] [QUEUE] group b8ea5710 not known drained: pulled=false pulling=true socket=true idle=true', 'notable'],
  ['debug', '[03:29:47] [QUEUE] group b8ea5710 not known drained: pulled=false pulling=true', 'unexplained'],
  // An addressed history answer filtered on the reader's windows: what a newcomer was withheld, worth
  // reading on every pass (CC-4, 2026-10-25) and not dirt. A line that does not finish is not it.
  [
    'log',
    "[01:41:12] [HISTORY_ENTITLEMENT] b8226a10… - answer addressed to c71e1a5b, filtered on the reader's 1 window(s): withheld 0, 1 undated within 60 min of one, 0 undatable; kept 0",
    'notable',
  ],
  ['log', "[01:41:12] [HISTORY_ENTITLEMENT] b8226a10… - answer addressed to c71e1a5b, filtered on the reader's 1 window(s): withheld 0", 'unexplained'],
  ['log', '[14:26:02] [SYNC] WASM purge skipped - server list unreliable (fetchOk=false, 9 group(s))', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=false).', 'notable'],
  ['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=true).', 'benign'],
  ['log', '[14:24:06] [HISTORY_STATE] From b78568a3… for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  ['log', '[14:24:06] [HISTORY_STATE] Sent for 642f389a… - 7e5952f8…, from 2026-05-16T00:00:00.000Z', 'stateChanges'],
  // The third spelling, which reports the OUTCOME of that comparison rather than the exchange.
  [
    'log',
    '[14:24:06] [HISTORY_STATE] b78568a3… holds something different for 642f389a… - describing our store',
    'stateChanges',
  ],
  // THE FOURTH SPELLING, and the asker's own side: our key differed from a peer's, so we asked that
  // one peer to describe its store. `stateChanges` with the other three - the finding is the TRIGGER,
  // which stays in `notable`. Verbatim from GRP-7 on 2026-08-24, where it landed in `unexplained`.
  [
    'log',
    '[01:40:12] [HISTORY_STATE] Keys differ for 6bd37588… - asked b78568a3…:web-b78568a3…-msglwqh6-vegy to describe',
    'stateChanges',
  ],
  // THE FIFTH SPELLING - the SCROLLBACK RANGE, sighted on the local estate 2026-09-04 on a
  // two-client exchange that was otherwise clean, where these three were the only thing between a
  // correct check and a clean run. `stateChanges` with their four siblings, for the same reason: the
  // finding is the TRIGGER.
  [
    'log',
    '[15:12:59] [HISTORY_RANGE] Asked for up to 50 message(s) before 2026-09-04T08:41:33.920Z in 15335785…',
    'stateChanges',
  ],
  [
    'log',
    '[15:12:59] [HISTORY_RANGE] c71e1a5b… wants up to 50 message(s) before 2026-09-04T08:41:33.920Z in 15335785…',
    'stateChanges',
  ],
  [
    'log',
    '[15:12:59] [HISTORY_RANGE] Hold nothing before that point in 15335785… - staying silent',
    'stateChanges',
  ],
  ['log', '[15:13:04] [HISTORY_RANGE] Sent 3 of 7 message(s) older than 2026-09-04T08:41:33.920Z for 15335785…', 'stateChanges'],
  ['log', '[15:13:04] [HISTORY_RANGE] 15335785… already reaches its floor - not asking', 'stateChanges'],
  // AND THE TWO THAT MUST NOT BE COVERED. Both mean the range could not be served for a REASON -
  // a malformed request, and no local store at all - which is not an error but is exactly the shape
  // a coverage gap has. Filed as routine they would make a real gap invisible, so they stay
  // unexplained until somebody reads one.
  [
    'log',
    '[15:13:04] [HISTORY_RANGE] Unusable range from b78568a3… for 15335785… - ignoring',
    'unexplained',
  ],
  ['log', '[15:13:04] [HISTORY_RANGE] No storage - cannot serve 15335785…', 'unexplained'],
  // THE SAME EXCHANGE REPORTING A REAL DIFF, the sibling of the `nothing to do` case above. Both
  // variants of the one template are pinned, because a rule written from the sighting alone would
  // have covered the first and left `(identical stores)` in `unexplained` for the next run to find.
  [
    'log',
    '[01:40:12] [HISTORY_REQ] 6bd37588... diff with b78568a3…:web-b78568a3…-msglwqh6-vegy: 0 to send, 1 to pull',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [HISTORY_REQ] 6bd37588... diff with b78568a3…:web-b78568a3…-msglwqh6-vegy: 3 to send, 0 to pull (identical stores)',
    'notable',
  ],
  // AND THE REMAINING FIVE SPELLINGS OF THE SAME SITE, pinned in one edit for the reason the two
  // above exist: `actions.ts` writes eight `[HISTORY_REQ]` lines, two had rules, and the campaign was
  // meeting the rest one PASS-DIRTY at a time (GRP-10, pass 2 of 2026-08-25, on `no probe`).
  // Identities here are the rig's own, reused from the cases above rather than copied from the
  // sighting - the device that produced it is a real one and this file is public.
  ['log', '[01:40:12] [HISTORY_REQ] 6bd37588... not local - cannot serve history, skip', 'notable'],
  ['log', '[01:40:12] [HISTORY_REQ] 6bd37588... not active locally - skip', 'notable'],
  [
    'log',
    '[01:40:12] [HISTORY_REQ] no probe from b78568a3…:web-b78568a3…-msglwqh6-vegy for 6bd37588... - nothing to answer',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [HISTORY_REQ] 6bd37588... asked b78568a3…:web-b78568a3…-msglwqh6-vegy to describe itself, no digest came',
    'notable',
  ],
  // THE FIFTH IS PINNED AT `unexplained` ON PURPOSE - the assertion is that it still BREAKS `clean`.
  // It is the fallback branch: this device could not read its own history store and declined a repair
  // it was elected to perform. Written here so that completing the tag "for consistency" fails the
  // selftest instead of quietly retiring the one line under it that accuses.
  [
    'log',
    '[01:40:12] [HISTORY_REQ] 6bd37588... store unreadable - staying silent so another member answers',
    'unexplained',
  ],
  // THE ACCESS-TOKEN REFRESH, ALL FOUR SPELLINGS OF ONE SITE. The fourth is the one GRP-8 landed in
  // `unexplained` on 2026-08-24; the others are pinned beside it because widening a rule is exactly
  // how the spellings that already worked stop working.
  ['log', '[01:40:12] [A] token exp=59s→refresh', 'benign'],
  // `remaining` is a subtraction against the wall clock: a token already expired gives a NEGATIVE
  // one, and it is the same renewal.
  ['log', '[01:40:12] [A] token exp=-3s→refresh', 'benign'],
  ['log', '[01:40:12] [A] token→refresh', 'benign'],
  ['log', '[01:40:12] [A] refresh→ /api/auth/refresh', 'benign'],
  ['log', '[01:40:12] [A] refresh✓ 214ms exp=3599s', 'benign'],
  // AND THE TWO `[A]` LINES THAT MUST NOT BE FORGIVEN, which is the whole reason the rule enumerates
  // spellings instead of taking the prefix. A logout or a fresh authentication inside a check that
  // did neither is a finding, and `unexplained` is what makes somebody read it.
  ['log', '[01:40:12] [A] clear', 'unexplained'],
  ['log', '[01:40:12] [A] login returnTo=/chat uri=https://canari-emse.fr flow=default', 'unexplained'],
  // A STALE `pending` INVITATION ROW BEING RECONCILED, IN THE THREE LINES IT TAKES, in order. The
  // server offers a device that is ALREADY in the tree, Rust declines the duplicate leaf, and the
  // row is promoted to `active` so the offer stops coming back. `notable`, all three: the header
  // only prints when there IS work to do, so seeing it means a membership row had drifted.
  ['log', '[01:40:12] [PENDING] 1 pending invitation(s) to process', 'notable'],
  ['log', '[01:40:12] [RUST::WARN] Skipping KeyPackage already a member of the group', 'notable'],
  [
    'log',
    '[01:40:12] [PENDING] tauri-d82cd226… already a member of 8325af55… - invitation fulfilled, marked active',
    'notable',
  ],
  // THE FOURTH SPELLING OF THE SAME DRIFT, taken from the TREE rather than the server's registry.
  // `actions.ts:225` skips the Add when the leaf is already a leaf, because re-adding invalidates
  // the queued Welcome and causes the kick+re-add churn the guard exists to end. Raised
  // `unexplained` on GRP-5, pass 3 of 5, 2026-08-24 - and only on pass 3, because the intermittence
  // is whether such a row happens to be pending when the sweep runs.
  [
    'log',
    '[11:57:26] [PENDING] tauri-d82cd226…-msgnk8nf-gyb2 already in tree for 5b186d04… - skip (will join via queued Welcome)',
    'notable',
  ],
  // THE FOURTH SPELLING OF "the guard held" in the pending-invitation family, and the one whose
  // asymmetry matters: the conversation EXISTS locally but is not usable yet, so the sweep must NOT
  // send a welcome_request - the branch for a conversation that is absent entirely is the one that
  // does. Landed in `unexplained` on GRP-8, pass 2 of 5, 2026-08-25.
  ['log', '[23:56:26] [PENDING] Group 941d7236…: local conversation not ready - skip', 'notable'],
  // Plural, because the count is a count and a rule pinned to `1` would forgive the interesting case.
  ['log', '[01:40:12] [PENDING] 4 pending invitation(s) to process', 'notable'],
  // AND THE LINE THE SAME TAG PRINTS WHEN THERE IS NOTHING TO DO, which must stay out of `notable`:
  // it fires on every connect, and a rule that could not tell the two apart would report the sweep
  // as a finding on every single run.
  ['log', '[01:40:12] [PENDING] No pending MLS messages', 'benign'],
  // THE OTHER FOURTEEN LINES OF THE SAME SWEEP, PINNED IN ONE GO ON 2026-08-25, after three passes
  // had each reported a different spelling of "the guard held" (GRP-5 pass 3, GRP-8 pass 2, GRP-4
  // pass 3). The whole site was read (actions.ts:119-336) and every line's bucket MEASURED against
  // the classifier rather than assumed; the reasoning per line is in watch.mjs beside its rule.
  // Pinned here because the value of enumerating a site is lost the moment a later prefix rule can
  // quietly widen over it.
  ['log', '[01:40:12] [PENDING] Group 941d7236… deleted or absent from server - cleaning up invitations', 'notable'],
  ['log', '[01:40:12] [PENDING] Group 941d7236… absent locally -> welcome_request sent', 'notable'],
  ['log', '[01:40:12] [PENDING] Group 416ce9d6…: lock held by another device - skip', 'notable'],
  ['log', '[01:40:12] [PENDING] Device web-b78568a3…-msgnk8nf-gyb2 not found (deregistered) -> cleanup', 'notable'],
  ['log', '[01:40:12] [PENDING] web-b78568a3… already in MLS tree of 941d7236…', 'notable'],
  ['log', '[01:40:12] [PENDING] WrongEpoch for web-b78568a3… in 941d7236… - checking...', 'notable'],
  ['log', '[01:40:12] [PENDING] web-b78568a3… already active - skip', 'notable'],
  ['log', '[01:40:12] [PENDING] 2 Welcome(s) sent.', 'notable'],
  // THE SUCCESS LINE IN BOTH SPELLINGS. `pour` was French in a dev-facing log (CLAUDE.md: those are
  // English) and was fixed on 2026-08-25, but W1 and W2 serve prod and will keep emitting the old
  // word until the next deploy. Both are pinned so the classifier is provably right on both sides of
  // it, and the French one can be deleted once no client can still produce it.
  ['log', '[01:40:12] [PENDING] Welcome → web-b78568a3… (user: b78568a3…) pour 941d7236…', 'notable'],
  ['log', '[01:40:12] [PENDING] Welcome → web-b78568a3… (user: b78568a3…) for 941d7236…', 'notable'],
  // AND THE FOUR THAT ARE DELIBERATELY RULELESS, pinned in `unexplained` so a later widening cannot
  // forgive them. The sweep aborting before it processed anything; a FALLBACK reached, which is by
  // definition the primary path having failed (the identical WELCOME_REQ line is pinned the same way
  // above); an error inside a destructive repair; and the catch-all that leaves a device unadded.
  ['log', '[01:40:12] [PENDING] Error fetching pending invitations: TypeError: fetch failed', 'unexplained'],
  ['log', '[01:40:12] [PENDING] KeyPackage retrieved via fallback for web-b78568a3… (> 30 days)', 'unexplained'],
  ['log', '[01:40:12] [PENDING] Kick error for web-b78568a3… in 941d7236…: GroupNotFound', 'unexplained'],
  ['log', '[01:40:12] [PENDING] Add error for web-b78568a3… to 941d7236…: TypeError: undefined', 'unexplained'],
  // THE LINE THAT REPLACED THE INHERITED ACCIDENT, anchored and exact like its fourteen siblings.
  // It says what the WrongEpoch branch knows and carries no error text, so it cannot be cut into a
  // different bucket by its own length.
  ['log',
   '[01:40:12] [PENDING] Epoch moved under the Add for web-b78568a3… in 941d7236… - invitation still pending, next sweep retries',
   'notable'],
  // THE TWO OLD SPELLINGS, KEPT PINNED, exactly as `pour|for` is kept in watch.mjs: A1 EMBEDS its
  // frontend, so it goes on emitting `Non-recoverable error for X: <errStr>` until an APK carrying
  // the new line is installed, while W1/W2 change at the next deploy. Both buckets are pinned
  // because which one the old line reached depended on whether `errStr.slice(0, 100)` cut the word
  // the generic `epoch` rule matched. Drop them once A1 runs a build with the new line.
  ['log', '[01:40:12] [PENDING] Non-recoverable error for web-b78568a3…: WrongEpoch', 'notable'],
  [
    'log',
    '[01:40:12] [PENDING] Non-recoverable error for web-b78568a3…: Error: the server refused the commit and the reason it gave ran l',
    'unexplained',
  ],
  // THE `[QUEUE]` WELCOME BUFFER AND THE FRAMES LEFT BEHIND, every spelling of the site pinned at
  // once (2026-08-25). GRP pass 5 landed the first two in `unexplained` on GRP-1; the rest were
  // placed with them, and are pinned here so a later widening of one rule cannot forgive another.
  // The first two are VERBATIM from GRP-1 pass 5, redacted id and all - the rig truncates a group
  // id before the classifier ever sees it, so that is the spelling the rules are matched against.
  [
    'log',
    // Respelt 2026-10-14: one line per Welcome window instead of one per frame.
    '[01:40:12] [QUEUE] Buffering messages for group b6a425af… behind its Welcome - the count is reported when the Welcome ends',
    'notable',
  ],
  // The three ways the window closes, pinned SEPARATELY though one rule matches all three: they
  // mean different things about the frames (given back, given back after a failure, given back by
  // the sweep), and the risk in a shared rule is exactly that one of the three later drifts.
  [
    'log',
    '[01:40:12] [QUEUE] Welcome complete: re-queued 1 buffered message(s) for b6a425af…',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [QUEUE] Welcome failed: re-queued 2 buffered message(s) for b6a425af-1111-2222-3333-444455556666',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [QUEUE] stranded buffer: re-queued 3 buffered message(s) for b6a425af-1111-2222-3333-444455556666',
    'notable',
  ],
  // THE TWO DEFERRAL SITES THAT FEED THAT RE-FETCH, one per `UnackedReason`. They are pinned
  // TOGETHER because only one of them ever had a rule: `unknown-group`'s line carries the word
  // `welcome_request` and was claimed by a generic keyword, while `absent-conversation`'s says the
  // same thing without the word and broke `clean` twice on 2026-08-25 (GRP-7 pass 3, GRP-8 pass 5).
  // Same event, same bucket - and pinning the pair is what stops the halves drifting apart again.
  [
    'log',
    '[01:40:12] [BUFFER] recovery started for unknown group b6a425af…',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [MLS] Message for absent conversation b6a425af… - retry after restore',
    'notable',
  ],
  // A commit race lost and answered (#2416, #2414), verbatim from the two pull requests, and the
  // controls: a reason outside the enum, and the same sentence saying something WAS committed.
  ['log', '[04:00:00] [PENDING] Add of web-c71e1a5b-mvn2mrrz-j6mu to 46163138... abandoned before its stage (tree-unconfirmed) - nothing committed', 'notable'],
  ['log', '[04:00:00] [SYNC] the Add was abandoned before its stage (removed-meanwhile) - nobody added', 'notable'],
  ['log', '[04:00:00] [PENDING] Add of web-c71e1a5b-mvn2mrrz-j6mu to 46163138... abandoned before its stage (gave-up) - nothing committed', 'unexplained'],
  ['log', '[04:00:00] [SYNC] the Add was abandoned before its stage (removed-meanwhile) - half of them added', 'unexplained'],
  // FRAMES REFUSED FOR LACK OF A ROW (#2414/#2416 round 4): normal only where a row provokes them, so
  // UNEXPLAINED by default - the generic `/epoch|GAP/` rule must NOT claim them (REFUSED_FOR_LACK_OF_ROW_NARRATION).
  ['log', "[04:00:00] [COMMIT_RACE] 46163138… not caught up: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked, the tree is unconfirmed", 'unexplained'],
  ['log', "[04:00:00] [REMOVE_MEMBER] 46163138… not caught up: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked, the tree is unconfirmed", 'unexplained'],
  ['log', "[04:00:00] [PENDING] 46163138… not caught up: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked, the tree is unconfirmed", 'unexplained'],
  ['log', "[04:00:00] [GAP] 46163138 not replayed: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked", 'unexplained'],
  ['log', "[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 3: frames refused for lack of a row are still queued - no replay past them, nothing to rebuild on", 'unexplained'],
  // ... and the control: the same tags saying something ELSE stay with the generic rule.
  ['log', "[04:00:00] [GAP] 46163138 not replayed: frames refused for lack of a row are still queued and bring the missing epochs - replaying anyway", 'notable'],
  ["log", "[04:00:00] [PENDING] Tree of 46163138... not confirmed at the server's epoch, cannot say whether c71e1a5b is a member - nothing added", 'notable'],
  ['log', '[04:00:00] [COMMIT_RACE] 46163138... the Add of 1 device(s) was refused (epoch-moved, now epoch 3) - rebuilding on the tree that won', 'notable'],
  ['log', '[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 2: read the commit log, 1 commit(s) applied, now epoch 3', 'notable'],
  ['warn', '[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 2: the commit log is ahead (4) and could not be applied (now 2) - left to the sync watchdog: x', 'notable'],
  ['warn', '[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 2: the commit log could not be read - nothing to rebuild on: TypeError: fetch failed', 'notable'],
  ['log', '[04:00:00] [REMOVE_MEMBER] 46163138… 223bc34e holds no leaf at epoch 3 - nothing to commit', 'notable'],
  ['log', '[04:00:00] [REMOVE_MEMBER] 46163138… 223bc34e removed from the tree, now epoch 3', 'notable'],
  ['log', '[04:00:00] [REMOVE_MEMBER] 46163138… the Remove of 223bc34e was refused (epoch-moved, now epoch 3) - re-reading the tree', 'notable'],
  // The boot re-fetch #2408 added (GAP-1, 2026-10-25), a keyed site with two reasons joined, and a
  // trigger nobody wrote, which stays dirt.
  ['log', '[04:15:13] [QUEUE] conversation rows seeded: re-fetching for 1 group(s) left behind as absent-conversation [13c295e1]', 'notable'],
  ['log', '[04:15:13] [QUEUE] conversation 13c295e1… now exists: re-fetching for 1 group(s) left behind as absent-conversation + behind-refused-backlog [13c295e1]', 'notable'],
  ['log', '[04:15:13] [QUEUE] something else happened: re-fetching for 1 group(s) left behind as absent-conversation [13c295e1]', 'unexplained'],
  // Both trigger/reason pairs, which are the whole of `UnackedReason` and its only two call sites.
  [
    'log',
    '[01:40:12] [QUEUE] welcome processed: re-fetching for 2 group(s) left behind as unknown-group [b6a425af, c7b53610]',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [QUEUE] conversations restored: re-fetching for 1 group(s) left behind as absent-conversation [b6a425af]',
    'notable',
  ],
  // The same re-fetch declining to run. `notable` on purpose - the fetch that was owed did not
  // happen, and only the reconnect pull makes that safe. It reached `stateChanges` by accident of
  // the word "reconnect" before it had a rule; this pins the intent, not the accident.
  [
    'log',
    '[01:40:12] [QUEUE] welcome processed: socket closed, the reconnect pull covers it',
    'notable',
  ],
  // The control frame nobody acts on, in both spellings of its group.
  [
    'log',
    '[01:40:12] [QUEUE] group_reset (control) ignored - group=b6a425af-1111-2222-3333-444455556666',
    'notable',
  ],
  ['log', '[01:40:12] [QUEUE] group_reset (control) ignored - group=unknown', 'notable'],
  // The drain's re-entrancy guard: benign, and the mechanism that keeps the bulk-ingest pair single.
  ['log', '[01:40:12] [QUEUE] Drain already running - skipped', 'benign'],
  // AND THE PAIRING DEFECT IT PREVENTS. The app writes this one at `warn`, so before it had a rule
  // it sat in `warnings` and never broke `clean` - a silent close against the wrong phase. `severe`.
  [
    'warning',
    '[01:40:12] [QUEUE] endBulkIngest for window 7, which is not open - ignored (closed twice?)',
    'severe',
  ],
  // A REPLAY THAT GAVE UP. It logs once at `[WARN]` and returns `undefined`, so the caller's commit -
  // the stream cursor, the seen-ciphertext set, the retry counters - never runs, while the ratchet
  // advances it made are flushed anyway by a `finally`. The generations are durably spent and the
  // record of spending them is not, so the NEXT replay meets those frames and reports real loss.
  // Carries no word `NOTABLE` looks for and is not a console error: without this rule a run could
  // contain it and no bucket would show it.
  [
    'log',
    '[01:40:12] [WARN] History replay failed for Canari Test Beta: Failed to fetch',
    'severe',
  ],
  // A Welcome sent in answer to a welcome_request - the invitation-link join and every re-add.
  // `notable`: the mechanism working, and also somebody asking to be let into a group.
  ['log', '[14:26:09] [WELCOME_REQ] Welcome -> b78568a3…:web-b78568a3…-msglwqh6-vegy for 1bf6fefe…', 'notable'],
  // The re-admission Welcome, whose guard used to discard it. Group id redacted to 8 hex as the
  // client logs it; no device id, deliberately.
  [
    'log',
    '[14:26:09] [WELCOME] 1bf6fefe\u2026 held but EVICTED - this Welcome is a re-admission, not a redelivery',
    'notable',
  ],
  // AND THE FOUR FAILURES UNDER THE SAME TAG THAT A PREFIX RULE WOULD HAVE FORGIVEN. Each is a
  // real refusal or a real repair; none may go quiet because its successful sibling was classified.
  // This one lands in `notable`, claimed by the generic `re-add` rule, and it is pinned at the
  // bucket it ACTUALLY reaches rather than the one it arguably deserves. It is the app accusing
  // itself ("fix needed client-side"), so a case can be made that it should break `clean` - but no
  // run has produced it, and inventing a SEVERE rule for an unobserved line would change what a
  // future phase's verdict means on a guess. Pinned so it can never go silent, which is the part
  // that matters; if a run ever prints it, that is the moment to decide.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] web-b78568a3… re-added 3x in vain on 1bf6fefe... - re-add suspended (fix needed client-side)',
    'notable',
  ],
  ['log', '[14:26:09] [WELCOME_REQ] KeyPackage not found for web-b78568a3… - aborting', 'unexplained'],
  ['log', '[14:26:09] [WELCOME_REQ] Group 1bf6fefe... not found - refusing', 'unexplained'],
  // THE POST-WELCOME COOLDOWN, a fifth line under the tag and the only one that is neither a
  // success nor a failure: a device asked to be let into a group it is still joining, so the kick
  // that would evict its fresh leaf is declined. `notable` - in a check that invited nobody, a
  // second welcome_request is the finding.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] web-b78568a3… Welcome sent 7s ago - still joining, skip',
    'notable',
  ],
  // THE WHOLE OF THAT SITE, PINNED IN ONE PLACE. Nineteen lines carry this tag and a run surfaces
  // them one at a time - GRP-4 spent two passes on two different spellings of "the guard held".
  // So every one is pinned here, at the bucket it reaches, and the ten `unexplained` ones are the
  // point of the exercise: they have no rule ON PURPOSE, and this table is what stops a later
  // `^\[WELCOME_REQ\]` prefix from quietly forgiving them.
  //
  // The six guards that held. Each means a request was declined for a reason the design intends.
  ['log', '[14:26:09] [WELCOME_REQ] Request from self (web-b78568a3...) - ignored', 'notable'],
  ['log', '[14:26:09] [WELCOME_REQ] No ready conversation for 1bf6fefe... - deferring', 'notable'],
  ['log', '[14:26:09] [WELCOME_REQ] 1bf6fefe... not ready yet - deferred', 'notable'],
  ['log', '[14:26:09] [WELCOME_REQ] Already in progress for 1bf6fefe-aaaa - skip', 'notable'],
  [
    'log',
    '[14:26:09] [WELCOME_REQ] Lock busy for 1bf6fefe-aaaa - another device in progress, skip',
    'notable',
  ],
  // The ALREADY_MEMBER catch: convergent, the device joins via the Welcome already queued for it.
  // Same family as the `[PENDING]` trio above, and classified the same way.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] web-b78568a3\u2026 already a member of 1bf6fefe... - skip',
    'notable',
  ],
  // A leaf replaced (Remove + Add in ONE commit), claimed by the generic `re-?add` rule rather than
  // a rule of its own. The older two-commit spelling is kept: an embedded APK emits it until updated.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] web-b78568a3... leaf in MLS tree - remove + re-add in one commit (no Welcome sent from here this session)',
    'notable',
  ],
  [
    'log',
    '[14:26:09] [WELCOME_REQ] web-b78568a3... leaf in MLS tree - kick + re-add',
    'notable',
  ],
  // AND THE REFUSALS, ABORTS AND ERRORS, WHICH MUST STAY UNEXPLAINED. `Group ... not found` and
  // `KeyPackage not found ... - aborting` are pinned above already; these are the rest.
  ['log', '[14:26:09] [WELCOME_REQ] Group 1bf6fefe... deleted - refusing', 'unexplained'],
  [
    'log',
    '[14:26:09] [WELCOME_REQ] Members of 1bf6fefe\u2026 unavailable - refused (requester will retry)',
    'unexplained',
  ],
  // The security guard: somebody REMOVED from a group asked to be re-added into it. Reaches
  // `notable` via the generic `re-?add` rule, not a rule of its own - reported on every run, and it
  // does not break `clean` because the refusal IS the correct outcome.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] 6bd37588-aaaa not a member of 1bf6fefe\u2026 (removed) - re-add refused',
    'notable',
  ],
  // A FALLBACK REACHED IS A SIGNAL, NEVER A PATH - so the one fallback at this site is the one
  // "success" line here that must break `clean`. It means fetchUserDevices' 30-day window did not
  // hold the requester, and that is a fact about the estate somebody has to read.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] KeyPackage retrieved via fallback for web-b78568a3\u2026 (> 30 days)',
    'unexplained',
  ],
  // A repair abandoned halfway: the leaf was kicked and the re-add never happened, so the device
  // is now in NEITHER state. The worst outcome at this site, and it may never go quiet.
  [
    'log',
    '[14:26:09] [WELCOME_REQ] KeyPackage not found after kick for web-b78568a3\u2026 - skip',
    'unexplained',
  ],
  ['log', '[14:26:09] [WELCOME_REQ] Kick error for web-b78568a3\u2026: GroupNotFound', 'unexplained'],
  // THE CATCH-ALL ERROR BRANCH, AND THE ACCIDENT IN HOW IT IS BUCKETED. Both lines below are the
  // same log call; they part company only because the generic `epoch` rule happens to match the
  // words the error carried. Pinned in both spellings rather than smoothed over: the seam is real,
  // it is the classifier's and not the app's, and either bucket reports the line - `notable` on the
  // board, `unexplained` breaking `clean`. Whichever a run produces, it is visible.
  ['log', '[14:26:09] [WELCOME_REQ] Error for web-b78568a3\u2026: epoch mismatch', 'notable'],
  ['log', '[14:26:09] [WELCOME_REQ] Error for web-b78568a3\u2026: GroupNotFound', 'unexplained'],

  // THE KICK ITSELF, ALL FOUR SPELLINGS, PINNED SO THE BUCKET IS A DECISION AND NOT AN OVERSIGHT.
  // `[KICK]` has no rule in watch.mjs and gets none here: a kick is a REPAIR, so reaching one at
  // all is the finding, and `unexplained` breaking `clean` is the correct reading of a run that had
  // to remove a leaf. The three failure spellings were added 2026-08-24 with the logging itself -
  // before that the function swallowed both of its calls and then claimed the removal anyway, so
  // the FIRST line below was emitted on runs where nothing at all had been removed.
  ['log', '[14:26:09] [KICK] Stale leaf b78568a3\u2026:web-b78568a3\u2026 removed from 642f389a\u2026', 'unexplained'],
  [
    'log',
    "[14:26:09] [KICK] Leaf b78568a3\u2026:web-b78568a3\u2026 still in 642f389a\u2026's tree - remove refused: Error: GroupNotFound",
    'unexplained',
  ],
  [
    'log',
    '[14:26:09] [KICK] Routing row for b78568a3\u2026:web-b78568a3\u2026 still listed on 642f389a\u2026 - clear refused: Error: 503 Service Unavailable',
    'unexplained',
  ],
  // The summary naming WHICH half survived - the line a reader acts on, and the one that has to stay
  // legible whichever half failed, because a leaf out of the tree with a routing row still shipping
  // to it is a different estate from the reverse.
  [
    'log',
    '[14:26:09] [KICK] Stale leaf b78568a3\u2026:web-b78568a3\u2026 only PARTIALLY removed from 642f389a\u2026 - tree=still present, routing=still listed',
    'unexplained',
  ],
  // AND THE SAME SEAM AS THE TWO `WELCOME_REQ` ERROR LINES ABOVE, TWICE. This failure carries the
  // server's OWN WORDS, so the bucket depends on what those words happen to say: `epoch` is claimed
  // by the generic reconciliation rule and `DuplicateSignature` by the rule for that condition, both
  // landing in `notable`, while `GroupNotFound` above matches nothing and breaks `clean`. All three
  // are pinned rather than smoothed over, because the seam is the CLASSIFIER's and not the app's -
  // one log call, one meaning, three buckets - and either bucket reports the line: `notable` on the
  // board, `unexplained` breaking `clean`. Whichever a run produces, it is visible.
  [
    'log',
    "[14:26:09] [KICK] Leaf b78568a3\u2026:web-b78568a3\u2026 still in 642f389a\u2026's tree - remove refused: Error: epoch moved under us",
    'notable',
  ],
  [
    'log',
    "[14:26:09] [KICK] Leaf b78568a3\u2026:web-b78568a3\u2026 still in 642f389a\u2026's tree - remove refused: Error: DuplicateSignature",
    'notable',
  ],

  // The one that must NEVER be demoted: a real loss, timestamped exactly as the app writes it.
  ['log', "[14:24:06] [MLS] LOST frame for 642f389a… from d82cd226…: generation consumed but this frame was never processed - the sender's ratchet rewound (SecretReuseError, frame 5p:kq68gk)", 'severe'],
  // GROUP MEMBERSHIP, added 2026-08-23 with the rules themselves. Every `benign` line below is one
  // GRP produced on a healthy add, rename or departure; every `unexplained` line below is the SAME
  // gesture failing, and is here because the risk in classifying a success is a prefix that forgives
  // its failure too.
  ['log', '[14:08:26] [GROUP] My other devices: 3 (tauri-x-y, web-x-z, web-x-w)', 'benign'],
  [
    'log',
    '[14:08:26] [GROUP] addMembersBulk result: welcome=true (2115 bytes), added=3 (tauri-x-y, web-x-z, web-x-w)',
    'benign',
  ],
  ['log', '[14:08:26] [GROUP] Welcome -> d82cd226…:web-d82cd226…-mq6xoj9k-b6wr OK', 'benign'],
  // THE FAILURE OF THE LINE ABOVE, which no rule may forgive - this is what an undelivered Welcome
  // looks like, and the whole GRP phase exists to see it.
  ['log', '[14:08:26] [GROUP] Welcome -> d82cd226…:web-d82cd226…-mq6xoj9k-b6wr FAILED', 'unexplained'],
  ['log', '[14:08:39] Inviting 1 member(s): b78568a3…', 'benign'],
  ['log', '[14:08:40] [OK] Added: b78568a3… (1 device(s)). (1 user(s) delivered)', 'benign'],
  ['log', '[14:08:40] [SYNC] Members added: b78568a3… (1/1 delivered)', 'benign'],
  ['log', '[14:10:28] b78568a3… retire du groupe.', 'benign'],
  // THE CURRENT SPELLINGS of creation, rename and departure: the id, never the name (GRP, 2026-10-22).
  ['log', '[06:44:38] [OK] Group d80f646d… created.', 'benign'],
  ['log', '[06:44:38] [GROUP] Group created successfully (id=d80f646d…)', 'benign'],
  ['log', '[14:12:38] Group cab9b983… renamed', 'benign'],
  ['log', '[14:12:38] 📝 Group renamed by f7a9bb80…', 'benign'],
  ['log', '[06:49:10] [INFO] c71e1a5b… left group "4271a303…"', 'benign'],
  ['debug', '[2026-10-22T04:44:36.752Z] [historyOverlay] stack ready - entries written', 'benign'],
  ['debug', '[2026-10-22T04:40:12.551Z] [AUDIO] opening the tone output for send', 'benign'],
  ['debug', '[2026-10-22T04:40:12.543Z] [AUDIO] last tone ended, suspending the tone output', 'benign'],
  // A tone that FAILED is not routine, and the rule names its one reason.
  ['debug', '[2026-10-22T04:40:12.543Z] [AUDIO] the send tone failed, suspending the tone output', 'unexplained'],
  ['log', '[06:40:14] [OUTBOX] 3d9f6c2f… durable write took 1 ms (0 file bytes)', 'benign'],
  ['debug', '[2026-10-22T04:40:12.275Z] [CHAT_VIEW] 358105f1 messages 1 (hasNewMessage=true, response=follow-bottom)', 'benign'],
  ['debug', '[2026-10-22T04:40:12.275Z] [CHAT_VIEW] 358105f1 messages 2 (hasNewMessage=false, response=n/a)', 'benign'],
  ['log', '[14:08:40] [WELCOME] Group ee6ba569… ready', 'benign'],
  [
    'log',
    '[14:15:47] [WELCOME] 110280b7… already held - redelivered Welcome ignored (idempotent)',
    'benign',
  ],
  // THE TWO HALVES OF THE LINE THAT USED TO BE ONE. The commit form is the ordinary outcome of
  // every membership change; the other form is a frame nobody could decrypt and must keep breaking
  // `clean`. Pinned together because a single rule over the shared prefix would forgive both.
  [
    'log',
    '[14:32:47] [MLS] No application payload for 4ad03375… - commit applied, none expected',
    // `stateChanges`, not `benign`: an epoch moved, which is worth SEEING and is not a defect.
    // `unexplained` excludes `stateChanges`, so it does not break `clean` - and unlike a BENIGN
    // entry it stays in a bucket a reader looks at.
    'stateChanges',
  ],
  [
    'log',
    '[14:32:47] [MLS] No application payload for 4ad03375… - not a commit: stale commit already applied, or a frame older than the kept ratchet window',
    'unexplained',
  ],
  // THE COVERAGE LEG OF THE HISTORY EXCHANGE, and the three failures wearing the same tag. The
  // success spelling is the responder stating its own window - sent only when NARROWER, and the one
  // thing that lets an asker tell a clipped answer from a conversation with no more past - so it
  // belongs with the request and the bundle it answers. The other three are failures of that same
  // mechanism and must keep breaking `clean`, which is why the rule is pinned to one spelling
  // instead of the tag: a `^\[HISTORY_COVERAGE\]` prefix would forgive all four. Seen on DEL-1,
  // 2026-09-05.
  [
    'log',
    '[06:15:35] [HISTORY_COVERAGE] Told f7a9bb80…:tauri-f7a9bb80…-mtn445lg-25sy we are complete only from 2026-06-07T00:00:00.000Z in cb9f3a9a…',
    'notable',
  ],
  ['log', '[06:15:35] [HISTORY_COVERAGE] Unusable coverage from f7a9bb80… for cb9f3a9a…', 'unexplained'],
  [
    'log',
    '[06:15:35] [HISTORY_COVERAGE] Chase failed for cb9f3a9a…: TypeError: nope',
    'unexplained',
  ],
  [
    'log',
    '[06:15:35] [HISTORY_COVERAGE] Could not state our coverage to f7a9bb80… for cb9f3a9a…: TypeError: nope',
    'unexplained',
  ],
  // AND THE TWO EVICTION LINES THAT MUST NOT BE CLASSIFIED. Both are the defects GRP-3 and GRP-8
  // found on 2026-08-23: a removed member's pipeline attempting recovery on a group it was
  // legitimately evicted from, and its outbox retrying an encrypt that can never succeed. Both are
  // FIXED - the Remove commit is now authoritative, so neither line can be produced any more - and
  // they stay here as regression sentinels: their return means the fix is gone, and a later triage
  // pass must not be able to quietly forgive them.
  ['log', '[14:10:28] [PIPELINE] Recovery attempt finished for 4ca35caf…', 'unexplained'],
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… transient failure (attempt 1): Crypto/OpenMLS error: Encrypt error: GroupStateError(UseAfterEviction)',
    'unexplained',
  ],
  // THE DEPARTURE THIS DEVICE CHOSE, stated before it is performed - the third time that same 403
  // came back and the last. A leave and a delete are not learnt from a commit, so the two above do
  // not cover them: the device decides, and it used to record the decision LAST, after the server
  // call and the WASM forget. Anything reading the conversations map inside that window still saw a
  // live group whose membership was already gone, and asked the members-only endpoint about it.
  //
  // `stateChanges` for its neighbours' reason, and it must be SOME bucket: the line is emitted on
  // every leave and every delete the campaign performs, so leaving it unclassified would put four
  // GRP rows into PASS-DIRTY on the sentence that proves the defect is fixed.
  [
    'log',
    '[14:10:28] [DELETE] 4ca35caf… retired locally before the server action',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [LEAVE] 4ca35caf… retired locally before the server action',
    'stateChanges',
  ],
  // WHAT REPLACED THEM. The eviction is learnt from the commit that stated it, so the removed
  // device reports the change and stops - no recovery, no retry ladder. `stateChanges`, not
  // `benign`: what this client holds really did change, and a reader must see it.
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… by a Remove commit - conversation retired',
    'stateChanges',
  ],
  // THE OTHER THREE EVIDENCES THAT REACH THE SAME DISPOSITION, pinned one by one because the rule
  // enumerates them rather than globbing: the exclusion announced by its author, a frame that
  // arrived after the commit, and a membership check reading a commit already applied. All three
  // used to be written out at their own sites, and two of them retired nothing at all.
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… by an exclusion its author announced - conversation retired',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… by a Remove commit a frame for the group arrived after - conversation retired',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… by a Remove commit this device had already applied - conversation retired',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [RUST::WARN] Evicted from group 4ca35caf-1f2e-4c3d-8a9b-0e1d2c3b4a59: a Remove commit naming this device was applied at epoch 4 - the group is now inactive and nothing further can be sent',
    // `notable`, not `stateChanges`, and pinned so the reason is recorded: the line names the epoch
    // the removal landed at, so NOTABLE's generic epoch rule claims it and `stateChanges` excludes
    // whatever is already notable. Same contract for a reader either way - surfaced, does not break
    // `clean` - which is why the unreachable STATE_CHANGE rule was deleted instead of fought.
    'notable',
  ],
  // ── THE OUTBOX ENTRY THAT DIED WITH ITS GROUP: SIX LINES, TWO VERDICTS ────────────────────────
  //
  // The report used to name neither the kind nor the cause, so one sentence covered a read receipt
  // losing a race and a message the user wrote being lost for ever - and the `group-deleted`
  // spelling had no rule at all, which is why it came back unexplained in GRP-4, GRP-6 and GRP-7.
  // These six cases exist because the SPLIT is the whole value: if the classifier ever widens to
  // cover the two at the bottom, three checks go green while a user's message quietly disappears.
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… control entry in 4ca35caf…, group-deleted - permanent failure (control: nothing the user wrote is lost)',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… control entry in 4ca35caf…, evicted - permanent failure (control: nothing the user wrote is lost)',
    'stateChanges',
  ],
  // A real message lost to an EVICTION is by design on the removed peer of GRP-3 and GRP-8.
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… text entry in 4ca35caf…, evicted - permanent failure',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… media entry in 4ca35caf…, evicted - permanent failure',
    'stateChanges',
  ],
  // A real message lost because somebody DELETED the group under us is not by design anywhere: it
  // owes an explanation on the row that produced it, so it must stay unexplained.
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… text entry in 4ca35caf…, group-deleted - permanent failure',
    'unexplained',
  ],
  // And the eviction learnt from a REFUSED SEND stays unexplained whatever it was carrying: it
  // means the fact-based path missed the removal, which is the branch that hides an eviction.
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… control entry in 4ca35caf…, evicted-late - permanent failure (control: nothing the user wrote is lost)',
    'unexplained',
  ],
  // THE THIRD PATH: a frame the group still routed to a device it had removed. The two spellings
  // land in different buckets for one reason - the Rust one names the epochs, so NOTABLE's generic
  // epoch rule claims it - and both are surfaced without breaking `clean`, which is the contract
  // that actually matters. Pinned so the precedence is recorded rather than rediscovered.
  [
    'log',
    '[14:10:28] [MLS] Frame for 4ca35caf… arrived after eviction - ACKed, no repair owed',
    'stateChanges',
  ],
  [
    'log',
    '[14:10:28] [RUST::WARN] Frame for group 4ca35caf-1f2e-4c3d-8a9b-0e1d2c3b4a59 arrived after this device was evicted - ACKed and dropped, no repair is owed: msg_epoch=4 group_epoch=4',
    'notable',
  ],
  // And the history replay's own report of the same thing. A replay that added nothing because we
  // are no longer a member is not an empty replay, and the line exists so the two can be told apart.
  [
    'log',
    '[14:10:28] [OK] Nothing caught up for Equipe: removed from this group, 12 frame(s) skipped.',
    'stateChanges',
  ],
  // A REPLAYED Remove COMMIT. Nothing happened the second time, which is why it is `benign` while
  // the line above it is not. Two spellings, one rule each, deliberately: a prefix rule over
  // `[EVICT]` would have covered both AND the two below, which must break `clean`.
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… - already retired, nothing to do',
    'benign',
  ],
  // THE TWO EVICTION LINES THAT MUST STILL BREAK `clean`, pinned beside the four successes above
  // because that is the only thing stopping an `^\[EVICT\]`-shaped rule from swallowing them.
  //
  // The first is the branch that HIDES an eviction: membership could not be read after a commit, so
  // the conversation was not retired and the next refused send is what will find it. The second is
  // OpenMLS and our own query DISAGREEING about membership - the query said we are still a member
  // and the send was refused anyway. Neither is survivable as a forgiven line.
  [
    'log',
    '[14:10:28] [EVICT] Membership of 4ca35caf… could not be read after a commit: Error: WASM client not ready',
    'unexplained',
  ],
  [
    'log',
    '[14:10:28] [OUTBOX] 1d9076db… send REFUSED as evicted, after isGroupActive answered that this device is still a member of 4ca35caf… - the two disagree, and OpenMLS is the one that is right',
    'unexplained',
  ],
  // AND THE TWO EVIDENCES THAT MEAN THE FACT ARRIVED LATE, in the disposition's own words. They are
  // the same `[EVICT]` module as the four successes above and they are deliberately NOT written in
  // the `Removed from …` shape, so the rule that forgives those cannot reach them however it is
  // later widened. Reaching one means a message was written, encrypted and refused to learn what a
  // Remove commit had already stated, which is never a forgivable line.
  [
    'log',
    '[14:10:28] [EVICT] 4ca35caf… - a send was refused as evicted, so this device learnt its removal by FAILING: the Remove commit never reached it',
    'unexplained',
  ],
  [
    'log',
    '[14:10:28] [EVICT] 4ca35caf… - the delivery service refused this device as a non-member, so this device learnt its removal by FAILING: the Remove commit never reached it',
    'unexplained',
  ],
  // And the Rust half of that same contradiction, which accuses from the other side of the FFI.
  [
    'log',
    '[14:10:28] [RUST::ERROR] Send refused: this device was evicted from group 4ca35caf-1f2e-4c3d-8a9b-0e1d2c3b4a59 and did not learn it from the Remove commit - the commit was never received, or its `is_group_active` check did not run',
    'unexplained',
  ],
  // And one nobody has ever classified, which must land in `unexplained` and break `clean`.
  ['log', '[14:24:06] [SOMETHING] a line no rule has ever seen', 'unexplained'],
  // THE BURN, which is the repair succeeding and must be visible without failing anything. A run that
  // reloaded inside the checkpoint window has this line and a run that missed the window does not,
  // which is the only way `burn.mjs` can tell a real pass from an experiment that never happened.
  [
    'log',
    "[14:24:06] [MLS] Restored state for 642f389a… was 2 generation(s) behind this device's own sends - burnt, no frame will re-use a spent generation",
    'notable',
  ],
  ['log', '[14:24:06] [MLS] Could not burn 2 generation(s) for 642f389a…: GroupNotFound', 'notable'],
  // The cold start, which only a check that reloads on purpose ever sees. Each is a step reporting
  // that it completed; a step that fails says something else and must stay unexplained.
  ['log', '[hooks] Deep-link listener registered', 'benign'],
  ['log', '[hooks] launch URL read on attempt 1, 42ms after the bundle ran', 'benign'],
  // NOT forgiven, on purpose: a replayed launch URL means the WebView reloaded under the app, which
  // is the visible end of something upstream and has to reach the row that met it.
  ['log', '[hooks] launch URL already acted on by this start, ignoring the replay: fr.emse.canari://chat/x', 'unexplained'],
  ['debug', '[Cookies] flushed after refresh', 'benign'],
  ['log', '[21:31:56] [PIN] Device key restored from PinVault - auto-login…', 'benign'],
  ['log', '[21:36:45] MLS state loaded from mls.bin (native).', 'benign'],
  ['log', '[DB] Using SQLite storage (Tauri)', 'benign'],
  [
    'info',
    '[Push] startPushService device=tauri-aaaaaaaa…-bbbbbbbb-cccc (platform will be confirmed by FCM token)',
    'benign',
  ],
  // TWO DECISION LINES the coding standard requires (read on GRP, 2026-10-22), pinned whole: the
  // overlay hand-off and the composer's measured height. A re-worded emitter must fall back to
  // `unexplained`, which the control after them proves.
  [
    'debug',
    '[2026-10-22T01:32:57.758Z] [historyOverlay] overlay 39 takes the ghost entry under the pointer (a hand-off)',
    'benign',
  ],
  ['debug', '[2026-10-22T01:32:59.021Z] [ChatComposer] composer height unset -> 70px', 'benign'],
  ['debug', '[2026-10-22T01:32:59.021Z] [ChatComposer] composer height 70px -> 92px', 'benign'],
  ['debug', '[2026-10-22T01:32:59.021Z] [ChatComposer] composer height changed', 'unexplained'],
  // THE `removed` GUARD FIRING, AND ITS FIVE SIBLINGS NOT BEING SWALLOWED WITH IT. Every one of
  // these lines is the SAME log statement in `discoverMissingGroups`; only the reducer's reason
  // separates a designed keep from a keep taken because the client could not read the server. A
  // rule on `kept - ` alone would silence the second kind, so both are pinned here: READ-10 came
  // back PASS-DIRTY on the first, and would come back clean on the second if this ever regressed.
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "READ10-mt3a2434" kept - already removed, awaiting a manual deletion',
    'benign',
  ],
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "Equipe" kept - server status uncertain (network)',
    'unexplained',
  ],
  [
    'log',
    '[20:23:56] [DISCOVERY] UI group "Equipe" kept - members unavailable (doubt)',
    'unexplained',
  ],
  // A GROUP TAKING ITS NAME BACK FROM THE SERVER - the correction shipped by #693, pinned because
  // the fix and the instrument that must not trip over it were written a commit apart. The line was
  // unclassified for exactly that gap: it is a REAL change to what the client holds, so it belongs
  // in `stateChanges` beside the placeholder it corrects, and it is not a defect, so it must not
  // sit in `unexplained` and dirty every campaign run where a group is renamed.
  [
    'log',
    '[20:23:56] [DISCOVERY] 642f389a... relabelled "Alice" -> "Promo 2027" (the server is the authority on a group\'s name)',
    'stateChanges',
  ],
  // CONTROL, AND IT IS THE ONE THAT MATTERS: the same event with the reason re-worded. The pattern
  // is anchored on the whole sentence on purpose - if someone edits the emitter's prose without
  // editing the rule, the instrument stops recognising its own subject, and the campaign must learn
  // that from `unexplained` rather than from a silently forgiven line.
  [
    'log',
    '[20:23:56] [DISCOVERY] 642f389a... relabelled "Alice" -> "Promo 2027" (the server knows best)',
    'unexplained',
  ],
  // CONTROL against widening the id to `.*`, which would let this rule swallow the three `kept - `
  // lines above - two of which MUST stay unexplained.
  [
    'log',
    '[20:23:56] [DISCOVERY] not-an-id... relabelled "Alice" -> "Promo 2027" (the server is the authority on a group\'s name)',
    'unexplained',
  ],
  // And the dismissal that ends that row's life, which READ-10 now performs itself.
  ['log', '[20:24:01] [DELETE_LOCAL] Local conversation deleted: 642f389a…', 'notable'],
  // THE TWO SIDES OF THE 2026-08-24 MEMBERSHIP FIX, pinned together because they are opposite kinds
  // of line emitted by the same function, and the temptation was to allowlist both.
  //
  // The first REPLACES an error: `loadGroupMembers` asked a members-only endpoint for the roster of a
  // conversation this device had been removed from, so GRP-3 kept recording
  // `GET /api/mls/groups/:id/members -> 403`. A line whose whole job is to stand where a 403 stood
  // must not itself count as dirt - it is expected AND necessary, since without it a clean GRP-3
  // cannot be told from one that never selected the conversation.
  [
    'log',
    '[12:41:03] [VERIFY] Roster of f3f2dc35… not requested - conversation retired',
    'benign',
  ],
  // The second is the visible end of something upstream: a server re-registration that failed. It
  // was a `catch {}` with no log at all until the same change, and it stays UNEXPLAINED on purpose -
  // it fires only when a repair did not work, and that is a thing somebody must come and look at.
  [
    'log',
    '[12:41:03] [SYNC] Server re-registration of f3f2dc35… failed: Error: NetworkError',
    'unexplained',
  ],
  // ── THE LINE THE 403 FIX ADDED, pinned before it is ever measured ──────────────────────────────
  //
  // A FIX THAT INVENTS A SENTENCE CAN DIRTY THE VERY CHECK IT REPAIRS. GRP-6 watches a leaver for
  // thirty seconds, and the leaver is now exactly where this line is emitted, so it lands in that
  // window on the first pass after the deploy. It is claimed by NOTABLE's broad `re-?add` rule -
  // asserted here rather than assumed, because "a broad rule probably covers it" is how a sentence
  // nobody chose to allowlist ends up silenced.
  [
    'log',
    '[15:56:39] [READD] ca436926... server holds no membership row for us - marking removed',
    'notable',
  ],
  // Its sibling, unchanged by the fix and now reserved for failures that say NOTHING about
  // membership. Same bucket, and that is the point: a reader sees both, neither breaks `clean`, and
  // the distinction between them is carried by the sentence rather than by the bucket.
  [
    'log',
    '[15:56:39] [READD] ca436926... externalJoin threw: GroupInfo fetch HTTP error: 503',
    'notable',
  ],
  // THE SINGLE-FLIGHT JOIN GUARD, both scope shapes, verbatim from COMM-11, COMM-13, COMM-21 and
  // COMM-22 on 2026-08-25 where all four landed in `unexplained` and dirtied four passing rows. The
  // community spelling is pinned beside the salon one although no run has produced it yet: it comes
  // from the same `scopeLabel` call and a rule that covered one and not the other is exactly the
  // half-written pattern this file exists to catch.
  [
    'log',
    '[14:23:35] [GRAINE] salon 079878d3 of 15f60f8d: a join is already in flight for this scope - awaiting it',
    'benign',
  ],
  [
    'log',
    '[14:23:35] [GRAINE] community 15f60f8d: a join is already in flight for this scope - awaiting it',
    'benign',
  ],
  // AND THE EVICTION IT MUST NOT BE CONFUSED WITH, pinned at `unexplained` ON PURPOSE. A device that
  // holds a group the server routes nothing to was thrown out by somebody's commit, and outside a
  // check that did the throwing that is a finding - COMM-22 forgives it per row with
  // `EVICTED_REJOIN_NARRATION` and nothing else may. Verbatim from COMM-22's W2 on 2026-08-25.
  [
    'log',
    '[14:40:08] [GRAINE] salon 495b56cb of d4075a25: this device holds the distribution group but the group holds NO row for it (0 device(s) for this user) - the local group is stale, rejoining',
    'unexplained',
  ],
  // THE TWO LINES COMM-18's FIFTH RUN DIRTIED A ROW WITH, and both dirtied it the same way: the
  // PRODUCT re-worded a sentence and left the rule behind. That is the failure mode this whole file
  // exists for, met twice in one run, so both spellings are pinned verbatim from that run.
  [
    'info',
    '[GRAINE] community 47da4ca1 has no other member and no other device of ours to ask for history',
    'benign',
  ],
  // AND THE WORDING IT REPLACED, PINNED AT `unexplained` ON PURPOSE. `e96bfa12` widened the sentence
  // when the repair path learnt to ask another device of the same user, so only a STALE BUNDLE can
  // still print the short form - and a stale bundle unproves every verdict the run it appears in
  // took. Forgiving it would turn the loudest possible warning into routine.
  ['info', '[GRAINE] community 47da4ca1 has no other member to ask for history', 'unexplained'],
  // THE ANSWER TO A SEED REQUEST, WHICH NOW NAMES ITS DELIVERY CLASS. Both tails are routine here -
  // what decides which is correct is `frameHandler.test.ts`, and this file's job is only that
  // neither dirties a row. The declining variant is pinned beside them because the suffix follows an
  // optional clause, which is the exact place a hand-written regex stops matching.
  ['info', '[GRAINE] answered alice with 1 seed(s) as key material', 'benign'],
  ['info', '[GRAINE] answered alice with 0 seed(s), declining 1 as transport', 'benign'],
  // ...AND THE SUFFIX-LESS FORM, `unexplained` for the same reason as the short history line above:
  // after 2026-08-25 only a client on an old bundle can print it, and on this campaign that is the
  // single most important thing a log can tell us.
  ['info', '[GRAINE] answered alice with 1 seed(s)', 'unexplained'],
  // The section 20 admitter's success path is routine; its retry after a lost epoch is NOT.
  ['info', '[GRAINE] ADMIT invited f7a9bb80 to 198d5d07 (private salon: false)', 'benign'],
  ['info', '[GRAINE] ADMIT f7a9bb80 into community 198d5d07: start', 'benign'],
  ['info', '[GRAINE] ADMIT f7a9bb80 into salon 079878d3 of 198d5d07: start', 'benign'],
  ['info', '[GRAINE] ADMIT Welcome -> f7a9bb80:tauri-f7a9bb80…-mueu83ad-njjp for community 198d5d07', 'benign'],
  ['warn', '[GRAINE] ADMIT f7a9bb80 into community 198d5d07: the Add was not accepted and could not be rebuilt (x; epoch 0 -> 0) - 1 device(s) of theirs NOT admitted', 'notable'],
  // A PRIVATE SALON THE WALK DECLINED TO ENTER - `notable`, not `benign`: correct on a community
  // holding salons this viewer may not read, and THE finding in any row about being let into one.
  [
    'log',
    '[20:46:31] [GRAINE] private salon bea8c230 of 9b34e540 not entered: the server says this viewer has no access to it, so its GroupInfo would be refused',
    'notable',
  ],
  // Its sibling tail, `unexplained` because it is a different claim: not "may not read this" but
  // "could not have read anything". One sentence, two tails, two buckets - by design.
  [
    'log',
    '[20:46:31] [GRAINE] private salon bea8c230 of 9b34e540 not entered: no MLS client on this load',
    'unexplained',
  ],
  // A DEVICE ERASING ITSELF, AND THE FOUR LINES THE HEAL-REVOKE ROWS REST ON.
  //
  // The three success sentences are `notable` and gate nothing, which is why those rows hand
  // `ignoringExpectedLog` no list for them: `NOTABLE`'s `/forget|revoke|reset|corrupt/i` claims all
  // three, so they never reached `unexplained` and there has never been anything to forgive. Pinned
  // HERE rather than left implicit, because the next reader of `healrevoke.mjs` will otherwise write
  // the list again - as one was written, on 2026-08-29, before anything was measured.
  //
  // The `[RESET]` bookends carry NO timestamp - `wipeDeviceToFactory` uses a bare `console.log` -
  // while the `[SECURITY]` line goes through `appendLog` and does. Both stampings are here on
  // purpose: an `^`-anchored rule silently dead against one of them is this file's oldest defect.
  ['log', '[16:02:11] [SECURITY] Revoked device detected: local state purged, reconnection required.', 'notable'],
  ['log', '[RESET] wiping this device back to a fresh install', 'notable'],
  ['log', '[RESET] done - nothing of this device remains', 'notable'],
  // AND THE ONE THAT MUST BREAK `clean`: HEAL-REVOKE-1's open P1 is a revoked device that kept
  // everything, and this is the sentence in which it would say so. It sits one word from the line
  // above and means the opposite, so it is asserted in `errors` and not merely in `notable`.
  // `errors` is the bucket that DECIDES - it also lands in `notable`, and the matcher above asserts
  // membership rather than exclusivity for exactly that reason.
  ['error', '[RESET] 2 store(s) SURVIVED the wipe: canari-mls, keyval-store', 'errors'],
  // A BULK ADD OF THREE, as FLOOR-2 prints it (2026-10-25): the member list is comma-separated.
  ['log', 'Inviting 3 member(s): c71e1a5b…, 223bc34e…, 43319a65…...', 'benign'],
  ['log', '[OK] Added: c71e1a5b…, 223bc34e…, 43319a65… (3 device(s)). (3 user(s) delivered)', 'benign'],
  ['log', '[SYNC] Members added: c71e1a5b…, 223bc34e…, 43319a65… (3/3 delivered)', 'benign'],
  ['log', '[SYNC] Members added: c71e1a5b…, 223bc34e… (1/2 delivered) and more', 'unexplained'],
  // The admitted device's two 1.4.x decision lines, and their controls.
  ['log', "[HISTORY_ADDRESSED] 7722a9f1… admitted - the inviter's push is solicited", 'benign'],
  ['log', '[LEAF_REFRESH] 7722a9f1... first sight of this leaf (admitted, no refresh of ours on record) - observed now, its first refresh is owed from 5.2 d after this or seven days after its admission, whichever is later', 'benign'],
  ['log', '[LEAF_REFRESH] 7722a9f1... first sight of this leaf (commit-sourced, no refresh of ours on record) - observed now, its first refresh is owed from 5.2 d after this', 'unexplained'],
  ['log', '[HISTORY_ADDRESSED] REFUSED an addressed message in 7722a9f1… from c71e1a5b - only a history answer may be addressed in a conversation', 'unexplained'],
];

let failures = 0;

/**
 * The same sentence carrying the stamp the app writes TODAY, millisecond field included.
 *
 * WHY EVERY CASE IS RUN TWICE. Every list in `watch.mjs` is `^`-anchored against the sentence, so
 * the reader that removes the stamp decides whether ANY of them can match. On 2026-09-16 #742 gave
 * the console a millisecond field and the reader knew only `[14:11:08]`; the bracket stayed at
 * position 0 and BENIGN, NOTABLE, SEVERE and STATE_CHANGE went dead together, for five days,
 * silently. The fixtures below were all written with the older spelling, so every one of them kept
 * passing while the rig reported a hundred lines of ordinary narration as dirt on real clients.
 *
 * A fixture list cannot be trusted to be re-spelt by hand whenever the app changes its stamp - that
 * is the same "somebody will remember" that lost the five days. So the PROPERTY is asserted
 * instead: a stamp carries no meaning, therefore stamping a line must not move it between buckets.
 * Whatever the next format turns out to be, adding it here is one line and the gate goes red the
 * day the reader stops recognising it.
 */
const stamped = (text) =>
  /^\[\d\d:\d\d:\d\d\]/.test(text)
    ? text.replace(/^\[(\d\d:\d\d:\d\d)\]/, '[$1.520]')
    : `[14:11:08.520] ${text}`;

const BUCKETS = ['severe', 'errors', 'notable', 'stateChanges', 'unexplained'];

/** Which buckets one line lands in. The needle is the sentence, so it matches either spelling. */
async function bucketsFor(level, text) {
  const rep = await report({ cx: cxOf([[level, text]]), label: 'selftest' });
  const needle = stripStamp(text).slice(0, 49);
  return BUCKETS.filter((b) => rep[b].some((l) => String(l).includes(needle)));
}

for (const [level, text, want] of CASES) {
  const landed = await bucketsFor(level, text);
  // `benign` is not a bucket - it is the absence of every other one.
  const got = landed.length === 0 ? 'benign' : landed.join('+');
  // THE STAMP CHANGES NOTHING, and this is the assert that says so. Reported as its own failure
  // rather than folded into the one below: "this rule is wrong" and "the reader cannot see past
  // the stamp" are different repairs, and a hundred of the second at once is one defect, not a
  // hundred.
  const landedStamped = await bucketsFor(level, stamped(text));
  if (landed.join('+') !== landedStamped.join('+')) {
    failures++;
    console.log(`FAIL stamp        ${text.slice(0, 78)}`);
    console.log(`       bare: ${got || 'benign'}   stamped: ${landedStamped.join('+') || 'benign'}`);
  }
  /**
   * MEMBERSHIP, NOT EXCLUSIVITY - the buckets overlap by design and demanding one was the test
   * being wrong rather than the classifier. `[MLS] LOST frame` is `severe` AND `notable`: it is a
   * defect that breaks `clean` and it is also something a reader must see in the noise summary.
   * What must hold is that the bucket which DECIDES is present, and that nothing expected elsewhere
   * silently also sits in `unexplained` - the two failures worth catching.
   */
  const ok =
    want === 'benign'
      ? landed.length === 0
      : landed.includes(want) && (want === 'unexplained' || !landed.includes('unexplained'));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(12)} ${text.slice(0, 78)}`);
  if (!ok) console.log(`       landed in: ${got}`);
}

// `clean` must be false for the unexplained line and true for the benign one - the gate itself,
// not just the sorting.
const dirty = await report({ cx: cxOf([['log', '[14:24:06] [SOMETHING] a line no rule has ever seen']]), label: 's' });
const clean = await report({ cx: cxOf([['log', '[14:25:41] [LIFECYCLE] Resume: already connected (flag=true, socket=true).']]), label: 's' });
if (dirty.clean !== false) { failures++; console.log('FAIL an unclassified line must break clean'); }
else console.log('ok   gate         an unclassified line breaks clean');
if (clean.clean !== true) { failures++; console.log('FAIL a benign line must not break clean'); }
else console.log('ok   gate         a benign line does not break clean');

/**
 * THE HTTP HALF OF THE SAME GATE, which had no case here at all and needed one.
 *
 * `badHttp` breaks `clean` exactly like `unexplained`, and it was deciding on `r.failed` BEFORE
 * consulting the status - so a response that ARRIVED with a 200 and whose body load was then
 * cancelled was filed as a failure. It reported `GET /api/users/<id>/avatar -> 200` and broke
 * MSG-7's fifth pass on 2026-08-14. A status is an answer; a request that got one is judged on it.
 */
function netOf(reqs) {
  const events = [];
  reqs.forEach(([url, status, failed], i) => {
    const requestId = `r${i}`;
    events.push({
      method: 'Network.requestWillBeSent',
      params: {
        requestId,
        request: { url, method: 'GET' },
        timestamp: 1000 + i,
        wallTime: 1_786_710 + i,
      },
    });
    if (status !== null)
      events.push({
        method: 'Network.responseReceived',
        params: { requestId, response: { status } },
      });
    if (failed)
      events.push({ method: 'Network.loadingFailed', params: { requestId, errorText: failed } });
  });
  return { events };
}

const SITE = 'https://canari-emse.fr';
const HTTP_CASES = [
  // [what it is, url, status, failed, must it break clean]
  ['a 200 whose body load was cancelled', `${SITE}/api/users/aaaa/avatar`, 200, 'net::ERR_ABORTED', false],
  ['a 200 that simply completed', `${SITE}/api/presence`, 200, null, false],
  ['a 502 on that same endpoint', `${SITE}/api/users/aaaa/avatar`, 502, null, true],
  ['a request that never got a status', `${SITE}/api/mls/send`, null, 'net::ERR_CONNECTION_REFUSED', true],
];
for (const [what, url, status, failed, shouldBreak] of HTTP_CASES) {
  const rep = await report({ cx: netOf([[url, status, failed]]), label: 'selftest' });
  const ok = rep.badHttp.length > 0 === shouldBreak && rep.clean === !shouldBreak;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${(shouldBreak ? 'badHttp' : 'ok-http').padEnd(12)} ${what}`);
  if (!ok) console.log(`       badHttp=${JSON.stringify(rep.badHttp)} clean=${rep.clean}`);
}


/**
 * A STATUS WITH NO REQUEST IS EVIDENCE FOR NOTHING - the three cases that make it one.
 *
 * HEAL-NEW-15's gate on `038c7e8d` demoted the row partly on a `415 Unsupported Media Type` that no
 * bucket named: Chrome's sentence carries the status and nothing else, and the url and
 * `networkRequestId` that `Log.entryAdded` had carried all along were dropped at render time. Dirt
 * whose subject cannot be recovered can be neither explained nor fixed, and adding it to an ignore
 * list is weakening the test rather than explaining a line - so the fix has to be here.
 *
 * The third case is the one that was silently WRONG rather than merely unhelpful: the dedup key was
 * the sentence, and Chrome writes the same sentence for every failing resource, so ten requests
 * collapsed into one line carrying the FIRST url - and `isBenignUrl` then judged all ten on it. A
 * benign avatar 404 arriving first forgave a 404 from anywhere else on the page.
 */
function netLinesOf(reqs) {
  const events = [];
  reqs.forEach(([url, status, method], i) => {
    const requestId = `n${i}`;
    events.push({
      method: 'Network.requestWillBeSent',
      params: { requestId, request: { url, method }, timestamp: 1000 + i, wallTime: 1_786_710 + i },
    });
    events.push({ method: 'Network.responseReceived', params: { requestId, response: { status } } });
    events.push({
      method: 'Log.entryAdded',
      params: {
        entry: {
          timestamp: 1_786_710_000_000 + i * 1000,
          level: 'error',
          source: 'network',
          text: `Failed to load resource: the server responded with a status of ${status} ()`,
          url,
          networkRequestId: requestId,
        },
      },
    });
  });
  return { events };
}

const named = await report({
  cx: netLinesOf([[`${SITE}/api/media/upload`, 415, 'POST']]),
  label: 'selftest',
});
{
  // THE CLAIM IS THAT THE LINE NAMES ITS REQUEST, not that an origin was stripped from it. This used
  // to assert `POST /api/media/upload`, which held only because the renderer removed a hardcoded
  // `https://canari-emse.fr` - a literal that stopped matching anything the day the rig moved to the
  // local estate, taking every path-anchored forgiveness with it (see `pathOfLine`). The origin is
  // kept now, so the assertion is written against the fact rather than against the spelling.
  const ok = named.errors.some((l) => l.includes('415') && l.includes('POST') && l.includes('/api/media/upload'));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'named'.padEnd(12)} a 415 error line carries the request that earned it`);
  if (!ok) console.log(`       errors=${JSON.stringify(named.errors)}`);
}

const twoResources = await report({
  cx: netLinesOf([
    [`${SITE}/api/media/upload`, 415, 'POST'],
    [`${SITE}/api/mls/commit`, 415, 'POST'],
  ]),
  label: 'selftest',
});
{
  const ok =
    twoResources.errors.length === 2 &&
    twoResources.errors.some((l) => l.includes('/api/media/upload')) &&
    twoResources.errors.some((l) => l.includes('/api/mls/commit'));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'named'.padEnd(12)} two resources failing the same way are two lines, not one`);
  if (!ok) console.log(`       errors=${JSON.stringify(twoResources.errors)}`);
}

// A WORKER'S OWN `console.log` CARRIES A URL TOO - THE WORKER FILE - AND IT IS NOT A REQUEST.
// The first cut of the fix keyed on `url` alone and rendered four `[RUST::WARN] Past-epoch
// application frame` lines on HEAL-NEW-2 as `<- ??? /_app/immutable/workers/mlsCrypto.worker-*.js`.
// The `???` was the tell: there was no request to name, so the suffix dressed an application
// sentence as an HTTP failure. Only `source === 'network'` earns one.
const workerLine = await report({
  cx: {
    events: [
      {
        method: 'Log.entryAdded',
        params: {
          entry: {
            timestamp: 1_786_710_000_000,
            level: 'error',
            source: 'worker',
            text: '[MLS] LOST frame in 642f389a…',
            url: `${SITE}/_app/immutable/workers/mlsCrypto.worker-BYORCre_.js`,
          },
        },
      },
    ],
  },
  label: 'selftest',
});
{
  const ok = workerLine.severe.some((l) => l === '[MLS] LOST frame in 642f389a…');
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'named'.padEnd(12)} a worker's own log line is NOT dressed as a request`);
  if (!ok) console.log(`       severe=${JSON.stringify(workerLine.severe)}`);
}

const benignFirst = await report({
  cx: netLinesOf([
    [`${SITE}/api/users/${'a'.repeat(64)}/avatar`, 404, 'GET'],
    [`${SITE}/api/forms/e318b48e`, 404, 'GET'],
  ]),
  label: 'selftest',
});
{
  // The avatar 404 is understood and forgiven on its own url; the other one is not, and its line
  // must survive to break `clean`. Before the url joined the dedup key it did not exist at all.
  const ok =
    benignFirst.errors.length === 1 &&
    benignFirst.errors[0].includes('/api/forms/e318b48e') &&
    benignFirst.clean === false;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'named'.padEnd(12)} a benign avatar 404 does not forgive a 404 from elsewhere`);
  if (!ok) console.log(`       errors=${JSON.stringify(benignFirst.errors)} clean=${benignFirst.clean}`);
}


/**
 * THE FORGIVENESS, TESTED FOR WHAT IT MUST NOT FORGIVE.
 *
 * `ignoringExpectedLog` exists so DEL-2 can name the one sentence the classifier refuses to classify
 * - a `text` entry dying on `group-deleted`, a message the user wrote and will never see sent. A
 * helper like that is dangerous in exactly one direction: too wide, and it silences the signal it
 * was written to let a single check through. Nothing about that is visible from a green run, so the
 * cases below are the ones that would go quiet - a needle over-matching a NEIGHBOURING sentence, and
 * dirt of another kind sitting beside a forgiven line.
 */
/** The admission cases' group: its prefix is what the lines print. */
const ADM_G = '21a3145f-088e-4214-9692-63455cc27ac9';
const FORGIVE_CASES = [
  [
    'frames refused for lack of a row: forgiven where a row names the narration',
    [['log', "[04:00:00] [COMMIT_RACE] 46163138… not caught up: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked, the tree is unconfirmed"], ['log', "[04:00:00] [GAP] 46163138 not replayed: frames refused for lack of a row are still queued and bring the missing epochs - their pull is asked"], ['log', "[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 3: frames refused for lack of a row are still queued - no replay past them, nothing to rebuild on"]],
    REFUSED_FOR_LACK_OF_ROW_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    'control: in a row that does not name that narration (a CC row with no refused frame queued) they stay dirt',
    [['log', '[04:00:00] [COMMIT] 46163138... refused concurrent_commit at epoch 3: frames refused for lack of a row are still queued - no replay past them, nothing to rebuild on']],
    [/^\[COMMIT\] [0-9a-f]{8}\.\.\. refused concurrent_commit at epoch \d+: read the commit log/],
    { clean: false, unmatched: 1 },
  ],
  [
    'the DEL-2 sentence, forgiven by its own needle',
    [['log', '[09:14:02] [OUTBOX] a721e695… text entry in 472df672…, group-deleted - permanent failure']],
    [/^\[OUTBOX\] [0-9a-f]{8}… (text|reply|media) entry in [0-9a-f]{8}…, group-deleted - permanent failure$/],
    { clean: true, unmatched: 0 },
  ],
  [
    'a needle that matched nothing is REPORTED, and forgives nothing',
    [['log', '[09:14:02] [DELETE] Group 472df672... not found on server (already deleted?)']],
    ['[DELETE] Group', 'a line this run never produced'],
    { clean: true, unmatched: 1 },
  ],
  [
    'the evicted-late spelling is NOT swallowed by the group-deleted needle',
    [['log', '[09:14:02] [OUTBOX] a721e695… text entry in 472df672…, evicted-late - permanent failure']],
    [/^\[OUTBOX\] [0-9a-f]{8}… (text|reply|media) entry in [0-9a-f]{8}…, group-deleted - permanent failure$/],
    { clean: false, unmatched: 1 },
  ],
  [
    'a lost frame beside a forgiven line still breaks clean',
    [
      ['log', '[09:14:02] [OUTBOX] a721e695… text entry in 472df672…, group-deleted - permanent failure'],
      ['log', '[09:14:03] MLS decryption failed: generation out of bounds'],
    ],
    [/group-deleted - permanent failure$/],
    { clean: false, unmatched: 0 },
  ],
  // COMM-22'S OWN NEEDLES, AGAINST THE LINE THEY WERE WRITTEN FROM. The list is exported and used at
  // one call site, so nothing else would ever notice it having stopped matching - and a needle that
  // no longer matches looks exactly like new dirt on the next run. The non-zero device count is the
  // case that matters: the same sentence with a routed device is a different defect, and this asserts
  // the pattern does NOT reach it.
  [
    "the evicted peer rejoining, forgiven by COMM-22's own needles",
    [
      [
        'log',
        '[14:40:08] [GRAINE] salon 495b56cb of d4075a25: this device holds the distribution group but the group holds NO row for it (0 device(s) for this user) - the local group is stale, rejoining',
      ],
    ],
    EVICTED_REJOIN_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    'the same sentence with a ROUTED device is not forgiven',
    [
      [
        'log',
        '[14:40:08] [GRAINE] salon 495b56cb of d4075a25: this device holds the distribution group but the group holds NO row for it (2 device(s) for this user) - the local group is stale, rejoining',
      ],
    ],
    EVICTED_REJOIN_NARRATION,
    { clean: false, unmatched: 1 },
  ],
  // THE PANEL SUCCEEDING, against the trail `purge-devices.mjs` provokes on every mint and every
  // revocation. The ids carry the U+2026 the component appends, matched by `\S+` and never spelled
  // out here - this file is ASCII, and a literal glyph is one a re-encode can mangle into a needle
  // that matches nothing.
  [
    "the device panel deleting a device, forgiven by the runner that clicked",
    [
      ['log', '[DevicePanel] Loading devices and sessions for user: 4c1f8a20-...'],
      ['log', '[DevicePanel] 2 live session(s)'],
      ['log', '[DevicePanel] Found 4 device(s)'],
      ['log', '[DevicePanel] Deleting device f0a3bb2c…'],
      ['log', '[DevicePanel] Deleted device web-f0a3…'],
    ],
    DEVICE_PANEL_NARRATION,
    // TWO NEEDLES GO DRY HERE AND THAT IS THE MEASUREMENT, not a slack expectation: `Loading devices
    // and sessions` and `N live session(s)` are already `BENIGN`, so they never reach a bucket this
    // can filter. Every HEAL-NEW and HEAL-REVOKE row therefore records `unmatched: 2` for a healthy
    // panel, and a reader who did not know that would read the campaign's own instrument as a
    // finding. Pinned rather than trimmed: the list is the whole documented trail on purpose.
    { clean: true, unmatched: 2 },
  ],
  [
    'a removal the user cancelled is not forgiven - the runner meant to delete',
    [['log', '[DevicePanel] Removal of f0a3bb2c-1d44-4e1a-9b77-2a0c5e8f1234 cancelled by user']],
    DEVICE_PANEL_NARRATION,
    { clean: false, unmatched: 5 },
  ],
  [
    // Read verbatim on GRAINE-AUTH-1, -2 and -6 (2026-10-22): a reloaded page's own decisions. The
    // five older needles of the list see no line here, hence `unmatched: 5`.
    'a reloaded page narrating its own boot is forgiven',
    [
      ['log', '[04:13:20.680] [RESTORE] kept 2 salon row(s) the community load owns'],
      ['log', '[04:13:20.681] [RESTORE] 19 conversation row(s) seeded - history follows'],
      ['log', "[04:13:20.690] [WORKSPACE-SNAPSHOT] the list on screen is the server's now (1 community(ies))"],
      ['log', '[04:13:20.691] [UNREAD] communities loaded: joined the counts request already in flight'],
      ['debug', '[2026-10-22T02:13:20.806Z] [AvatarPresence] 1 of 1 have no photo - not requested'],
      ['debug', '[2026-10-22T02:13:20.837Z] [RoutePreload] {"pathname":"/communities","first":true}'],
      ['debug', '[04:08:14.347] [MLS] Bulk ingest checkpoint landed - committing its progress markers.'],
      ['log', '[04:13:20.877] [STRAY] compared 1 tree(s): 1 roster(s) in one read, 0 refused, 0 not answered (nobody removed in them)'],
      ['debug', '[2026-10-22T02:13:21.939Z] [CHAT_VIEW] channel_ messages 3 (hasNewMessage=true, response=repin-entry)'],
    ],
    PAGE_BOOT_NARRATION,
    { clean: true, unmatched: 8 },
  ],
  [
    // Read on the first live FLOOR draw on dev (2026-10-25), after the invariant's reload.
    'the device notices, the trust consumer and the legacy seal format are boot narration',
    [
      ['log', '[02:42:30.317] [DEVICE_NOTICE] 2 unseen new-device alert(s) restored'],
      ['debug', '[02:42:30.317] [TRUST] device-event consumer registered'],
      ['log', '[02:42:30.637] [MLS] web checkpoint seal format: legacy (WASM ChaCha20)'],
    ],
    PAGE_BOOT_NARRATION,
    { clean: true, unmatched: 14 },
  ],
  [
    // CONTROL: a seal format other than the one this build writes is a reading, not narration.
    'another checkpoint seal format is not forgiven',
    [['log', '[02:42:30.637] [MLS] web checkpoint seal format: v2 (WebCrypto AES-GCM)']],
    PAGE_BOOT_NARRATION,
    { clean: false, unmatched: 17 },
  ],
  [
    // CONTROL: the same stray-tree sweep with a refusal in it is a finding, not the boot narrating.
    'a stray-tree sweep that was refused is not forgiven',
    [['log', '[04:13:20.877] [STRAY] compared 1 tree(s): 1 roster(s) in one read, 1 refused, 0 not answered (nobody removed in them)']],
    PAGE_BOOT_NARRATION,
    { clean: false, unmatched: 17 },
  ],
  [
    'a console error beside a forgiven line still breaks clean',
    [
      ['log', '[09:14:02] [OUTBOX] a721e695… text entry in 472df672…, group-deleted - permanent failure'],
      ['error', 'Uncaught (in promise) TypeError: x is not a function'],
    ],
    [/group-deleted - permanent failure$/],
    { clean: false, unmatched: 0 },
  ],
  // THE DEV ROWS' NARRATION (read on DEV-1 and DEV-2, `1.4.1-alpha.3`, 2026-10-25). Every needle there
  // is `atLevels`, so each list gets three cases: forgiven at its own level, NOT forgiven as an error
  // or a warning carrying the same words, and NOT forgiven in its odd variant - the one a needle that
  // merely matched the prefix would have swallowed.
  [
    "the owner's device notice, forgiven at its levels",
    [
      ['debug', '[10:01:02] [TRUST] 1 device event(s) handed to the notices (drain end)'],
      ['debug', '[10:01:02] [DEVICE_NOTICE] 1 device event(s) to sort (+0 undecided)'],
      ['log', '[10:01:02] [DEVICE_NOTICE] a new device was added to this account (first-sight)'],
    ],
    OWNER_DEVICE_NOTICE_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    "the owner's device notice as an ERROR and a WARNING is not forgiven",
    [
      ['error', '[10:01:02] [DEVICE_NOTICE] a new device was added to this account (first-sight)'],
      ['warning', '[10:01:02] [TRUST] 1 device event(s) handed to the notices (drain end)'],
    ],
    OWNER_DEVICE_NOTICE_NARRATION,
    { clean: false, unmatched: 3 },
  ],
  [
    'an event the notices could not decide is not forgiven',
    [['debug', '[10:01:02] [DEVICE_NOTICE] 2 device event(s) to sort (+1 undecided)']],
    OWNER_DEVICE_NOTICE_NARRATION,
    { clean: false, unmatched: 3 },
  ],
  [
    "a contact's device notice, forgiven at its levels",
    [
      ['debug', '[10:01:02] [TRUST] 1 device event(s) handed to the notices (drain end)'],
      ['debug', '[10:01:02] [DEVICE_NOTICE] 1 device event(s) to sort (+0 undecided)'],
      ['log', '[10:01:02] [DEVICE_NOTICE] contact line written in 46163138...'],
      ['debug', '[10:01:02] [DEVICE_NOTICE] 472df672... has no stored row - no line owed'],
    ],
    CONTACT_DEVICE_NOTICE_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    // A warning never breaks `clean` on its own, so what is asserted is that both STAY in the bucket.
    'a contact line as a WARNING, and a line left owed, are not forgiven',
    [
      ['warning', '[10:01:02] [DEVICE_NOTICE] contact line written in 46163138...'],
      ['warning', '[10:01:02] [DEVICE_NOTICE] tree of 46163138... unreadable, its line stays owed'],
    ],
    CONTACT_DEVICE_NOTICE_NARRATION,
    { clean: true, unmatched: 4, warnings: 2 },
  ],
  [
    "a fresh device's first session, forgiven at its levels",
    [
      ['log', '[10:01:02] [A] ws-'],
      ['log', '[10:01:02] [A] callback pkce=verifier challenged=yes'],
      ['debug', '[10:01:02] [POSTS] first page not stored - the device key is not in hand for this account'],
      ['log', '[10:01:02] [PIN] Keypad shown (open) - the unlock is owed to the member'],
      ['log', '[10:01:02] [DISCOVERY] Placeholder 46163138… created.'],
      [
        'debug',
        "[10:01:02] [GRAINE] absorbed 3/3 seed(s) (0 already held; endorsements verified: 3 from the tree, 0 from the server's published keys) from 46163138… in community 472df672 - salon(s) a721e695, 495b56cb",
      ],
    ],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: true, unmatched: 14 },
  ],
  [
    'a callback that was not challenged, and a seed lost on the way, are not forgiven',
    [
      ['log', '[10:01:02] [A] callback pkce=verifier challenged=no'],
      [
        'debug',
        "[10:01:02] [GRAINE] absorbed 2/3 seed(s) (0 already held; endorsements verified: 2 from the tree, 0 from the server's published keys) from 46163138… in community 472df672 - salon(s) a721e695",
      ],
    ],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: false, unmatched: 20 },
  ],
  [
    'a fresh-session line as an ERROR is not forgiven',
    [['error', '[10:01:02] [PIN] Keypad shown (open) - the unlock is owed to the member']],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: false, unmatched: 20 },
  ],
  [
    'a login that skipped PKCE is not forgiven by the fresh-client needle',
    [['log', '[10:01:02] [A] login returnTo=/ uri=https://dev.example/callback flow=code pkce=none (server has no oidcPkce)']],
    FRESH_CLIENT_NARRATION,
    { clean: false, unmatched: 6 },
  ],
  [
    "a revoked device's sign-out, forgiven at its levels",
    [
      ['debug', '[10:01:02] [TRUST] device-event consumer removed'],
      ['info', '[10:01:02] [RESTORE] generation 4 retired (running=false, queued asks=0)'],
      ['log', '[10:01:02] [WORKSPACE-SNAPSHOT] signed out: 2 community(ies) forgotten'],
    ],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: true, unmatched: 12 },
  ],
  [
    "a revoked device's MLS client torn down, forgiven (alpha.5 DEV-2)",
    [
      ['info', '[14:59:07.993] [WS] MLS client destroyed - its socket is released and no open may follow'],
      ['info', '[14:59:08.014] [WS] Paused - disconnect sent, socket released until the next foreground.'],
    ],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: true, unmatched: 13 },
  ],
  [
    "a revoked device's requests refused once its session ended, forgiven (alpha.5 DEV-3)",
    [
      ['info', '[15:46:38.652] [AUTH] 401 on GET /api/mls/messages - renewing the token and sending the same request once more'],
      ['info', '[15:46:38.788] [A] refresh✗latched (cookie already proven dead by this device revocation - not asking again)'],
      ['info', '[15:46:39.091] [SYNC] WASM purge skipped - the server list could not be fetched'],
    ],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: true, unmatched: 12 },
  ],
  [
    "control: a revoked device's undrained backlog at ERROR is not narration",
    [['error', '[15:46:38.785] [PENDING] Pending fetch failed after 0 message(s) - the backlog for x is UNDRAINED and stays queued until the next reconnect: SessionEndedByDeviceRevocationError']],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: false, unmatched: 15 },
  ],
  [
    'control: the same teardown on a device nobody revoked stays dirt',
    [['info', '[14:59:07.993] [WS] MLS client destroyed - its socket is released and no open may follow']],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: false, unmatched: 20 },
  ],
  [
    'control: the revoked device signing out TWICE is not narrated (the known P3)',
    [['info', '[14:59:08.216] [A] logout✓200 79ms']],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: false, unmatched: 15 },
  ],
  [
    "a revoked device's pending fetch ended by its own revocation, and the redirect that signs out no more, forgiven",
    [
      ['info', '[14:59:07.900] [PENDING] Pending fetch ended after 0 message(s): this device was revoked by its owner, nothing remains to drain'],
      ['log', '[14:59:08.100] [AUTH] Session expired - the revoked-device reset already signed out; redirecting to /login.'],
    ],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: true, unmatched: 15 },
  ],
  [
    'control: the same two lines on a device nobody revoked stay dirt, and the pending fetch at error is never forgiven',
    [
      ['info', '[14:59:07.900] [PENDING] Pending fetch ended after 0 message(s): this device was revoked by its owner, nothing remains to drain'],
      ['log', '[14:59:08.100] [AUTH] Session expired - the revoked-device reset already signed out; redirecting to /login.'],
      ['error', '[14:59:07.900] [PENDING] Pending fetch failed after 0 message(s) - the backlog for u:d is UNDRAINED and stays queued until the next reconnect:'],
    ],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: false, unmatched: 20 },
  ],
  [
    'a revoked device that signed out ONCE: its one logout line is forgiven where it was counted',
    [['info', '[14:59:08.216] [A] logout✓200 79ms']],
    [...REVOKED_SIGN_OUT_NARRATION, revokedLogoutOnce(() => ['[14:59:08.216] [A] logout✓200 79ms'])],
    { clean: true, unmatched: 15 },
  ],
  [
    'control: a SECOND logout that arrives later is counted at classification time - neither line is forgiven',
    [['info', '[14:59:08.216] [A] logout✓200 79ms']],
    [...REVOKED_SIGN_OUT_NARRATION, revokedLogoutOnce(() => ['[14:59:08.216] [A] logout✓200 79ms', '[14:59:09.001] [A] logout✗ 12ms: TypeError - signed out locally'])],
    { clean: false, unmatched: 16 },
  ],
  [
    'control: the counted-once needle is not part of the revoked narration, so the row must earn it',
    [['info', '[14:59:08.216] [A] logout✓200 79ms']],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: false, unmatched: 15 },
  ],
  [
    "a fresh device's restore of unproven messages, forgiven on the minted seat",
    [['info', '[14:58:45.518] [AUTHORSHIP] 25 restored message(s) in b86896fc… relayed by 223bc34e carry no author proof - kept, marked unverified']],
    FRESH_DEVICE_RESTORE_NARRATION,
    { clean: true, unmatched: 1 },
  ],
  [
    "a minted device's hidden batch of rows that are not arrivals, forgiven",
    [['info', '[15:40:02.017] [NOTIF] Batch into "c0ef269d…" added 1 while hidden, none of them an inbound message - nothing to raise.']],
    FRESH_DEVICE_RESTORE_NARRATION,
    { clean: true, unmatched: 1 },
  ],
  [
    'control: the same restore on a seat that was not minted stays dirt',
    [['info', '[14:58:45.518] [AUTHORSHIP] 25 restored message(s) in b86896fc… relayed by 223bc34e carry no author proof - kept, marked unverified']],
    FRESH_DEVICE_SESSION_NARRATION,
    { clean: false, unmatched: 20 },
  ],
  [
    'control: a restore that REFUSED a forged message is never narration',
    [['error', '[14:58:45.518] [AUTHORSHIP] REFUSED a replayed message 1a2b3c4d relayed by 223bc34e in b86896fc…: signed by x']],
    FRESH_DEVICE_RESTORE_NARRATION,
    { clean: false, unmatched: 2 },
  ],
  [
    'a restore retired with asks still queued, and a sign-out as an ERROR, are not forgiven',
    [
      ['info', '[10:01:02] [RESTORE] generation 4 retired (running=true, queued asks=2)'],
      ['error', '[10:01:02] [WORKSPACE-SNAPSHOT] signed out: 2 community(ies) forgotten'],
    ],
    REVOKED_SIGN_OUT_NARRATION,
    { clean: false, unmatched: 15 },
  ],
  [
    "the adder's own memberAdded notice is forgiven at debug (#2412)",
    [['debug', "[15:22:58.206] [NOTICE] memberAdded written on the acting device in b5c78665… as 8107e57d - the id every member's device writes"]],
    GROUP_CREATION_NARRATION,
    { clean: true, unmatched: 2 },
  ],
  [
    'control: the same notice at log, or for another event, is not forgiven',
    [
      ['log', "[15:22:58.206] [NOTICE] memberAdded written on the acting device in b5c78665… as 8107e57d - the id every member's device writes"],
      ['debug', "[15:22:58.206] [NOTICE] memberRemoved written on the acting device in b5c78665… as 8107e57d - the id every member's device writes"],
    ],
    GROUP_CREATION_NARRATION,
    { clean: false, unmatched: 3 },
  ],
  [
    "the remover's own lines are forgiven: committed, already-out, and its memberRemoved notice at debug",
    [
      ['log', '[15:47:38.470] [REMOVE_MEMBER] 223bc34e removed from the group (committed)'],
      ['log', '[15:47:38.470] [REMOVE_MEMBER] 223bc34e removed from the group (already-out)'],
      ['debug', "[15:47:38.471] [NOTICE] memberRemoved written on the acting device in 997f2c05… as 28647c70 - the id every member's device writes"],
    ],
    REMOVE_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    'control: an unconfirmed or failed Remove, and the notice at log, stay dirt',
    [
      ['log', '[15:47:38.470] [REMOVE_MEMBER] 223bc34e removed from the group (unconfirmed)'],
      ['log', '[15:47:38.470] [REMOVE_MEMBER] 223bc34e not fully removed: Error: boom'],
      ['log', "[15:47:38.471] [NOTICE] memberRemoved written on the acting device in 997f2c05… as 28647c70 - the id every member's device writes"],
    ],
    REMOVE_NARRATION,
    { clean: false, unmatched: 2 },
  ],
  // ── the admission narrations (#2500): scoped to the row's group and to the endings it plays ──
  [
    "a member's ask, admitted and declined in the row's group, forgiven at its levels",
    [
      ['log', "[10:01:02] [JOIN_ASK] 223bc34e… has no leaf in 21a3145f... - a new person is not added automatically, a member's approval is asked"],
      ['log', "[10:01:02] [JOIN_REQUEST] 223bc34e… asks to join 21a3145f... - a member's answer is awaited"],
      ['log', '[10:01:02] [JOIN_REQUEST] 223bc34e… admitted in 21a3145f... - the ask leaves this screen'],
      ['info', '[10:01:02] [JOIN_REQUEST] 223bc34e… declined in 21a3145f…'],
      ['log', '[10:01:02] [JOIN_REQUEST] 223bc34e… declined - their seat is withdrawn'],
    ],
    admissionMemberNarration(ADM_G, { admitted: true, declined: true }),
    { clean: true, unmatched: 0 },
  ],
  [
    'control: the same ask at warn, and an ask about ANOTHER group, stay dirt',
    [
      ['warning', "[10:01:02] [JOIN_REQUEST] 223bc34e… asks to join 21a3145f... - a member's answer is awaited"],
      ['log', "[10:01:02] [JOIN_ASK] 223bc34e… has no leaf in 098bfb7f... - a new person is not added automatically, a member's approval is asked"],
    ],
    admissionMemberNarration(ADM_G),
    { clean: false, unmatched: 2, warnings: 1 },
  ],
  [
    'control: a Decline in a row that plays none (ADM-1) stays dirt',
    [['log', '[10:01:02] [JOIN_REQUEST] 223bc34e… declined in 21a3145f... - the ask leaves this screen']],
    admissionMemberNarration(ADM_G, { admitted: true }),
    { clean: false, unmatched: 3 },
  ],
  // AN ADD THE GATE REFUSED WHOLE (#2505), narrated by its approver: ADM-3 when the Decline wins, ADM-10.
  [
    "an Add refused whole in the row's group, in a row that plays it (ADM-3), forgiven",
    [
      ['log', '[14:29:37.561] [COMMIT_RACE] 21a3145f... the gate refused to admit every person the Add offered (223bc34e…) - nobody added'],
      ['log', '[14:29:37.644] [SYNC] the Add was abandoned before its stage (not-admitted) - nobody added'],
      ['log', '[14:29:37.644] [JOIN_REQUEST] approve of 223bc34e… in 21a3145f... did not happen - the server settled the ask meanwhile (the Add did not happen (removed-meanwhile))'],
    ],
    admissionMemberNarration(ADM_G, { admitted: true, declined: true, addRefused: true }),
    { clean: true, unmatched: 7 },
  ],
  [
    'control: the same three lines in a row where no gate refusal is expected (ADM-2) stay dirt',
    [
      ['log', '[14:29:37.561] [COMMIT_RACE] 21a3145f... the gate refused to admit every person the Add offered (223bc34e…) - nobody added'],
      ['log', '[14:29:37.644] [SYNC] the Add was abandoned before its stage (not-admitted) - nobody added'],
      ['log', '[14:29:37.644] [JOIN_REQUEST] approve of 223bc34e… in 21a3145f... did not happen - the server settled the ask meanwhile (the Add did not happen (removed-meanwhile))'],
    ],
    admissionMemberNarration(ADM_G, { declined: true }),
    { clean: false, unmatched: 4 },
  ],
  [
    // The SYNC line names no group (as the Decline's "their seat is withdrawn" does): it is kept to the
    // two rows that play a refusal, and the two lines that DO name a group stay dirt for another one.
    'control: the two group-naming lines about ANOTHER group stay dirt, even in ADM-10',
    [
      ['log', '[14:29:37.561] [COMMIT_RACE] 098bfb7f... the gate refused to admit every person the Add offered (223bc34e…) - nobody added'],
      ['log', '[14:29:37.644] [SYNC] the Add was abandoned before its stage (not-admitted) - nobody added'],
      ['log', '[14:29:37.644] [JOIN_REQUEST] approve of 223bc34e… in 098bfb7f... did not happen - the server settled the ask meanwhile (the Add did not happen (removed-meanwhile))'],
    ],
    admissionMemberNarration(ADM_G, { declined: true, addRefused: true }),
    { clean: false, unmatched: 8 },
  ],
  [
    "a Decline that won the race, narrated by the approver at info with the group named, in a row that plays it (ADM-3), forgiven",
    [['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (not-admitted): the gate refused to admit 223bc34e…']],
    admissionMemberNarration(ADM_G, { admitted: true, declined: true, addRefused: true }),
    { clean: true, unmatched: 9 },
  ],
  [
    'control: that line in a row that plays no refusal (ADM-2), for another group, or at warn, stays dirt',
    [
      ['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (not-admitted): the gate refused to admit 223bc34e…'],
    ],
    admissionMemberNarration(ADM_G, { declined: true }),
    { clean: false, unmatched: 4 },
  ],
  [
    'an ask settled before the Add, narrated at info with the group named, in a row that plays it (ADM-10), forgiven',
    [['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (removed-meanwhile): the ask of joe was settled before the Add was built']],
    admissionMemberNarration(ADM_G, { declined: true, addRefused: true }),
    { clean: true, unmatched: 8 },
  ],
  [
    'control: that line in a row that plays no refusal stays dirt',
    [['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (removed-meanwhile): the ask of joe was settled before the Add was built']],
    admissionMemberNarration(ADM_G, { declined: true }),
    { clean: false, unmatched: 4 },
  ],
  [
    'control: the settled-ask line naming ANOTHER group, or at warn, stays dirt in ADM-10',
    [
      ['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 098bfb7f... was abandoned before its stage (removed-meanwhile): the ask of joe was settled before the Add was built'],
      ['warning', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (removed-meanwhile): the ask of joe was settled before the Add was built'],
    ],
    admissionMemberNarration(ADM_G, { declined: true, addRefused: true }),
    { clean: false, unmatched: 9, warnings: 1 },
  ],
  [
    'control: the same line naming ANOTHER group, or logged at warn (a read failure), stays dirt in ADM-10',
    [
      ['info', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 098bfb7f... was abandoned before its stage (not-admitted): the gate refused to admit 223bc34e…'],
      ['warning', '[14:29:37.644] [SYNC] processBulkAddition: The Add in 21a3145f... was abandoned before its stage (not-admitted): the gate refused to admit 223bc34e…'],
    ],
    admissionMemberNarration(ADM_G, { declined: true, addRefused: true }),
    { clean: false, unmatched: 9, warnings: 1 },
  ],
  [
    'control: an Add abandoned for a reason nobody declared, or the refusal at warn, is not forgiven in ADM-10',
    [
      ['log', '[14:29:37.644] [SYNC] the Add was abandoned before its stage (lost) - nobody added'],
      ['warning', '[14:29:37.561] [COMMIT_RACE] 21a3145f... the gate refused to admit every person the Add offered (223bc34e…) - nobody added'],
    ],
    admissionMemberNarration(ADM_G, { declined: true, addRefused: true }),
    { clean: false, unmatched: 9, warnings: 1 },
  ],
  [
    "the joiner's wait and both endings in the row's group, forgiven",
    [
      ['log', '[10:01:02] [DISCOVERY] Placeholder 21a3145f… created.'],
      ['log', '[10:01:02] [DISCOVERY] "21a3145f…" awaits a member admission'],
      ['log', '[10:01:02] [DISCOVERY] "21a3145f…" no longer awaits a member'],
      ['log', '[10:01:02] [DISCOVERY] never-admitted "21a3145f…" is no longer listed - the ask was declined or expired - removing'],
    ],
    admissionJoinerNarration(ADM_G, { admitted: true, declined: true }),
    { clean: true, unmatched: 0 },
  ],
  [
    "control: the joiner's lines about another group, an ending the row does not play, or at error, stay dirt",
    [
      ['log', '[10:01:02] [DISCOVERY] Placeholder 098bfb7f… created.'],
      ['log', '[10:01:02] [DISCOVERY] Placeholder 21a3145fabc created.'],
      ['log', '[10:01:02] [DISCOVERY] never-admitted "21a3145f…" is no longer listed - the ask was declined or expired - removing'],
      ['error', '[10:01:02] [DISCOVERY] "21a3145f…" awaits a member admission'],
    ],
    admissionJoinerNarration(ADM_G, { admitted: true }),
    { clean: false, unmatched: 3 },
  ],
  [
    "a minted sibling's KeyPackage vetted, at debug, forgiven",
    [['debug', '[10:01:02] [TRUST] KeyPackage for 472df672... vetted: pinned']],
    SIBLING_MINT_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    'control: the same vetting at warn, or another outcome, stays dirt',
    [
      ['warning', '[10:01:02] [TRUST] KeyPackage for 472df672... vetted: pinned'],
      ['debug', '[10:01:02] [TRUST] KeyPackage for 472df672... vetted: mismatch'],
    ],
    SIBLING_MINT_NARRATION,
    { clean: false, unmatched: 1, warnings: 1 },
  ],
  [
    "RM-6's refused privacy flip, by its code at debug, forgiven",
    [['debug', '[10:01:02] [channelSettings.handleTogglePrivacy failed] ChannelApiError: {"code":"REMOVAL_EXCEEDS_ACTOR","message":"x"}']],
    PRIVACY_REFUSED_EXCEEDS_ACTOR_NARRATION,
    { clean: true, unmatched: 0 },
  ],
  [
    'control: the same refusal at warn, or another code, stays dirt',
    [
      ['warning', '[10:01:02] [channelSettings.handleTogglePrivacy failed] ChannelApiError: {"code":"REMOVAL_EXCEEDS_ACTOR","message":"x"}'],
      ['error', '[10:01:02] [channelSettings.handleTogglePrivacy failed] ChannelApiError: {"code":"FORBIDDEN","message":"x"}'],
    ],
    PRIVACY_REFUSED_EXCEEDS_ACTOR_NARRATION,
    { clean: false, unmatched: 1, warnings: 1 },
  ],
];
for (const [what, lines, needles, want] of FORGIVE_CASES) {
  const rep = ignoringExpectedLog(await report({ cx: cxOf(lines), label: 'selftest' }), needles);
  // `warnings` is asserted only where a case names it: a warning never breaks `clean`, so a needle
  // forgiving one is visible ONLY as the bucket shrinking.
  const got = { clean: rep.clean, unmatched: rep.ignoredAsExpectedLog.unmatched.length, ...('warnings' in want ? { warnings: rep.warnings.length } : {}) };
  const ok = got.clean === want.clean && got.unmatched === want.unmatched && got.warnings === want.warnings;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'forgive'.padEnd(12)} ${what}`);
  if (!ok) console.log(`       want=${JSON.stringify(want)} got=${JSON.stringify(got)} rep=${JSON.stringify({ severe: rep.severe, errors: rep.errors, unexplained: rep.unexplained })}`);
}
/**
 * A PATH RULE MUST FORGIVE THE SAME REQUEST WHATEVER ESTATE IT WAS MADE AGAINST.
 *
 * THE ONE THAT SHIPPED: the renderer stripped a hardcoded `https://canari-emse.fr` before printing
 * a request, so every rule in the campaign was written against a bare path. The rig moved to the
 * LOCAL estate on 2026-09-03, the literal matched nothing, the lines became absolute urls - and
 * every path-anchored forgiveness went inert WITHOUT A WORD. MENTION-5 forgave a 404 it goes and
 * causes and was `PASS-DIRTY` on it anyway; `MINT_REFUSALS` stopped forgiving the refresh 401 every
 * device mint produces. A rule that cannot match fails silently, which is why both spellings are
 * pinned here rather than trusted to whichever one the estate happens to render.
 */
const REFUSAL_CASES = [
  // [what it is, url, status, the rule, must the report stay clean]
  ['a local-estate url is forgiven by a path rule', 'http://localhost:8081/api/users/' + 'a'.repeat(64), 404, [{ path: /^\/api\/users\/[0-9a-f]{64}$/, status: [404] }], true],
  ['and so is the production spelling of the same request', 'https://canari-emse.fr/api/users/' + 'a'.repeat(64), 404, [{ path: /^\/api\/users\/[0-9a-f]{64}$/, status: [404] }], true],
  // THE QUERY IS PART OF WHAT A RULE SEES - `MINT_REFUSALS` is written `(\?|$)` precisely for this.
  ['a refresh 401 with a query string is forgiven', 'http://localhost:8081/api/auth/refresh?clientVersion=0.16.3', 401, [{ path: /^\/api\/auth\/refresh(\?|$)/, status: [401] }], true],
  // NARROW IN BOTH DIRECTIONS, which is the whole safety of a pair rule.
  ['the same path with another status is NOT forgiven', 'http://localhost:8081/api/users/' + 'a'.repeat(64), 500, [{ path: /^\/api\/users\/[0-9a-f]{64}$/, status: [404] }], false],
  // A REVOKED DEVICE'S REFUSALS (alpha.5 DEV-2/3/6), given to the revoked seat only.
  ['a revoked device asking for its own KeyPackage: 404, forgiven', 'https://dev.example/api/mls/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mvpd61xf-pvv6/key-package', 404, REVOKED_REFUSALS, true],
  ['its revocation check answered 401, forgiven', 'https://dev.example/api/mls/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mvpd61xf-pvv6/revoked', 401, REVOKED_REFUSALS, true],
  ['its pending fetch answered 401, forgiven', 'https://dev.example/api/mls/messages/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mvpd61xf-pvv6?limit=500&caps=addressed-history-1', 401, REVOKED_REFUSALS, true],
  ['control: a 500 on its KeyPackage is NOT forgiven', 'https://dev.example/api/mls/devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/web-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-mvpd61xf-pvv6/key-package', 500, REVOKED_REFUSALS, false],
  ['control: a 401 on a send is NOT forgiven', 'https://dev.example/api/mls/send', 401, REVOKED_REFUSALS, false],
  ['the same status on another path is NOT forgiven', 'http://localhost:8081/api/mls/send', 404, [{ path: /^\/api\/users\/[0-9a-f]{64}$/, status: [404] }], false],
];
for (const [what, url, status, rule, shouldBeClean] of REFUSAL_CASES) {
  const rep = ignoringExpectedRefusal(await report({ cx: netOf([[url, status, null]]), label: 'selftest' }), rule);
  const ok = rep.clean === shouldBeClean;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'refusal'.padEnd(12)} ${what}`);
  if (!ok) console.log(`       clean=${rep.clean} badHttp=${JSON.stringify(rep.badHttp)}`);
}

/**
 * THE APP'S OWN REACTION TO A DELIBERATE CUT, forgiven only under `ignoringOfflineCut`. The gateway
 * line is `String(err)`, so it carries `Error: ` before the sentence, and the rule written without it
 * forgave nothing: GRP-7 was `PASS-DIRTY` on its own cut (2026-10-22). Pinned as the app spells it,
 * and pinned to stay dirt outside a cut.
 */
const CUT_LINE =
  '[06:50:17] Gateway inaccessible: Error: WebSocket connection failed to ws://localhost:8081/api/ws (chat-gateway). Check that the gateway is running and reachable.';
{
  const plain = await report({ cx: cxOf([['log', CUT_LINE]]), label: 'selftest' });
  const underCut = ignoringOfflineCut(plain);
  const ok = plain.unexplained.length === 1 && underCut.unexplained.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'cut'.padEnd(12)} the gateway line is forgiven under a cut and only there`);
}

/**
 * THE ONE NAMED ENVIRONMENT EXCEPTION (`DEV_EDGE_CSP_EXCEPTION`, 2026-10-25): the Cloudflare inline
 * script the dev edge injects is forgiven, one per document, on dev only - and every control beside
 * it stays dirt. A report taken with it must read clean, so a verdict reads PASS, never PASS-DIRTY.
 */
{
  const CF = 'sha256-CFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFCFC=';
  const APP = 'sha256-APPAPPAPPAPPAPPAPPAPPAPPAPPAPPAPPAPPAPPAPPA=';
  const line = (hash, url = 'https://dev.canari-emse.fr/chat', directive = 'script-src') => ({
    level: 'error',
    source: 'security',
    url,
    text: `Executing inline script violates the following Content Security Policy directive '${directive} 'self''. Either the 'unsafe-inline' keyword, a hash ('${hash}'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked.`,
  });
  const withHash = (l) => ({ ...l, ...cspBlockedHashOf(l) });
  const page = { injected: 1, appHashes: [APP] };
  const cases = [
    ['forgiven', 'the injected script, on dev, one document', [line(CF)], 0, page, 1],
    ['forgiven', 'one per document across a reload', [line(CF), line(CF.replace('CFC', 'CFD'))], 1, page, 2],
    ['control', 'an APP inline script refused stays dirt', [line(APP)], 0, page, 0],
    ['control', 'a refusal on another origin stays dirt', [line(CF, 'http://localhost:5173/chat')], 0, page, 0],
    ['control', 'another directive stays dirt', [line(CF, undefined, 'style-src')], 0, page, 0],
    ['control', 'more refusals than documents forgives none', [line(CF), line(CF.replace('CFC', 'CFD'))], 0, page, 0],
    ['control', 'a page without the injection forgives none', [line(CF)], 0, { injected: 0, appHashes: [APP] }, 0],
    ['control', 'an unreadable page forgives none', [line(CF)], 0, null, 0],
  ];
  for (const [kind, label, errs, docs, pg, want] of cases) {
    const d = devEdgeCspDecision(errs.map(withHash), docs, pg);
    const ok = d.forgiven.length === want && d.kept.length === errs.length - want;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${kind.padEnd(12)} ${label}`);
  }
  // A non-security console error carrying the same words is never a candidate.
  const fake = { ...line(CF), source: 'console-api' };
  const okFake = devEdgeCspDecision([{ ...fake, ...cspBlockedHashOf(fake) }], 0, page).forgiven.length === 0;
  if (!okFake) failures++;
  console.log(`${okFake ? 'ok  ' : 'FAIL'} ${'control'.padEnd(12)} an app console line echoing the sentence stays dirt`);

  // END TO END: a report whose only error is the injected refusal reads clean, records the exception,
  // and `gate` keeps a PASS a PASS while listing the exception in the detail.
  const cx = cxOf([]);
  cx.events.push({ method: 'Log.entryAdded', params: { entry: { ...line(CF), timestamp: Date.now() } } });
  cx.send = async (method) => (method === 'Runtime.evaluate' ? { result: { value: JSON.stringify(page) } } : {});
  const rep = await report({ cx, label: 'W1' });
  const g = gate('PASS', { W1: rep });
  const okE2E = rep.clean && rep.environmentException?.forgiven === 1 && g.verdict === 'PASS' && g.detail.environmentException?.W1?.name === DEV_EDGE_CSP_EXCEPTION.name;
  if (!okE2E) failures++;
  console.log(`${okE2E ? 'ok  ' : 'FAIL'} ${'forgiven'.padEnd(12)} a verdict taken with the exception reads PASS and names it (got ${g.verdict})`);
}

// A ROW THAT DID NOT PASS KEEPS EVERY CLIENT'S WHOLE CONSOLE (DUP-6, alpha.4), routine lines included.
{
  const ev = (text, type = 'log') => ({ method: 'Runtime.consoleAPICalled', params: { type, args: [{ value: text }] } });
  const d = consoleDump({ W1: { cx: { events: [ev('[WS RCV] routine'), ev('boom', 'error')] } }, W2: null });
  const ok = Object.keys(d).join() === 'W1' && d.W1 === 'info [WS RCV] routine\nerror boom';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'consoles'.padEnd(12)} a non-PASS row keeps each client's whole console, routine lines included`);
  if (!ok) failures++;
}

// THE SIGN-OUT COUNTER reads zero, one and two - the row asserts exactly one.
{
  const okCount =
    signOutCount(['[A] logout✓200 61ms', '[A] other']) === 1 &&
    signOutCount(['[A] logout✓200 61ms', '[A] logout✗ 12ms: lost']) === 2 &&
    signOutCount(['[A] logout✓200 61ms', '[A] logout✓200 59ms']) === 2 &&
    signOutCount([]) === 0;
  console.log(`${okCount ? 'ok  ' : 'FAIL'} ${'logouts'.padEnd(12)} the sign-out counter reads zero, one and two`);
  if (!okCount) failures++;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
