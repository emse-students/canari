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
  it('keys only the rows still pending OF ITS CONVERSATION and clears their flag, placeholders in the order they appear', () => {
    const { sql, params } = orderAtFillStatement('conv', [
      { id: 'a', orderAt: 10 },
      { id: 'b', orderAt: 20 },
    ]);
    expect(sql).toBe(
      'UPDATE messages SET order_at = CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 END, order_pending = NULL ' +
        'WHERE conversation_id = $7 AND order_pending = 1 AND id IN ($5, $6)'
    );
    expect(params).toEqual(['a', 10, 'b', 20, 'a', 'b', 'conv']);
  });

  it('never exceeds the parameter ceiling and refuses an empty batch', () => {
    expect(ORDER_AT_FILL_ROWS_PER_STATEMENT * ORDER_AT_FILL_COLUMNS + 1).toBeLessThanOrEqual(
      MAX_BOUND_PARAMETERS
    );
    expect(() => orderAtFillStatement('conv', [])).toThrow();
  });
});

describe('sealedSwapStatement', () => {
  const swap = (id: string, conversationId = 'conv') => ({
    id,
    conversationId,
    expected: `old-${id}`,
    iv: `iv-${id}`,
    cipherText: `ct-${id}`,
  });

  it('compare-and-swaps on the key column of the store, the payload columns only', () => {
    const { id: _a, conversationId: _ca, ...a } = swap('a');
    const { id: _b, conversationId: _cb, ...b } = swap('b');
    const { sql, params } = sealedSwapStatement('graine', [
      { id: 'a', ...a },
      { id: 'b', ...b },
    ]);
    expect(sql).toBe(
      'UPDATE graine SET iv = CASE WHEN session_id = $1 THEN $2 WHEN session_id = $3 THEN $4 END, ' +
        'cipher_text = CASE WHEN session_id = $5 THEN $6 WHEN session_id = $7 THEN $8 END ' +
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

  it('names a MESSAGE row by its conversation and its id: the same id in two conversations is two rows', () => {
    const { sql, params } = sealedSwapStatement('messages', [swap('x', 'A'), swap('x', 'B')]);
    expect(sql).toBe(
      'UPDATE messages SET iv = CASE WHEN (conversation_id = $1 AND id = $2) THEN $3 ' +
        'WHEN (conversation_id = $4 AND id = $5) THEN $6 END, ' +
        'cipher_text = CASE WHEN (conversation_id = $7 AND id = $8) THEN $9 ' +
        'WHEN (conversation_id = $10 AND id = $11) THEN $12 END, rev = rev + 1 ' +
        'WHERE ((conversation_id = $13 AND id = $14) AND cipher_text = $15) OR ' +
        '((conversation_id = $16 AND id = $17) AND cipher_text = $18)'
    );
    expect(params.slice(0, 6)).toEqual(['A', 'x', 'iv-x', 'B', 'x', 'iv-x']);
    expect(() =>
      sealedSwapStatement('messages', [{ id: 'x', expected: 'e', iv: 'i', cipherText: 'c' }])
    ).toThrow();
  });

  it('numbers placeholders in the order they appear, so either binding convention is right', () => {
    const { sql, params } = sealedSwapStatement('messages', [swap('x'), swap('y'), swap('z')]);
    const order = (sql.match(/\$\d+/g) ?? []).map((p) => Number(p.slice(1)));
    expect(order).toEqual(params.map((_, i) => i + 1));
  });

  it('raises the revision of a re-sealed MESSAGE, so a compare-and-set that read it retries', () => {
    expect(sealedSwapStatement('messages', [swap('x')]).sql).toContain(', rev = rev + 1 WHERE');
    expect(sealedSwapStatement('graine', [swap('x')]).sql).not.toContain('rev');
  });

  it('fits a full batch under the bound-parameter ceiling', () => {
    expect(SEALED_SWAP_ROWS_PER_STATEMENT * SEALED_SWAP_COLUMNS).toBeLessThanOrEqual(
      MAX_BOUND_PARAMETERS
    );
    const full = Array.from({ length: SEALED_SWAP_ROWS_PER_STATEMENT }, (_, i) => swap(`m${i}`));
    expect(sealedSwapStatement('messages', full).params.length).toBeLessThanOrEqual(
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
      'INSERT INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending) VALUES ' +
        '($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)' +
        ' ON CONFLICT(conversation_id, id) DO UPDATE SET timestamp = excluded.timestamp, ' +
        'iv = excluded.iv, cipher_text = excluded.cipher_text, order_at = excluded.order_at, ' +
        'order_pending = excluded.order_pending, rev = messages.rev + 1'
    );
  });

  it('raises the revision of a row it replaces, never resets it - and IGNORE stays an insert', () => {
    expect(messageInsertSql(1)).not.toContain('OR REPLACE');
    expect(messageInsertSql(1, 'ignore')).toBe(
      'INSERT OR IGNORE INTO messages (id, conversation_id, timestamp, iv, cipher_text, order_at, order_pending) VALUES ($1, $2, $3, $4, $5, $6, $7)'
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
