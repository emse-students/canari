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
const repostToMyFollowers = vi.fn(async (_id: string) => true);
const undoMyRepost = vi.fn(async (_id: string) => false);
vi.mock('$lib/posts/sharePost', () => ({
  sendPostLinkInApp: (...a: unknown[]) => sendPostLinkInApp(...a),
  copyPostLink: (...a: unknown[]) => copyPostLink(...a),
  sharePostLinkOut: (...a: unknown[]) => sharePostLinkOut(...a),
  repostToMyFollowers: (id: string) => repostToMyFollowers(id),
  undoMyRepost: (id: string) => undoMyRepost(id),
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

function open(onClose = vi.fn(), onSentInApp?: () => void) {
  const instance = mount(PostShareSheet, {
    target: document.body,
    props: { open: true, postId: 'p1', onClose, onSentInApp },
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

describe('PostShareSheet - the member repost row (WP-F6)', () => {
  function openWith(props: Record<string, unknown>) {
    const instance = mount(PostShareSheet, {
      target: document.body,
      props: { open: true, postId: 'p1', onClose: vi.fn(), ...props },
    });
    mounted.push(() => unmount(instance));
    flushSync();
  }

  it('is not drawn when the server offers no repost', () => {
    openWith({});
    expect(document.querySelector('[data-repost-row]')).toBeNull();
  });

  it('reposts, and hands the host the answer', async () => {
    const onRepostChange = vi.fn();
    openWith({ canRepost: true, onRepostChange });
    button('Republier pour mes abonnés').click();
    expect(repostToMyFollowers).toHaveBeenCalledWith('p1');
    await vi.waitFor(() => expect(onRepostChange).toHaveBeenCalledWith('p1', true));
  });

  it('takes a repost back when the reader reposted it', async () => {
    const onRepostChange = vi.fn();
    openWith({ repostedByMe: true, onRepostChange });
    button('Annuler ma republication').click();
    expect(undoMyRepost).toHaveBeenCalledWith('p1');
    await vi.waitFor(() => expect(onRepostChange).toHaveBeenCalledWith('p1', false));
  });
});

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

  it('says the link was sent in the app only when its landing was published', () => {
    const onSentInApp = vi.fn();
    sendPostLinkInApp.mockReturnValueOnce(false);
    open(vi.fn(), onSentInApp);
    button('New').click();
    expect(onSentInApp).not.toHaveBeenCalled();
    sendPostLinkInApp.mockReturnValueOnce(true);
    button('Old').click();
    expect(onSentInApp).toHaveBeenCalledOnce();
  });

  it('copies the link from the bottom row', () => {
    const onClose = open();
    button('Copier le lien').click();
    expect(copyPostLink).toHaveBeenCalledWith('p1');
    expect(onClose).toHaveBeenCalled();
  });

  it('acts on its post even when closing it clears the id it was given (the reel viewer)', () => {
    // The reel viewer passes `postId={shareFor}` and closes with `shareFor = null`: a row that
    // read `postId` after the close acted on null and did nothing (Mi 9T, 2026-10-28).
    native = true;
    const props = $state({
      open: true,
      postId: 'p1' as string,
      onClose: () => {
        props.postId = null as unknown as string;
      },
    });
    const instance = mount(PostShareSheet, { target: document.body, props });
    mounted.push(() => unmount(instance));
    flushSync();
    button('New').click();
    expect(sendPostLinkInApp).toHaveBeenCalledWith('p1', 'g-new');
    props.postId = 'p1';
    flushSync();
    button('Copier le lien').click();
    expect(copyPostLink).toHaveBeenCalledWith('p1');
    props.postId = 'p1';
    flushSync();
    button('Partager via').click();
    expect(sharePostLinkOut).toHaveBeenCalledWith('p1');
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
