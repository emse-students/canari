import { afterEach, describe, expect, it } from 'vitest';
import { canari } from '$lib/proto/canari.js';
import { encodeAppMessage } from '$lib/proto/codec';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  authorDescriptor,
  checkRecordedAuthorship,
  recordAuthorship,
  resetPublishedAuthorKeys,
  setPinnedSignatureKeys,
  splitAuthorProof,
} from './messageAuthorship';
import { keySource, newTestAuthor, signedBy } from './messageAuthorship.testKit';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const GROUP = 'g-auth';
const HELLO = { messageId: 'm-1', sentAt: 1_700_000_000_000, text: { content: 'hello' } };

afterEach(() => {
  setPinnedSignatureKeys(null);
  resetPublishedAuthorKeys();
});

describe('the descriptor', () => {
  it('matches the vector mls-core signs (tests/authored_frames.rs)', async () => {
    const d = await authorDescriptor('group-1', 'alice:dev-a', new TextEncoder().encode('body'));
    expect(hex(d)).toBe(
      '00000014' +
        '63616e6172692d6d6c732d617574686f722d7631' +
        '00000007' +
        '67726f75702d31' +
        '0000000b' +
        '616c6963653a6465762d61' +
        '00000020' +
        '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5'
    );
  });
});

describe('splitting a decrypted plaintext', () => {
  it('finds the proof mls-core appended as the last field, and the exact body before it', () => {
    const body = encodeAppMessage(HELLO);
    const proof = canari.AuthorProof.encode({
      version: 1,
      author: 'a:b',
      signature: new Uint8Array(64),
    }).finish();
    const trailer = [0x72, proof.length]; // field 14, wire type 2
    const plaintext = new Uint8Array([...body, ...trailer, ...proof]);
    const split = splitAuthorProof(plaintext);
    expect(split && hex(split.body)).toBe(hex(body));
    expect(split && hex(split.proof)).toBe(hex(proof));
    expect(recordAuthorship(plaintext, GROUP)).toEqual({
      body: toBase64(body),
      proof: toBase64(proof),
      group: GROUP,
    });
  });

  it('records nothing for an unsigned frame or bytes that are not protobuf', () => {
    expect(recordAuthorship(encodeAppMessage(HELLO), GROUP)).toBeUndefined();
    expect(recordAuthorship(new Uint8Array([0xff, 0xff, 0xff]), GROUP)).toBeUndefined();
  });
});

describe('checking a relayed proof', () => {
  it('verifies under the author device key and hands back the signed message', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, rec);
    expect(check.kind).toBe('verified');
    if (check.kind !== 'verified') return;
    expect(check.authorUserId).toBe('alice');
    expect(check.message.messageId).toBe('m-1');
    expect(check.message.text?.content).toBe('hello');
  });

  it('names the group a proof was signed in, so a replay elsewhere is never taken for this one', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, 'g-elsewhere', HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, rec);
    expect(check.kind === 'verified' && check.group).toBe('g-elsewhere');
  });

  it('refuses a proof whose recorded group was rewritten to this conversation', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, 'g-elsewhere', HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, {
      ...rec,
      group: GROUP,
    });
    expect(check.kind).toBe('forged');
  });

  it('refuses a proof that names no group', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, {
      ...rec,
      group: '',
    });
    expect(check.kind).toBe('forged');
  });

  it('asks the server once per device for a whole bundle', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const source = keySource({ published: [alice] });
    let asked = 0;
    const counting = {
      ...source,
      fetchDeviceSignatureKeys: async (u: string, d: string) => {
        asked += 1;
        return source.fetchDeviceSignatureKeys(u, d);
      },
    };
    for (const id of ['m-1', 'm-2', 'm-3']) {
      const rec = await signedBy(alice, GROUP, { ...HELLO, messageId: id });
      expect((await checkRecordedAuthorship(counting, GROUP, rec)).kind).toBe('verified');
    }
    expect(asked).toBe(1);
  });

  it('refuses a body whose text or timestamp was changed after signing', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    for (const altered of [
      { ...HELLO, text: { content: 'goodbye' } },
      { ...HELLO, sentAt: HELLO.sentAt + 1 },
    ]) {
      const forged = { ...rec, body: toBase64(encodeAppMessage(altered)) };
      expect(
        (await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, forged)).kind
      ).toBe('forged');
    }
  });

  it('refuses a proof signed by one member in another member name', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const mallory = await newTestAuthor('mallory:dev-m');
    // Mallory signs with HER key, claiming to be alice: alice's key does not verify it.
    const rec = await signedBy(mallory, GROUP, HELLO, { claim: 'alice:dev-a' });
    const check = await checkRecordedAuthorship(keySource({ tree: [alice, mallory] }), GROUP, rec);
    expect(check.kind).toBe('forged');
  });

  it('verifies a device that has left the tree under the keys the server published for it', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(keySource({ published: [alice] }), GROUP, rec);
    expect(check.kind).toBe('verified');
  });

  it('says unanswered, not forged, when the author has left and the server cannot be asked', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(keySource({ unreachable: true }), GROUP, rec);
    expect(check.kind).toBe('unanswered');
  });

  it('lets a pin overrule a key the server publishes', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const substitute = await newTestAuthor('alice:dev-a');
    // The server (or whoever answers for it) published a key of its own and signed with it.
    const rec = await signedBy(substitute, GROUP, HELLO);
    setPinnedSignatureKeys({ keysFor: async () => [alice.publicKey] });
    const check = await checkRecordedAuthorship(keySource({ published: [substitute] }), GROUP, rec);
    expect(check.kind).toBe('forged');
  });

  it('refuses a proof that does not decode', async () => {
    const check = await checkRecordedAuthorship(keySource({}), GROUP, {
      body: toBase64(encodeAppMessage(HELLO)),
      proof: toBase64(fromBase64('AAAA')),
      group: GROUP,
    });
    expect(check.kind).toBe('forged');
  });
});
