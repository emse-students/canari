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
vi.mock('$lib/sharing/shareOut', async () => {
  // The real `runShareOut` (the toast on failure) over a mocked sheet.
  const actual =
    await vi.importActual<typeof import('$lib/sharing/shareOut')>('$lib/sharing/shareOut');
  return { ...actual, shareTextOut: (text: string) => shareTextOut(text) };
});
const copyPublicShareLink = vi.fn(async (_path: string) => {});
vi.mock('$lib/utils/copyShareLink', () => ({
  copyPublicShareLink: (path: string) => copyPublicShareLink(path),
}));
const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock('$lib/mobile/sharedInbox', () => ({ discardSharedFiles: async () => {} }));
const repostToFollowers = vi.fn(async (id: string): Promise<unknown> => ({ postId: id }));
const undoRepost = vi.fn(async (_id: string): Promise<unknown> => ({ ok: true }));
vi.mock('./api', () => ({
  repostToFollowers: (id: string) => repostToFollowers(id),
  undoRepost: (id: string) => undoRepost(id),
}));
vi.mock('$lib/utils/publicAppUrl', () => ({
  publicAppUrl: (path: string) => `https://canari.emse.fr${path}`,
}));

const {
  copyPostLink,
  postShareUrl,
  sendPostLinkInApp,
  sharePostLinkOut,
  repostRefusalMessage,
  repostToMyFollowers,
  undoMyRepost,
} = await import('./sharePost');
const { ApiRefusalError } = await import('$lib/utils/apiRefusalError');
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
    expect(sendPostLinkInApp('p1', 'group-1')).toBe(true);
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

  it('copies the link through the shared helper, which owns the confirmation', () => {
    copyPostLink('p1');
    expect(copyPublicShareLink).toHaveBeenCalledWith('/posts/p1');
  });
});

describe('member reposts (WP-F6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps every refusal code to its own sentence, never the message', () => {
    const codes = ['MEMBER_REPOST_ANONYMOUS', 'MEMBER_REPOST_NOT_ALLOWED', 'MEMBER_REPOST_ALREADY'];
    const sentences = new Set(codes.map((c) => repostRefusalMessage(c, 400)));
    expect(sentences.size).toBe(codes.length);
    expect(repostRefusalMessage(null, 404)).not.toBe(repostRefusalMessage(null, 500));
  });

  it('a repost confirms with a toast and answers true', async () => {
    expect(await repostToMyFollowers('p1')).toBe(true);
    expect(repostToFollowers).toHaveBeenCalledWith('p1');
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'info');
  });

  it('a refused repost says why and answers false', async () => {
    repostToFollowers.mockRejectedValueOnce(
      new ApiRefusalError(403, 'MEMBER_REPOST_NOT_ALLOWED', 'no')
    );
    expect(await repostToMyFollowers('p1')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      repostRefusalMessage('MEMBER_REPOST_NOT_ALLOWED', 403),
      'error'
    );
  });

  it('taking it back answers false', async () => {
    expect(await undoMyRepost('p1')).toBe(false);
    expect(undoRepost).toHaveBeenCalledWith('p1');
  });
});
