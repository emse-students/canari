/**
 * THE CLASSIFIER, RUN OVER LINES WHOSE RIGHT BUCKET IS KNOWN.
 *
 *   node classify-selftest.mjs
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
import { report } from './watch.mjs';

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
  ['log', '[14:24:25] [OUTBOX] 12 entries still queued', 'notable'],
  // The two withdrawal branches, pinned TOGETHER because the risk in classifying them is that one
  // rule swallows both: they share a prefix, an id and the word "withdrawn", and they mean opposite
  // things about what the peers hold. Landed in `unexplained` on MUT-19's first green run.
  ['log', '[11:11:10] [OUTBOX] a721e695… withdrawn from the queue before it was ever sent', 'benign'],
  [
    'log',
    '[11:11:10] [OUTBOX] a721e695… withdrawn while it was already being sent - the peers will have it, so the delete has to travel as an event',
    'notable',
  ],
  ['log', '[14:24:06] [MLS] Frames are being lost in 642f389a… - reconciling this conversation', 'notable'],
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
  // Plural, because the count is a count and a rule pinned to `1` would forgive the interesting case.
  ['log', '[01:40:12] [PENDING] 4 pending invitation(s) to process', 'notable'],
  // AND THE LINE THE SAME TAG PRINTS WHEN THERE IS NOTHING TO DO, which must stay out of `notable`:
  // it fires on every connect, and a rule that could not tell the two apart would report the sweep
  // as a finding on every single run.
  ['log', '[01:40:12] [PENDING] No pending MLS messages', 'benign'],
  // A Welcome sent in answer to a welcome_request - the invitation-link join and every re-add.
  // `notable`: the mechanism working, and also somebody asking to be let into a group.
  ['log', '[14:26:09] [WELCOME_REQ] Welcome -> b78568a3…:web-b78568a3…-msglwqh6-vegy for 1bf6fefe…', 'notable'],
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
  // A kick followed by a re-add, claimed by the generic `re-?add` rule rather than a rule of its own.
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
  ['log', '[14:12:38] Groupe renomme en "GRP5-mt5rospko89-R"', 'benign'],
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
  // WHAT REPLACED THEM. The eviction is learnt from the commit that stated it, so the removed
  // device reports the change and stops - no recovery, no retry ladder. `stateChanges`, not
  // `benign`: what this client holds really did change, and a reader must see it.
  [
    'log',
    '[14:10:28] [EVICT] Removed from 4ca35caf… by a Remove commit - conversation retired',
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
  ['log', '[14:10:28] [OUTBOX] 1d9076db… evicted from 4ca35caf… - permanent failure', 'stateChanges'],
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
  ['debug', '[Cookies] flushed after refresh', 'benign'],
  ['log', '[21:31:56] [PIN] Device key restored from PinVault - auto-login…', 'benign'],
  ['log', '[21:36:45] MLS state loaded from mls.bin (native).', 'benign'],
  ['log', '[DB] Using SQLite storage (Tauri)', 'benign'],
  [
    'info',
    '[Push] startPushService device=tauri-aaaaaaaa…-bbbbbbbb-cccc (platform will be confirmed by FCM token)',
    'benign',
  ],
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
  // And the dismissal that ends that row's life, which READ-10 now performs itself.
  ['log', '[20:24:01] [DELETE_LOCAL] Local conversation deleted: 642f389a…', 'notable'],
];

let failures = 0;
for (const [level, text, want] of CASES) {
  const rep = await report({ cx: cxOf([[level, text]]), label: 'selftest' });
  const buckets = ['severe', 'errors', 'notable', 'stateChanges', 'unexplained'];
  const landed = buckets.filter((b) => rep[b].some((l) => String(l).includes(text.slice(11, 60))));
  // `benign` is not a bucket - it is the absence of every other one.
  const got = landed.length === 0 ? 'benign' : landed.join('+');
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
