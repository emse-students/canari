import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A post shared from its sheet: every row shares the post's LINK and nothing else, and "send in
 * the app" goes the road of a share from another app - offered to the picked conversation, which
 * then opens with the link in its composer. Nothing is sent from here.
 */
const landShareOn = vi.fn();
vi.mock('$lib/sharing/shareLanding', () => ({
  landShareOn: (id: string) => landShareOn(id),
}));
const shareTextOut = vi.fn(async (_text: string) => {});
vi.mock('$lib/sharing/shareOut', () => ({
  shareTextOut: (text: string) => shareTextOut(text),
}));
const copyPublicShareLink = vi.fn(async (_path: string) => {});
vi.mock('$lib/utils/copyShareLink', () => ({
  copyPublicShareLink: (path: string) => copyPublicShareLink(path),
}));
const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock('$lib/mobile/sharedInbox', () => ({ discardSharedFiles: async () => {} }));
vi.mock('$lib/utils/publicAppUrl', () => ({
  publicAppUrl: (path: string) => `https://canari.emse.fr${path}`,
}));

const { copyPostLink, postShareUrl, sendPostLinkInApp, sharePostLinkOut } =
  await import('./sharePost');
const { incomingShare } = await import('$lib/stores/incomingShare.svelte');

describe('sharePost', () => {
  beforeEach(() => {
    incomingShare.cancel();
    vi.clearAllMocks();
  });

  it('shares the public link of the post and nothing else', () => {
    expect(postShareUrl('p1')).toBe('https://canari.emse.fr/posts/p1');
  });

  it('sends into a conversation by offering the link to it and opening it - never sending', () => {
    sendPostLinkInApp('p1', 'group-1');
    expect(incomingShare.pending).toEqual({
      text: 'https://canari.emse.fr/posts/p1',
      files: [],
      suggested: null,
    });
    expect(incomingShare.target).toBe('group-1');
    expect(landShareOn).toHaveBeenCalledWith('group-1');
  });

  it('opens the system sheet on the link, and says so when it cannot', async () => {
    shareTextOut.mockRejectedValueOnce(new Error('busy'));
    sharePostLinkOut('p1');
    expect(shareTextOut).toHaveBeenCalledWith('https://canari.emse.fr/posts/p1');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });

  it('copies the link and confirms with a toast', async () => {
    copyPostLink('p1');
    expect(copyPublicShareLink).toHaveBeenCalledWith('/posts/p1');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info'));
  });
});
