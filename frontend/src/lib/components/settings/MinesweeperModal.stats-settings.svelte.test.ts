// @vitest-environment happy-dom
/**
 * MINESWEEPER STATS, PAGING AND SETTINGS (2026-11-04). Pinned: the sheet has a Classement and a Stats
 * tab, the stats tab asks the server only when opened and draws the record, "show more" appends the
 * next page and ends at the total, the settings persist per device, and the long-press delay a player
 * chose is the one the board waits for (a long press flags a cell only once that delay has passed).
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const api = vi.hoisted(() => ({ leaderboard: vi.fn(), stats: vi.fn() }));

vi.mock('$lib/minesweeper/api', () => ({
  fetchMinesweeperLeaderboard: api.leaderboard,
  fetchMinesweeperStats: api.stats,
  fetchMinesweeperBans: vi.fn().mockResolvedValue([]),
  removeMinesweeperScore: vi.fn(),
  banMinesweeperUser: vi.fn(),
  unbanMinesweeperUser: vi.fn(),
  startMinesweeperChallenge: vi.fn().mockRejectedValue(new Error('no server in this test')),
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
}));
vi.mock('$lib/stores/userState.svelte', () => ({ globalAdminState: () => false }));

import MinesweeperModal from './MinesweeperModal.svelte';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const entry = (n: number) => ({
  scoreId: `s${n}`,
  rank: n,
  userId: `u${n}`,
  displayName: `Player ${n}`,
  durationMs: 40000 + n,
  moveCount: 90,
  verifiedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
});
const STATS = {
  played: 8,
  won: 2,
  lost: 6,
  winRate: 0.25,
  bestMs: 41000,
  averageMs: 50000,
  medianMs: 50000,
  rank: 4,
  recent: [
    { scoreId: 'a', durationMs: 41000, moveCount: 90, verifiedAt: new Date().toISOString() },
    { scoreId: 'b', durationMs: 59000, moveCount: 95, verifiedAt: new Date().toISOString() },
  ],
};

beforeEach(() => {
  localStorage.clear();
  api.leaderboard.mockReset().mockResolvedValue({ entries: [entry(1), entry(2)], total: 2 });
  api.stats.mockReset().mockResolvedValue(STATS);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(MinesweeperModal, {
    target: document.body,
    props: { open: true, onClose: () => {} },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
};
const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text)
  );

describe('leaderboard sheet - tabs, paging and relative dates', () => {
  it('opens on the ranking, with a relative date per row, and asks for no stats yet', async () => {
    await open();
    byLabel('Classement')!.click();
    await settle();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Player 1');
    expect(document.body.textContent).toContain('il y a 3h');
    expect(api.stats).not.toHaveBeenCalled();
  });

  it('loads the stats when their tab opens and draws the record', async () => {
    await open();
    byLabel('Classement')!.click();
    await settle();
    byText('Stats')!.click();
    await settle();
    expect(api.stats).toHaveBeenCalledOnce();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Parties classées');
    expect(text).toContain('25 %');
    expect(text).toContain('Rang #4');
    expect(text).toContain('41000ms');
    expect(
      document.querySelector('[role="img"][aria-label="Temps de vos dernières victoires"]')
    ).not.toBeNull();
    expect(text).toContain('Seules les parties classées');
  });

  it('says so when the stats cannot be loaded', async () => {
    api.stats.mockRejectedValue(new Error('500'));
    await open();
    byLabel('Classement')!.click();
    await settle();
    byText('Stats')!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Impossible de charger vos statistiques'
    );
  });

  it('appends the next page from where the loaded ones end, and stops at the total', async () => {
    const first = Array.from({ length: 10 }, (_, i) => entry(i + 1));
    // Keyed on the offset: the modal also loads the first page by itself when it opens.
    api.leaderboard.mockImplementation(async (_limit: number, offset: number) =>
      offset === 0 ? { entries: first, total: 12 } : { entries: [entry(11), entry(12)], total: 12 }
    );
    await open();
    byLabel('Classement')!.click();
    await settle();
    expect(document.querySelectorAll('ol > li')).toHaveLength(10);
    byText('Voir plus')!.click();
    await settle();
    expect(api.leaderboard).toHaveBeenLastCalledWith(10, 10);
    expect(document.querySelectorAll('ol > li')).toHaveLength(12);
    expect(byText('Voir plus')).toBeUndefined();
  });
});

describe('settings sheet', () => {
  const openSettings = async () => {
    await open();
    byLabel('Réglages')!.click();
    await settle();
  };

  it('persists each choice per device', async () => {
    await openSettings();
    document.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); // double-tap zoom
    flushSync();
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = '500';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    byText('Rapide')!.click();
    flushSync();
    expect(JSON.parse(localStorage.getItem('canari.minesweeper.settings')!)).toEqual({
      doubleTapZoom: false,
      longPressMs: 500,
      haptics: true,
      animations: 'fast',
    });
  });

  it('starts from the stored settings', async () => {
    localStorage.setItem(
      'canari.minesweeper.settings',
      JSON.stringify({ doubleTapZoom: true, longPressMs: 600, haptics: false, animations: 'off' })
    );
    await openSettings();
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe('600');
    const [doubleTap, haptics] = [...document.querySelectorAll('[role="switch"]')];
    expect(doubleTap.getAttribute('aria-checked')).toBe('true');
    expect(haptics.getAttribute('aria-checked')).toBe('false');
    expect(byText('Aucune')!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('long-press delay', () => {
  /** Digs the first cell of an unranked game (mines get placed), so a long press afterwards FLAGS. */
  async function startedGame() {
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
    for (let i = 0; i < 8; i++) {
      await flushMacrotask();
      flushSync();
    }
    return [...document.querySelectorAll<HTMLButtonElement>('[data-cell]')].findIndex(
      (c) =>
        !c.querySelector('svg') && c.textContent?.trim() === '' && c.className.includes('yellow')
    );
  }

  const pressTouch = (cell: number) =>
    document
      .querySelector(`[data-cell="${cell}"]`)!
      .dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, button: 0 })
      );

  it.each([
    [200, 250, true],
    [600, 250, false],
    [600, 650, true],
  ])('with a %i ms delay, a %i ms hold flags: %s', async (delay, hold, flagged) => {
    localStorage.setItem(
      'canari.minesweeper.settings',
      JSON.stringify({ doubleTapZoom: true, longPressMs: delay, haptics: false, animations: 'off' })
    );
    const target = await startedGame();
    expect(target).toBeGreaterThan(0);
    vi.useFakeTimers();
    pressTouch(target);
    vi.advanceTimersByTime(hold);
    flushSync();
    const hasFlag = document.querySelector(`[data-cell="${target}"] svg`) !== null;
    expect(hasFlag).toBe(flagged);
  });
});
