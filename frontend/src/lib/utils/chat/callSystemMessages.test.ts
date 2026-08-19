import {
  buildCallEndedText,
  formatCallDuration,
  mkCallStartedEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';
import { setLocale } from '$lib/paraglide/runtime';

describe('formatCallDuration', () => {
  // The expected strings are French, so the locale is PINNED rather than inherited:
  // the resolution order ends in `preferredLanguage`, and happy-dom prefers English - which
  // made these assertions depend on a dependency's default instead of on the code.
  beforeEach(() => setLocale('fr', { reload: false }));

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
  // The expected strings are French, so the locale is PINNED rather than inherited:
  // the resolution order ends in `preferredLanguage`, and happy-dom prefers English - which
  // made these assertions depend on a dependency's default instead of on the code.
  beforeEach(() => setLocale('fr', { reload: false }));

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

  it('round-trips the endedAt finalization flag', () => {
    const env = mkCallStartedEnvelope('Alice', 'room-1', 'user-1', 1_700_000_000_000);
    if (env.kind !== 'system' || !env.callEvent) throw new Error('expected system call envelope');
    // A fresh "started" envelope carries no endedAt (call still ongoing).
    expect(env.callEvent.endedAt).toBeUndefined();

    const ended = serializeEnvelope({
      ...env,
      callEvent: { ...env.callEvent, endedAt: 1_700_000_120_000 },
    });
    const parsed = parseEnvelope(ended);
    if (parsed.kind !== 'system') throw new Error('expected system envelope');
    expect(parsed.callEvent?.endedAt).toBe(1_700_000_120_000);
  });
});
