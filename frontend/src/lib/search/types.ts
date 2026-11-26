/**
 * THE SHAPES OF THE UNIVERSAL SEARCH (owner, 2026-11-26): one query, results grouped by section,
 * each section answered by ONE provider. The design, the local/server split and the privacy rules
 * are on `docs/wiki/frontend/universal-search.md`.
 */

/** The sections, in the order the page draws them and the chips list them. */
export const SEARCH_SECTIONS = [
  'people',
  'discussions',
  'communities',
  'associations',
  'posts',
  'events',
  'forms',
  'settings',
] as const;

export type SearchSectionId = (typeof SEARCH_SECTIONS)[number];

/**
 * Where a section's answer comes from - said on the page, because principle 1 is a promise a reader
 * should be able to check:
 *  - `device`: matched on the device over what it already holds; the query never leaves it.
 *  - `list`: a list the server sends (the same one its own page reads), matched on the device; the
 *    server learns that the list was read, never what was typed.
 *  - `server`: the query is sent to the server, which answers the matches.
 */
export type SearchSource = 'device' | 'list' | 'server';

/** One result row, whatever its section. Everything the row draws and where it leads. */
export interface SearchHit {
  /** Unique inside its section (a message hit is `<conversationId>/<messageId>`). */
  key: string;
  title: string;
  /** The grey line under the title (a promo, an association, a date); absent when none. */
  subtitle?: string;
  /**
   * A message's text around the match, with the matched words located for the highlight
   * (`foldWithIndex` offsets in the ORIGINAL text).
   */
  snippet?: { text: string; ranges: readonly [number, number][] };
  /** Where the row leads, when it is a page; otherwise {@link SearchHit.open} acts. */
  href?: string;
  /** What a tap does when the row is not a plain link (a conversation, an event's sheet). */
  open?: () => void;
  /** A user id whose avatar the row draws (a person, a direct conversation). */
  avatarUserId?: string;
  /** An image the row draws instead (an association logo, a community cover). */
  imageUrl?: string | null;
}

/** What one provider answers for one query. */
export interface SearchSectionAnswer<H = SearchHit> {
  hits: H[];
  /** The total the server counted, when it counts; absent means `hits` is the whole answer. */
  total?: number;
}

/** What a provider is asked: the words, and how many rows the section wants this time. */
export interface SearchRequest {
  query: string;
  /** 3 in the overview, more once the reader asked for the whole section ("Tout afficher"). */
  limit: number;
}

/** One section's answerer. A provider throws on a failure; it never answers an empty list for one. */
export interface SearchProvider<H = SearchHit> {
  section: SearchSectionId;
  source: SearchSource;
  search(request: SearchRequest): Promise<SearchSectionAnswer<H>>;
}

/** The overview shows this many rows per section; "Tout afficher" opens the rest. */
export const OVERVIEW_LIMIT = 3;
/** The rows a whole section shows at first, and each "Afficher plus" adds. */
export const SECTION_PAGE = 30;
/** A query shorter than this asks nothing (one letter would list every row of every section). */
export const MIN_QUERY_LENGTH = 2;
