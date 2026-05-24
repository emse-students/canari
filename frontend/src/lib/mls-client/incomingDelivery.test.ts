import { describe, expect, it } from 'vitest';
import { parseQueuedCreatedAt } from './incomingDelivery';

describe('parseQueuedCreatedAt', () => {
  it('parses ISO strings', () => {
    const iso = '2024-03-15T08:30:00.000Z';
    expect(parseQueuedCreatedAt(iso)).toBe(Date.parse(iso));
  });

  it('parses numeric epoch ms', () => {
    expect(parseQueuedCreatedAt(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('returns undefined for invalid values', () => {
    expect(parseQueuedCreatedAt(null)).toBeUndefined();
    expect(parseQueuedCreatedAt('not-a-date')).toBeUndefined();
    expect(parseQueuedCreatedAt(0)).toBeUndefined();
  });
});
