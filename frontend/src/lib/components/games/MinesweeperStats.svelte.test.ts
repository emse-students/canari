// @vitest-environment happy-dom
/**
 * THE STATS TAB OF THE GAMES PAGE (moved from the game's leaderboard sheet, owner, 2026-11-13).
 * Pinned: it asks the server on mount, draws every figure the old sheet showed (played, won, lost,
 * win rate, rank, best, average, median, the sparkline, the dated latest wins, the ranked-only note),
 * and says so when the stats cannot be loaded.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({ stats: vi.fn() }));
vi.mock('$lib/minesweeper/api', () => ({
  fetchMinesweeperStats: api.stats,
  formatDurationMs: (ms: number) => `${ms}ms`,
}));

import MinesweeperStats from './MinesweeperStats.svelte';

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
    { scoreId: 'a', durationMs: 41000, moveCount: 90, verifiedAt: '2026-11-01T10:00:00Z' },
    { scoreId: 'b', durationMs: 59000, moveCount: 95, verifiedAt: '2026-11-02T10:00:00Z' },
  ],
};

let component: ReturnType<typeof mount> | null = null;
async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

beforeEach(() => {
  api.stats.mockReset().mockResolvedValue(STATS);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MinesweeperStats', () => {
  it('asks once on mount and draws the whole record', async () => {
    component = mount(MinesweeperStats, { target: document.body });
    await settle();
    expect(api.stats).toHaveBeenCalledOnce();
    const text = document.body.textContent ?? '';
    for (const part of [
      'Parties classées',
      'Victoires',
      'Perdues ou abandonnées',
      '25 %',
      'Rang #4',
      '41000ms',
      '50000ms',
      'Seules les parties classées',
    ]) {
      expect(text).toContain(part);
    }
    expect(
      document.querySelector('[role="img"][aria-label="Temps de vos dernières victoires"]')
    ).not.toBeNull();
    expect(document.querySelectorAll('ul > li')).toHaveLength(2);
  });

  it('shows dashes for a player with no win and says there is nothing yet', async () => {
    api.stats.mockResolvedValue({
      ...STATS,
      won: 0,
      winRate: null,
      bestMs: null,
      averageMs: null,
      medianMs: null,
      rank: null,
      recent: [],
    });
    component = mount(MinesweeperStats, { target: document.body });
    await settle();
    expect(document.body.textContent).toContain('Aucune partie classée gagnée');
  });

  it('says so when the stats cannot be loaded', async () => {
    api.stats.mockRejectedValue(new Error('500'));
    component = mount(MinesweeperStats, { target: document.body });
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Impossible de charger vos statistiques'
    );
  });
});
