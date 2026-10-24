import { describe, expect, it } from 'vitest';
import { voipRegistrationField } from './voipRegistration';

describe('voipRegistrationField - the native ring on the iPhone (WP-C6)', () => {
  it('sends nothing from Android, which has no VoIP token', () => {
    expect(voipRegistrationField('android', true, 'tok')).toEqual({});
    expect(voipRegistrationField('android', false, null)).toEqual({});
  });

  it('clears the server copy from an iPhone binary without the native ring, token file or not', () => {
    expect(voipRegistrationField('ios', false, null)).toEqual({ voipToken: null });
    expect(voipRegistrationField('ios', false, 'stale')).toEqual({ voipToken: null });
  });

  it('sends the token from a ring binary, and nothing until PushKit has given one', () => {
    expect(voipRegistrationField('ios', true, 'tok')).toEqual({ voipToken: 'tok' });
    expect(voipRegistrationField('ios', true, null)).toEqual({});
    expect(voipRegistrationField('ios', true, '')).toEqual({});
  });
});
