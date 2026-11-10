/**
 * THE READER'S FOLLOW SUGGESTIONS IN THE SESSION (engagement WP-6, decisions 3 and 7): what the
 * feed carousel, the empty Suivis feed and the onboarding banner draw - ONE read of
 * `me/suggestions` per reader, shared by the three, and the X that dismisses a card everywhere at
 * once. "Suivez aussi..." reads its own page (`FollowAlsoSuggestions.svelte`), and dismisses here.
 *
 * - The read is asked ONCE per reader. A failure is a warning and is not asked again until another
 *   reader signs in: the carousel is a bonus, and a feed that retried it on every mount would be
 *   traffic with no event behind it.
 * - A dismissal is optimistic: the card leaves at once, and comes back with a toast if the server
 *   refused it.
 * - A per-reader cache (`registerPerReaderCache`): signing out or switching accounts forgets it, and
 *   an answer that left for the previous reader is dropped when it lands.
 */
import { SvelteSet } from 'svelte/reactivity';
import { registerPerReaderCache } from '$lib/utils/sharedCache';
import { Log } from '$lib/utils/Log';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import {
  dismissFollowSuggestion,
  getFollowSuggestions,
  type FollowSuggestions,
  type SuggestedEntity,
  type SuggestedPerson,
  type SuggestionKind,
} from './api';
import { associationChipState, personChipState } from './followState.svelte';

/**
 * L12: "follows almost nobody" is fewer than this many follows in total (accepted person follows
 * plus entity follows) - the onboarding banner (decision 7).
 */
export const ONBOARDING_FOLLOWS_BELOW = 5;
/** The feed carousel is drawn once, after this many posts (the design's "after the 3rd post"). */
export const FEED_CAROUSEL_AFTER_POSTS = 3;
/** How many cards one carousel carries. */
export const CAROUSEL_CARDS_MAX = 10;
/** How many people "Suivez aussi..." offers. */
export const FOLLOW_ALSO_MAX = 5;

/** One card: a person or an entity. */
export type SuggestionCard =
  | { kind: 'user'; id: string; person: SuggestedPerson }
  | { kind: 'association'; id: string; entity: SuggestedEntity };

/**
 * The feed the carousel belongs to: Pour toi alone (owner, 2026-11-10 - Campus and Associations are
 * pure lists, nothing inserted between their posts).
 */
const CAROUSEL_FEEDS: readonly string[] = ['foryou'];

/**
 * People and entities interleaved, a person first, at most `max` cards: neither source buries the
 * other, and a short one leaves the rest to the longer.
 */
export function interleaveCards(
  data: Pick<FollowSuggestions, 'people' | 'entities'>,
  max = CAROUSEL_CARDS_MAX
): SuggestionCard[] {
  const out: SuggestionCard[] = [];
  const people = data.people.map((person): SuggestionCard => ({
    kind: 'user',
    id: person.userId,
    person,
  }));
  const entities = data.entities.map((entity): SuggestionCard => ({
    kind: 'association',
    id: entity.id,
    entity,
  }));
  for (let i = 0; out.length < max && (i < people.length || i < entities.length); i++) {
    if (i < people.length) out.push(people[i]);
    if (i < entities.length && out.length < max) out.push(entities[i]);
  }
  return out;
}

/** Where the feed draws its suggestions, if anywhere. */
export type SuggestionPlacement = 'banner' | 'page' | 'inline';

/**
 * THE ONE RULE OF WHERE (decision 3 and 7, the table "Where suggestions appear"):
 * - only in Pour toi, and only while a card is left to act on;
 * - an EMPTY Pour toi: the carousel is the page body;
 * - a reader who follows fewer than {@link ONBOARDING_FOLLOWS_BELOW} accounts: a banner at the top;
 * - otherwise once, after the {@link FEED_CAROUSEL_AFTER_POSTS}rd post.
 * One placement at a time: a reader never sees the same cards twice on one screen.
 */
