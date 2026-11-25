// @vitest-environment happy-dom
/**
 * THE UNRANKED LEVELS ON SCREEN (owner, 2026-11-25). Pinned: the level picker exists in Libre only,
 * resizes the blank board, is remembered, and is gone once the first cell is dug (the game keeps its
 * level); a ranked game plays the ranked board and asks for its challenge exactly as before, whatever
 * level Libre last used.
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
  const app = mount(MinesweeperModal, {
    target: document.body,
    props: { open: true, onClose: vi.fn() },
  });
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

describe('MinesweeperModal - unranked levels', () => {
  it('shows no level picker in a ranked game, and plays the ranked board', async () => {
    await open();
    expect(picker()).toBeNull();
    expect(cells()).toBe(18 * 32);
  });

  it('starts a newcomer in Libre on Debutant, and cycles the board through the levels', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Débutant');
    expect(cells()).toBe(81);
    picker()!.click();
    flushSync();
    await tick();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Intermédiaire');
    expect(cells()).toBe(256);
    expect(localStorage.getItem('canari.minesweeper.level')).toBe('intermediate');
    picker()!.click();
    flushSync();
    expect(cells()).toBe(18 * 32);
  });

  it('keeps a newcomer on Debutant across sessions after they switch to Libre', async () => {
    // No key at all: a newcomer. The first open resolves (and stores) Debutant.
    await open();
    byText('Classé')!.click();
    flushSync();
    expect(cells()).toBe(81);
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    // The next session: the Libre key now exists, and must not turn the newcomer into an Expert.
    await open();
    expect(picker()!.getAttribute('aria-label')).toBe('Niveau : Débutant');
    expect(cells()).toBe(81);
  });

  it('resizes the blank board when the player switches between ranked and Libre', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    await open();
    expect(cells()).toBe(18 * 32);
    byText('Classé')!.click();
    flushSync();
    expect(cells()).toBe(81);
    expect(picker()).not.toBeNull();
  });

  it('locks the level once the first cell is dug: the picker goes, the game keeps its size', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    await digFirst();
    expect(startChallenge).not.toHaveBeenCalled();
    expect(picker()).toBeNull();
    expect(cells()).toBe(81);
    // The mines counter reads this board: 10 mines, none flagged yet.
    expect(document.body.textContent).toContain('10');
  });

  it('leaves ranked untouched whatever level Libre last used: same challenge, ranked board', async () => {
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
  });
});
