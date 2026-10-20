import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { callMicNotice } from './callStatusText';

describe('callMicNotice', () => {
  it('says nothing when no system holds a microphone', () => {
    expect(callMicNotice('live', false, false, 'Alice')).toBeNull();
  });

  it('names this device first: it is the one the user can act on, and could not see', () => {
    expect(callMicNotice('live', true, true, 'Alice')).toBe(m.call_mic_suspended_local());
  });

  it('names the other party when it said its system took its microphone', () => {
    expect(callMicNotice('live', false, true, 'Alice')).toBe(
      m.call_mic_suspended_peer({ name: 'Alice' })
    );
    expect(callMicNotice('live', false, true, undefined)).toBe(m.call_mic_suspended_peer_unnamed());
  });

  it('says nothing outside a LIVE call: ringing, connecting and reconnecting say their own state', () => {
    for (const kind of ['incoming', 'ringing', 'connecting', 'reconnecting', 'ended'] as const) {
      expect(callMicNotice(kind, true, true, 'Alice'), kind).toBeNull();
    }
  });
});
