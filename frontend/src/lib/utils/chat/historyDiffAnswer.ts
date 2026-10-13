import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { HistoryDiff, HistoryDigest } from '$lib/utils/chat/historyManifest';
import {
  diffHistoryDigest,
  isEmptyHistoryDiff,
  selectEntryIdsForPrefixes,
} from '$lib/utils/chat/historyManifest';
import {
  historyRangeStartFor,
  readHistoryEntries,
  sendHistoryBundleForIds,
  sendHistoryCoverage,
  sendHistoryPull,
} from '$lib/utils/chat/groupActions';

/**
 * What answering a solicitation needs, and it is the same set on both roads that reach it.
 *
 * It is a plain bag rather than the caller's own context because the two callers are on opposite
 * sides of the message pipeline: `handleHistoryRequest` answers a digest it is WAITING for, and the
 * system handler answers one that arrived after that wait ended. Sharing the bag is what keeps them
 * from drifting into two diffs.
 */
export interface HistoryAnswerDeps {
  storage: IStorage | null;
  deviceKeyB64: string;
  mlsService: IMlsService;
  log: (msg: string) => void;
}

/**
 * States where OUR completeness begins, when the asker asked from below it - and says nothing
 * otherwise.
 *
 * Called at every point a device actually ANSWERS, and at none of the points where it stays silent
 * so another member takes over: silence means "ask somebody else", and a coverage line attached to
 * it would tell the asker we answered when we did not.
 */
export async function stateOurCoverage(params: {
  groupId: string;
  selfIdentity: string;
  requesterIdentity: string;
  since: number;
  deps: HistoryAnswerDeps;
}): Promise<void> {
  const { groupId, selfIdentity, requesterIdentity, since, deps } = params;
  const coveredFrom = await historyRangeStartFor(groupId, deps.storage);
  if (coveredFrom <= since) return;
  await sendHistoryCoverage(
    groupId,
    { from: selfIdentity, to: requesterIdentity, since, coveredFrom },
    deps
  );
}

/**
 * Answers a digest: diff it against our store, send what the asker lacks, ask for what we lack.
 *
 * **THE LAST LEG OF A SOLICITATION, AND IT NEEDS NOTHING REMEMBERED.** The digest carries the
 * manifest and the window the asker drew; our own store carries the rest. That is why this is a
 * function and not a continuation inside the wait that asked for it: a digest that arrives after
 * the responder stopped waiting is still a complete, answerable question, and dropping it cost the
 * P1 measured on 2026-09-05 - three messages missing for ever on a device that had just rejoined,
 * because its queue took 67 s to drain and the waiter lived 60 s.
 *
 * Because the diff is symmetric, this repairs BOTH devices: what we hold and it does not goes out
 * as a bundle, what it holds and we do not comes back as a pull.
 */
export async function answerHistoryDigest(params: {
  groupId: string;
  /** The device that described itself - the one this answer is addressed to. */
  requesterIdentity: string;
  /** OURS, for the legs where we are the asker. */
  selfIdentity: string;
  digest: HistoryDigest;
  /** The window the asker drew. Never recomputed here: two devices deriving it disagree. */
  since: number;
  deps: HistoryAnswerDeps;
}): Promise<void> {
  const { groupId, requesterIdentity, selfIdentity, digest, since, deps } = params;
  const { log } = deps;
  const short = groupId.slice(0, 8);

  const entries = await readHistoryEntries(groupId, deps);
  if (entries === null) {
    log(`[HISTORY_REQ] ${short}... store unreadable - staying silent so another member answers`);
    return;
  }

  const diff = await diffHistoryDigest(entries, digest);
  const idsToSend =
    digest.mode === 'ids'
      ? diff.missingOnPeer
      : selectEntryIdsForPrefixes(entries, diff.pushPrefixes, digest.depth);

  // The diff is computed over our WHOLE store and clipped only on the way out, which is what keeps
  // the two sides symmetric: a stored timestamp can differ by a hair between devices (see
  // `historyManifest`), so clipping the COMPARISON would let a message near the boundary read as
  // missing on one side and present on the other, for ever. Clipping the ANSWER cannot: the worst it
  // does is decline to send something the asker did not ask for.
  await sendHistoryBundleForIds(groupId, idsToSend, deps, {
    to: requesterIdentity,
    since,
  }).catch((e) => log(`[HISTORY_BUNDLE] Diff send error to ${requesterIdentity}: ${String(e)}`));

  // The requester listed messages we do not have, so we ask for them on the same exchange.
  const pulled = await pullWhatWeLack({
    groupId,
    selfIdentity,
    holderIdentity: requesterIdentity,
    digest,
    diff,
    deps,
  });

  log(
    `[HISTORY_REQ] ${short}... diff with ${requesterIdentity}: ${idsToSend.length} to send, ${pulled} to pull${isEmptyHistoryDiff(diff) ? ' (identical stores)' : ''}`
  );

  // Last, after everything this device had to give. The diff above names what we hold and it does
  // not, which says nothing about the range below OUR window - a device that pruned to ninety days
  // has an honest, complete answer for the last ninety days and none at all before that.
  await stateOurCoverage({ groupId, selfIdentity, requesterIdentity, since, deps });
}

