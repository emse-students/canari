import { RepeatCounter } from './log-repeat';

describe('RepeatCounter', () => {
  it('prints the first occurrence, then each power of ten', () => {
    const counter = new RepeatCounter();
    const printed: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const n = counter.hit('s');
      if (n !== null) printed.push(n);
    }
    expect(printed).toEqual([1, 10, 100, 1000]);
  });

  it('counts subjects apart, and forgets the oldest past its bound', () => {
    const counter = new RepeatCounter(1);
    expect(counter.hit('a')).toBe(1);
    expect(counter.hit('a')).toBeNull();
    expect(counter.hit('b')).toBe(1);
    expect(counter.hit('a')).toBe(1);
  });
});
