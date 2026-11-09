/**
 * THE CELL DIFF (2026-11-04): the screen re-renders a cell only when its VIEW object is replaced.
 * Pinned: nothing changed -> the same object back (assigning it is free), a flood replaces exactly the
 * cells it opened and every other view keeps its identity, and a flag replaces one.
 */
import { describe, it, expect } from 'vitest';
import { EMPTY_CELL_VIEWS, syncCellViews } from './cellViews';
import { createBoard, revealCell, toggleFlag, BEGINNER } from './game';

describe('syncCellViews', () => {
  it('builds a view per cell the first time, and nothing the second', () => {
    const board = createBoard(BEGINNER, 'seed-a');
    const first = syncCellViews(board.cells, EMPTY_CELL_VIEWS);
    expect(first.changed).toBe(81);
    expect(first.next.views).toHaveLength(81);
    const again = syncCellViews(board.cells, first.next);
    expect(again.changed).toBe(0);
    expect(again.next).toBe(first.next);
  });

  it('replaces only the cells a reveal changed', () => {
    const board = createBoard(BEGINNER, 'seed-a');
    const before = syncCellViews(board.cells, EMPTY_CELL_VIEWS).next;
    revealCell(board, 4, 4);
    const opened = board.cells.filter((c) => c.state === 'revealed').length;
    expect(opened).toBeGreaterThan(0);
    const { next, changed } = syncCellViews(board.cells, before);
    // First dig places the mines, so a hidden cell's `mine`/`adjacent` may change too; a reveal can
    // never replace FEWER views than it opened, and the revealed ones are all fresh.
    expect(changed).toBeGreaterThanOrEqual(opened);
    board.cells.forEach((c, i) => {
      expect(next.views[i]).toMatchObject({ state: c.state, mine: c.mine, adjacent: c.adjacent });
    });
    // Once mines exist, a second sync is a no-op again.
    expect(syncCellViews(board.cells, next).next).toBe(next);
  });

  it('a later flood leaves every untouched view with its identity', () => {
    const board = createBoard(BEGINNER, 'seed-b');
    revealCell(board, 4, 4);
    const settled = syncCellViews(board.cells, EMPTY_CELL_VIEWS).next;
    const hidden = board.cells.findIndex((c) => c.state === 'hidden' && !c.mine);
    expect(hidden).toBeGreaterThanOrEqual(0);
    revealCell(board, hidden % 9, Math.floor(hidden / 9));
    const { next, changed } = syncCellViews(board.cells, settled);
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(81);
    const same = next.views.filter((v, i) => v === settled.views[i]).length;
    expect(same).toBe(81 - changed);
  });

  it('replaces exactly one view for a flag', () => {
    const board = createBoard(BEGINNER, 'seed-b');
    revealCell(board, 4, 4);
    const settled = syncCellViews(board.cells, EMPTY_CELL_VIEWS).next;
    const hidden = board.cells.findIndex((c) => c.state === 'hidden');
    toggleFlag(board, hidden % 9, Math.floor(hidden / 9));
    const { next, changed } = syncCellViews(board.cells, settled);
    expect(changed).toBe(1);
    expect(next.views[hidden].state).toBe('flagged');
  });
});
