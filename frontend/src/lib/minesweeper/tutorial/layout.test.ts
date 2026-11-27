import { describe, expect, it } from 'vitest';
import { revealCell, toggleFlag } from '../game';
import { boardFromLayout, pictureOf } from './layout';

describe('boardFromLayout', () => {
  it('builds the engine board a picture describes: size, mines, revealed numbers, flags', () => {
    const board = boardFromLayout(['F1.', '121', '.1F']);
    expect(board.width).toBe(3);
    expect(board.height).toBe(3);
    expect(board.minesPlaced).toBe(true);
    expect(board.mineCount).toBe(2);
    expect(board.flagCount).toBe(2);
    // Five numbers are open; the two flags and the two safe hidden cells are not.
    expect(board.revealedCount).toBe(5);
    expect(board.cells[4]).toMatchObject({ state: 'revealed', adjacent: 2, mine: false });
    expect(board.cells[0]).toMatchObject({ state: 'flagged', mine: true });
    expect(board.cells[2]).toMatchObject({ state: 'hidden', mine: false });
  });

  it('counts the mines around every cell, hidden ones included', () => {
    const board = boardFromLayout(['000', '011', '01#']);
    expect(board.cells[2 * 3 + 2]).toMatchObject({ mine: true, state: 'hidden' });
    expect(board.cells[1 * 3 + 1].adjacent).toBe(1);
  });

  it('plays on the real engine: a safe tap opens, a mine ends the game, a flag toggles', () => {
    const board = boardFromLayout(['000', '011', '01#']);
    toggleFlag(board, 2, 2);
    expect(board.cells[8].state).toBe('flagged');
    toggleFlag(board, 2, 2);
    revealCell(board, 2, 2);
    expect(board.status).toBe('lost');
  });

  it('chords a number whose flags match it, as the game does', () => {
    const board = boardFromLayout(['F1.', '121', '.1F']);
    revealCell(board, 1, 1);
    expect(board.cells[2].state).toBe('revealed');
    expect(board.cells[6].state).toBe('revealed');
    expect(board.status).toBe('won');
  });

  it('refuses a digit that lies about its neighbours, so a wrong picture cannot ship', () => {
    expect(() => boardFromLayout(['2.', '.#'])).toThrow(/says 2 but 1 mines/);
  });

  it('refuses an empty, ragged or unreadable picture', () => {
    expect(() => boardFromLayout([])).toThrow(/empty/);
    expect(() => boardFromLayout(['00', '0'])).toThrow(/differ in length/);
    expect(() => boardFromLayout(['0x'])).toThrow(/unknown character/);
  });

  it('reads fog and hidden numbers: ? is open and safe, ~ and X are hidden, X a mine', () => {
    const board = boardFromLayout(['?2~', '?#X']);
    expect(board.cells[0]).toMatchObject({ state: 'revealed', mine: false });
    expect(board.cells[2]).toMatchObject({ state: 'hidden', mine: false });
    expect(board.cells[5]).toMatchObject({ state: 'hidden', mine: true });
    // A shown number counts the fog's mines too: the picture is a real board.
    expect(board.cells[1].adjacent).toBe(2);
    expect(() => boardFromLayout(['?1~', '?#X'])).toThrow(/says 1 but 2 mines/);
  });
});

describe('pictureOf', () => {
  it('marks the ? cells, the drawn fog, and in an open picture the hidden cells no shown number touches', () => {
    const rows = ['~...', '?1.?', '????'];
    const open = pictureOf(rows, true);
    expect(open.unknown).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    // (3,0) touches only a ? and fog: nothing shown speaks about it.
    expect(open.fog.slice(0, 4)).toEqual([true, false, false, true]);
    // A closed picture keeps every hidden cell playable, but drawn fog is still fog.
    expect(pictureOf(rows, false).fog.slice(0, 4)).toEqual([true, false, false, false]);
  });
});
