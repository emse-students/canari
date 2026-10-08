import { describe, expect, it } from 'vitest';
import { measureRestoreShortfall } from './restoreShortfall';

const row = (id: string, lifecycle: 'active' | 'pending') => ({ id, lifecycle });

describe('measureRestoreShortfall', () => {
  it('reports nothing when every active row holds its group', () => {
    expect(
      measureRestoreShortfall([row('a', 'active'), row('b', 'active')], new Set(['a', 'b']))
    ).toBeNull();
  });

  it('reports the count owed, delivered and the ids missing', () => {
    expect(
      measureRestoreShortfall(
        [row('a', 'active'), row('b', 'active'), row('c', 'active')],
        new Set(['a'])
      )
    ).toEqual({ expected: 3, restored: 1, missingIds: ['b', 'c'] });
  });

  it('does not owe a group to a pending row (a backup restored on another device)', () => {
    expect(measureRestoreShortfall([row('a', 'pending')], new Set())).toBeNull();
  });

  it('does not owe an MLS group to a channel row', () => {
    expect(measureRestoreShortfall([row('channel_x', 'active')], new Set())).toBeNull();
  });

  it('reports nothing for an empty restore', () => {
    expect(measureRestoreShortfall([], new Set())).toBeNull();
  });
});
