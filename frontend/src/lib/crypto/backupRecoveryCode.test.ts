import {
  deriveBackupKeyB64,
  deviceKeyCheckValue,
  formatRecoveryCode,
  generateRecoveryCodeBytes,
  parseRecoveryCode,
  RECOVERY_CODE_BYTES,
} from './backupRecoveryCode';

/**
 * The code a user writes down is the ONLY thing that opens a v3 backup, so what matters is that
 * every code survives being written and typed back - in any case, with or without its hyphens, with
 * the letters people confuse for digits - and that nothing which is not a code parses as one.
 */

describe('the recovery code', () => {
  it('round-trips through its written form', () => {
    for (let i = 0; i < 50; i += 1) {
      const bytes = generateRecoveryCodeBytes();
      const written = formatRecoveryCode(bytes);
      expect(written).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/);
      expect(parseRecoveryCode(written)).toEqual(bytes);
    }
  });

  it('round-trips the extremes', () => {
    const zero = new Uint8Array(RECOVERY_CODE_BYTES);
    const ones = new Uint8Array(RECOVERY_CODE_BYTES).fill(255);
    expect(parseRecoveryCode(formatRecoveryCode(zero))).toEqual(zero);
    expect(parseRecoveryCode(formatRecoveryCode(ones))).toEqual(ones);
  });

  it('ignores case, spaces and hyphens, and reads I, L and O as digits', () => {
    const bytes = generateRecoveryCodeBytes();
    const written = formatRecoveryCode(bytes);
    const typed = written.toLowerCase().replace(/-/g, ' ');
    expect(parseRecoveryCode(typed)).toEqual(bytes);

    const withZero = formatRecoveryCode(new Uint8Array(RECOVERY_CODE_BYTES));
    expect(parseRecoveryCode(withZero.replace(/0/g, 'O'))).toEqual(
      new Uint8Array(RECOVERY_CODE_BYTES)
    );
    const one = new Uint8Array(RECOVERY_CODE_BYTES);
    one[15] = 1;
    const withOne = formatRecoveryCode(one);
    expect(parseRecoveryCode(withOne.replace(/1/g, 'l'))).toEqual(one);
    expect(parseRecoveryCode(withOne.replace(/1/g, 'I'))).toEqual(one);
  });

  it('refuses what is not a code', () => {
    const written = formatRecoveryCode(generateRecoveryCodeBytes());
    expect(parseRecoveryCode('')).toBeNull();
    expect(parseRecoveryCode(written.slice(0, -1))).toBeNull();
    expect(parseRecoveryCode(written + '0')).toBeNull();
    // U is outside Crockford's alphabet.
    expect(parseRecoveryCode('U' + written.slice(1))).toBeNull();
    // 26 characters hold 130 bits, the first carrying the top five: above 7 it is wider than 128.
    expect(parseRecoveryCode('7' + written.slice(1))).not.toBeNull();
    expect(parseRecoveryCode('8' + written.slice(1))).toBeNull();
  });

  it('refuses to format anything but 16 bytes', () => {
    expect(() => formatRecoveryCode(new Uint8Array(15))).toThrow();
  });
});

describe('the derived keys', () => {
  it('derives one key per code and salt', async () => {
    const code = generateRecoveryCodeBytes();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const a = await deriveBackupKeyB64(code, salt);
    expect(await deriveBackupKeyB64(code, salt)).toBe(a);
    expect(atob(a)).toHaveLength(32);
    expect(await deriveBackupKeyB64(code, crypto.getRandomValues(new Uint8Array(16)))).not.toBe(a);
    expect(await deriveBackupKeyB64(generateRecoveryCodeBytes(), salt)).not.toBe(a);
  });

  it('gives a device key a check value that is not the key', async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const kcv = await deviceKeyCheckValue(key);
    expect(await deviceKeyCheckValue(key)).toBe(kcv);
    expect(atob(kcv)).toHaveLength(16);
    expect(kcv).not.toBe(key);
  });
});
