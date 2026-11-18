// @vitest-environment happy-dom
/**
 * THE MODERATOR'S REPLAY VIEWER (owner, 2026-11-17). Pinned: it says what it is doing while the game
 * loads, tells "none was kept" (a 404) from a failure, shows the board after the move the scrubber is
 * on, and starts over from the end rather than sitting still. The board itself is `replay.test.ts`'s.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

const api = vi.hoisted(() => ({ fetchReplay: vi.fn() }));
vi.mock('$lib/minesweeper/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchMinesweeperReplay: api.fetchReplay,
  formatDurationMs: (ms: number) => `${ms}ms`,
}));

import MinesweeperReplay from './MinesweeperReplay.svelte';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  api.fetchReplay.mockReset();
});

/** A small generator-1 game: dig the middle, flag a corner, take the flag off, dig again. */
const GAME = {
  scoreId: 's1',
  userId: 'alice',
  displayName: 'Alice',
  durationMs: 3000,
  verifiedAt: '2026-11-17T10:00:00Z',
  seed: 'abc',
  generatorVersion: 1 as const,
  config: { width: 8, height: 8, mineCount: 6 },
  moves: [
    { type: 'reveal' as const, x: 4, y: 4, t: 0 },
    { type: 'flag' as const, x: 0, y: 0, t: 1000 },
    { type: 'flag' as const, x: 0, y: 0, t: 2000 },
    { type: 'reveal' as const, x: 4, y: 4, t: 3000 },
  ],
};

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync();
    await tick();
  }
};
async function open() {
  const app = mount(MinesweeperReplay, {
    target: document.body,
    props: { scoreId: 's1', onClose: () => {} },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await settle();
}
const text = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
const scrub = (ms: number) => {
  const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
  range.value = String(ms);
  range.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const flagged = () => document.querySelector('[data-cell="0"] svg') !== null;

describe('MinesweeperReplay', () => {
  it('says it is loading, then shows the game: its length, generator and moves', async () => {
    api.fetchReplay.mockReturnValue(new Promise(() => {}));
    await open();
    expect(document.body.textContent).toContain('Chargement de la partie');

    api.fetchReplay.mockResolvedValue(GAME);
    document.body.innerHTML = '';
    await open();
    expect(api.fetchReplay).toHaveBeenCalledWith('s1');
    expect(text('replay-summary')).toBe('3000ms - générateur 1 - 4 coups');
    expect(text('replay-count')).toBe('Coup 0 / 4');
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(64);
  });

  it('shows the board after the move the scrubber is on, forwards and backwards', async () => {
    api.fetchReplay.mockResolvedValue(GAME);
    await open();
    scrub(1500);
    expect(text('replay-count')).toBe('Coup 2 / 4');
    expect(flagged()).toBe(true);
    expect(text('replay-last')).toContain('Drapeau en 1,1 à 1000ms');
    scrub(2500);
    expect(text('replay-count')).toBe('Coup 3 / 4');
    expect(flagged()).toBe(false);
    scrub(500);
    expect(text('replay-count')).toBe('Coup 1 / 4');
    scrub(0);
    expect(text('replay-count')).toBe('Coup 1 / 4');
  });

  it('restarts to the first move with the restart button', async () => {
    api.fetchReplay.mockResolvedValue(GAME);
    await open();
    scrub(3000);
    expect(text('replay-count')).toBe('Coup 4 / 4');
    document.querySelector<HTMLButtonElement>('button[aria-label="Revenir au début"]')!.click();
    flushSync();
    expect(text('replay-clock')).toBe('0ms');
    expect(text('replay-count')).toBe('Coup 1 / 4');
  });

  it('says none was kept for a 404, as an answer and not as a failure', async () => {
    api.fetchReplay.mockRejectedValue(new ApiRefusalError(404, null, 'not found'));
    await open();
    expect(document.body.textContent).toContain("Aucun enregistrement n'a été conservé");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('says it could not load for any other failure', async () => {
    api.fetchReplay.mockRejectedValue(new Error('network'));
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Impossible de charger la partie'
    );
  });
});
