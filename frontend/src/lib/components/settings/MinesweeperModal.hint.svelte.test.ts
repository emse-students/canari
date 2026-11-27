// @vitest-environment happy-dom
/**
 * THE BULB (owner, 2026-11-25): a hint in an UNRANKED game only. Pinned: a ranked game draws no bulb
 * (before the first dig and once its challenge is held), an unranked one does, lights the cells or the
 * counter `findHint` names with its message, and the next move clears the highlight. What `findHint`
 * deduces is `hint.test.ts`; here it is mocked so the board's randomness cannot reach the assertions.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import type { MinesweeperHint } from '$lib/minesweeper/hint';

const startChallenge = vi.hoisted(() => vi.fn());
const findHint = vi.hoisted(() => vi.fn<() => MinesweeperHint>());

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/minesweeper/api', () => ({
  startMinesweeperChallenge: startChallenge,
  submitMinesweeperChallenge: vi.fn(),
  formatDurationMs: (ms: number) => `${ms}ms`,
  MinesweeperBannedError: class extends Error {},
  MinesweeperUpdateRequiredError: class extends Error {},
}));
vi.mock('$lib/minesweeper/hint', () => ({ findHint }));

import MinesweeperModal from './MinesweeperModal.svelte';
import { flushMacrotask } from '../../../test/flush';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
  startChallenge.mockReset();
  findHint.mockReset();
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
const bulb = () => document.querySelector<HTMLButtonElement>('button[aria-label="Indice"]');
const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const lit = () => [...document.querySelectorAll<HTMLElement>('[data-hint]')];

/** Digs the first cell and lets the first-dig path (challenge, paint, generation) finish. */
async function firstDig() {
  cell(0).click();
  for (let i = 0; i < 8; i++) {
    await flushMacrotask();
    flushSync();
  }
}

async function openUnrankedAndDig() {
  localStorage.setItem('canari.minesweeper.unranked', '1');
  await open();
  await firstDig();
  expect(startChallenge).not.toHaveBeenCalled();
}

describe('MinesweeperModal - the miner lamp (was the bulb)', () => {
  it('draws no bulb in a ranked game, before the first dig or once the challenge is held', async () => {
    startChallenge.mockResolvedValue({
      challengeId: 'c1',
      seed: '8601e326fcef5ef936a1c69d6ab6ac41',
      generatorVersion: 2,
    });
    localStorage.setItem('canari.minesweeper.unranked', '0');
    await open();
    expect(bulb()).toBeNull();
    await firstDig();
    expect(startChallenge).toHaveBeenCalledOnce();
    expect(bulb()).toBeNull();
    expect(findHint).not.toHaveBeenCalled();
  });

  it('offers the bulb unranked, dimmed until there is a board to read, then lights the numbers it names', async () => {
    localStorage.setItem('canari.minesweeper.unranked', '1');
    await open();
    // Beside the mode pastille from the start, but with nothing to read before the first dig.
    expect(bulb()!.disabled).toBe(true);
    await firstDig();
    expect(bulb()!.disabled).toBe(false);
    // The hint is a miner's lamp, not a bulb (owner, 2026-11-27): unlit until a hint is shown, then lit.
    expect(bulb()!.querySelector('svg[data-lit]')?.getAttribute('data-lit')).toBe('false');
    findHint.mockReturnValue({ kind: 'numbers', tier: 'single', cells: [0] });
    bulb()!.click();
    flushSync();
    expect(bulb()!.querySelector('svg[data-lit]')?.getAttribute('data-lit')).toBe('true');
    expect(bulb()!.querySelector('svg.lucide-lightbulb')).toBeNull();
    expect(findHint).toHaveBeenCalledOnce();
    expect(lit().map((el) => el.dataset.hint)).toEqual(['hint']);
    expect(cell(0).dataset.hint).toBe('hint');
    expect(document.body.textContent).toContain('Ce chiffre suffit pour trouver un coup sûr.');
  });

  it('clears the highlight on the next move', async () => {
    await openUnrankedAndDig();
    findHint.mockReturnValue({ kind: 'numbers', tier: 'pair', cells: [0, 1] });
    bulb()!.click();
    flushSync();
    expect(lit()).toHaveLength(2);
    // A flag on any still-hidden cell is a move.
    const hidden = document.querySelector<HTMLButtonElement>('[data-cell].ms-hidden')!;
    hidden.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSync();
    expect(lit()).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Lisez ces chiffres ensemble');
  });

  it('keeps the status line mounted, empty, so its first message is announced', async () => {
    await openUnrankedAndDig();
    const status = document.querySelector('p[role="status"]')!;
    expect(status).not.toBeNull();
    expect(status.textContent?.trim()).toBe('');
    findHint.mockReturnValue({ kind: 'none', complete: true });
    bulb()!.click();
    flushSync();
    expect(document.querySelector('p[role="status"]')).toBe(status);
    expect(status.textContent).toContain("Aucun coup sûr n'a été trouvé.");
  });

  it('locks the mode pastille while the first dig waits for its challenge', async () => {
    let answer: (value: unknown) => void = () => {};
    startChallenge.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    localStorage.setItem('canari.minesweeper.unranked', '0');
    await open();
    expect(pill().disabled).toBe(false);
    cell(0).click();
    flushSync();
    await tick();
    expect(startChallenge).toHaveBeenCalledOnce();
    expect(pill().disabled).toBe(true);
    pill().click();
    flushSync();
    // The sheet did not open and nothing was written: the mode is being decided.
    expect(document.querySelectorAll('[data-mode]')).toHaveLength(0);
    expect(localStorage.getItem('canari.minesweeper.unranked')).toBe('0');
    answer({ challengeId: 'c1', seed: '8601e326fcef5ef936a1c69d6ab6ac41', generatorVersion: 2 });
    await firstDig();
  });

  it('rings the mines-left counter when only the total decides', async () => {
    await openUnrankedAndDig();
    findHint.mockReturnValue({ kind: 'counter' });
    bulb()!.click();
    flushSync();
    expect(lit().map((el) => el.dataset.hint)).toEqual(['counter']);
    expect(lit()[0].textContent).toContain('(indice)');
    expect(document.body.textContent).toContain('Le nombre de mines restantes donne un coup sûr.');
  });

  it('marks a misplaced flag as such', async () => {
    await openUnrankedAndDig();
    findHint.mockReturnValue({ kind: 'wrong-flag', cell: 5 });
    bulb()!.click();
    flushSync();
    expect(cell(5).dataset.hint).toBe('wrong');
    expect(document.body.textContent).toContain('Ce drapeau est mal placé.');
  });
});
