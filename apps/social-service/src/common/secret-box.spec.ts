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
    // A tampered BYTE, not a tampered character: the payload's last base64url character carries
    // padding bits the decoder ignores, so swapping it changed no byte about one run in sixteen
    // (any of A-D swapped for A or B) and the "tampered" box opened.
    const raw = Buffer.from(sealed.slice('v1.'.length), 'base64url');
    raw[raw.length - 1] ^= 0x01;
    const tampered = 'v1.' + raw.toString('base64url');
    expect(() => openSecret('p', 'asso-1:vendor', tampered)).toThrow(SecretBoxOpenError);
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
});
