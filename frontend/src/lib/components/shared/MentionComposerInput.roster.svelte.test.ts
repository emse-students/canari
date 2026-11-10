// @vitest-environment happy-dom
/**
 * A ROSTER-BACKED PICKER OPENS WITHOUT LOOPING. `suggestLocally` used to write `suggestions` and then read
 * it back to set `open`, inside the effect that follows the roster prop: the effect depended on the
 * array it replaced on every run, so the first `@` ended in `effect_update_depth_exceeded`. Found by the
 * live chat's composer (owner, 2026-11-09), the first mounted test of this component with a roster.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MentionComposerInput from './MentionComposerInput.svelte';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Bob',
  peekUserDisplayName: () => 'Bob',
  resolveUserDisplayName: async () => 'Bob',
  resolveDisplayNames: async () => {},
  seedUserDisplayName: () => {},
}));
vi.mock('$lib/users/blocks', () => ({ listBlockedUsers: async () => [] }));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => [] })),
}));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'a'.repeat(64) }));

afterEach(() => {
  document.body.innerHTML = '';
});

it('opens on a bare @ from a static roster, and stops there', () => {
  const target = document.createElement('div');
  document.body.append(target);
  const roster = [{ id: 'b'.repeat(64) }];
  const app = mount(MentionComposerInput, {
    target,
    props: { mentionRoster: roster, singleLine: true },
  });
  flushSync();
  const editor = target.querySelector<HTMLElement>('[role="textbox"]')!;
  editor.textContent = '@';
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
  expect(target.querySelectorAll('[data-mention-suggestion]').length).toBe(1);
  unmount(app);
});
