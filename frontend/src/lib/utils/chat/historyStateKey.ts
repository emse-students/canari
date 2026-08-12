import type { MessageReaction } from '$lib/types';
import type { StoredMessage } from '$lib/db';
import { isWithinHistoryRange } from './historyWindow';

/**
 * One short string standing for everything two devices must agree on about a conversation, so that
 * agreeing costs one frame instead of a digest exchange.
 *
 * The reconciliation on connect asks a single question - *do we hold the same thing?* - and the
 * common answer is yes. A digest describes a store in proportion to its size; this describes it in
 * 16 characters, and only when the two differ is the digest worth exchanging at all.
 *
 * **What it covers, and why exactly that.**
 *
 * - **The id set**, because that is what "the same messages" means; and
 * - **the mutation state of each message** - deleted, edited (by when), reacted to (by whom, with
 *   what, when, still standing or taken back). Ids alone would let two devices agree that a message
 *   exists while disagreeing about whether it was deleted, and BOTH would then call themselves
 *   complete. The state key exists to be believed, so it has to cover everything a peer could
 *   repair.
 * - **Never the content.** A deleted message keeps its id and loses its text, and the two devices
 *   must still recognise their agreement about it. Hashing content would make a purge look like a
 *   difference for ever - and it would put message text through a function whose output travels.
 *
 * **What it deliberately leaves out.** The read watermarks and the conversation floor are merged as
 * `max` and ride on every bundle; they converge through the shared log, which the reconciliation
 * runs AFTER draining. Putting them in the key would make a difference in read state - the most
 * frequently changing thing in a conversation - trigger a digest exchange that repairs messages
 * nobody was missing.
 *
 * **Why a `max`-free, order-free combine.** The contributions are XOR-folded, so the key does not
 * depend on the order messages are walked in and cannot depend on a sort two devices might do
 * differently - the mistake `compareIds` exists to prevent in the manifest. It also means a future
 * incremental version can maintain the fold across writes, XOR-ing a message out and its new state
 * in, without walking the window at all.
 *
 * @see docs/wiki/protocols/history-reconciliation.md#completeness-is-asked-from-the-requesters-side
 */

/** Hex characters of the key, i.e. 64 bits. See {@link historyStateKey} for why that is enough. */
const STATE_KEY_HEX_CHARS = 16;

/**
 * The canonical form of one reaction: the pair it belongs to, when it last changed, and whether it
 * currently stands.
 *
 * `at` defaults to 0 and `removed` to false for the same reason the type declares them optional - a
 * bare `{emoji, userId}` is a placement of unknown age, which is what it was before those fields
 * existed. Two devices reading the same stored reaction must produce the same string, so every
 * absent field has to have a written-down default rather than an incidental one.
 */
function canonicalReaction(r: MessageReaction): string {
  return `${r.userId?.toLowerCase() ?? ''}${r.emoji ?? ''}${r.at ?? 0}${r.removed ? 1 : 0}`;
}

/**
 * The canonical form of one message's reconcilable state.
 *
 * Reactions are SORTED here, and that is the one place order matters: they are a set, stored as an
 * array, and two devices that received the same two reactions in opposite orders hold the same
 * state. Sorting is by the canonical string itself, which is ASCII-comparable by construction, so
 * no locale can enter into it (`localeCompare` would make two devices in different locales disagree
 * for ever - the manifest carries the same warning for the same reason).
 */
export function canonicalMessageState(m: StoredMessage): string {
  const reactions = (m.reactions ?? []).map(canonicalReaction).sort();
  return [
    m.id,
    m.isDeleted ? 1 : 0,
    // The edit's OWN timestamp, not the flag: two different edits of the same message are two
    // different states, and `isEdited` alone cannot tell them apart. A message edited by a client
    // too old to send the time contributes its flag and no time, which is what it actually knows.
    m.isEdited ? (m.editedAt ?? 1) : 0,
    reactions.join(''),
  ].join('');
}

/**
 * Folds one message's digest into the accumulator.
 *
 * XOR is commutative and associative, which is what makes the key independent of walk order. It is
 * NOT idempotent - a message folded in twice cancels itself out entirely - which is exactly why the
 * caller deduplicates by id before folding, and why that guard is not optional tidiness.
 */
function xorInto(acc: Uint8Array, digest: Uint8Array): void {
  for (let i = 0; i < acc.length; i++) acc[i] ^= digest[i];
}

/**
 * The state key of `messages`, restricted to what falls at or after `since`.
 *
 * `since` is the asker's stated window and both sides must compute over the SAME one, which is why
 * it is a parameter here rather than derived: a key computed over a boundary the peer did not name
 * answers a question the peer did not ask. `deviceWindowStart` rounds that boundary to the day so
 * two devices connecting the same day can produce comparable keys at all.
 *
 * An empty selection has a key of its own (all zeroes) rather than being an absent value: "I hold
 * nothing in this window" is an answer, and a peer holding nothing either must be able to match it.
 *
 * 64 bits, like the manifest's slice fingerprints and for the same reason: a collision here declares
 * two conversations identical when they are not, and the messages in the difference are lost
 * silently. One in 10^19 against the handful of comparisons a device makes per connect.
 */
export async function historyStateKey(
  messages: readonly StoredMessage[],
  since: number = 0
): Promise<string> {
  const acc = new Uint8Array(STATE_KEY_HEX_CHARS / 2);
  const seen = new Set<string>();
  for (const m of messages) {
    const id = m.id?.trim();
    // A store should not hold the same id twice, but a key that trusts that is a key which can
    // differ from a peer's for a reason neither device is able to see.
    if (!id || seen.has(id)) continue;
    if (!isWithinHistoryRange(Number(m.timestamp), since)) continue;
    seen.add(id);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalMessageState(m))
    );
    xorInto(acc, new Uint8Array(digest, 0, acc.length));
  }
  return [...acc].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads a state key off a frame a peer sent us, or `null` for anything that is not one. */
export function parseHistoryStateKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return key.length === STATE_KEY_HEX_CHARS && /^[0-9a-f]+$/.test(key) ? key : null;
}
