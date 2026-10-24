// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Conversation } from '$lib/types';

/**
 * The share sheet as Instagram draws it: the conversations newest first, a tap sends the post's
 * link into one, and the bottom row copies the link or opens the system sheet - the latter only
 * where one exists. Every row closes the sheet.
 */
const sendPostLinkInApp = vi.fn();
const copyPostLink = vi.fn();
const sharePostLinkOut = vi.fn();
vi.mock('$lib/posts/sharePost', () => ({
  sendPostLinkInApp: (...a: unknown[]) => sendPostLinkInApp(...a),
  copyPostLink: (...a: unknown[]) => copyPostLink(...a),
  sharePostLinkOut: (...a: unknown[]) => sharePostLinkOut(...a),
}));

let native = false;
vi.mock('$lib/sharing/shareOut', () => ({ canShareOut: () => native }));
vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: async () => null,
  getUserDisplayNameSync: (_id: string, fallback: string) => fallback,
}));

function convo(id: string, name: string, at: number): [string, Conversation] {
  return [
    id,
    {
      id,
      name,
      contactName: name,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: 'group',
      lastMessageAt: at,
    } as unknown as Conversation,
  ];
}

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalConvs: { conversations: new Map([convo('g-old', 'Old', 1), convo('g-new', 'New', 9)]) },
  globalSession: { userId: '11111111-1111-4111-8111-111111111111' },
  globalChannels: { channelWorkspaces: [] },
}));

const { default: PostShareSheet } = await import('./PostShareSheet.svelte');

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  native = false;
});

function open(onClose = vi.fn()) {
  const instance = mount(PostShareSheet, {
    target: document.body,
    props: { open: true, postId: 'p1', onClose },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return onClose;
}

function cellNames(): string[] {
  return [...document.querySelectorAll('[data-share-grid] li button')].map(
    (b) => b.getAttribute('aria-label') ?? ''
  );
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

describe('PostShareSheet', () => {
  it('lists the conversations newest first', () => {
    open();
    expect(cellNames()).toEqual(['Envoyer à New', 'Envoyer à Old']);
  });

  it('sends the post into the tapped conversation and closes', () => {
    const onClose = open();
    button('New').click();
    expect(onClose).toHaveBeenCalled();
    expect(sendPostLinkInApp).toHaveBeenCalledWith('p1', 'g-new');
  });

  it('copies the link from the bottom row', () => {
    const onClose = open();
    button('Copier le lien').click();
    expect(copyPostLink).toHaveBeenCalledWith('p1');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers the system sheet only where there is one', () => {
    open();
    expect(document.body.textContent).not.toContain('Partager via');
    mounted.pop()!();
    document.body.innerHTML = '';
    native = true;
    open();
    button('Partager via').click();
    expect(sharePostLinkOut).toHaveBeenCalledWith('p1');
  });
});
