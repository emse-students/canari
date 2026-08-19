import type { IStorage } from './db';
import { BackupError, importBackup } from './backup';

/**
 * A backup that refuses a file has to say WHICH refusal it is.
 *
 * Every check here used to throw an `Error` carrying an English sentence, and the only reader was
 * `console.log` - so a refused import and a successful one were indistinguishable from the screen.
 * The sentence could not be translated either, because the sentence is not this layer's to write.
 * What these tests hold is the classification: the code, from a closed set, on every path out.
 */

let decryptResult: (() => Uint8Array) | null = null;
vi.mock('$lib/wasm/mls_wasm.js', () => ({
  decrypt_with_key: () => {
    if (!decryptResult) throw new Error('key mismatch');
    return decryptResult();
  },
}));

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Nothing here reaches the write path; every case is a refusal before it. */
const storage = {
  getConversations: async () => [],
  importEncryptedRow: async () => undefined,
  importEncryptedGraineRow: async () => undefined,
  mergeConversation: async () => undefined,
} as unknown as IStorage;

/** A file with the right magic header and `version` in its fourth byte. */
function file(version: number, body: number[] = [1, 2, 3]): Uint8Array {
  return new Uint8Array([0x43, 0x41, 0x4e, version, ...body]);
}

/** Makes the envelope open onto `payload`, as the WASM helper would. */
function opensTo(payload: unknown) {
  decryptResult = () => new TextEncoder().encode(JSON.stringify(payload));
}

/** A payload that passes every check, so a single field can be broken per test. */
function validPayload(over: Record<string, unknown> = {}) {
  return { version: 2, userId: 'u1', conversations: [], messages: [], ...over };
}

async function codeOf(data: Uint8Array): Promise<string> {
  try {
    await importBackup(data, KEY, storage, 'device-1');
  } catch (e) {
    if (e instanceof BackupError) return e.code;
    return `unclassified: ${String(e)}`;
  }
  return 'no error';
}

beforeEach(() => {
  decryptResult = null;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('importBackup classification', () => {
  it('names a file that is not a backup at all', async () => {
    expect(await codeOf(new Uint8Array([1, 2, 3, 4, 5]))).toBe('not_a_backup');
    // Too short to even carry the header - the same verdict, not a crash on an absent index.
    expect(await codeOf(new Uint8Array([0x43]))).toBe('not_a_backup');
  });

  it('names a v1 file rather than failing to decrypt it', async () => {
    // A v1 file is sealed with the PIN, not the device key, so trying the key would produce
    // `wrong_key` - a sentence telling the user to check a PIN that was never the problem.
    expect(await codeOf(file(1))).toBe('too_old');
  });

  it('names a key that does not open the envelope', async () => {
    decryptResult = null;
    expect(await codeOf(file(2))).toBe('wrong_key');
  });

  it('names a payload that opened but is not JSON', async () => {
    // The key WAS right - the bytes are ours - so this must not read as a wrong PIN. It used to
    // escape as a bare SyntaxError, the one refusal with no classification at all.
    decryptResult = () => new TextEncoder().encode('{ truncated');
    expect(await codeOf(file(2))).toBe('corrupted');
  });

  it.each([
    ['payload version', validPayload({ version: 0 })],
    ['missing conversations', validPayload({ conversations: 'nope' })],
    ['missing messages', validPayload({ messages: null })],
    ['a conversation with no id', validPayload({ conversations: [{ id: '  ' }] })],
    [
      'a conversation name over the cap',
      validPayload({ conversations: [{ id: 'c1', name: 'x'.repeat(501) }] }),
    ],
    ['a message with no id', validPayload({ messages: [{ id: '' }] })],
    ['a message with no conversation', validPayload({ messages: [{ id: 'm1' }] })],
    [
      'a message with no ciphertext',
      validPayload({ messages: [{ id: 'm1', conversationId: 'c1', iv: 'x' }] }),
    ],
    ['a session with no id', validPayload({ graine: [{ sessionId: '' }] })],
    ['a session with no channel', validPayload({ graine: [{ sessionId: 's1' }] })],
    [
      'a session with no ciphertext',
      validPayload({ graine: [{ sessionId: 's1', channelId: 'c', workspaceId: 'w' }] }),
    ],
  ])(
    'calls %s corrupted, because a reader cannot act on the difference',
    async (_what, payload) => {
      opensTo(payload);
      expect(await codeOf(file(2))).toBe('corrupted');
    }
  );

  it.each([
    [
      'conversations',
      validPayload({ conversations: Array.from({ length: 10_001 }, () => ({ id: 'c' })) }),
    ],
    ['messages', validPayload({ messages: Array.from({ length: 500_001 }, () => ({ id: 'm' })) })],
    [
      'channel sessions',
      validPayload({ graine: Array.from({ length: 100_001 }, () => ({ sessionId: 's' })) }),
    ],
  ])('refuses too many %s as a size problem, not a corruption', async (_what, payload) => {
    opensTo(payload);
    expect(await codeOf(file(2))).toBe('too_large');
  });

  it('carries a developer-facing detail that is never the user sentence', async () => {
    opensTo(validPayload({ messages: [{ id: 'm-42' }] }));
    await expect(importBackup(file(2), KEY, storage, 'device-1')).rejects.toMatchObject({
      code: 'corrupted',
      // The offending id belongs in the log, and nowhere near a translated sentence.
      detail: expect.stringContaining('m-42'),
    });
  });

  it('accepts a well-formed backup and says whether it came from this device', async () => {
    opensTo(validPayload({ exporterDeviceId: 'device-1' }));
    await expect(importBackup(file(2), KEY, storage, 'device-1')).resolves.toMatchObject({
      isSameDevice: true,
    });

    opensTo(validPayload({ exporterDeviceId: 'device-2' }));
    await expect(importBackup(file(2), KEY, storage, 'device-1')).resolves.toMatchObject({
      isSameDevice: false,
    });
  });
});
