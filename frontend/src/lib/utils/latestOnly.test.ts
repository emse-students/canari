import { describe, it, expect } from 'vitest';
import { createLatestOnly } from './latestOnly';

describe('createLatestOnly', () => {
  it('a lone load is current', () => {
    const begin = createLatestOnly();
    expect(begin()()).toBe(true);
  });

  it('two overlapping loads: only the later one stays current, whichever answers first', async () => {
    const begin = createLatestOnly();
    let result = '';
    const resolvers: Record<string, () => void> = {};
    async function load(name: string) {
      const isCurrent = begin();
      await new Promise<void>((r) => (resolvers[name] = r));
      if (isCurrent()) result = name;
    }
    const first = load('first');
    const second = load('second');
    // The newer request answers first, then the older one lands late.
    resolvers.second();
    await second;
    resolvers.first();
    await first;
    expect(result).toBe('second');
  });
});
