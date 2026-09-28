import { describe, expect, it } from 'vitest';
import { commitAdmits } from './commitAdmits';

const SELF = 'user-a:web-self';

describe('commitAdmits', () => {
  it('admits every excluded device of a single Add, which reports no added list', () => {
    expect(commitAdmits(['user-b:tauri-b1'], undefined, SELF)).toEqual([
      { userId: 'user-b', deviceId: 'tauri-b1' },
    ]);
  });

  it('drops a device the staging SKIPPED for an invalid KeyPackage - no Welcome will reach it', () => {
    expect(commitAdmits(['user-b:tauri-b1', 'user-b:web-b2'], ['tauri-b1'], SELF)).toEqual([
      { userId: 'user-b', deviceId: 'tauri-b1' },
    ]);
  });

  it('never admits the committing device itself', () => {
    expect(commitAdmits([SELF, 'user-b:tauri-b1'], undefined, SELF)).toEqual([
      { userId: 'user-b', deviceId: 'tauri-b1' },
    ]);
  });

  it('splits on the LAST separator and ignores a malformed entry', () => {
    expect(commitAdmits(['a:b:web-x', 'nocolon', ':web-y', 'user-z:'], undefined, SELF)).toEqual([
      { userId: 'a:b', deviceId: 'web-x' },
    ]);
  });

  it('admits nothing for a commit that adds nobody', () => {
    expect(commitAdmits(undefined, undefined, SELF)).toEqual([]);
  });
});
