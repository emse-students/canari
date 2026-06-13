import { describe, expect, it } from 'vitest';
import {
  buildCallEndedText,
  formatCallDuration,
  mkCallStartedEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';

describe('formatCallDuration', () => {
  it('formats sub-minute calls', () => {
    expect(formatCallDuration(30_000)).toBe("moins d'une minute");
  });

  it('formats one minute', () => {
    expect(formatCallDuration(60_000)).toBe('1 minute');
  });

  it('formats multiple minutes', () => {
    expect(formatCallDuration(3 * 60_000 + 20_000)).toBe('3 minutes');
  });
});

describe('call system envelopes', () => {
  it('round-trips call metadata', () => {
    const env = mkCallStartedEnvelope('Alice', 'room-1', 'user-1', 1_700_000_000_000);
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed.kind).toBe('system');
    if (parsed.kind !== 'system') return;
    expect(parsed.text).toBe('Alice a démarré un appel');
    expect(parsed.callEvent).toEqual({
      callId: 'room-1',
      starterId: 'user-1',
      startedAt: 1_700_000_000_000,
    });
  });

  it('builds the ended call text', () => {
    expect(buildCallEndedText('Bob', 120_000)).toBe('Bob a démarré un appel qui a duré 2 minutes');
  });
});
