import { tick } from 'svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { formatMentionToken } from '$lib/utils/mentions';
import { currentUserId } from '$lib/stores/userState.svelte';
import { filterUserSuggestions } from '$lib/utils/users/suggestionFilter';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

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
  /** When set, only users whose IDs are in this list appear in suggestions. */
  allowedUserIds?: string[];
}) {
  let query = $state('');
  let suggestions = $state<MentionUser[]>([]);
  let open = $state(false);
  let start = $state(-1);
  let selectedIdx = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
        const allowed = opts.allowedUserIds;
        const me = currentUserId();
        suggestions = filterUserSuggestions(data, {
          excludeIds: me ? [me] : [],
          // AN EMPTY ALLOWLIST MEANS "NO RESTRICTION" HERE, WHICH IS THE OPPOSITE OF WHAT
          // `filterUserSuggestions` DOES WITH ONE - it would offer nobody. The array is a channel's
          // member list or a group's roster, and it is legitimately empty before that list has
          // loaded, so the two readings differ exactly while a reader is typing into a
          // conversation that has not settled. Passing it only when non-empty keeps the reading
          // this composable has always had.
          ...(allowed && allowed.length > 0 ? { filterUserIds: allowed } : {}),
        }).slice(0, 6);
        open = suggestions.length > 0;
        selectedIdx = -1;
      }
    } catch {
      suggestions = [];
      open = false;
    }
  }

  function detectMentionAtCursor(text: string, cursor: number) {
    const textBeforeCursor = text.slice(0, cursor);
    const m = textBeforeCursor.match(/@([\wÀ-ž]*)$/);
    if (m && m[1].length > 0) {
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
    select,
    handleKeydown,
  };
}
