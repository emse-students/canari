import { tick } from 'svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';

export type MentionUser = { id: string; displayName: string | null };

/**
 * Composable for @mention autocomplete in text inputs/textareas.
 *
 * @param getText  - Returns the current text value (called on every select).
 * @param setText  - Updates the text value (called with the resolved text on select, and on each input event).
 * @param getEl    - Returns the input/textarea element for cursor positioning after selection.
 */
export function useMentionAutocomplete(opts: {
  getText: () => string;
  setText: (text: string) => void;
  getEl?: () => HTMLTextAreaElement | HTMLInputElement | null;
}) {
  let query = $state('');
  let suggestions = $state<MentionUser[]>([]);
  let open = $state(false);
  let start = $state(-1);
  let selectedIdx = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function search(q: string) {
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data: MentionUser[] = await res.json();
        suggestions = data.slice(0, 6);
        open = suggestions.length > 0;
        selectedIdx = -1;
      }
    } catch {
      suggestions = [];
      open = false;
    }
  }

  /** Call from `oninput` on the text element. Updates the text via setText and triggers autocomplete. */
  function handleInput(e: Event) {
    const el = e.target as HTMLTextAreaElement | HTMLInputElement;
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;
    opts.setText(val);
    const textBeforeCursor = val.slice(0, cursor);
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
    }
  }

  /** Replaces the @query token with the selected user's display name. */
  function select(user: MentionUser) {
    const displayName = user.displayName || user.id;
    const savedStart = start;
    const text = opts.getText();
    const before = text.slice(0, savedStart);
    const after = text.slice(savedStart + 1 + query.length);
    const newText = `${before}@${displayName} ${after}`;
    const newCursor = before.length + displayName.length + 2;
    opts.setText(newText);
    open = false;
    suggestions = [];
    query = '';
    start = -1;
    void tick().then(() => {
      const el = opts.getEl?.();
      if (el) {
        el.focus();
        el.setSelectionRange(newCursor, newCursor);
      }
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
    select,
    handleKeydown,
  };
}
