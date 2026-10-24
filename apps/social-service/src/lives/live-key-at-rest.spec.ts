import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { LYDIA_BUSINESS_KEY_PURPOSE } from '../associations/associations.service';
import { openSecret, SECRET_BOX_ENV, SecretBoxOpenError } from '../common/secret-box';
import {
  LIVE_KEY_ENCRYPTION_SECRET_ENV,
  LIVE_KEY_PURPOSE,
  LIVE_KEY_VERSION,
  liveKeyContext,
  LiveKeyUnavailableError,
  isLiveKeySealingConfigured,
  openLiveKey,
  openLiveKeyOr503,
  sealLiveKey,
  type StoredLiveKey,
} from './live-key-at-rest';

const LIVE_A = '11111111-1111-4111-8111-111111111111';
const LIVE_B = '22222222-2222-4222-8222-222222222222';
const KEY = '0f'.repeat(32);

/** The stored form a sealed row carries. */
function stored(liveId: string, key = KEY): StoredLiveKey {
  return { ...sealLiveKey(liveId, key), liveKey: null };
}

/** The reason of the typed error `fn` throws. */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof LiveKeyUnavailableError) return e.reason;
    throw e;
  }
  throw new Error('did not throw');
}

describe('live-key-at-rest', () => {
  const previous = process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
  let errors: jest.SpyInstance;
  let warns: jest.SpyInstance;

  beforeEach(() => {
    process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = 'live-key-throwaway-secret-0123456789abcdef';
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    if (previous === undefined) delete process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV];
    else process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = previous;
  });

  it('opens what it sealed, under the current version, and never stores the key in the clear', () => {
    const row = stored(LIVE_A);
    expect(row.liveKeyVersion).toBe(LIVE_KEY_VERSION);
    expect(row.liveKeyCiphertext).not.toContain(KEY);
    expect(openLiveKey(LIVE_A, row)).toBe(KEY);
    expect(errors).not.toHaveBeenCalled();
  });

  it('seals twice to two different ciphertexts (fresh IV)', () => {
    expect(stored(LIVE_A).liveKeyCiphertext).not.toBe(stored(LIVE_A).liveKeyCiphertext);
  });

  it('A CIPHERTEXT COPIED TO ANOTHER LIVE DOES NOT OPEN, and says so at ERROR', () => {
    expect(reasonOf(() => openLiveKey(LIVE_B, stored(LIVE_A)))).toBe('does-not-open');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(LIVE_B);
    expect(String(errors.mock.calls[0][0])).not.toContain(KEY);
  });

  it('refuses a version it does not hold a secret for, and a relabelled version', () => {
    expect(reasonOf(() => openLiveKey(LIVE_A, { ...stored(LIVE_A), liveKeyVersion: 2 }))).toBe(
      'unknown-version'
    );
    expect(reasonOf(() => openLiveKey(LIVE_A, { ...stored(LIVE_A), liveKeyVersion: null }))).toBe(
      'unknown-version'
    );
  });

  it('does not open under another secret', () => {
    const row = stored(LIVE_A);
    process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = 'another-throwaway-secret-0123456789abcdef';
    expect(reasonOf(() => openLiveKey(LIVE_A, row))).toBe('does-not-open');
  });

  it('does not open under the Lydia purpose, even when both variables hold the SAME secret', () => {
    const shared = 'live-key-throwaway-secret-0123456789abcdef';
    const lydiaBefore = process.env[SECRET_BOX_ENV];
    try {
      process.env[SECRET_BOX_ENV] = shared;
      process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = shared;
      const row = stored(LIVE_A);
      const ctx = liveKeyContext(LIVE_A, LIVE_KEY_VERSION);
      // The control: the same secret, context and env open it under the live-key purpose...
      expect(
        openSecret(LIVE_KEY_PURPOSE, ctx, row.liveKeyCiphertext as string, SECRET_BOX_ENV)
      ).toBe(KEY);
      // ...so the purpose alone is what refuses it under the Lydia one.
      expect(() =>
        openSecret(LYDIA_BUSINESS_KEY_PURPOSE, ctx, row.liveKeyCiphertext as string, SECRET_BOX_ENV)
      ).toThrow(SecretBoxOpenError);
    } finally {
      if (lydiaBefore === undefined) delete process.env[SECRET_BOX_ENV];
      else process.env[SECRET_BOX_ENV] = lydiaBefore;
    }
  });

  it('without a secret of 32+ characters: nothing seals, nothing opens, both typed', () => {
    const row = stored(LIVE_A);
    process.env[LIVE_KEY_ENCRYPTION_SECRET_ENV] = 'short';
    expect(isLiveKeySealingConfigured()).toBe(false);
    expect(reasonOf(() => sealLiveKey(LIVE_A, KEY))).toBe('secret-missing');
    expect(reasonOf(() => openLiveKey(LIVE_A, row))).toBe('secret-missing');
    expect(String(errors.mock.calls[0][0])).toContain(LIVE_KEY_ENCRYPTION_SECRET_ENV);
  });

  it('reads the previous, plaintext form at WARN, and refuses a row with no usable key', () => {
    const legacy = { liveKeyCiphertext: null, liveKeyVersion: null, liveKey: KEY };
    expect(openLiveKey(LIVE_A, legacy)).toBe(KEY);
    expect(warns).toHaveBeenCalledTimes(1);
    expect(String(warns.mock.calls[0][0])).not.toContain(KEY);
    expect(
      reasonOf(() =>
        openLiveKey(LIVE_A, { liveKeyCiphertext: null, liveKeyVersion: null, liveKey: null })
      )
    ).toBe('absent');
    expect(
      reasonOf(() =>
        openLiveKey(LIVE_A, { liveKeyCiphertext: null, liveKeyVersion: null, liveKey: 'zz' })
      )
    ).toBe('malformed');
  });

  it('answers a route 503 LIVE_KEY_UNAVAILABLE, never a null', () => {
    let thrown: unknown = null;
    try {
      openLiveKeyOr503(LIVE_B, stored(LIVE_A));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getResponse()).toEqual({
      code: 'LIVE_KEY_UNAVAILABLE',
    });
  });
});
