import { withOwnEntry } from './object-keys';

/** `withOwnEntry`: the write of a request-supplied key, as an own entry of a new prototype-less map. */
describe('withOwnEntry', () => {
  it('returns a new prototype-less map with the entry added and the others kept', () => {
    const before = { a: 1 };
    const after = withOwnEntry(before, 'b', 2);

    expect(Object.getPrototypeOf(after)).toBeNull();
    expect({ ...after }).toEqual({ a: 1, b: 2 });
    expect(before).toEqual({ a: 1 });
  });

  it('starts from nothing when there is no map yet', () => {
    expect({ ...withOwnEntry<number>(undefined, 'a', 1) }).toEqual({ a: 1 });
  });

  it.each(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__'])(
    'throws for the key %s rather than writing it',
    (hostile) => {
      expect(() => withOwnEntry({}, hostile, 1)).toThrow(TypeError);
    }
  );

  it('drops a hostile key already stored, rather than carrying it on', () => {
    const stored = JSON.parse('{"__proto__": [1], "constructor": [2], "u0": [3]}') as Record<
      string,
      number[]
    >;
    const after = withOwnEntry(stored, 'u1', [4]);

    expect(Object.keys(after).sort()).toEqual(['u0', 'u1']);
  });
});
