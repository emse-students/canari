import { tick } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { formatMentionToken } from '$lib/utils/mentions';
import { currentUserId } from '$lib/stores/userState.svelte';
import { filterUserSuggestions } from '$lib/utils/users/suggestionFilter';
import {
  peekUserDisplayName,
  resolveDisplayNames,
  seedUserDisplayName,
} from '$lib/utils/users/displayName';
import {
  findMentionQuery,
  foldedWords,
  MENTION_MAX_ROWS,
  MentionNameIndex,
  suggestFromRoster,
  wordsMatchQuery,
  type MentionRosterMember,
} from '$lib/utils/users/mentionRoster';
import { listBlockedUsers } from '$lib/users/blocks';
import { Log } from '$lib/utils/Log';

export type MentionUser = { id: string; displayName: string | null };

/** One name search: `search` fills the list (no roster), `more` tops a roster's rows up (a live). */
type SearchRequest = { q: string; kind: 'search' | 'more'; generation: number };

/** {@link membersKey} per roster array: a roster is keyed once, never once per keystroke. */
const membersKeys = new WeakMap<readonly MentionRosterMember[], string>();

/**
 * Who a roster holds, as a set (sorted ids) - never the array holding them nor their order: the live
 * chat rebuilds and reorders its roster on every line (`liveMentionRoster`), and neither makes the
 * name index's members other ones. Cached per array, so a 5,000-member roster is keyed once.
 */
function membersKey(roster: readonly MentionRosterMember[] | undefined): string {
  if (!roster) return '';
  let key = membersKeys.get(roster);
  if (key === undefined) {
    key = roster
      .map((m) => m.id.toLowerCase())
      .sort()
      .join(',');
    membersKeys.set(roster, key);
  }
  return key;
}

/** Whether a query holds a space, i.e. names more than one word. */
function hasSpace(q: string): boolean {
  return /\s/.test(q);
}

/**
 * ONE MEANING OF "MATCHES" FOR A QUERY OF SEVERAL WORDS (review of #3402). The directory search ANDs
 * SUBSTRINGS, so "@Jean je le" or "@Marie et toi" - a sentence, not a name - still found Jean and
 * Marie, the picker stayed open, Enter was swallowed and Tab inserted a mention nobody chose. A
 * multi-word answer is therefore held to the roster's own rule (every word starts a different word
 * of the name, `wordsMatchQuery`) before it may keep a mention open. One word keeps the server's
 * reading: it is a name being typed, and its fuzzy match is what makes a typo forgivable.
 */
function matchingWholeQuery<T extends MentionUser>(rows: readonly T[], q: string): T[] {
  if (!hasSpace(q.trim())) return [...rows];
  const words = foldedWords(q);
  return rows.filter((u) => !!u.displayName && wordsMatchQuery(foldedWords(u.displayName), words));
}

/**
 * Composable for @mention autocomplete in text inputs or mention editors.
 *
 * Provide either classic input/textarea callbacks (`getEl` + selection from event)
 * or editor callbacks (`getCursor` / `setCursor`) for contenteditable surfaces.
 */
