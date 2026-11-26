// @vitest-environment happy-dom
/**
 * A PAGE MAY OPEN THE NEW-DISCUSSION PANEL WITH PEOPLE ALREADY CHOSEN (a form's respondents): the
 * chips hold them, the footer counts them, and every opening starts from the prop, not from the
 * previous selection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SidebarNewChatModal from './SidebarNewChatModal.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(initialMembers: { id: string; name: string }[]) {
  const instance = mount(SidebarNewChatModal, {
    target: document.body,
    props: {
      open: true,
      currentUserId: 'me',
      initialMembers,
      onClose: () => {},
      onStartDirect: () => {},
      onCreateGroup: () => {},
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
}

describe('SidebarNewChatModal - initialMembers', () => {
  it('opens with the people a page chose, as chips, and offers the group', () => {
    render([
      { id: 'u1', name: 'Ada Lovelace' },
      { id: 'u2', name: 'Alan Turing' },
    ]);
    const chips = document.querySelector('[data-testid="new-chat-chips"]');
    expect(chips?.textContent).toContain('Ada Lovelace');
    expect(chips?.textContent).toContain('Alan Turing');
    expect(document.querySelector('[data-testid="new-chat-proceed"]')?.textContent).toContain('2');
  });

  it('opens empty when no page chose anyone', () => {
    render([]);
    expect(document.querySelector('[data-testid="new-chat-chips"]')).toBeNull();
  });
});