/**
 * Asks the device that described its store for whatever `diff` says we lack, and returns how many
 * ids and slices were asked for (0 when nothing was missing, and then nothing is sent).
 *
 * ONE implementation for both roads that learn a peer's holdings from its digest - the elected
 * responder ({@link answerHistoryDigest}) and a member that only overheard it
 * ({@link pullFromOverheardDigest}) - so the two cannot drift into two pulls. Nothing is recorded if
 * the answer never comes.
 */
async function pullWhatWeLack(params: {
  groupId: string;
  selfIdentity: string;
  /** The device whose digest named what we lack, and so the one that can serve it. */
  holderIdentity: string;
  digest: HistoryDigest;
  diff: HistoryDiff;
  deps: HistoryAnswerDeps;
}): Promise<number> {
  const { groupId, selfIdentity, holderIdentity, digest, diff, deps } = params;
  const idsToPull = digest.mode === 'ids' ? diff.missingLocally : [];
  const wanted = idsToPull.length + diff.pullPrefixes.length;
  if (wanted === 0) return 0;
  await sendHistoryPull(
    groupId,
    {
      from: selfIdentity,
      to: holderIdentity,
      ids: idsToPull,
      prefixes: diff.pullPrefixes,
      depth: digest.mode === 'range' ? digest.depth : undefined,
      // OUR window, not the one the digest arrived with. On this leg we are the asker, and the
      // `since` a digest carries describes what ITS AUTHOR wants - reusing it would cap this device
      // at the shortest window in the conversation.
      since: await historyRangeStartFor(groupId, deps.storage),
    },
    deps
  ).catch((e) => deps.log(`[HISTORY_PULL] Pull send error to ${holderIdentity}: ${String(e)}`));
  return wanted;
}

/**
 * A digest this device OVERHEARD - an exchange between two other members - read as what it is:
 * a statement, by the device that sent it, of every message it holds.
 *
 * **Every leg of the exchange is a group broadcast, so every member already receives and decrypts
 * the digest; only the elected responder used to read it.** Measured on production 2026-10-13: a
 * browser lacked one message its owner's phone held, and nothing the browser could notice about
 * itself said so - no unreadable frame, no queued row, a connection pass that rightly saw no reason
 * to sweep. Its only evidence of the gap arrived as the phone's digest, addressed to the phone's
 * other device, and was recorded and dropped without a line. Ingesting an overheard ANSWER was
 * already the rule (`history_bundle`: "an answer meant for a peer is simply free messages"); this is
 * the same rule applied to the QUESTION.
 *
 * **It ASKS, it never answers.** What the digest's author lacks is the elected responder's job, and
 * a second answer would put every member on the frame the election exists to give one. What WE
 * lack is ours alone, and it is asked of the author - the one device known, by its own statement a
 * moment ago, to hold it. The pull is addressed, so only the author serves it, and a bundle asks for
 * nothing back: one overheard digest costs this device one store read and at most one pull, and the
 * exchange ends there.
 */
export async function pullFromOverheardDigest(params: {
  groupId: string;
  /** The device that described itself - the only one known to hold what it listed. */
  holderIdentity: string;
  selfIdentity: string;
  digest: HistoryDigest;
  deps: HistoryAnswerDeps;
}): Promise<void> {
  const { groupId, holderIdentity, selfIdentity, digest, deps } = params;
  const short = groupId.slice(0, 8);

  const entries = await readHistoryEntries(groupId, deps);
  if (entries === null) {
    deps.log(
      `[HISTORY_DIGEST] ${short}... overheard ${holderIdentity}'s digest but our store is unreadable - cannot tell what we lack`
    );
    return;
  }

  const diff = await diffHistoryDigest(entries, digest);
  const pulled = await pullWhatWeLack({
    groupId,
    selfIdentity,
    holderIdentity,
    digest,
    diff,
    deps,
  });
  deps.log(
    pulled > 0
      ? `[HISTORY_DIGEST] ${short}... overheard ${holderIdentity}'s digest naming ${pulled} id(s)/slice(s) we lack - asked it for them`
      : `[HISTORY_DIGEST] ${short}... overheard ${holderIdentity}'s digest - we hold everything it lists`
  );
}
