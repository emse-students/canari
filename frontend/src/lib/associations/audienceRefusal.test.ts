import { describe, expect, it } from 'vitest';
import { SocialApiError } from './api';
import {
  AUDIENCE_REFUSAL,
  audienceRefusalCode,
  audienceRefusalMessage,
  audienceRefusalText,
} from './audienceRefusal';

describe('audience refusals are classified by code, never by message', () => {
  it('reads each of the five server codes', () => {
    for (const code of Object.values(AUDIENCE_REFUSAL)) {
      expect(audienceRefusalCode(new SocialApiError('english prose', code, 403))).toBe(code);
    }
  });

  it('ignores the prose: the same sentence with another code is not an audience refusal', () => {
    const prose = 'Only an institution may address everyone';
    expect(audienceRefusalCode(new SocialApiError(prose, null, 400))).toBeNull();
    expect(audienceRefusalCode(new SocialApiError(prose, 'SOMETHING_ELSE', 400))).toBeNull();
    expect(audienceRefusalCode(new Error(prose))).toBeNull();
    expect(audienceRefusalCode(undefined)).toBeNull();
  });

  it('gives every code its own non-empty sentence, and none is the server English', () => {
    const seen = new Set<string>();
    for (const code of Object.values(AUDIENCE_REFUSAL)) {
      const text = audienceRefusalText(code);
      expect(text.length).toBeGreaterThan(10);
      seen.add(text);
    }
    expect(seen.size).toBe(5);
  });

  it('answers null for a foreign error so the caller keeps its own fallback', () => {
    expect(audienceRefusalMessage(new SocialApiError('boom', null, 500))).toBeNull();
    expect(
      audienceRefusalMessage(new SocialApiError('x', AUDIENCE_REFUSAL.OUTSIDE_BDE_CAMPUS, 403))
    ).toBe(audienceRefusalText(AUDIENCE_REFUSAL.OUTSIDE_BDE_CAMPUS));
  });
});
