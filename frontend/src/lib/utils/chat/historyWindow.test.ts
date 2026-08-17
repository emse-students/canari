import { describe, it, expect, afterEach } from 'vitest';
import {
  NATIVE_DEVICE_WINDOW_MS,
  WEB_DEVICE_WINDOW_MS,
  deviceWindowMs,
  deviceWindowStart,
  historyRangeStart,
  isWithinHistoryRange,
  mergeHistoryFloor,
  parseHistoryFloor,
  parseHistorySince,
} from './historyWindow';

/**
 * The two boundaries of history reconciliation. Every case here passes `now` explicitly: a test
 * that reads the wall clock measures the machine it runs on rather than the rule it describes.
 */

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Midnight of the day the web window opens on, which is the boundary that goes on the wire. */
const DAY_START_90_DAYS_BEFORE_NOW = Math.floor((NOW - WEB_DEVICE_WINDOW_MS) / DAY_MS) * DAY_MS;

/**
 * Pretends this process is the Tauri shell, which is the only thing the window size depends on.
 *
 * The marker is SET ON the existing window and never replaces it. Assigning a fresh object to
 * `globalThis.window` swaps out the whole jsdom environment - `localStorage` and everything else go
 * with it - and vitest reuses that environment across files, so it takes down every test file that
 * runs after this one rather than this one.
 */
type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function asNative(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

function asWeb(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

afterEach(asWeb);

describe('the device window', () => {
  it('is 90 days in a browser and 5 years in the native shell', () => {
    expect(deviceWindowMs()).toBe(WEB_DEVICE_WINDOW_MS);
    asNative();
    expect(deviceWindowMs()).toBe(NATIVE_DEVICE_WINDOW_MS);
  });

  it('opens one window before the instant it is asked about, rounded down to the day', () => {
    // NOW is midday, so a raw subtraction lands at midday too. The boundary that goes on the wire
    // is the midnight at or before it.
    expect(deviceWindowStart(NOW)).toBe(DAY_START_90_DAYS_BEFORE_NOW);
    expect(deviceWindowStart(NOW)).toBeLessThan(NOW - WEB_DEVICE_WINDOW_MS);
  });

  it('gives the SAME boundary all day, which is the whole point of rounding it', () => {
    // Unrounded, two devices connecting a second apart draw two different lines - so a comparison
    // of what each holds "over its window" can never come out equal, and anything computed over
    // the window is stale the instant after it is computed.
    const morning = Date.UTC(2026, 7, 12, 6, 30, 0);
    const evening = Date.UTC(2026, 7, 12, 23, 59, 59);
    expect(deviceWindowStart(morning)).toBe(deviceWindowStart(evening));
  });

  it('rounds DOWN, so a device asks for slightly more than its window rather than less', () => {
    // The safe direction, and the same one every other boundary here takes: over-asking costs
    // bandwidth, under-asking loses messages.
    expect(deviceWindowStart(NOW)).toBeLessThanOrEqual(NOW - WEB_DEVICE_WINDOW_MS);
    expect(NOW - WEB_DEVICE_WINDOW_MS - deviceWindowStart(NOW)).toBeLessThan(DAY_MS);
  });

  it('moves by exactly one day from one day to the next', () => {
    expect(deviceWindowStart(NOW + DAY_MS)).toBe(deviceWindowStart(NOW) + DAY_MS);
  });
});

describe('parseHistoryFloor', () => {
  it('keeps a usable instant and floors it', () => {
    expect(parseHistoryFloor(1_700_000_000_123.7, NOW)).toBe(1_700_000_000_123);
  });

  it('rejects everything that is not one', () => {
    for (const raw of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'later', {}]) {
      expect(parseHistoryFloor(raw, NOW)).toBeUndefined();
    }
  });

  it('clamps a floor claimed in the future down to now', () => {
    // The merge is `max` and has no way back: a floor after the messages it is meant to bound would
    // put the whole conversation below it, on every device that merged it, permanently.
    expect(parseHistoryFloor(NOW + 10 * 365 * 24 * 3600 * 1000, NOW)).toBe(NOW);
  });
});

describe('mergeHistoryFloor', () => {
  it('takes the larger of the two', () => {
    expect(mergeHistoryFloor(1000, 2000, NOW)).toBe(2000);
  });

  it('answers null when the incoming floor is not ahead, so the caller skips its write', () => {
    expect(mergeHistoryFloor(2000, 2000, NOW)).toBeNull();
    expect(mergeHistoryFloor(2000, 1000, NOW)).toBeNull();
    expect(mergeHistoryFloor(undefined, undefined, NOW)).toBeNull();
    expect(mergeHistoryFloor(undefined, 'nonsense', NOW)).toBeNull();
  });

  it('accepts the first floor a conversation is ever told about', () => {
    expect(mergeHistoryFloor(undefined, 1000, NOW)).toBe(1000);
  });

  it('is idempotent, commutative and associative - which is what makes it converge', () => {
    const values = [5000, 1000, 3000];
    const fold = (order: number[]): number | undefined => {
      let held: number | undefined;
      for (const v of order) {
        const merged = mergeHistoryFloor(held, v, NOW);
        if (merged !== null) held = merged;
      }
      return held;
    };
    expect(fold(values)).toBe(5000);
    expect(fold([...values].reverse())).toBe(5000);
    expect(fold([...values, ...values])).toBe(5000);
  });
});

describe('historyRangeStart', () => {
  it('is the window when no floor has been agreed', () => {
    expect(historyRangeStart(undefined, NOW)).toBe(DAY_START_90_DAYS_BEFORE_NOW);
  });

  it('is the floor when the floor is the later of the two', () => {
    const floor = NOW - 10 * 24 * 3600 * 1000;
    expect(historyRangeStart(floor, NOW)).toBe(floor);
  });

  it('is the window when the floor is older than it - the phone is not shrunk by the browser', () => {
    asNative();
    const floor = NOW - 100 * 24 * 3600 * 1000;
    expect(historyRangeStart(floor, NOW)).toBe(floor);
    asWeb();
    // The same floor, read on the browser, is below its 90-day window - so the browser claims less.
    expect(historyRangeStart(floor, NOW)).toBe(DAY_START_90_DAYS_BEFORE_NOW);
  });
});

describe('parseHistorySince', () => {
  it('reads a stated range start', () => {
    expect(parseHistorySince(1500.9)).toBe(1500);
  });

  it('reads a stated beginning-of-time as the window it is, not as absence', () => {
    // 0 is a legitimate answer - "from the beginning" - and it is exactly the value the retired
    // shim used for a frame that stated nothing, which is what made the two indistinguishable.
    expect(parseHistorySince(0)).toBe(0);
  });

  it('refuses a frame that states no usable window', () => {
    // Every ask carries `since`, and its senders type it as required. Absence is therefore a broken
    // frame, and the callers decline it rather than inventing a window on the asker's behalf.
    for (const raw of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', {}]) {
      expect(parseHistorySince(raw)).toBeNull();
    }
  });
});

describe('isWithinHistoryRange', () => {
  it('includes the boundary', () => {
    expect(isWithinHistoryRange(1000, 1000)).toBe(true);
    expect(isWithinHistoryRange(999, 1000)).toBe(false);
  });

  it('keeps a message whose timestamp cannot be compared', () => {
    expect(isWithinHistoryRange(Number.NaN, 1000)).toBe(true);
  });
});
