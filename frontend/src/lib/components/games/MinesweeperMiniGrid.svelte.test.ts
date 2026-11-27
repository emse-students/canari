// @vitest-environment happy-dom
/**
 * THE TUTORIAL'S MINI-GRID (owner, 2026-11-25): the real game in small. Pinned: a tap does what it does in
 * the game (open, flag, chord a number, flag automatically when the count is certain), the mines counter
 * follows the flags, a mine ends the lesson and says so, the goal ends it and says so ONCE, and the hint
 * rings the number it reads and outlines its marks - ONE outline per rectangle, red, yellow or green
 * (owner, 2026-11-26).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { LESSONS } from '$lib/minesweeper/tutorial/lessons';
import { PATTERNS } from '$lib/minesweeper/tutorial/patterns';
import MinesweeperMiniGrid from './MinesweeperMiniGrid.svelte';

const lessonOf = (id: string) => [...LESSONS, ...PATTERNS].find((l) => l.id === id)!;
const mounted: Array<() => void> = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
const unmountAll = () => {
  while (mounted.length) mounted.pop()!();
};
afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function open(id: string, hintStep: number | null = null, flagPrimary = false, touch = false) {
  const onSolved = vi.fn();
  const onLost = vi.fn();
  const onInvert = vi.fn();
  const app = mount(MinesweeperMiniGrid, {
    target: document.body,
    props: { lesson: lessonOf(id), hintStep, onSolved, onLost, flagPrimary, touch, onInvert },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return { onSolved, onLost, onInvert };
}

const rightClick = (i: number) => {
  cell(i).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  flushSync();
};

const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const marks = (kind?: string) => [
  ...document.querySelectorAll<HTMLElement>(kind ? `[data-mark="${kind}"]` : '[data-mark]'),
];
const counter = () =>
  document.querySelector('[data-testid="tutorial-counter"]')!.textContent?.trim();

describe('MinesweeperMiniGrid', () => {
  it('draws the lesson picture: 9 cells for the flag lesson, the numbers open', () => {
    open('flag');
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(9);
    expect(cell(4).textContent?.trim()).toBe('1');
  });

  it('flags on a short press when the player chose the flag first, and solves the lesson once', () => {
    const { onSolved, onLost } = open('flag', null, true);
    cell(8).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
    // A finished lesson ignores further taps: it cannot be solved twice or lost after the fact.
    cell(0).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('flags on a right-click (a long press) when the short press digs', () => {
    const { onSolved } = open('flag');
    cell(8).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('ends the lesson as lost when a mine is opened', () => {
    const { onSolved, onLost } = open('flag');
    cell(8).click(); // dig mode: the mine
    flushSync();
    expect(onLost).toHaveBeenCalledOnce();
    expect(onSolved).not.toHaveBeenCalled();
  });

  it('chords a number: a tap on the 2 opens what its flags make safe, whatever the gestures', () => {
    const { onSolved } = open('chord', null, true);
    cell(4).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('rings the numbers a hint reads and outlines its group ONCE', async () => {
    open('one_two_one', 0);
    await tick();
    // The 1 and the 2 the step reads are ringed; the 1 on the right is not read.
    expect(cell(6).getAttribute('data-hint')).toBe('read');
    expect(cell(7).getAttribute('data-hint')).toBe('read');
    expect(cell(7).getAttribute('aria-label')).toBe('Chiffre lu : 2');
    expect(cell(8).getAttribute('data-hint')).toBeNull();
    // The pair of cells is ONE yellow outline, not two rings; the mine it forces is red.
    expect(marks()).toHaveLength(2);
    expect(marks('group')).toHaveLength(1);
    expect(marks('mine')).toHaveLength(1);
  });

  it('badges a group with the mines it holds when the numbers fix it', async () => {
    open('one_one', 1);
    await tick();
    expect(document.querySelector('[data-mark-count]')?.getAttribute('data-mark-count')).toBe('1');
  });

  it('draws red for a certain mine, green for a certain safe cell, from the last step of a pattern', async () => {
    open('one_two_one', 2);
    await tick();
    expect(marks('mine')).toHaveLength(2);
    expect(marks('safe')).toHaveLength(1);
    expect(marks('group')).toHaveLength(0);
  });

  it('outlines a mark of several rectangles as separate shapes with ONE badge', async () => {
    open('corner_one_three_one', 0);
    await tick();
    // The five cells a corner 3 sees are not a rectangle: two outlines, one yellow group, one badge.
    expect(marks('group')).toHaveLength(2);
    expect(document.querySelectorAll('[data-mark-count]')).toHaveLength(1);
    expect(document.querySelector('[data-mark-count]')?.getAttribute('data-mark-count')).toBe('3');
  });

  it('draws no outline before a hint, except the target of a gesture lesson', async () => {
    open('flag');
    await tick();
    expect(marks()).toHaveLength(0);
  });

  it('shows the mines counter and lowers it by one per flag, raising it back when a flag is lifted', async () => {
    open('flag');
    expect(counter()).toBe('1');
    rightClick(8);
    expect(counter()).toBe('0');
  });

  it('flags every certain mine at once when the number is tapped: the automatic flags', () => {
    const { onSolved } = open('autoflag');
    expect(counter()).toBe('2');
    cell(4).click(); // the 2, in dig mode
    flushSync();
    expect(counter()).toBe('0');
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('teaches the counter: flag the mine, and the rest opens with a single tap on a zero', () => {
    const { onSolved } = open('counter');
    expect(counter()).toBe('1');
    rightClick(5); // (1,1), the mine
    expect(counter()).toBe('0');
    cell(7).click(); // (3,1): a zero, the two right columns open
    cell(1).click(); // (1,0)
    cell(9).click(); // (1,2)
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('draws an OPEN grid as a window: the fog is dotted and not playable, the counter reads "?"', () => {
    const { onLost } = open('one_two');
    expect(counter()).toBe('?');
    expect(
      document.querySelector('[data-testid="tutorial-counter"]')?.getAttribute('aria-label')
    ).toBe('Nombre de mines inconnu');
    // The end of the hidden row is the picture's continuation, and hides a mine.
    expect(cell(4).getAttribute('data-hint')).toBe('far');
    cell(4).click();
    flushSync();
    expect(onLost).not.toHaveBeenCalled();
    expect(cell(4).getAttribute('data-hint')).toBe('far');
    // The cells next to a number are the pattern, and stay playable.
    expect(cell(2).getAttribute('data-hint')).toBeNull();
  });

  it('draws an open cell whose number is hidden as "?", and ignores a tap on it', () => {
    open('one_two');
    expect(cell(0).getAttribute('data-hint')).toBe('unknown');
    expect(cell(0).textContent?.trim()).toBe('?');
    expect(cell(0).getAttribute('aria-label')).toBe('Chiffre caché : seul le motif compte');
    cell(0).click();
    flushSync();
    expect(cell(0).textContent?.trim()).toBe('?');
  });

  it('shows "?" on a cell the player opens in an open picture: its number would count the fog', () => {
    open('one_one');
    const target = 1 * 5 + 3; // (3,1), the cell the 1-1 makes safe
    cell(target).click();
    flushSync();
    expect(cell(target).getAttribute('data-hint')).toBe('unknown');
    expect(cell(target).textContent?.trim()).toBe('?');
  });

  it('keeps a closed lesson closed: its counter is a number and every cell is playable', () => {
    open('flag');
    expect(counter()).toBe('1');
    expect(document.querySelectorAll('[data-hint="far"]')).toHaveLength(0);
  });

  it('draws what is left of a number once its flags are taken off, and only on the step that reads it', async () => {
    open('reduction_intro', 0);
    await tick();
    const pills = [...document.querySelectorAll<HTMLElement>('[data-reduced]')];
    expect(pills.map((p) => p.dataset.reduced)).toEqual(['1']);
    expect(pills[0].textContent?.trim()).toBe('→ 1');
  });

  it('shows no reduction label before a hint', async () => {
    open('reduction_intro');
    await tick();
    expect(document.querySelectorAll('[data-reduced]')).toHaveLength(0);
  });

  it('shows the gesture target of the guided lesson from the start, in green, without any hint', () => {
    open('reveal');
    expect(marks('safe')).toHaveLength(1);
    expect(cell(0).getAttribute('data-hint')).toBeNull();
  });

  it('says the two gestures under the grid, for a mouse or a finger, and offers to swap them', () => {
    const { onInvert } = open('flag');
    const said = () =>
      document
        .querySelector('[data-testid="tutorial-gestures"]')
        ?.textContent?.replace(/\s+/g, ' ');
    expect(said()).toContain('Clic gauche : creuser · clic droit : drapeau');
    document.querySelector<HTMLButtonElement>('[data-testid="tutorial-invert"]')!.click();
    expect(onInvert).toHaveBeenCalledOnce();
    unmountAll();
    open('flag', null, true, true);
    expect(said()).toContain('Appui court : drapeau · appui long : creuser');
  });

  it('flags on a long press of a finger, and does not dig on the click that ends it', () => {
    vi.useFakeTimers();
    try {
      const { onSolved, onLost } = open('flag', null, false, true);
      cell(8).dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })
      );
      vi.advanceTimersByTime(1000);
      flushSync();
      cell(8).click();
      flushSync();
      expect(onSolved).toHaveBeenCalledOnce();
      expect(onLost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
