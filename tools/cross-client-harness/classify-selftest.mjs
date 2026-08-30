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
import {
  DEVICE_PANEL_NARRATION,
  EVICTED_REJOIN_NARRATION,
  ignoringExpectedLog,
  report,
} from './watch.mjs';

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
    '[01:40:12] [QUEUE] Buffering message for group b6a425af… (Welcome in progress)',
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
    '[01:40:12] [BUFFER] welcome_request sent for unknown group b6a425af…',
    'notable',
  ],
  [
    'log',
    '[01:40:12] [MLS] Message for absent conversation b6a425af… - retry after restore',
    'notable',
  ],
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
    '[01:40:12] [QUEUE] endBulkIngest without a matching beginBulkIngest - ignored',
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
  const ok = named.errors.some((l) => l.includes('415') && l.includes('POST /api/media/upload'));
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
const FORGIVE_CASES = [
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
      ['log', '[DevicePanel] Deleted device f0a3bb2c… (groups cleaned: 9, keyPackages: 3)'],
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
    'a console error beside a forgiven line still breaks clean',
    [
      ['log', '[09:14:02] [OUTBOX] a721e695… text entry in 472df672…, group-deleted - permanent failure'],
      ['error', 'Uncaught (in promise) TypeError: x is not a function'],
    ],
    [/group-deleted - permanent failure$/],
    { clean: false, unmatched: 0 },
  ],
];
for (const [what, lines, needles, want] of FORGIVE_CASES) {
  const rep = ignoringExpectedLog(await report({ cx: cxOf(lines), label: 'selftest' }), needles);
  const got = { clean: rep.clean, unmatched: rep.ignoredAsExpectedLog.unmatched.length };
  const ok = got.clean === want.clean && got.unmatched === want.unmatched;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'forgive'.padEnd(12)} ${what}`);
  if (!ok) console.log(`       want=${JSON.stringify(want)} got=${JSON.stringify(got)} rep=${JSON.stringify({ severe: rep.severe, errors: rep.errors, unexplained: rep.unexplained })}`);
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall good');
process.exit(failures ? 1 : 0);
