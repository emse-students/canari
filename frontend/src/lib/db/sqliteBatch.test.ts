import { describe, expect, it } from 'vitest';
import {
  MAX_BOUND_PARAMETERS,
  MESSAGE_COLUMNS,
  MESSAGE_ROWS_PER_STATEMENT,
  SEALED_SWAP_COLUMNS,
  SEALED_SWAP_ROWS_PER_STATEMENT,
  ORDER_AT_FILL_COLUMNS,
  ORDER_AT_FILL_ROWS_PER_STATEMENT,
  chunk,
  messageInsertSql,
  orderAtFillStatement,
  sealedSwapStatement,
} from './sqliteBatch';

describe('orderAtFillStatement', () => {
  it('keys only the rows still pending and clears their flag, placeholders in the order they appear', () => {
    const { sql, params } = orderAtFillStatement([
      { id: 'a', orderAt: 10 },
      { id: 'b', orderAt: 20 },
    ]);
    expect(sql).toBe(
      'UPDATE messages SET order_at = CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 END, order_pending = NULL ' +
        'WHERE order_pending = 1 AND id IN ($5, $6)'
    );
    expect(params).toEqual(['a', 10, 'b', 20, 'a', 'b']);
  });

  it('never exceeds the parameter ceiling and refuses an empty batch', () => {
    expect(ORDER_AT_FILL_ROWS_PER_STATEMENT * ORDER_AT_FILL_COLUMNS).toBeLessThanOrEqual(
      MAX_BOUND_PARAMETERS
    );
    expect(() => orderAtFillStatement([])).toThrow();
  });
});

describe('sealedSwapStatement', () => {
  const swap = (id: string) => ({
    id,
    expected: `old-${id}`,
    iv: `iv-${id}`,
    cipherText: `ct-${id}`,
  });

  it('compare-and-swaps on the key column of the store, the payload columns only', () => {
    const { sql, params } = sealedSwapStatement('graine', [swap('a'), swap('b')]);
    expect(sql).toBe(
      'UPDATE graine SET iv = CASE session_id WHEN $1 THEN $2 WHEN $3 THEN $4 END, ' +
        'cipher_text = CASE session_id WHEN $5 THEN $6 WHEN $7 THEN $8 END ' +
        'WHERE (session_id = $9 AND cipher_text = $10) OR (session_id = $11 AND cipher_text = $12)'
    );
    expect(params).toEqual([
      'a',
      'iv-a',
      'b',
      'iv-b',
      'a',
      'ct-a',
      'b',
      'ct-b',
      'a',
      'old-a',
      'b',
      'old-b',
    ]);
  });

  it('numbers placeholders in the order they appear, so either binding convention is right', () => {
    const { sql, params } = sealedSwapStatement('messages', [swap('x'), swap('y'), swap('z')]);
    const order = (sql.match(/\$\d+/g) ?? []).map((p) => Number(p.slice(1)));
    expect(order).toEqual(params.map((_, i) => i + 1));
  });

  it('fits a full batch under the bound-parameter ceiling', () => {
    expect(SEALED_SWAP_ROWS_PER_STATEMENT * SEALED_SWAP_COLUMNS).toBeLessThanOrEqual(
      MAX_BOUND_PARAMETERS
    );
    const full = Array.from({ length: SEALED_SWAP_ROWS_PER_STATEMENT }, (_, i) => swap(`m${i}`));
    expect(sealedSwapStatement('outbox', full).params.length).toBeLessThanOrEqual(
      MAX_BOUND_PARAMETERS
    );
  });

  it('rejects an empty batch', () => {
    expect(() => sealedSwapStatement('messages', [])).toThrow();
  });
});

describe('messageInsertSql', () => {
  it('numbers placeholders across the whole statement, not per tuple', () => {
    expect(messageInsertSql(2)).toBe(
      'INSERT OR REPLACE INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending) VALUES ' +
        '($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)'
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
