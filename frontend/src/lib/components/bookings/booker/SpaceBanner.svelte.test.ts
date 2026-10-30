// @vitest-environment happy-dom
/**
 * THE HEAD OF A SPACE'S PAGE: "Gerer" only for whoever manages the space, and "Partager" taking
 * the system share sheet where the build has one (and telling the member when it does not open)
 * but copying the link, with the helper's own confirmation, everywhere else - never both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const canShareOut = vi.hoisted(() => vi.fn());
const shareTextOut = vi.hoisted(() => vi.fn());
const copyPublicShareLink = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('$lib/utils/copyShareLink', () => ({
  copyPublicShareLink: (...a: unknown[]) => copyPublicShareLink(...a),
}));
// `runShareOut` stays the real one: its failure toast is what is asserted.
vi.mock('$lib/sharing/shareOut', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/sharing/shareOut')>()),
  canShareOut: () => canShareOut(),
  shareTextOut: (...a: unknown[]) => shareTextOut(...a),
}));

import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { BookerSpace } from '$lib/bookings/api';
import SpaceBanner from './SpaceBanner.svelte';

const mounted: ReturnType<typeof mount>[] = [];
const onQr = vi.fn();

function render(over: Partial<BookerSpace> = {}) {
  const space = {
    id: 'space-1234',
    name: 'Salle de musique',
    description: 'Piano droit',
    poster: null,
    canManage: false,
    ...over,
  } as unknown as BookerSpace;
  mounted.push(mount(SpaceBanner, { target: document.body, props: { space, onQr } }));
  flushSync();
}

const named = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a')].find(
    (b) => b.textContent?.trim() === label
  );

beforeEach(() => {
  setLocale('en', { reload: false });
  canShareOut.mockReset();
  shareTextOut.mockReset();
  copyPublicShareLink.mockReset();
  showToast.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SpaceBanner', () => {
  it('draws the name, the description and a placeholder when there is no poster', () => {
    render();
    expect(document.querySelector('h1')?.textContent).toBe('Salle de musique');
    expect(document.body.textContent).toContain('Piano droit');
    expect(document.querySelector('[data-testid="space-banner-placeholder"]')).not.toBeNull();
  });

  it('offers "Manage" only to whoever manages the space', () => {
    render();
    expect(named(m.bookings_space_manage_short())).toBeUndefined();
    unmount(mounted.pop()!, { outro: false });
    document.body.innerHTML = '';
    render({ canManage: true });
    expect(named(m.bookings_space_manage_short())?.getAttribute('href')).toContain('space-1234');
  });

  it('opens the QR code from its button', () => {
    render();
    named(m.qr_button())!.click();
    expect(onQr).toHaveBeenCalledOnce();
  });

  it('copies the link, and opens no sheet, where there is no system share sheet', () => {
    canShareOut.mockReturnValue(false);
    render();
    named(m.bookings_space_share())!.click();
    expect(copyPublicShareLink).toHaveBeenCalledWith(expect.stringContaining('space-1234'));
    expect(shareTextOut).not.toHaveBeenCalled();
  });

  it('opens the system share sheet on the link, and copies nothing, on the phone apps', async () => {
    canShareOut.mockReturnValue(true);
    shareTextOut.mockResolvedValue(undefined);
    render();
    named(m.bookings_space_share())!.click();
    await tick();
    expect(shareTextOut).toHaveBeenCalledWith(expect.stringContaining('space-1234'));
    expect(copyPublicShareLink).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says so, and falls back to nothing, when the share sheet does not open', async () => {
    canShareOut.mockReturnValue(true);
    shareTextOut.mockRejectedValue(new Error('no sheet'));
    render();
    named(m.bookings_space_share())!.click();
    await tick();
    await tick();
    expect(showToast).toHaveBeenCalledWith(m.share_out_failed(), 'error');
    expect(copyPublicShareLink).not.toHaveBeenCalled();
  });
});
