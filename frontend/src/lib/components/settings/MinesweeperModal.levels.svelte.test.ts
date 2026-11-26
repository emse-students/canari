// @vitest-environment happy-dom
/**
 * THE UNRANKED LEVELS ON SCREEN (owner, 2026-11-25), BY GENERATION AND NOT BY SIZE, PICKED IN THE MODE SHEET
 * (owner, 2026-11-26). Pinned: a newcomer starts in Libre on Debutant, a level is one of the four modes of
 * the sheet and never redraws the board (every level is the ranked size), it is remembered, and the mode is
 * locked once the first cell is dug (the game keeps its level); each level generates its board with its own
 * target score; a ranked game plays the ranked board and asks for its challenge exactly as before, whatever
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
  const app = mount(MinesweeperModal, { target: document.body });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

const pill = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label^="Mode de la partie"]')!;
const cells = () => document.querySelectorAll('[data-cell]').length;
/** Picks a mode in the sheet, as a player does: the pastille, then the row. */
function pick(mode: string) {
  pill().click();
  flushSync();
  document.querySelector<HTMLElement>(`[data-mode="${mode}"]`)!.click();
  flushSync();
}

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
  it('plays the ranked board in a ranked game, and shows it on the pastille', async () => {
    localStorage.setItem('canari.minesweeper.unranked', '0');
    await open();
    expect(pill().textContent).toContain('Classé');
    expect(cells()).toBe(18 * 32);
  });

  it('starts a newcomer in Libre on Debutant, and a level pick redraws nothing', async () => {
    await open();
    expect(pill().getAttribute('aria-label')).toBe('Mode de la partie : Libre · Débutant. Changer');
    expect(cells()).toBe(18 * 32);
    pick('intermediate');
    expect(pill().getAttribute('aria-label')).toBe(
      'Mode de la partie : Libre · Intermédiaire. Changer'
    );
    expect(localStorage.getItem('canari.minesweeper.level')).toBe('intermediate');
    pick('expert');
    expect(pill().textContent).toContain('Expert');
    // A level is a generation: the grid is the ranked one at every step.
    expect(cells()).toBe(18 * 32);
  });

  it('keeps a newcomer on Debutant across sessions after they pick ranked and back to Libre', async () => {
    // No key at all: a newcomer. The first open resolves (and stores) Debutant.
    await open();
    pick('ranked');
    pick('beginner');
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    // The next session: the mode key now exists, and must not turn the newcomer into an Expert.
    await open();
    expect(pill().textContent).toContain('Débutant');
  });

  it('remembers the ranked pick over the newcomer default', async () => {
    await open();
    pick('ranked');
    while (mounted.length) mounted.pop()!();
    document.body.innerHTML = '';
    await open();
    expect(pill().textContent).toContain('Classé');
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

  it('locks the mode once the first cell is dug: the pastille only reminds, the game keeps its board', async () => {
    localStorage.setItem('canari.minesweeper.level', 'beginner');
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    await digFirst();
    expect(pill().disabled).toBe(true);
    expect(pill().textContent).toContain('Débutant');
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
