// @vitest-environment happy-dom
/**
 * The feed's LIVE card as a reader meets it (owner, 2026-11-07): nothing at all with no live on air;
 * ONE live is a large card (preview, EN DIRECT, viewer count, title, who broadcasts); SEVERAL are a
 * carousel of cards; no title reads "X est en live". A tap opens the viewer; a lost answer keeps the
 * cards, a refusal removes them; and the list is re-read on a timer ONLY while the card is on screen
 * in a visible page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveFeedCard from './LiveFeedCard.svelte';
import type { LiveListItem } from '$lib/live/types';
import type { OpenLivesOutcome } from '$lib/live/openLives';
import type { LivePosterLoad } from '$lib/live/livePosterView';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/AssociationAvatar.svelte', async () => ({
  default: (await import('../reels/AvatarStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `sync-${id}`,
  resolveUserDisplayName: async (id: string) => `Name ${id}`,
}));
vi.mock('$lib/associations/api', () => ({
  getAssociation: async (id: string) => ({ id, name: `Asso ${id}`, logoUrl: null }),
}));

const item = (
  id: string,
  broadcasterId: string,
  associationId: string | null = null,
  extra: Partial<LiveListItem> = {}
): LiveListItem => ({
  id,
  broadcasterId,
  associationId,
  startedAt: '2026-10-19T10:00:00.000Z',
  ...extra,
});

const mounted: Record<string, unknown>[] = [];
beforeEach(() => {
  for (const level of ['debug', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  URL.createObjectURL = vi.fn(() => 'blob:poster');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function render(outcomes: OpenLivesOutcome[], previewPeriodMs?: number) {
  const load = vi.fn(async () => outcomes.shift() ?? { kind: 'kept' as const });
  const onOpen = vi.fn();
  const fetchLimits = vi.fn(async () => ({ previewPeriodMs }) as never);
  let report: (v: boolean) => void = () => {};
  const watchOnScreen = vi.fn((_el: HTMLElement, r: (v: boolean) => void) => {
    report = r;
    return () => {};
  });
  const loadPoster = vi.fn(async (): Promise<LivePosterLoad> => ({
    kind: 'shown',
    image: new Blob([new Uint8Array(1)]),
  }));
  const props = $state({
    refreshKey: 1,
    viewerId: 'me',
    onOpen,
    load,
    fetchLimits,
    watchOnScreen,
    loadPoster,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(LiveFeedCard, { target, props }));
  return { load, onOpen, props, fetchLimits, loadPoster, onScreen: (v: boolean) => report(v) };
}

const cards = () => [...document.querySelectorAll<HTMLButtonElement>('[data-live-open]')];

describe('LiveFeedCard', () => {
  it('draws nothing while nothing is on air, and asks no limits', async () => {
    const { fetchLimits } = render([{ kind: 'answered', lives: [] }]);
    await settle();
    expect(document.querySelector('[data-live-feed-card]')).toBeNull();
    expect(fetchLimits).not.toHaveBeenCalled();
  });

  it('one live is a large card: preview, EN DIRECT, viewer count, title and who broadcasts', async () => {
    const live = item('l1', 'u1', null, {
      title: 'Soirée',
      viewers: 7,
      poster: { name: 'p1', ageMs: 4000 },
      posterKey: 'ab'.repeat(32),
    });
    const { onOpen, loadPoster } = render([{ kind: 'answered', lives: [live] }]);
    await settle();
    expect(
      document.querySelector('[data-live-feed-card]')?.getAttribute('data-live-feed-layout')
    ).toBe('large');
    expect(document.querySelector('[data-live-carousel]')).toBeNull();
    const [card] = cards();
    expect(card.getAttribute('data-live-card-size')).toBe('large');
    expect(card.getAttribute('aria-label')).toBe(
      m.live_card_is_live_titled({ name: 'Name u1', title: 'Soirée' })
    );
    expect(card.querySelector('[data-live-card-title]')?.textContent?.trim()).toBe('Soirée');
    expect(card.querySelector('[data-live-badge]')?.textContent).toContain(m.live_card_badge());
    expect(
      card.querySelector('[data-live-viewer-count]')?.getAttribute('data-live-viewer-count')
    ).toBe('7');
    expect(loadPoster).toHaveBeenCalledTimes(1);
    expect(card.querySelector('[data-live-poster-image]')?.getAttribute('src')).toBe('blob:poster');
    expect(card.querySelector('[data-live-poster-age]')?.textContent).toBe(
      m.live_card_preview_age_seconds({ seconds: 4 })
    );
    card.click();
    expect(onOpen).toHaveBeenCalledWith(live);
  });

  it('a live with no title reads "X est en live", and no poster asks nothing', async () => {
    const { loadPoster } = render([{ kind: 'answered', lives: [item('l1', 'u1')] }]);
    await settle();
    const [card] = cards();
    expect(card.getAttribute('aria-label')).toBe(m.live_card_is_live({ name: 'Name u1' }));
    expect(card.querySelector('[data-live-card-title]')?.textContent?.trim()).toBe(
      m.live_card_is_live({ name: 'Name u1' })
    );
    expect(card.querySelector('[data-live-poster-image]')).toBeNull();
    expect(card.querySelector('[data-live-viewer-count]')).toBeNull();
    expect(loadPoster).not.toHaveBeenCalled();
  });

  it('two lives or more are a carousel of compact cards, each opening its own', async () => {
    const a = item('l1', 'u1', null, { title: 'A' });
    const b = item('l2', 'u2', 'asso-9');
    const { onOpen } = render([{ kind: 'answered', lives: [a, b] }]);
    await settle();
    const carousel = document.querySelector('[data-live-carousel]');
    expect(carousel?.getAttribute('aria-label')).toBe(m.live_card_carousel_label());
    expect(cards().map((c) => c.getAttribute('data-live-card-size'))).toEqual([
      'compact',
      'compact',
    ]);
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual([
      m.live_card_is_live_titled({ name: 'Name u1', title: 'A' }),
      m.live_card_is_live({ name: 'Asso asso-9' }),
    ]);
    cards()[1].click();
    expect(onOpen).toHaveBeenCalledWith(b);
  });

  it('asks again at each feed refresh: a lost answer keeps the cards, a refusal removes them', async () => {
    const { load, props } = render([
      { kind: 'answered', lives: [item('l1', 'u1')] },
      { kind: 'kept' },
      { kind: 'hidden' },
    ]);
    await settle();
    expect(cards()).toHaveLength(1);
    props.refreshKey = 2;
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cards()).toHaveLength(1);
    props.refreshKey = 3;
    await settle();
    expect(document.querySelector('[data-live-feed-card]')).toBeNull();
  });

  it('re-reads the list every previewPeriodMs only while on screen in a visible page', async () => {
    vi.useFakeTimers();
    const answered = (): OpenLivesOutcome => ({ kind: 'answered', lives: [item('l1', 'u1')] });
    const { load, onScreen } = render(
      [answered(), answered(), answered(), answered(), answered()],
      15_000
    );
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // Not on screen yet: no timer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    onScreen(true);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    // Scrolled away: the timer stops.
    onScreen(false);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
    // On screen again, but the page hidden: still nothing.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    onScreen(true);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('with no period in the limits, it refreshes with the feed only', async () => {
    vi.useFakeTimers();
    const { load, onScreen } = render([{ kind: 'answered', lives: [item('l1', 'u1')] }]);
    await settle();
    onScreen(true);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
