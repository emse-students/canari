// @vitest-environment happy-dom
/**
 * THE UNRANKED LEVELS ON SCREEN (owner, 2026-11-25), BY GENERATION AND NOT BY SIZE. Pinned: the level
 * picker exists in Libre only, never redraws the board (every level is the ranked size), is remembered,
 * and is gone once the first cell is dug (the game keeps its level); each level generates its board with
 * its own target score; a ranked game plays the ranked board and asks for its challenge exactly as
 * before, whatever level Libre last used.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

const startChallenge = vi.hoisted(() => vi.fn());

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: startChallenge,
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
  MinesweeperUpdateRequiredError: class extends Error {},
}));

import MinesweeperModal from './MinesweeperModal.svelte';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  startChallenge.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(MinesweeperModal, { target: document.body });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

const picker = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Niveau"]');
const cells = () => document.querySelectorAll('[data-cell]').length;
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text
  );

async function digFirst() {
  document.querySelector<HTMLButtonElement>('[data-cell="0"]')!.click();
  for (let i = 0; i < 8; i++) {
    await flushMacrotask();
    flushSync();
  }
}

/** The target score the board of the first dig was generated with, read from the generation log. */
function generatedTarget(): number | undefined {
  const call = vi
    .mocked(console.debug)
    .mock.calls.find(([message]) => message === '[minesweeper] board generated');
  return (call?.[1] as { targetScore?: number } | undefined)?.targetScore;
}

describe('MinesweeperModal - unranked levels', () => {
  it('shows no level picker in a ranked game, and plays the ranked board', async () => {
    await open();
    expect(picker()).toBeNull();
    expect(cells()).toBe(18 * 32);
  });

  it('starts a newcomer in Libre on Debutant, and cycles the level without redrawing the board', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Débutant');
    expect(cells()).toBe(18 * 32);
    picker()!.click();
    flushSync();
    await tick();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Intermédiaire');
    expect(localStorage.getItem('canari.minesweeper.level')).toBe('intermediate');
    picker()!.click();
    flushSync();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Expert');
    // A level is a generation: the grid is the ranked one at every step.
    expect(cells()).toBe(18 * 32);
  });

  it('keeps a newcomer on Debutant across sessions after they switch to Libre', async () => {
    // No key at all: a newcomer. The first open resolves (and stores) Debutant.
    await open();
    byText('Classé')!.click();
    flushSync();
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    // The next session: the Libre key now exists, and must not turn the newcomer into an Expert.
    await open();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Débutant');
  });

  it('offers the picker in Libre only, ranked or not on the same grid', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    await open();
    expect(picker()).toBeNull();
    byText('Classé')!.click();
    flushSync();
    expect(picker()).not.toBeNull();
    expect(cells()).toBe(18 * 32);
  });

  it.each([
    ['beginner', 0],
    ['intermediate', 30],
    ['expert', 60],
  ])(
    'generates a %s game with its own target score (%i)',
    async (level, target) => {
      localStorage.setItem('canari.minesweeper.level', level);
      localStorage.setItem('canari.minesweeper.unranked', '1');
      await open();
      await digFirst();
      expect(startChallenge).not.toHaveBeenCalled();
      expect(generatedTarget()).toBe(target);
    },
    30_000
  );

  it('locks the level once the first cell is dug: the picker goes, the game keeps its board', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    await digFirst();
    expect(picker()).toBeNull();
    expect(cells()).toBe(18 * 32);
    // The mines counter reads the ranked board's 150 mines, none flagged yet.
    expect(document.body.textContent).toContain('150');
  }, 30_000);

  it('leaves ranked untouched whatever level Libre last used: same challenge, ranked board and target', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '0');
    startChallenge.mockResolvedValue({
      challengeId: 'c1',
      seed: '8601e326fcef5ef936a1c69d6ab6ac41',
      generatorVersion: 2,
    });
    await open();
    await digFirst();
    expect(startChallenge).toHaveBeenCalledOnce();
    expect(startChallenge).toHaveBeenCalledWith();
    expect(cells()).toBe(18 * 32);
    expect(generatedTarget()).toBe(60);
  }, 30_000);
});
