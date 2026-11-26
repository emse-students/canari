// @vitest-environment happy-dom
/**
 * MINESWEEPER SETTINGS (2026-11-04). Pinned: the settings persist per device, and the long-press delay
 * a player chose is the one the board waits for (a long press flags a cell only once that delay has
 * passed). The stats and the paging moved to the Games page, the one leaderboard (2026-11-13).
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: vi.fn().mockRejectedValue(new Error('no server in this test')),
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
  MinesweeperUpdateRequiredError: class extends Error {},
}));

import MinesweeperModal from './MinesweeperModal.svelte';
import { startMinesweeperChallenge, submitMinesweeperChallenge } from '$lib/minesweeper/api';
import { CHALLENGE, createBoard, revealCell } from '$lib/minesweeper/game';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
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
  const app = mount(MinesweeperModal, { target: document.body });
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
        !c.querySelector('svg') && c.textContent?.trim() === '' && c.className.includes('ms-hidden')
    );
  }

  const pressTouch = (cell: number) =>
    document
      .querySelector(`[data-cell="${cell}"]`)!
      .dispatchEvent(
        new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, button: 0 })
      );

  it.each([
    [150, 100, false],
    [150, 200, true],
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

describe('animation speed', () => {
  /** The element carrying the speed factor: everything animated inside the modal inherits it. */
  const speedRoot = () => document.querySelector<HTMLElement>('[style*="--ms-anim"]');

  it.each([
    ['normal', '1'],
    ['fast', '0.5'],
    ['off', '0'],
  ])(
    '%s sets the factor to %s and scales the buttons transitions with it',
    async (speed, factor) => {
      localStorage.setItem(
        'canari.minesweeper.settings',
        JSON.stringify({ doubleTapZoom: true, longPressMs: 350, haptics: false, animations: speed })
      );
      await open();
      const style = speedRoot()?.getAttribute('style') ?? '';
      expect(style).toContain(`--ms-anim: ${factor}`);
      // Tailwind's transition-* utilities read this variable, so every button follows the setting.
      expect(style).toContain('--default-transition-duration: calc(150ms * var(--ms-anim))');
    }
  );
});

describe('pan inertia', () => {
  /** Drags a fast flick across the board with the given pointer type; true when a glide frame was scheduled. */
  async function flickGlides(pointerType: 'touch' | 'mouse'): Promise<boolean> {
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    let t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    // happy-dom has no pointer capture; the pan calls it on the viewport.
    Element.prototype.setPointerCapture = () => {};
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const cell = document.querySelector<HTMLElement>('[data-cell="0"]')!;
    const fire = (type: string, x: number) =>
      cell.dispatchEvent(
        new PointerEvent(type, {
          pointerType,
          pointerId: 1,
          clientX: x,
          clientY: 100,
          bubbles: true,
          button: 0,
        })
      );
    fire('pointerdown', 100);
    for (const x of [140, 200, 280]) {
      t += 8;
      fire('pointermove', x);
    }
    t += 4;
    const before = raf.mock.calls.length;
    fire('pointerup', 280);
    return raf.mock.calls.length > before;
  }

  it('glides after a touch flick', async () => {
    expect(await flickGlides('touch')).toBe(true);
  });

  it('does not glide after a mouse drag: the board stops where the cursor does', async () => {
    expect(await flickGlides('mouse')).toBe(false);
  });
});

describe('the timed move log of a ranked game', () => {
  // A seed whose generator-2 board is known, so the test can win it by clicking every safe cell.
  const seed = '8601e326fcef5ef936a1c69d6ab6ac41';
  const first = 16 * CHALLENGE.width + 9;

  it('stamps every move from the first dig, and submits the winning move as the game length', async () => {
    // A newcomer plays unranked; this game is the ranked one, chosen as a player chooses it.
    localStorage.setItem('canari.minesweeper.unranked', '0');
    vi.mocked(startMinesweeperChallenge).mockResolvedValueOnce({
      challengeId: 'c-1',
      seed,
      generatorVersion: 2,
      config: CHALLENGE,
      startedAt: '2026-11-17T10:00:00Z',
      expiresAt: '2026-11-17T12:00:00Z',
      serverNow: '2026-11-17T10:00:00Z',
    });
    vi.mocked(submitMinesweeperChallenge).mockResolvedValueOnce({
      accepted: true,
      durationMs: 1,
      moveCount: 1,
      personalBestMs: 1,
      isPersonalBest: true,
      rank: 1,
      previousRank: null,
      ranksGained: 0,
    });
    const reference = createBoard(CHALLENGE, seed, 2);
    revealCell(reference, 9, 16);
    const safe = reference.cells.flatMap((c, i) => (c.mine ? [] : [i]));

    await open();
    const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
    cell(first).click();
    for (let i = 0; i < 12; i++) {
      await flushMacrotask();
      flushSync();
    }
    for (const i of safe) {
      if (cell(i).className.includes('ms-hidden')) {
        cell(i).click();
        flushSync();
      }
    }
    await settle();

    expect(submitMinesweeperChallenge).toHaveBeenCalledTimes(1);
    const [, moves, claimed] = vi.mocked(submitMinesweeperChallenge).mock.calls[0];
    expect(moves[0]).toMatchObject({ type: 'reveal', x: 9, y: 16, t: 0 });
    expect(moves.every((m) => Number.isInteger(m.t) && m.t >= 0)).toBe(true);
    expect(moves.every((m, i) => i === 0 || m.t >= moves[i - 1].t)).toBe(true);
    // The server refuses a log that does not end where the game did.
    expect(claimed).toBe(moves[moves.length - 1].t);
  }, 60_000);
});
