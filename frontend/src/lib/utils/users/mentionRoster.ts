import { foldForSearch } from '$lib/utils/textFold';
import type { ChatMessage } from '$lib/types';

/** One member of the conversation a mention picker is open in. */
export interface MentionRosterMember {
  id: string;
  /** The name when the caller already holds it; the picker falls back to the display-name cache. */
  displayName?: string | null;
  /** Epoch ms of the member's latest message in THIS conversation, when one is loaded. */
  lastSpokeAt?: number;
}

/** How many rows a picker shows at once. */
export const MENTION_MAX_ROWS = 6;

/**
 * Builds a conversation's mention roster: its member ids, each stamped with the time the member
 * last spoke in the messages that are loaded. System rows carry no information about who is worth
 * suggesting, so they are skipped.
 */
export function buildMentionRoster(
  memberIds: readonly string[],
  messages: readonly Pick<ChatMessage, 'senderId' | 'timestamp' | 'isSystem'>[]
): MentionRosterMember[] {
  const last = new Map<string, number>();
  for (const msg of messages) {
    if (msg.isSystem) continue;
    const id = msg.senderId.toLowerCase();
    const at = new Date(msg.timestamp).getTime();
    if (Number.isFinite(at) && at > (last.get(id) ?? 0)) last.set(id, at);
  }
  return memberIds.map((id) => ({ id, lastSpokeAt: last.get(id.toLowerCase()) }));
}

/** The longest query a mention may grow to before the text after the `@` is read as plain text. */
export const MENTION_QUERY_MAX = 64;

