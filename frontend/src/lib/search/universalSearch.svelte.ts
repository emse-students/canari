/**
 * THE STATE OF ONE OPEN UNIVERSAL SEARCH: the words, the chip the reader picked, and each section's
 * answer. One instance per opening of the search (the page builds it when the bar opens and disposes
 * of it when it closes), so nothing a search read outlives it.
 *
 * WHICH ANSWER LANDS IS DECIDED BY A COUNTER, NEVER BY A CLOCK. Every run of a section takes the next
 * number of that section; an answer that is not the latest one asked of its section is dropped, so
 * the order the network or the store answers in never decides what is shown.
 *
 * PACING, NOT CORRECTNESS. The sections answered on the device run at every keystroke. The two that
 * send the words to a server (Personnes, Posts) are asked once the typing pauses for
 * {@link SERVER_PACE_MS}, as the posts search always was: a keystroke is not a question, and a request
 * per letter would be traffic nobody reads. The pause decides only WHEN a request leaves; which
 * answer is shown is still the counter's.
 */
import { Log } from '$lib/utils/Log';
import type { PostEntity } from '$lib/posts/api';
import type { PostSearchCriteria, PostSearchPick } from '$lib/posts/postSearchFilters';
import { hasSearchCriteria } from '$lib/posts/postSearchFilters';
import {
  MIN_QUERY_LENGTH,
  OVERVIEW_LIMIT,
  SECTION_PAGE,
  SEARCH_SECTIONS,
  type SearchHit,
  type SearchProvider,
  type SearchSectionId,
  type SearchSource,
} from './types';

/** How long the typing must pause before the words are sent to a server. */
export const SERVER_PACE_MS = 400;

/** One section's answer as the page draws it. */
export interface SectionState<H = SearchHit> {
  status: 'idle' | 'loading' | 'done' | 'failed';
  hits: H[];
  /** How many there are in all, when known. */
  total: number;
  /** How many rows the section asks for now. */
  limit: number;
}

/** The Posts section's reader: the existing post search, filters included (1.8.2). */
export type PostsSearch = (
  criteria: PostSearchCriteria,
  page: { limit: number }
) => Promise<PostEntity[]>;

function idle<H>(limit: number): SectionState<H> {
  return { status: 'idle', hits: [], total: 0, limit };
}

/** Whether `query` asks anything at all of a section. */
export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH;
}