export function feedSuggestionPlacement(input: {
  feed: string;
  postCount: number;
  followingCount: number;
  openCards: number;
}): SuggestionPlacement | null {
  if (!CAROUSEL_FEEDS.includes(input.feed) || input.openCards === 0) return null;
  if (input.feed === 'foryou' && input.postCount === 0) return 'page';
  if (input.followingCount < ONBOARDING_FOLLOWS_BELOW) return 'banner';
  if (input.postCount >= FEED_CAROUSEL_AFTER_POSTS) return 'inline';
  return null;
}

const read = $state<{ data: FollowSuggestions | null; failed: boolean }>({
  data: null,
  failed: false,
});
/** Cards dismissed in this session, `kind:id` - reactive, every carousel drops them at once. */
const dismissed = new SvelteSet<string>();
let epoch = 0;
let asked = false;

const key = (kind: SuggestionKind, id: string) => `${kind}:${id}`;

/** Forgets everything: another account signed in, or the reader signed out (or a test). */
export function resetSuggestions(): void {
  epoch++;
  asked = false;
  read.data = null;
  read.failed = false;
  dismissed.clear();
}
registerPerReaderCache(resetSuggestions);

/** Reads the reader's suggestions once; a second call, or one after a failure, does nothing. */
export function ensureFeedSuggestions(): void {
  if (asked) return;
  asked = true;
  const mine = epoch;
  getFollowSuggestions()
    .then((data) => {
      if (mine !== epoch) return;
      read.data = data;
    })
    .catch((e: unknown) => {
      if (mine !== epoch) return;
      read.failed = true;
      console.warn('[suggestions] read failed, not asked again this session', e);
    });
}

/** The reader's follow count once read, `null` before (the banner waits for the answer). */
export function suggestionsFollowingCount(): number | null {
  return read.data ? read.data.followingCount : null;
}

/**
 * The feed's cards, the dismissed ones gone. Empty until read. PEOPLE ONLY (lead's decision,
 * 2026-11-10, reversible - docs/wiki/engagement.md, WP-6): the carousel lives in Pour toi, which is
 * people's posts only, so an entity card there would offer what the tab never shows. The read still
 * carries the entities (`me/suggestions` is unchanged for the installed clients); they are left here.
 */
export function feedSuggestionCards(): SuggestionCard[] {
  if (!read.data) return [];
  return interleaveCards({ people: read.data.people, entities: [] }).filter(
    (c) => !dismissed.has(key(c.kind, c.id))
  );
}

/** Whether a card was dismissed in this session (the "Suivez aussi..." row reads it too). */
export function isSuggestionDismissed(kind: SuggestionKind, id: string): boolean {
  return dismissed.has(key(kind, id));
}

/**
 * Whether a card is still drawn: not dismissed, and its "Suivre" still means something - a person
 * not followed (a request sent stays drawn, showing "Demande envoyee"), an entity not followed. An
 * answer not read yet keeps it drawn; a chip the ledger hides (a block, a membership) hides it.
 */
export function cardDrawn(card: SuggestionCard): boolean {
  if (dismissed.has(key(card.kind, card.id))) return false;
  if (card.kind === 'user') {
    const s = personChipState(card.id);
    return s === undefined || s === null || s === 'pending';
  }
  const s = associationChipState(card.id);
  return s === undefined || s === false;
}

/**
 * Whether a card is still OPEN - something left to do on it: drawn, and not a request already sent.
 * A carousel whose every card is followed or dismissed is hidden (the design's table).
 */
export function cardOpen(card: SuggestionCard): boolean {
  if (!cardDrawn(card)) return false;
  return card.kind !== 'user' || personChipState(card.id) !== 'pending';
}

/** The X: the card leaves every carousel at once; a refusal brings it back with a toast. */
export async function dismissSuggestion(kind: SuggestionKind, id: string): Promise<void> {
  const k = key(kind, id);
  if (dismissed.has(k)) return;
  dismissed.add(k);
  const mine = epoch;
  try {
    await dismissFollowSuggestion(kind, id);
  } catch (e) {
    if (mine !== epoch) return;
    Log.d('suggestions', `dismiss refused: ${String(e)}`);
    dismissed.delete(k);
    showToast(m.suggestions_dismiss_failed(), 'error');
  }
}
