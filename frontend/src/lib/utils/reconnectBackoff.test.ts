import { describe, expect, it } from 'vitest';
import { RECONNECT_DELAYS_MS, cappedReconnectDelayMs, reconnectDelayMs } from './reconnectBackoff';

describe('the reconnect ladder', () => {
  it('doubles from 1 s and holds its last rung', () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000,
    ]);
    expect(reconnectDelayMs(6)).toBe(30000);
    expect(reconnectDelayMs(100)).toBe(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]);
  });

  it('reads a negative index as the first attempt', () => {
    expect(reconnectDelayMs(-1)).toBe(1000);
  });

  it('flattens at a cap for a socket that must come back fast', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => cappedReconnectDelayMs(i, 4000))).toEqual([
      1000, 2000, 4000, 4000, 4000, 4000, 4000,
    ]);
  });
});
