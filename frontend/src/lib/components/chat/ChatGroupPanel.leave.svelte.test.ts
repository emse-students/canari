/**
 * A DIRECT MESSAGE HAS NO GROUP TO LEAVE.
 *
 * The info sheet of a two-person conversation read "Quitter le groupe" (Mi 9T reading, 2026-10-05):
 * the footer offered the leave button whenever a leave handler was wired, and the parent wires it
 * for every conversation. The button now also requires `isGroupConversation`; a DM keeps its
 * delete button.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));

import ChatGroupPanel from './ChatGroupPanel.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render(isGroupConversation: boolean) {
  const c = mount(ChatGroupPanel, {
    target: document.body,
    props: {
      effectiveDisplayName: 'Peer',
      contactName: 'peer',
      isGroupConversation,
      currentUserId: 'me',
      groupMembers: ['me', 'peer'],
      onClose: () => {},
      onGroupLeave: () => {},
      onGroupDelete: () => {},
    },
  });
  mounted.push(() => void unmount(c));
  await tick();
  flushSync();
}

const hasButton = (text: string) =>
  [...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes(text));

describe('ChatGroupPanel leave button', () => {
  it('is offered on a group of two members', async () => {
    await render(true);
    expect(hasButton(m.chat_group_leave_button())).toBe(true);
  });

  it('is not offered on a direct message, which keeps its delete button', async () => {
    await render(false);
    expect(hasButton(m.chat_group_leave_button())).toBe(false);
    expect(hasButton(m.chat_group_delete_dm_button())).toBe(true);
  });
});
