import { describe, expect, it } from 'vitest';
import {
  addBlankMatrixEntry,
  addMatrixEntries,
  ensureMatrixAxes,
  matrixAllowsMultiple,
  matrixAxisEntries,
  moveMatrixEntry,
  removeMatrixEntry,
  renameMatrixEntry,
  setMatrixMultiple,
  type EditorMatrixQuestion,
} from './matrixEditor';
import { insertQuestion, newQuestion } from './questionDraft';

const grid = (): EditorMatrixQuestion => ({
  type: 'matrix_single',
  rows: [
    { id: 'r1', value: 'Accueil' },
    { id: 'r2', value: 'Repas' },
  ],
  options: [{ id: 'c1', label: 'Bien', priceModifier: 0 }],
});

describe('the "Plusieurs reponses par ligne" switch', () => {
  it('writes the stored type it maps to, and reads it back', () => {
    const item = grid();
    expect(matrixAllowsMultiple(item)).toBe(false);
    setMatrixMultiple(item, true);
    expect(item.type).toBe('matrix_multiple');
    expect(matrixAllowsMultiple(item)).toBe(true);
    setMatrixMultiple(item, false);
    expect(item.type).toBe('matrix_single');
  });

  it('touches no question that is not a grid', () => {
    const item = { type: 'short_text' };
    setMatrixMultiple(item, true);
    expect(item.type).toBe('short_text');
  });
});

describe('the axes, read and written through the stored shape', () => {
  it('reads rows from `value` and columns from the options', () => {
    expect(matrixAxisEntries(grid(), 'rows')).toEqual([
      { id: 'r1', label: 'Accueil' },
      { id: 'r2', label: 'Repas' },
    ]);
    expect(matrixAxisEntries(grid(), 'columns')).toEqual([{ id: 'c1', label: 'Bien' }]);
  });

  it('renames by id, adds, moves and removes', () => {
    const item = grid();
    renameMatrixEntry(item, 'rows', 'r2', 'Soiree');
    renameMatrixEntry(item, 'columns', 'c1', 'Tres bien');
    expect(addBlankMatrixEntry(item, 'columns')).toBe(true);
    expect(moveMatrixEntry(item, 'rows', 1, 0)).toBe(true);
    expect(moveMatrixEntry(item, 'rows', 0, 5)).toBe(false);
    expect(matrixAxisEntries(item, 'rows').map((r) => r.label)).toEqual(['Soiree', 'Accueil']);
    expect(matrixAxisEntries(item, 'columns').map((c) => c.label)).toEqual(['Tres bien', '']);
    expect(removeMatrixEntry(item, 'rows', 'r1')).toBe(true);
    // The last row stays: a grid keeps one row and one column.
    expect(removeMatrixEntry(item, 'rows', 'r2')).toBe(false);
    expect(item.rows).toEqual([{ id: 'r2', value: 'Soiree' }]);
  });

  it('pastes a list, naming what is already there; a blank starter gives way', () => {
    const item: EditorMatrixQuestion = { type: 'matrix_single', rows: [], options: [] };
    ensureMatrixAxes(item);
    const result = addMatrixEntries(item, 'rows', ['A', 'B', 'A']);
    expect(result).toEqual({ added: 2, duplicates: ['A'], overflow: 0 });
    expect(matrixAxisEntries(item, 'rows').map((r) => r.label)).toEqual(['A', 'B']);
  });

  it('gives a legacy string row an id', () => {
    const item: EditorMatrixQuestion = { type: 'matrix_single', rows: ['Old'], options: [] };
    addBlankMatrixEntry(item, 'rows');
    expect((item.rows as { id: string }[]).every((r) => typeof r.id === 'string')).toBe(true);
  });
});

describe('a new question, and where it goes', () => {
  it('starts each type with what its editor needs', () => {
    const matrix = newQuestion('matrix_single');
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.options).toHaveLength(1);
    expect(newQuestion('product_grid').required).toBe(true);
    expect(newQuestion('product_grid').productGrid).toBeTruthy();
    expect(newQuestion('linear_scale').scale).toEqual({ min: 1, max: 5 });
    expect(newQuestion('single_choice').options).toHaveLength(1);
    expect(newQuestion('short_text').required).toBe(false);
  });

  it('is inserted after the given index, or at the end', () => {
    expect(insertQuestion(['a', 'b', 'c'], 'x', 0)).toEqual(['a', 'x', 'b', 'c']);
    expect(insertQuestion(['a', 'b'], 'x', null)).toEqual(['a', 'b', 'x']);
    expect(insertQuestion(['a', 'b'], 'x', 9)).toEqual(['a', 'b', 'x']);
  });
});
