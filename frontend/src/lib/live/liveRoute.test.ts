import { describe, expect, it } from 'vitest';
import { LiveRefusalError } from './api';
import { liveRouteProblemOf } from './liveRoute';
import type { LiveRefusalKind } from './types';

const refusal = (status: number, kind: LiveRefusalKind) =>
  new LiveRefusalError(status, null, 'x', kind, null, null, null);

describe('liveRouteProblemOf', () => {
  it('reads an absent, hidden or ended live as gone - the server tells them apart to nobody', () => {
    expect(liveRouteProblemOf(refusal(404, 'not-found'))).toBe('gone');
    expect(liveRouteProblemOf(refusal(410, 'ended'))).toBe('gone');
  });
  it('keeps the live-full screen apart', () => {
    expect(liveRouteProblemOf(refusal(503, 'full'))).toBe('full');
  });
  it('says unavailable for a removed viewer or a switched-off estate', () => {
    expect(liveRouteProblemOf(refusal(403, 'removed'))).toBe('unavailable');
    expect(liveRouteProblemOf(refusal(404, 'disabled'))).toBe('unavailable');
  });
  it('offers a retry on a seat or rate wobble, and stops on a defect', () => {
    expect(liveRouteProblemOf(refusal(503, 'seats-unavailable'))).toBe('retry');
    expect(liveRouteProblemOf(new TypeError('boom'))).toBe('unavailable');
  });
});
