import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  native: false,
  runShareOut: vi.fn((_w: string, open: () => Promise<void>) => open().then(() => true)),
  shareTextOut: vi.fn((_t: string) => Promise.resolve()),
  copy: vi.fn((_p: string) => Promise.resolve({ ok: true })),
}));
vi.mock('$lib/sharing/shareOut', () => ({
  canShareOut: () => h.native,
  runShareOut: h.runShareOut,
  shareTextOut: h.shareTextOut,
}));
vi.mock('$lib/utils/copyShareLink', () => ({ copyPublicShareLink: h.copy }));
vi.mock('$lib/utils/publicAppUrl', () => ({ publicAppUrl: (p: string) => `https://c.test${p}` }));

import { liveShareUrl, shareLiveLink } from './shareLive';

beforeEach(() => vi.clearAllMocks());

describe('shareLiveLink', () => {
  it('names the page of the live on the public origin', () => {
    expect(liveShareUrl('l1')).toBe('https://c.test/lives/l1');
  });
  it('opens the system sheet in a phone app', () => {
    h.native = true;
    shareLiveLink('l1');
    expect(h.shareTextOut).toHaveBeenCalledWith('https://c.test/lives/l1');
    expect(h.copy).not.toHaveBeenCalled();
  });
  it('copies the link elsewhere', () => {
    h.native = false;
    shareLiveLink('l1');
    expect(h.copy).toHaveBeenCalledWith('/lives/l1');
    expect(h.runShareOut).not.toHaveBeenCalled();
  });
});