/** What separates the words of a name or of a query: spaces (a non-breaking one too), apostrophes, hyphens. */
const WORD_SEPARATORS = /[\s'’-]+/;

/** The folded words of `text` (accents and case removed), empty ones dropped. */
export function foldedWords(text: string): string[] {
  return foldForSearch(text).split(WORD_SEPARATORS).filter(Boolean);
}

/**
 * Whether every query word starts a DIFFERENT word of the name, in any order - so "jean dup",
 * "dup jean" and "dupont" all find "Jean Dupont", and "jean jean" does not find a single Jean.
 * Names and queries hold a handful of words, so the assignment is searched exhaustively.
 */
export function wordsMatchQuery(
  nameWords: readonly string[],
  queryWords: readonly string[]
): boolean {
  if (queryWords.length === 0) return true;
  if (queryWords.length > nameWords.length) return false;
  const used = Array.from({ length: nameWords.length }, () => false);
  const place = (i: number): boolean => {
    if (i === queryWords.length) return true;
    for (let w = 0; w < nameWords.length; w++) {
      if (used[w] || !nameWords[w].startsWith(queryWords[i])) continue;
      used[w] = true;
      if (place(i + 1)) return true;
      used[w] = false;
    }
    return false;
  };
  return place(0);
}

/** One member as the index holds it: the name it was folded from, its folded form and words. */
interface IndexedName {
  name: string;
  folded: string;
  words: string[];
}

/**
 * THE NAMES OF A ROSTER, FOLDED ONCE (owner, 2026-11-12: the `@` was slow with a large population).
 *
 * The picker used to fold every member's name on every keystroke: a community of a few thousand
 * paid thousands of `normalize('NFD')` calls per letter typed. The index keeps each member's folded
 * words for as long as the picker lives, keyed by id, and folds again only the member whose NAME
 * changed (a name resolved after the first open) - never because a key was pressed.
 */
export class MentionNameIndex {
  private readonly entries = new Map<string, IndexedName>();
  /** How many names were folded since the index was made - what the tests read to prove the above. */
  folds = 0;

  /** The folded form of `name` for member `key`, folded only if `name` is new for that member. */
  entry(key: string, name: string): IndexedName {
    const known = this.entries.get(key);
    if (known && known.name === name) return known;
    this.folds += 1;
    const folded = foldForSearch(name);
    const entry = { name, folded, words: folded.split(WORD_SEPARATORS).filter(Boolean) };
    this.entries.set(key, entry);
    return entry;
  }
}

/**
 * Picks the rows a roster-backed mention picker shows for `query`, locally.
 *
 * Every word of the folded query (accent- and case-insensitive) must START a different word of the
 * name, in any order, so "@m" finds "Marie Dupont" and "Jean Martin", "@dupont marie" finds the
 * first, and a bare "@" finds everybody. Order: whoever spoke most recently here first, then
 * alphabetical on the folded name. `resolveName` supplies the name of a member that carries none;
 * a member with no name at all is left out, because a row that can only read as a raw id is not
 * one a reader can pick by typing (reported through `onUnnamed`).
 *
 * Only the best `limit` rows are kept while the roster is walked (a bounded insertion, never a sort
 * of every match), and names come folded from `index`: a keystroke costs one pass of look-ups.
 *
 * @param excludeIds - ids never offered (the signed-in reader, accounts they blocked)
 */
export function suggestFromRoster(
  roster: readonly MentionRosterMember[],
  query: string,
  {
    excludeIds,
    resolveName,
    onUnnamed,
    index = new MentionNameIndex(),
    limit = MENTION_MAX_ROWS,
  }: {
    excludeIds: readonly string[];
    resolveName: (id: string) => string | null;
    /** Called for each member dropped because no name is known, so the drop is never silent. */
    onUnnamed?: (id: string) => void;
    /** The picker's own index, kept between keystrokes; a fresh one folds every name once. */
    index?: MentionNameIndex;
    /** How many rows to return. */
    limit?: number;
  }
): { id: string; displayName: string }[] {
  const excluded = new Set(excludeIds.map((id) => id.toLowerCase()));
  const queryWords = foldedWords(query);
  const best: { id: string; displayName: string; folded: string; at: number }[] = [];
  const seen = new Set<string>();
  const before = (a: { folded: string; at: number }, b: { folded: string; at: number }): boolean =>
    b.at - a.at < 0 || (a.at === b.at && a.folded.localeCompare(b.folded) < 0);
  for (const member of roster) {
    const key = member.id.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    const name = member.displayName?.trim() || resolveName(member.id);
    if (!name) {
      onUnnamed?.(member.id);
      continue;
    }
    const entry = index.entry(key, name);
    if (!wordsMatchQuery(entry.words, queryWords)) continue;
    seen.add(key);
    const row = {
      id: member.id,
      displayName: name,
      folded: entry.folded,
      at: member.lastSpokeAt ?? 0,
    };
    if (best.length === limit && !before(row, best[best.length - 1])) continue;
    let i = best.length;
    while (i > 0 && before(row, best[i - 1])) i--;
    best.splice(i, 0, row);
    if (best.length > limit) best.pop();
  }
  return best.map(({ id, displayName }) => ({ id, displayName }));
}

/**
 * The mention being typed at the end of `textBeforeCursor`: where its `@` is and what follows it.
 *
 * The query may hold SPACES (owner, 2026-11-12: "@Prenom NOM" could not be searched, the first space
 * ended it), so it is a run of letters, digits, `_`, apostrophes, hyphens and spaces after the last
 * `@` - never starting with a space ("@ " is not a mention), never crossing a newline, and at most
 * {@link MENTION_QUERY_MAX} characters. Whether a query with a space is STILL a mention is decided by
 * the picker from its matches, not here: this only says where the candidate starts.
 */
export function findMentionQuery(
  textBeforeCursor: string
): { start: number; query: string } | null {
  const m = MENTION_QUERY_RE.exec(textBeforeCursor);
  if (!m || m[1].length > MENTION_QUERY_MAX) return null;
  return { start: textBeforeCursor.length - m[0].length, query: m[1] };
}

const MENTION_QUERY_RE = /@((?:[\p{L}\p{M}\p{N}_'\u2019-][\p{L}\p{M}\p{N}_'\u2019 \u00a0-]*)?)$/u;
