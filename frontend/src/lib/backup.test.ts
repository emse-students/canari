import type { IStorage } from './db';
import { BackupError, backupFileVersion, exportBackup, importBackup } from './backup';
import { openSealedBytes, sealBytes } from './encryption';
import { formatRecoveryCode, generateRecoveryCodeBytes } from './crypto/backupRecoveryCode';

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

  it('says a v2 file carries a usable MLS state, since its envelope opened under this key', async () => {
    opensTo(validPayload({ mlsState: 'ab' }));
    await expect(importBackup(file(2), KEY, storage, 'device-1')).resolves.toMatchObject({
      mlsStateUsable: true,
    });
  });
});

/**
 * v3: sealed under a recovery code, never under a device key. What these hold is that the file
 * moves between two devices whose keys share nothing - the phone case, where the at-rest key is
 * random per install - and that the code, not the key, is what opens it.
 */
describe('a v3 backup', () => {
  const EXPORT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const IMPORT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

  type Row = { id: string; conversationId: string; timestamp: number } & Sealed;
  type Sealed = { iv: Uint8Array; cipherText: Uint8Array };

  async function sealed(text: string, key: string): Promise<Sealed> {
    return sealBytes(new TextEncoder().encode(text), key);
  }

  async function read(row: Sealed, key: string): Promise<string | null> {
    const plain = await openSealedBytes(row.cipherText, row.iv, key);
    return plain ? new TextDecoder().decode(plain) : null;
  }

  /** A storage holding one conversation, one message and one seed, all under `EXPORT_KEY`. */
  async function exportingStorage(): Promise<IStorage> {
    const message: Row = {
      id: 'm1',
      conversationId: 'c1',
      timestamp: 1,
      ...(await sealed('hello', EXPORT_KEY)),
    };
    const seed = {
      sessionId: 's1',
      workspaceId: 'w1',
      channelId: 'ch1',
      senderId: 'u1',
      firstIndex: 0,
      createdAt: 1,
      ...(await sealed('seed-bytes', EXPORT_KEY)),
    };
    return {
      getConversations: async () => [{ id: 'c1', name: 'one' }],
      getAllEncryptedRows: async () => [message],
      getAllEncryptedGraineRows: async () => [seed],
    } as unknown as IStorage;
  }

  /** An empty storage on the importing device, recording what it was given. */
  function importingStorage() {
    const conversations: { id: string }[] = [];
    const rows: Row[] = [];
    const seeds: Sealed[] = [];
    const store = {
      getConversations: async () => conversations,
      mergeConversation: async (c: { id: string }) => void conversations.push(c),
      importEncryptedRow: async (r: Row) => void rows.push(r),
      importEncryptedGraineRow: async (r: Sealed) => void seeds.push(r),
    } as unknown as IStorage;
    return { store, rows, seeds };
  }

  async function exported(mlsState?: string) {
    const code = generateRecoveryCodeBytes();
    const data = await exportBackup(
      await exportingStorage(),
      'u1',
      EXPORT_KEY,
      'device-1',
      mlsState,
      code
    );
    return { data, code: formatRecoveryCode(code) };
  }

  it('is written as version 3', async () => {
    const { data } = await exported();
    expect(backupFileVersion(data)).toBe(3);
  });

  it('opens with its code on a device whose key shares nothing with the exporter', async () => {
    const { data, code } = await exported();
    const target = importingStorage();

    const result = await importBackup(data, IMPORT_KEY, target.store, 'device-2', code);

    expect(result.isSameDevice).toBe(false);
    expect(target.rows).toHaveLength(1);
    expect(target.seeds).toHaveLength(1);
    // Re-sealed under THIS device's key, and no longer under the exporter's.
    expect(await read(target.rows[0], IMPORT_KEY)).toBe('hello');
    expect(await read(target.seeds[0], IMPORT_KEY)).toBe('seed-bytes');
    expect(await read(target.rows[0], EXPORT_KEY)).toBeNull();
  });

  it('carries no row the exporting key alone can open', async () => {
    const { data } = await exported();
    // The device key is not the file's key: a file left in a cloud drive is worth nothing to
    // whoever holds - or can rebuild - the device key, without the code.
    await expect(
      importBackup(data, EXPORT_KEY, importingStorage().store, 'device-1', undefined)
    ).rejects.toMatchObject({ code: 'code_required' });
  });

  it('names a missing or malformed code before trying anything', async () => {
    const { data } = await exported();
    await expect(
      importBackup(data, IMPORT_KEY, importingStorage().store, 'device-2', 'not a code')
    ).rejects.toMatchObject({ code: 'code_required' });
  });

  it('names a code that does not open the file', async () => {
    const { data } = await exported();
    const other = formatRecoveryCode(generateRecoveryCodeBytes());
    await expect(
      importBackup(data, IMPORT_KEY, importingStorage().store, 'device-2', other)
    ).rejects.toMatchObject({ code: 'wrong_code' });
  });

  it('restores the MLS state only where it is sealed under the importing key', async () => {
    const { data, code } = await exported('cafe');

    const elsewhere = await importBackup(data, IMPORT_KEY, importingStorage().store, 'd2', code);
    expect(elsewhere.mlsStateUsable).toBe(false);

    const here = await importBackup(data, EXPORT_KEY, importingStorage().store, 'device-1', code);
    expect(here.mlsStateUsable).toBe(true);
    // The check value travels, the key never does.
    expect(new TextDecoder().decode(data)).not.toContain(EXPORT_KEY);
  });

  it('leaves out a row that does not open under the exporting key, and says so', async () => {
    const source = await exportingStorage();
    const stray: Row = {
      id: 'm2',
      conversationId: 'c1',
      timestamp: 2,
      ...(await sealed('stranded', IMPORT_KEY)),
    };
    const rows = await source.getAllEncryptedRows();
    (source as unknown as { getAllEncryptedRows: () => Promise<Row[]> }).getAllEncryptedRows =
      async () => [...(rows as Row[]), stray];
    const code = generateRecoveryCodeBytes();
    const data = await exportBackup(source, 'u1', EXPORT_KEY, 'device-1', undefined, code);
    const target = importingStorage();

    await importBackup(data, IMPORT_KEY, target.store, 'device-2', formatRecoveryCode(code));

    expect(target.rows.map((r) => r.id)).toEqual(['m1']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('1 message(s)'));
  });

  it('refuses a version this build does not know as corrupted', async () => {
    expect(await codeOf(file(4))).toBe('corrupted');
  });
});