export function useMentionAutocomplete(opts: {
  getText: () => string;
  setText: (text: string, cursor?: number) => void;
  getEl?: () => HTMLTextAreaElement | HTMLInputElement | null;
  getCursor?: () => number;
  setCursor?: (pos: number) => void;
  focus?: () => void;
  /**
   * The conversation's members. When non-empty the picker suggests from them LOCALLY (no request,
   * no debounce) and a bare `@` opens the list. Absent or empty - posts and comments, or a roster
   * still loading - it falls back to the server search over the whole directory.
   */
  roster?: MentionRosterMember[];
  /**
   * Narrows the accounts a NAME SEARCH found to those a mention here may reach (a live's audience,
   * owner 2026-11-09). Applied to the server search - the whole directory - never to the roster,
   * whose members are in the conversation already. With a roster it ALSO tops the roster's rows up
   * from that search, once a name is being typed. Absent: the search is unfiltered, as before.
   */
  audienceFilter?: (users: MentionUser[]) => Promise<MentionUser[]>;
}) {
  let query = $state('');
  let suggestions = $state<MentionUser[]>([]);
  let open = $state(false);
  let start = $state(-1);
  let selectedIdx = $state(-1);
  /** The picker's folded names, kept for its whole life: a keystroke folds nothing it already has. */
  const nameIndex = new MentionNameIndex();
  /**
   * A mention the reader gave up on - Escape, or a query with a space that matched nobody (the text
   * after the `@` is plain text then). Typing on at the same `@` keeps it closed and asks nothing;
   * editing it back to something it no longer extends revives it. `by` says which: only an end the
   * FACTS decided (`no-match`) may be undone by new facts - an Escape is the reader's own word, and
   * a roster batch landing afterwards never reopens over it (review of #3402).
   */
  let ended: { start: number; query: string; by: 'no-match' | 'reader' } | null = null;
  /**
   * Bumped by every change of the mention (a keystroke in it, its end). A server answer is applied
   * only if nothing changed since its request - a SEQUENCE, so an answer that arrives late, or out of
   * order, is dropped whatever the network's timing was.
   */
  let generation = 0;
  /** True while a name search is in flight: there is never more than one. */
  let searching = false;
  /** The latest search asked for while one was in flight; the ones it replaced are never sent. */
  let waiting: SearchRequest | null = null;
  /** The members ({@link membersKey}) the name index was last pruned to (see `suggestLocally`). */
  let indexedKey: string | null = null;
  /** The roster array `refreshRoster` last re-read. */
  let refreshedRoster: MentionRosterMember[] | undefined = opts.roster;
  /** The ids of the rows a `more` answer added to this mention's list (see `suggestLocally`). */
  let topUpIds = new Set<string>();
  /** A search failed and none has answered since (see `runSearch`). */
  let searchFailing = false;
  /** Set by `dispose`: nothing on its way may write to a picker whose composer is gone. */
  let disposed = false;
  /** Accounts the reader blocked, read once when a roster picker first opens (null = not read). */
  let blockedIds: string[] | null = null;
  /** Member ids whose name this picker already asked for: a roster change asks only for new ones. */
  const namesRequested = new SvelteSet<string>();
  /** Member ids already reported as dropped for lacking a name (one line each, not per keystroke). */
  const droppedLogged = new SvelteSet<string>();

  function applyCursor(pos: number) {
    if (opts.setCursor) {
      opts.setCursor(pos);
      return;
    }
    const el = opts.getEl?.();
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }

  /**
   * Asks the search endpoint, then applies the two rules that decide what a picker may offer.
   *
   * **THE SIGNED-IN READER IS NEVER OFFERED, AND THAT IS A FACT RATHER THAN A HOUSE STYLE
   * (2026-09-24).** Picking yourself inserts a chip, puts your own id on the wire, and then reaches
   * NOTHING on either side: `notifyChannelRecipients` skips `member.userId === input.senderId`
   * before it looks at any notification level, a post comment's notify block seeds
   * `alreadyNotified` with the author, and the client's own `mentionsMe` runs only on an INBOUND
   * frame - which your own message never is, because MLS gives no echo of it. There is also no
   * mentions inbox anywhere in this app, so the "self-mention as a bookmark" that some chat apps
   * offer has no surface here to be found again from. It was a control whose only possible effect
   * was on the text, and offering one is how a reader learns by being ignored what a fact could
   * have told them. `SidebarNewChatModal` and `ChatGroupPanel` already exclude the reader for the
   * same reason; this was the last picker that did not.
   *
   * It reads `currentUserId()` rather than taking the id as an argument because the decision is
   * made HERE and the fact is already known globally - three components would otherwise have to
   * thread a prop through, and any surface added later could forget to.
   */
  function applySearch(req: SearchRequest, found: MentionUser[]) {
    const me = currentUserId();
    suggestions = matchingWholeQuery(
      filterUserSuggestions(found, { excludeIds: me ? [me] : [] }),
      req.q
    ).slice(0, MENTION_MAX_ROWS);
    open = suggestions.length > 0;
    selectedIdx = -1;
    Log.d(`[mention] search answer applied: ${suggestions.length} row(s) of ${found.length}`);
    if (!open && hasSpace(req.q)) endMention('no account matches the words typed', 'no-match');
  }

  /**
   * Asks the directory for `q`, ONE REQUEST AT A TIME AND NO TIMER (owner, 2026-11-12: the `@` was
   * slow on the posts page). It used to wait 250 ms after each key, then send; every key paid that
   * wait and a slow answer could still land after a newer one. Now a key sends at once when nothing
   * is in flight; otherwise its query waits, replacing any query that was waiting, and goes when the
   * answer comes back. So a burst of keys costs at most two requests, and the answer applied is the
   * one asked for the mention as it stands ({@link generation}).
   */
  function requestSearch(q: string, kind: SearchRequest['kind']) {
    const req: SearchRequest = { q, kind, generation };
    if (searching) {
      Log.d(
        `[mention] a search is in flight - this ${kind} query waits${waiting ? ', replacing the one that was waiting' : ''}`
      );
      waiting = req;
      return;
    }
    Log.d(`[mention] ${kind} search sent (${q.length} char(s))`);
    void runSearch(req);
  }

  async function runSearch(req: SearchRequest) {
    searching = true;
    let found: MentionUser[] | null = null;
    try {
      found = await searchDirectory(req.q, req.kind);
    } catch (e) {
      noteSearchFailure(req.kind, e);
    }
    if (found) searchFailing = false;
    searching = false;
    if (disposed) {
      Log.d('[mention] a search answer arrived after the picker was destroyed - dropped');
      return;
    }
    if (req.generation !== generation) {
      Log.d('[mention] a search answer for an earlier query dropped');
    } else if (req.kind === 'more') {
      if (found) applyMore(req, found);
    } else if (found) {
      applySearch(req, found);
    } else {
      suggestions = [];
      open = false;
    }
    const next = waiting;
    waiting = null;
    if (!next) return;
    if (next.generation !== generation) {
      Log.d('[mention] the waiting query was overtaken - not sent');
      return;
    }
    Log.d(`[mention] the waiting ${next.kind} query sent (${next.q.length} char(s))`);
    void runSearch(next);
  }

  /**
   * A search that got no answer - a transport failure or a status that is not 2xx. ONE LINE PER
   * OUTAGE, not one per key typed while it lasts: the next answer re-arms it.
   */
  function noteSearchFailure(kind: SearchRequest['kind'], why: unknown) {
    if (!searchFailing) console.warn(`[mention] the name search failed (${kind})`, why);
    else Log.d(`[mention] the name search still fails (${kind})`);
    searchFailing = true;
  }

  /** The directory search, then `audienceFilter`; null when the server did not answer 2xx. */
  async function searchDirectory(
    q: string,
    kind: SearchRequest['kind']
  ): Promise<MentionUser[] | null> {
    const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      noteSearchFailure(kind, `HTTP ${res.status}`);
      return null;
    }
    const data: MentionUser[] = await res.json();
    return opts.audienceFilter ? opts.audienceFilter(data) : data;
  }

  /**
   * Tops the roster's rows up with accounts of the directory the audience filter let through - the
   * live chat's "first the people who are here, then anyone who may see it". Rows already offered
   * stay first and are never repeated; a stale answer (the query moved on) is dropped.
   */
  function applyMore(req: SearchRequest, found: MentionUser[]) {
    const me = currentUserId();
    const have = suggestions.map((u) => u.id.toLowerCase());
    const extra = filterUserSuggestions(found, {
      excludeIds: [...(me ? [me] : []), ...have, ...(blockedIds ?? [])],
    });
    const added = matchingWholeQuery(extra, req.q);
    const merged = [...suggestions, ...added].slice(0, MENTION_MAX_ROWS);
    for (const u of added) topUpIds.add(u.id.toLowerCase());
    suggestions = merged;
    open = merged.length > 0;
    if (!open && hasSpace(req.q)) endMention('nobody here or in the audience matches', 'no-match');
  }

  /**
   * Suggests from the conversation's own members, with no request.
   *
   * The server search only returned the school's top 10 matches, so with one letter a member of a
   * small group was almost never among them and "@M" proposed nobody. The members are already on
   * the client, so the roster is filtered here. The reader is never offered (see {@link applySearch}),
   * nor an account the reader blocked: the server hides blocked accounts from every picker, and a
   * group formed before the block still lists them. The reverse direction (someone who blocked the
   * reader) is not known to the client and stays offered.
   */
  function suggestLocally(roster: MentionRosterMember[]) {
    const key = membersKey(roster);
    if (key !== indexedKey) {
      // Other members (a list that finished loading, another conversation): the index keeps only
      // them, so it never grows with every conversation the composer has shown.
      indexedKey = key;
      nameIndex.retain(roster.map((m) => m.id.toLowerCase()));
    }
    const me = currentUserId();
    const offered = suggestFromRoster(roster, query, {
      excludeIds: [...(me ? [me] : []), ...(blockedIds ?? [])],
      resolveName: peekUserDisplayName,
      onUnnamed: (id) => {
        if (droppedLogged.has(id)) return;
        droppedLogged.add(id);
        console.warn(`[mention] member ${id.slice(0, 8)} has no known name and is not offered`);
      },
      index: nameIndex,
      limit: MENTION_MAX_ROWS,
    });
    // THE ROWS A `more` ANSWER ADDED, AND THE ROW THE READER SELECTED, OUTLIVE A ROSTER CHANGE (review
    // of #3402): a live chat re-sends its roster on every line, and re-reading it used to wipe the
    // audience top-up and the arrow-key selection under the reader's fingers.
    const selectedId = selectedIdx >= 0 ? suggestions[selectedIdx]?.id.toLowerCase() : undefined;
    const offeredIds = new Set(offered.map((u) => u.id.toLowerCase()));
    const kept = suggestions.filter(
      (u) => topUpIds.has(u.id.toLowerCase()) && !offeredIds.has(u.id.toLowerCase())
    );
    const rows = [...offered, ...kept].slice(0, MENTION_MAX_ROWS);
    suggestions = rows;
    open = rows.length > 0;
    selectedIdx = selectedId ? rows.findIndex((u) => u.id.toLowerCase() === selectedId) : -1;
  }

  /**
   * Prepares a roster for the picker, PER ROSTER: asks once for the names of members it has not
   * asked for yet (one batch, never per keystroke) and reads the reader's blocks (a cached read,
   * dropped on block and unblock). The composer outlives a conversation switch, so a once-per-picker
   * flag would leave every later conversation's unnamed members unresolved and silently dropped.
   * Re-filters the current query when either answer changed what may be offered.
   */
  async function prepareRoster(roster: MentionRosterMember[]) {
    const unnamed = roster.filter(
      (r) =>
        !r.displayName?.trim() &&
        !peekUserDisplayName(r.id) &&
        !namesRequested.has(r.id.toLowerCase())
    );
    for (const r of unnamed) namesRequested.add(r.id.toLowerCase());
    if (unnamed.length > 0) {
      Log.d('[mention] resolving roster names', {
        members: roster.length,
        unnamed: unnamed.length,
      });
    }
    const [blocks] = await Promise.all([
      listBlockedUsers().catch((e) => {
        console.warn('[mention] blocked list unreadable, blocked accounts stay offered', e);
        return [];
      }),
      unnamed.length > 0
        ? resolveDisplayNames(unnamed.map((r) => r.id)).catch((e) => {
            console.warn('[mention] roster names unresolved', e);
          })
        : Promise.resolve(),
    ]);
    const next = blocks.map((b) => b.userId);
    const blocksChanged = next.join(',') !== (blockedIds ?? []).join(',');
    blockedIds = next;
    if (
      disposed ||
      !(unnamed.length > 0 || blocksChanged) ||
      (opts.roster !== roster && membersKey(opts.roster) !== membersKey(roster))
    )
      return;
    if (start >= 0) {
      suggestLocally(roster);
    } else if (ended?.by === 'no-match' && unnamed.length > 0) {
      // A MENTION ENDED WHILE ITS NAMES WERE STILL ON THEIR WAY (review of #3402): on a slow link
      // "@Camille " can be typed before the batch names Camille, and the space found nobody. The
      // names that just landed are a new fact, so the end is undone and the caret read again.
      Log.d('[mention] roster names landed after a mention ended - reading the caret again');
      ended = null;
      const text = opts.getText();
      detectMentionAtCursor(text, readCursor(text));
    }
  }

  /** Where the caret is, from whichever surface this picker serves. */
  function readCursor(text: string): number {
    if (opts.getCursor) return opts.getCursor();
    return opts.getEl?.()?.selectionStart ?? text.length;
  }

  /**
   * Call when the roster prop changes (a member list that finished loading, a live chat's new line):
   * an open picker re-reads it instead of keeping the rows of the roster it opened on.
   *
   * NOTHING ON ITS WAY IS DROPPED (review of #3402). A search asks the directory for the TEXT typed,
   * which a roster does not change, and a `more` answer is merged against the rows on screen when it
   * lands. Dropping them on a roster change starved a busy live: each line can add, drop or reorder
   * an author, so the waiting query was cleared on every line and the audience top-up never landed.
   * A conversation switch changes the text, and the keystroke that follows makes answers stale.
   */
  function refreshRoster() {
    const roster = opts.roster;
    if (roster === refreshedRoster) return;
    refreshedRoster = roster;
    if (start < 0 || !roster || roster.length === 0) return;
    suggestLocally(roster);
    void prepareRoster(roster);
  }

  /**
   * Reads the mention at the caret and updates the picker.
   *
   * The query may hold spaces, so "@Jean Dup" is still a mention (see `findMentionQuery`). It stays
   * one for as long as somebody matches the WHOLE query: a space that leaves nobody ends it, and the
   * text is plain text from there ({@link ended}). With a roster that is known at once; without one,
   * from the search's answer.
   */
  function detectMentionAtCursor(text: string, cursor: number) {
    const found = findMentionQuery(text.slice(0, cursor));
    if (!found) {
      ended = null;
      if (start >= 0 || open) closeMention();
      return;
    }
    if (ended && found.start === ended.start && found.query.startsWith(ended.query)) {
      // Still the mention the reader gave up on, typed further: plain text, nothing asked.
      if (start >= 0 || open) closeMention();
      return;
    }
    ended = null;
    if (found.start === start && found.query === query) return;
    generation += 1;
    topUpIds = new Set();
    start = found.start;
    query = found.query;
    const roster = opts.roster;
    if (roster && roster.length > 0) {
      suggestLocally(roster);
      void prepareRoster(roster);
      if (opts.audienceFilter && query.length > 0) requestSearch(query, 'more');
      else if (!open && hasSpace(query))
        endMention('no member matches the words typed', 'no-match');
    } else if (query.length > 0) {
      if (roster) Log.d('[mention] roster not loaded, falling back to the server search');
      // The rows on screen answer an earlier query: hidden until this one's answer, so Enter or Tab
      // can never pick a row that no longer matches what is typed.
      open = false;
      suggestions = [];
      selectedIdx = -1;
      requestSearch(query, 'search');
    } else {
      // A bare `@` with no roster: nothing to search for yet, but the mention has begun.
      open = false;
      suggestions = [];
    }
  }

  /** Closes the picker and forgets the mention; any answer still on its way is dropped. */
  function closeMention() {
    generation += 1;
    waiting = null;
    topUpIds = new Set();
    open = false;
    suggestions = [];
    query = '';
    start = -1;
  }

  /** The reader gave up on this mention (see {@link ended}); `why` is logged. */
  function endMention(why: string, by: 'no-match' | 'reader') {
    Log.d(`[mention] mention closed: ${why}`);
    ended = { start, query, by };
    closeMention();
  }

  /**
   * Call when the composer is destroyed: an answer still on its way (a search, the roster's names)
   * lands on a picker nobody sees, so it is dropped and said so rather than applied.
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    if (searching || waiting) {
      Log.d(
        `[mention] picker destroyed with a search in flight${waiting ? ' and one waiting' : ''} - their answers will be dropped`
      );
    }
    waiting = null;
  }

  /** Call from `oninput` on a textarea/input. */
  function handleInput(e: Event) {
    const el = e.target as HTMLTextAreaElement | HTMLInputElement;
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;
    opts.setText(val);
    detectMentionAtCursor(val, cursor);
  }

  /** Call after a contenteditable mention editor updates its plain-text value. */
  function handleEditorInput(text: string, cursor: number) {
    detectMentionAtCursor(text, cursor);
  }

  /** Replaces the @query token with a stable `@[userId]` mention token. */
  function select(user: MentionUser) {
    if (start < 0) return;
    // The picked row CARRIES the name, and the editor is about to re-render the token through the
    // display-name cache. Seeding it here is what makes that read a hit: without it the composer
    // painted whatever the cache had for a user it had never looked up, which was visibly not the
    // name for as long as the round trip took. Never learn by failing what a fact could have told
    // you - and this fact is already in hand.
    if (user.displayName?.trim()) seedUserDisplayName(user.id, user.displayName.trim());
    const token = formatMentionToken(user.id);
    const text = opts.getText();
    const before = text.slice(0, start);
    const after = text.slice(start + 1 + query.length);
    const newText = `${before}${token} `;
    const newCursor = before.length + token.length + 1;
    opts.setText(newText + after, newCursor);
    closeMention();
    void tick().then(() => {
      opts.focus?.();
      applyCursor(newCursor);
    });
  }

  /**
   * Call from `onkeydown` on the text element.
   * Returns true if the event was consumed (caller should return early).
   */
  function handleKeydown(e: KeyboardEvent): boolean {
    if (!open || suggestions.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, suggestions.length - 1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, -1);
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0) select(suggestions[selectedIdx]);
      return true;
    }
    // Tab completes like a click: the highlighted row, else the first. Shift+Tab, a modified Tab and
    // a Tab pressed during IME composition keep the browser's own focus movement. A closed or
    // empty list never reaches here (guard above), so Tab keeps its normal behaviour there.
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      select(suggestions[selectedIdx >= 0 ? selectedIdx : 0]);
      return true;
    }
    if (e.key === 'Escape') {
      endMention('Escape', 'reader');
      return true;
    }
    return false;
  }

  return {
    get open() {
      return open;
    },
    get suggestions() {
      return suggestions;
    },
    get selectedIdx() {
      return selectedIdx;
    },
    handleInput,
    handleEditorInput,
    refreshRoster,
    select,
    handleKeydown,
    dispose,
  };
}
