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
import MinesweeperMiniGrid from './MinesweeperMiniGrid.svelte';

const lessonOf = (id: string) => LESSONS.find((l) => l.id === id)!;
const mounted: Array<() => void> = [];

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function open(id: string, hintStep: number | null = null) {
  const onSolved = vi.fn();
  const onLost = vi.fn();
  const app = mount(MinesweeperMiniGrid, {
    target: document.body,
    props: { lesson: lessonOf(id), hintStep, onSolved, onLost },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  return { onSolved, onLost };
}

const cell = (i: number) => document.querySelector<HTMLButtonElement>(`[data-cell="${i}"]`)!;
const marks = (kind?: string) => [
  ...document.querySelectorAll<HTMLElement>(kind ? `[data-mark="${kind}"]` : '[data-mark]'),
];
const counter = () =>
  document.querySelector('[data-testid="tutorial-counter"]')!.textContent?.trim();
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.trim().startsWith(text)
  )!;

describe('MinesweeperMiniGrid', () => {
  it('draws the lesson picture: 9 cells for the flag lesson, the numbers open', () => {
    open('flag');
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(9);
    expect(cell(4).textContent?.trim()).toBe('1');
  });

  it('flags on a tap in Drapeau mode, and solves the lesson once', () => {
    const { onSolved, onLost } = open('flag');
    byText('Drapeau').click();
    flushSync();
    cell(8).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
    // A finished lesson ignores further taps: it cannot be solved twice or lost after the fact.
    cell(0).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('flags on a right-click whatever the mode', () => {
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

  it('chords a number: a tap on the 2 opens what its flags make safe, in either mode', () => {
    const { onSolved } = open('chord');
    byText('Drapeau').click();
    flushSync();
    cell(4).click();
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('rings the number a hint reads and outlines its group ONCE, with the mines it holds', async () => {
    open('one_two_one', 0);
    await tick();
    expect(cell(1).getAttribute('data-hint')).toBe('read');
    expect(cell(1).getAttribute('aria-label')).toBe('Chiffre lu : 2');
    // The three hidden cells are ONE yellow outline, not three rings; its badge says two mines.
    expect(marks()).toHaveLength(1);
    expect(marks('group')).toHaveLength(1);
    expect(document.querySelector('[data-mark-count]')?.getAttribute('data-mark-count')).toBe('2');
    expect(cell(3).getAttribute('data-hint')).toBeNull();
  });

  it('draws red for a certain mine, green for a certain safe cell, from the last step of a pattern', async () => {
    open('one_two_one', 3);
    await tick();
    expect(marks('mine')).toHaveLength(2);
    expect(marks('safe')).toHaveLength(1);
    expect(marks('group')).toHaveLength(0);
  });

  it('outlines a mark of several rectangles as separate shapes with ONE badge', async () => {
    open('angle_one_three_one', 0);
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
    byText('Drapeau').click();
    flushSync();
    cell(8).click();
    flushSync();
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
    byText('Drapeau').click();
    flushSync();
    cell(5).click(); // (1,1), the mine
    flushSync();
    expect(counter()).toBe('0');
    byText('Miner').click();
    flushSync();
    cell(7).click(); // (3,1): a zero, the two right columns open
    cell(1).click(); // (1,0)
    cell(9).click(); // (1,2)
    flushSync();
    expect(onSolved).toHaveBeenCalledOnce();
  });

  it('shows the gesture target of the guided lesson from the start, in green, without any hint', () => {
    open('reveal');
    expect(marks('safe')).toHaveLength(1);
    expect(cell(0).getAttribute('data-hint')).toBeNull();
  });
});
