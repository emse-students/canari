import {
  SECRET_BOX_ENV,
  SecretBoxOpenError,
  SecretBoxUnavailableError,
  isSecretBoxConfigured,
  openSecret,
  sealSecret,
} from './secret-box';

describe('secret-box', () => {
  const previous = process.env[SECRET_BOX_ENV];
  beforeEach(() => {
    process.env[SECRET_BOX_ENV] = 'throwaway-test-secret-0123456789abcdef';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env[SECRET_BOX_ENV];
    else process.env[SECRET_BOX_ENV] = previous;
  });

  it('opens what it sealed, and never stores the plaintext', () => {
    const sealed = sealSecret('p', 'asso-1:vendor', 'the-plaintext');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('the-plaintext');
    expect(openSecret('p', 'asso-1:vendor', sealed)).toBe('the-plaintext');
  });

  it('seals twice to two different ciphertexts (fresh IV)', () => {
    expect(sealSecret('p', 'c', 'x')).not.toBe(sealSecret('p', 'c', 'x'));
  });

  it('refuses another context, another purpose, another secret and a tampered byte', () => {
    const sealed = sealSecret('p', 'asso-1:vendor', 'k');
    expect(() => openSecret('p', 'asso-2:vendor', sealed)).toThrow(SecretBoxOpenError);
    expect(() => openSecret('q', 'asso-1:vendor', sealed)).toThrow(SecretBoxOpenError);
    // A BYTE is flipped, not a character: the last base64url character of a 29-byte seal carries
    // two padding bits, so swapping it among A-D changed nothing and the "tampered" seal opened,
    // about one run in sixteen.
    const raw = Buffer.from(sealed.slice('v1.'.length), 'base64url');
    raw[raw.length - 1] ^= 0x01;
    expect(() => openSecret('p', 'asso-1:vendor', `v1.${raw.toString('base64url')}`)).toThrow(
      SecretBoxOpenError
    );
    process.env[SECRET_BOX_ENV] = 'another-throwaway-secret-0123456789abcdef';
    expect(() => openSecret('p', 'asso-1:vendor', sealed)).toThrow(SecretBoxOpenError);
    expect(() => openSecret('p', 'c', 'garbage')).toThrow(SecretBoxOpenError);
  });

  it('refuses to work at all without a secret of 32+ characters', () => {
    process.env[SECRET_BOX_ENV] = 'short';
    expect(isSecretBoxConfigured()).toBe(false);
    expect(() => sealSecret('p', 'c', 'x')).toThrow(SecretBoxUnavailableError);
    delete process.env[SECRET_BOX_ENV];
    expect(isSecretBoxConfigured()).toBe(false);
  });

  it('keeps each named secret to its own rows: another env neither seals with nor opens the default', () => {
    const OTHER = 'SECRET_BOX_SPEC_OTHER_SECRET';
    try {
      delete process.env[OTHER];
      expect(isSecretBoxConfigured(OTHER)).toBe(false);
      expect(() => sealSecret('p', 'c', 'x', OTHER)).toThrow(new SecretBoxUnavailableError(OTHER));
      process.env[OTHER] = 'a-second-throwaway-secret-0123456789abcdef';
      const sealed = sealSecret('p', 'c', 'x', OTHER);
      expect(openSecret('p', 'c', sealed, OTHER)).toBe('x');
      // Same purpose and context, the default secret: it does not open.
      expect(() => openSecret('p', 'c', sealed)).toThrow(SecretBoxOpenError);
    } finally {
      delete process.env[OTHER];
    }
  });
});
