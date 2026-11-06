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
  MENTION_MAX_ROWS,
  suggestFromRoster,
  type MentionRosterMember,
} from '$lib/utils/users/mentionRoster';
import { listBlockedUsers } from '$lib/users/blocks';
import { Log } from '$lib/utils/Log';

export type MentionUser = { id: string; displayName: string | null };

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
}) {
  let query = $state('');
  let suggestions = $state<MentionUser[]>([]);
  let open = $state(false);
  let start = $state(-1);
  let selectedIdx = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
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
  async function search(q: string) {
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data: MentionUser[] = await res.json();
        const me = currentUserId();
        suggestions = filterUserSuggestions(data, {
          excludeIds: me ? [me] : [],
        }).slice(0, MENTION_MAX_ROWS);
        open = suggestions.length > 0;
        selectedIdx = -1;
      }
    } catch {
      suggestions = [];
      open = false;
    }
  }

  /**
   * Suggests from the conversation's own members, with no request.
   *
   * The server search only returned the school's top 10 matches, so with one letter a member of a
   * small group was almost never among them and "@M" proposed nobody. The members are already on
   * the client, so the roster is filtered here. The reader is never offered (see {@link search}),
   * nor an account the reader blocked: the server hides blocked accounts from every picker, and a
   * group formed before the block still lists them. The reverse direction (someone who blocked the
   * reader) is not known to the client and stays offered.
   */
  function suggestLocally(roster: MentionRosterMember[]) {
    const me = currentUserId();
    suggestions = suggestFromRoster(roster, query, {
      excludeIds: [...(me ? [me] : []), ...(blockedIds ?? [])],
      resolveName: peekUserDisplayName,
      onUnnamed: (id) => {
        if (droppedLogged.has(id)) return;
        droppedLogged.add(id);
        console.warn(`[mention] member ${id.slice(0, 8)} has no known name and is not offered`);
      },
    }).slice(0, MENTION_MAX_ROWS);
    open = suggestions.length > 0;
    selectedIdx = -1;
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
    if ((unnamed.length > 0 || blocksChanged) && start >= 0 && opts.roster === roster) {
      suggestLocally(roster);
    }
  }

  /**
   * Call when the roster prop changes (a member list that finished loading, a conversation switch):
   * an open picker re-reads it instead of keeping the rows of the roster it opened on.
   */
  function refreshRoster() {
    const roster = opts.roster;
    if (start < 0 || !roster || roster.length === 0) return;
    suggestLocally(roster);
    void prepareRoster(roster);
  }

  function detectMentionAtCursor(text: string, cursor: number) {
    const textBeforeCursor = text.slice(0, cursor);
    const m = textBeforeCursor.match(/@([\wÀ-ž]*)$/);
    const roster = opts.roster;
    if (m && roster && roster.length > 0) {
      start = cursor - m[0].length;
      query = m[1];
      if (debounceTimer) clearTimeout(debounceTimer);
      suggestLocally(roster);
      void prepareRoster(roster);
    } else if (m && m[1].length > 0) {
      if (roster) Log.d('[mention] roster not loaded, falling back to the server search');
      start = cursor - m[0].length;
      query = m[1];
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void search(query), 250);
    } else {
      open = false;
      suggestions = [];
      query = '';
      start = -1;
    }
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
    open = false;
    suggestions = [];
    query = '';
    start = -1;
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
      open = false;
      suggestions = [];
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
  };
}
