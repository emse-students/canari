import { describe, expect, it } from 'vitest';
import {
  MAX_BOUND_PARAMETERS,
  MESSAGE_COLUMNS,
  MESSAGE_ROWS_PER_STATEMENT,
  chunk,
  messageInsertSql,
} from './sqliteBatch';

describe('messageInsertSql', () => {
  it('numbers placeholders across the whole statement, not per tuple', () => {
    expect(messageInsertSql(2)).toBe(
      'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, cipher_text) VALUES ' +
        '($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)'
    );
  });

  it('binds exactly MESSAGE_COLUMNS parameters per row', () => {
    const rows = 7;
    const placeholders = messageInsertSql(rows).match(/\$\d+/g) ?? [];
    expect(placeholders).toHaveLength(rows * MESSAGE_COLUMNS);
    // Every index from 1..n exactly once: a repeated index would bind two columns to one value.
    expect(new Set(placeholders).size).toBe(rows * MESSAGE_COLUMNS);
  });

  it('rejects an empty batch rather than emitting `VALUES` with nothing after it', () => {
    expect(() => messageInsertSql(0)).toThrow();
    expect(() => messageInsertSql(-1)).toThrow();
  });

  /** The ceiling is the whole reason chunking exists; a full statement must stay under it. */
  it('stays within the parameter ceiling at the chosen chunk size', () => {
    const placeholders = messageInsertSql(MESSAGE_ROWS_PER_STATEMENT).match(/\$\d+/g) ?? [];
    expect(placeholders.length).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    // And one more row would exceed it - i.e. the chunk size is the largest that fits.
    expect((MESSAGE_ROWS_PER_STATEMENT + 1) * MESSAGE_COLUMNS).toBeGreaterThan(
      MAX_BOUND_PARAMETERS
    );
  });
});

describe('chunk', () => {
  it('preserves order and yields no empty run', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it('returns a single run when everything fits', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('rejects a size that would loop for ever', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
