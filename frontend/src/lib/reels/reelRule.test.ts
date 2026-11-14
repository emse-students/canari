/**
 * The one client classifier of "what is a CanaReel": every VERTICAL video or every video of 90 s or
 * less (owner, 2026-11-14), applied only when the server serves `rule: 'vertical-or-short'`; against
 * an older server, vertical AND 90 s or less (owner, 2026-11-09). The boundaries are the ones the
 * server's door refuses at (`reel-rules.ts`), read from the served numbers - so a test here at 4:5,
 * 90 000 ms and 600 000 ms is the same line as `reel-rules.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isReelFrame,
  isReelVideo,
  longestReelMs,
  reelCapForFrame,
  reelDeclarationFor,
  reelLifetimeLabel,
  reelPickRefusal,
  reelPickRefusalText,
  reelRuleNotice,
  reelRuleOf,
} from './reelRule';
import { m } from '$lib/paraglide/messages';

const rule = { maxDurationMs: 90_000, maxAspectRatio: 0.8 };
/** What a server of 2026-11-14 or later serves. */
const orRule = { ...rule, maxVerticalDurationMs: 180_000 };
const served = { ...rule, rule: 'vertical-or-short' as const, maxVerticalDurationMs: 180_000 };

describe('reelRuleOf', () => {
  it('reads the served numbers of an estate older than 2026-11-14: vertical AND short', () => {
    expect(reelRuleOf({ maxDurationMs: 90_000, maxAspectRatio: 0.8 })).toEqual(rule);
  });

  it('applies the OR only when the server names it - the version-skew gate', () => {
    expect(reelRuleOf(served)).toEqual(orRule);
    expect(reelRuleOf({ ...rule, maxVerticalDurationMs: 180_000 })).toEqual(rule);
  });

  it('keeps vertical AND short, and accuses the answer, when the OR comes with no usable cap', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(reelRuleOf({ ...served, maxVerticalDurationMs: undefined })).toEqual(rule);
    expect(reelRuleOf({ ...served, maxVerticalDurationMs: 30_000 })).toEqual(rule);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
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

describe('isReelVideo - vertical OR short (owner, 2026-11-14)', () => {
  it.each([
    ['a short landscape video, drawn with bars', 1920, 1080, 30_000, true],
    ['a landscape video of 90 s exactly', 1920, 1080, 90_000, true],
    ['a landscape video one ms longer', 1920, 1080, 90_001, false],
    ['a long vertical video', 1080, 1920, 150_000, true],
    ['a vertical video at its cap', 1080, 1920, 180_000, true],
    ['a vertical video past its cap', 1080, 1920, 180_001, false],
    ['a short square video', 1080, 1080, 10_000, true],
    ['a short video with no frame', undefined, undefined, 10_000, true],
  ])('%s', (_label, width, height, durationMs, expected) => {
    expect(isReelVideo({ width, height, durationMs }, orRule)).toBe(expected);
  });

  it('under the older rule a landscape video is never one, and a vertical one stops at 90 s', () => {
    expect(isReelVideo({ width: 1920, height: 1080, durationMs: 30_000 }, rule)).toBe(false);
    expect(isReelVideo({ width: 1080, height: 1920, durationMs: 150_000 }, rule)).toBe(false);
  });
});

describe('reelCapForFrame and longestReelMs', () => {
  it('reads each frame cap under each rule', () => {
    expect(reelCapForFrame(orRule, true)).toBe(180_000);
    expect(reelCapForFrame(orRule, false)).toBe(90_000);
    expect(reelCapForFrame(rule, true)).toBe(90_000);
    expect(reelCapForFrame(rule, false)).toBeNull();
    expect(longestReelMs(orRule)).toBe(180_000);
    expect(longestReelMs(rule)).toBe(90_000);
  });
});

describe('reelRuleNotice', () => {
  it('words the rule the server applies', () => {
    const lifetime = m.reels_lifetime_years({ count: 1 });
    expect(reelRuleNotice(orRule, 365)).toBe(
      m.reels_publish_rule_vertical_or_short_notice({ seconds: 90, lifetime })
    );
    expect(reelRuleNotice(rule, 365)).toBe(
      m.reels_publish_from_composer_notice({ seconds: 90, lifetime })
    );
  });
});

describe('reelPickRefusal - a gallery pick in the CanaReels camera', () => {
  const pick = (width: number | null, height: number | null, durationMs: number | null) => ({
    width,
    height,
    durationMs,
  });

  it('takes a short landscape video and a long vertical one, refuses only a long landscape one', () => {
    expect(reelPickRefusal(pick(1920, 1080, 30_000), orRule, 90_000, 'feed')).toBeNull();
    expect(reelPickRefusal(pick(1080, 1920, 150_000), orRule, 90_000, 'feed')).toBeNull();
    expect(reelPickRefusal(pick(1920, 1080, 120_000), orRule, 90_000, 'feed')).toEqual({
      reason: 'long-landscape',
      shortMs: 90_000,
    });
    expect(reelPickRefusal(pick(1080, 1920, 180_001), orRule, 90_000, 'feed')).toEqual({
      reason: 'vertical-too-long',
      capMs: 180_000,
    });
  });

  it('lets through what the engine could not read: the publish decides on the prepared file', () => {
    expect(reelPickRefusal(pick(null, null, 150_000), orRule, 90_000, 'feed')).toBeNull();
    expect(reelPickRefusal(pick(1920, 1080, null), orRule, 90_000, 'feed')).toBeNull();
  });

  it('keeps the rule of 2026-11-09 against an older estate, and for a take sent in a conversation', () => {
    expect(reelPickRefusal(pick(1920, 1080, 30_000), rule, 90_000, 'feed')).toEqual({
      reason: 'not-vertical',
    });
    expect(reelPickRefusal(pick(1080, 1920, 120_000), rule, 90_000, 'feed')).toEqual({
      reason: 'too-long',
      capMs: 90_000,
    });
    expect(reelPickRefusal(pick(1080, 1920, 70_000), orRule, 60_000, 'chat')).toEqual({
      reason: 'too-long',
      capMs: 60_000,
    });
    expect(reelPickRefusal(pick(1920, 1080, 30_000), orRule, 60_000, 'chat')).toEqual({
      reason: 'not-vertical',
    });
    expect(reelPickRefusal(pick(1920, 1080, 120_000), null, 90_000, 'feed')).toEqual({
      reason: 'too-long',
      capMs: 90_000,
    });
  });

  it('words each refusal', () => {
    expect(reelPickRefusalText({ reason: 'too-long', capMs: 60_000 })).toBe(
      m.reels_capture_too_long({ seconds: 60 })
    );
    expect(reelPickRefusalText({ reason: 'vertical-too-long', capMs: 180_000 })).toBe(
      m.reels_capture_too_long_minutes({ minutes: 3 })
    );
    expect(reelPickRefusalText({ reason: 'long-landscape', shortMs: 90_000 })).toBe(
      m.reels_capture_long_landscape({ seconds: 90 })
    );
    expect(reelPickRefusalText({ reason: 'not-vertical' })).toBe(m.reels_capture_not_vertical());
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
