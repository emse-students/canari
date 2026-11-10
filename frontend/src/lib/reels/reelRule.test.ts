/**
 * The one client classifier of "what is a CanaReel" (owner, 2026-11-09): every VERTICAL video of 90 s
 * or less. The boundaries are the ones the server's door refuses at (`reel-rules.ts`), read from the
 * served numbers - so a test here at 4:5 and 90 000 ms is the same line as `reel-rules.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isReelFrame,
  isReelVideo,
  reelDeclarationFor,
  reelLifetimeLabel,
  reelRuleOf,
} from './reelRule';
import { m } from '$lib/paraglide/messages';

const rule = { maxDurationMs: 90_000, maxAspectRatio: 0.8 };

describe('reelRuleOf', () => {
  it('reads the served numbers', () => {
    expect(reelRuleOf({ maxDurationMs: 90_000, maxAspectRatio: 0.8 })).toEqual(rule);
  });

  it('is null, and says so, from an estate that serves no vertical rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(reelRuleOf({ maxDurationMs: 90_000 })).toBeNull();
    expect(reelRuleOf({ maxDurationMs: 90_000, maxAspectRatio: 0 })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('isReelFrame', () => {
  it.each([
    [720, 1280, true],
    [360, 480, true],
    [1080, 1350, true],
    [1081, 1350, false],
    [1080, 1080, false],
    [1280, 720, false],
  ])('%i x %i -> %s', (width, height, expected) => {
    expect(isReelFrame(width, height, rule)).toBe(expected);
  });

  it('is false on a frame with no dimensions', () => {
    expect(isReelFrame(undefined, 1280, rule)).toBe(false);
    expect(isReelFrame(720, 0, rule)).toBe(false);
    expect(isReelFrame(Number.NaN, 1280, rule)).toBe(false);
  });
});

describe('isReelVideo', () => {
  it('needs a known length from 1 ms to the cap', () => {
    expect(isReelVideo({ width: 720, height: 1280, durationMs: 90_000 }, rule)).toBe(true);
    expect(isReelVideo({ width: 720, height: 1280, durationMs: 90_001 }, rule)).toBe(false);
    expect(isReelVideo({ width: 720, height: 1280, durationMs: 0 }, rule)).toBe(false);
    expect(isReelVideo({ width: 720, height: 1280 }, rule)).toBe(false);
  });
});

describe('reelDeclarationFor', () => {
  const vertical = { type: 'video/mp4', width: 720, height: 1280, durationMs: 12_345.4 };

  it('declares a reel with its whole-ms length for one vertical video', () => {
    expect(reelDeclarationFor({}, [vertical], rule)).toEqual({ kind: 'reel', durationMs: 12_345 });
    expect(reelDeclarationFor({}, [{ ...vertical, type: 'video' }], rule)).not.toBeNull();
  });

  it('is null for a picture, two media, or a post carrying what a reel cannot', () => {
    expect(reelDeclarationFor({}, [{ ...vertical, type: 'image/jpeg' }], rule)).toBeNull();
    expect(reelDeclarationFor({}, [vertical, vertical], rule)).toBeNull();
    expect(reelDeclarationFor({ polls: [{} as never] }, [vertical], rule)).toBeNull();
    expect(reelDeclarationFor({ attachedFormId: 'f' }, [vertical], rule)).toBeNull();
    expect(reelDeclarationFor({ linkedCalendarEventId: 'e' }, [vertical], rule)).toBeNull();
    expect(reelDeclarationFor({ scheduledAt: '2030-01-01' }, [vertical], rule)).toBeNull();
  });

  it('treats an empty optional field as absent', () => {
    expect(reelDeclarationFor({ polls: [], scheduledAt: '' }, [vertical], rule)).not.toBeNull();
  });
});

describe('reelLifetimeLabel', () => {
  it('words the year as a year, and anything else in days', () => {
    expect(reelLifetimeLabel(365)).toBe(m.reels_lifetime_years({ count: 1 }));
    expect(reelLifetimeLabel(1)).toBe(m.reels_lifetime_days({ count: 1 }));
    expect(reelLifetimeLabel(730)).toBe(m.reels_lifetime_years({ count: 2 }));
    expect(reelLifetimeLabel(30)).toBe(m.reels_lifetime_days({ count: 30 }));
  });
});
