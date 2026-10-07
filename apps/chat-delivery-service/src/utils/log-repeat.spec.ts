import { RepeatCounter, cutDeviceId, cutUserId } from './log-repeat';

describe('RepeatCounter - a rate said once, then by its powers of ten', () => {
  it('prints the first occurrence, then the 10th and 100th, and nothing between', () => {
    const c = new RepeatCounter();
    const printed: number[] = [];
    for (let i = 0; i < 150; i++) {
      const n = c.hit('device-a');
      if (n !== null) printed.push(n);
    }
    expect(printed).toEqual([1, 10, 100]);
  });

  it('counts each subject on its own', () => {
    const c = new RepeatCounter();
    expect(c.hit('a')).toBe(1);
    expect(c.hit('b')).toBe(1);
    expect(c.hit('a')).toBeNull();
  });

  it('forgets the oldest subject past its bound, which then speaks again', () => {
    const c = new RepeatCounter(2);
    c.hit('a');
    c.hit('b');
    c.hit('c');
    expect(c.hit('a')).toBe(1);
  });
});

describe('cutUserId / cutDeviceId', () => {
  it('keeps 8 characters of a user and 12 of a device, so the device prefix survives', () => {
    expect(cutUserId('a'.repeat(64))).toBe('aaaaaaaa');
    expect(cutDeviceId('web-mtnci3lc-7mhd-xyz')).toBe('web-mtnci3lc');
    expect(cutUserId(undefined)).toBe('');
  });
});
