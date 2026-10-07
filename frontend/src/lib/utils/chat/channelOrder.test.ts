import { describe, expect, it } from 'vitest';
import { moveById, orderByIds } from './channelOrder';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('moveById', () => {
  it('moves an item one place either way', () => {
    expect(moveById(items, 'b', -1)?.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(moveById(items, 'b', 1)?.map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('answers null at an end, for an unknown id and for no move, so nothing no-op is persisted', () => {
    expect(moveById(items, 'a', -1)).toBeNull();
    expect(moveById(items, 'c', 1)).toBeNull();
    expect(moveById(items, 'zzz', 1)).toBeNull();
    expect(moveById(items, 'a', 0)).toBeNull();
  });

  it('does not mutate its input', () => {
    moveById(items, 'a', 1);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('orderByIds', () => {
  it('follows the named order', () => {
    expect(orderByIds(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps an unnamed item after the named ones and ignores an unknown id', () => {
    expect(orderByIds(items, ['c', 'ghost', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
});