export function createUniversalSearch(opts: {
  providers: readonly SearchProvider[];
  posts: PostsSearch;
}) {
  const providerOf = (section: SearchSectionId) =>
    opts.providers.find((p) => p.section === section);
  let query = $state('');
  let focus = $state<SearchSectionId | null>(null);
  let author = $state<PostSearchPick | null>(null);
  let association = $state<PostSearchPick | null>(null);
  const sections = $state(
    Object.fromEntries(
      SEARCH_SECTIONS.filter((s) => s !== 'posts').map((s) => [s, idle<SearchHit>(OVERVIEW_LIMIT)])
    ) as Record<Exclude<SearchSectionId, 'posts'>, SectionState>
  );
  const posts = $state<SectionState<PostEntity>>(idle(OVERVIEW_LIMIT));
  /** The number of the latest run asked of each section (plain, never drawn). */
  const epochs: Partial<Record<SearchSectionId, number>> = {};
  let serverTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function nextEpoch(section: SearchSectionId): number {
    const n = (epochs[section] ?? 0) + 1;
    epochs[section] = n;
    return n;
  }

  function sourceOf(section: SearchSectionId): SearchSource {
    return section === 'posts' ? 'server' : (providerOf(section)?.source ?? 'device');
  }

  /** The limit a section asks for: the overview's 3, or a page of its own once it is the chip. */
  function limitFor(section: SearchSectionId, current: number): number {
    if (focus !== section) return OVERVIEW_LIMIT;
    return Math.max(current, SECTION_PAGE);
  }

  async function runSection(section: Exclude<SearchSectionId, 'posts'>): Promise<void> {
    const provider = providerOf(section);
    const state = sections[section];
    const epoch = nextEpoch(section);
    if (!provider || !isSearchableQuery(query)) {
      sections[section] = idle(limitFor(section, state.limit));
      return;
    }
    const limit = limitFor(section, state.limit);
    sections[section] = { ...state, status: 'loading', limit };
    const asked = query;
    try {
      const answer = await provider.search({ query: asked, limit });
      if (disposed || epochs[section] !== epoch) return;
      sections[section] = {
        status: 'done',
        hits: answer.hits,
        total: answer.total ?? answer.hits.length,
        limit,
      };
    } catch (e) {
      if (disposed || epochs[section] !== epoch) return;
      console.error(`[SEARCH] the ${section} section failed: ${String(e).slice(0, 200)}`);
      sections[section] = { status: 'failed', hits: [], total: 0, limit };
    }
  }

  async function runPosts(): Promise<void> {
    const epoch = nextEpoch('posts');
    const criteria: PostSearchCriteria = {
      q: isSearchableQuery(query) ? query : '',
      authorId: author?.id,
      associationId: association?.id,
    };
    const limit = limitFor('posts', posts.limit);
    if (!hasSearchCriteria(criteria)) {
      Object.assign(posts, idle<PostEntity>(limit));
      return;
    }
    Object.assign(posts, { status: 'loading', limit });
    try {
      const rows = await opts.posts(criteria, { limit });
      if (disposed || epochs.posts !== epoch) return;
      // The server answers a page, never a count: a full page means there may be more.
      Object.assign(posts, { status: 'done', hits: rows, total: rows.length, limit });
    } catch (e) {
      if (disposed || epochs.posts !== epoch) return;
      console.error(`[SEARCH] the posts section failed: ${String(e).slice(0, 200)}`);
      Object.assign(posts, { status: 'failed', hits: [], total: 0, limit });
    }
  }

  function runAll(deviceOnly: boolean): void {
    for (const section of SEARCH_SECTIONS) {
      if (section === 'posts') {
        if (!deviceOnly) void runPosts();
        continue;
      }
      if (deviceOnly && sourceOf(section) === 'server') continue;
      void runSection(section);
    }
  }

  function cancelPacedRun(): void {
    if (serverTimer) clearTimeout(serverTimer);
    serverTimer = null;
  }

  /** Marks the server sections as asked, so the page says "searching" while the pause runs. */
  function markServerSectionsPending(): void {
    if (!isSearchableQuery(query) && !author && !association) return;
    for (const section of SEARCH_SECTIONS) {
      if (sourceOf(section) !== 'server') continue;
      if (section === 'posts') posts.status = 'loading';
      else if (isSearchableQuery(query)) sections[section].status = 'loading';
    }
  }

  return {
    get query() {
      return query;
    },
    get focus() {
      return focus;
    },
    get author() {
      return author;
    },
    get association() {
      return association;
    },
    get sections() {
      return sections;
    },
    get posts() {
      return posts;
    },
    /** Where a section answers from, for the line the page prints under it. */
    sourceOf,
    /** Whether anything is asked: words long enough, or a post filter. */
    get active(): boolean {
      return isSearchableQuery(query) || !!author || !!association;
    },

    /** The words changed: the device sections answer now, the server ones after the pause. */
    setQuery(next: string): void {
      query = next;
      runAll(true);
      cancelPacedRun();
      markServerSectionsPending();
      serverTimer = setTimeout(() => {
        serverTimer = null;
        void runPosts();
        for (const section of SEARCH_SECTIONS) {
          if (section !== 'posts' && sourceOf(section) === 'server') void runSection(section);
        }
      }, SERVER_PACE_MS);
    },

    /** Enter, or the phone's search key: every section now, no pause. */
    submit(): void {
      cancelPacedRun();
      runAll(false);
    },

    /** A chip: one section alone, with a page of its own; `null` is the overview again. */
    setFocus(next: SearchSectionId | null): void {
      if (next === focus) return;
      Log.d('SEARCH', `chip ${next ?? 'all'}`);
      const previous = focus;
      focus = next;
      for (const section of [previous, next]) {
        if (!section) continue;
        if (section === 'posts') void runPosts();
        else void runSection(section);
      }
    },

    /** "Afficher plus" inside a focused section. */
    showMore(section: SearchSectionId): void {
      if (section === 'posts') {
        posts.limit += SECTION_PAGE;
        void runPosts();
        return;
      }
      sections[section].limit += SECTION_PAGE;
      void runSection(section);
    },

    /** The Posts section's person filter; a pick is deliberate, so it runs at once. */
    setAuthor(pick: PostSearchPick | null): void {
      author = pick;
      void runPosts();
    },

    /** The Posts section's association filter, at once like the person. */
    setAssociation(pick: PostSearchPick | null): void {
      association = pick;
      void runPosts();
    },

    /** The Discussions section again: the store changed under an open search. */
    rerunDiscussions(): void {
      if (isSearchableQuery(query)) void runSection('discussions');
    },

    /** Drops a post a card deleted from the answer it is drawn in. */
    removePost(id: string): void {
      posts.hits = posts.hits.filter((p) => p.id !== id);
    },

    /** The search closes: nothing it asked may land afterwards. */
    dispose(): void {
      disposed = true;
      cancelPacedRun();
    },
  };
}

export type UniversalSearch = ReturnType<typeof createUniversalSearch>;
