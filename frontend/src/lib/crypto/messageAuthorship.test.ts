import { describe, expect, it } from 'vitest';
import { canari } from '$lib/proto/canari.js';
import { encodeAppMessage } from '$lib/proto/codec';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  authorDescriptor,
  checkRecordedAuthorship,
  recordAuthorship,
  splitAuthorProof,
} from './messageAuthorship';
import { keySource, newTestAuthor, signedBy } from './messageAuthorship.testKit';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const GROUP = 'g-auth';
const HELLO = { messageId: 'm-1', sentAt: 1_700_000_000_000, text: { content: 'hello' } };

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
    expect(recordAuthorship(plaintext, GROUP, 'verified')).toEqual({
      body: toBase64(body),
      proof: toBase64(proof),
      group: GROUP,
    });
  });

  it('records nothing for an unsigned frame or bytes that are not protobuf', () => {
    expect(recordAuthorship(encodeAppMessage(HELLO), GROUP, 'unsigned')).toBeUndefined();
    expect(recordAuthorship(new Uint8Array([0xff, 0xff, 0xff]), GROUP, 'unsigned')).toBeUndefined();
  });
});

describe('recording a decrypted frame takes the verdict mls-core gave it', () => {
  // A group field (wire types 3 and 4) before a field 14: mls-core's parser reads no group, so it
  // finds no trailer and answers `unsigned` - while protobufjs skips the group and DOES find one.
  // The two parsers disagree; only the verdict decides what is kept.
  function withGroupField(): Uint8Array {
    const body = encodeAppMessage(HELLO);
    const proof = canari.AuthorProof.encode({
      version: 1,
      author: 'someone:else',
      signature: new Uint8Array(64),
    }).finish();
    const group = [0x7b, 0x7c]; // field 15 start-group, end-group
    return new Uint8Array([...body, ...group, 0x72, proof.length, ...proof]);
  }

  it('keeps no proof mls-core did not verify, even one this parser would find', () => {
    const plaintext = withGroupField();
    expect(splitAuthorProof(plaintext)).not.toBeNull();
    expect(recordAuthorship(plaintext, GROUP, 'unsigned')).toBeUndefined();
    expect(recordAuthorship(plaintext, GROUP, 'refused')).toBeUndefined();
    expect(recordAuthorship(plaintext, GROUP, undefined)).toBeUndefined();
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

  it('names its author in the ONE canonical form - ASCII letters lowered, nothing else', async () => {
    const elise = await newTestAuthor('Élise:dev-e');
    const check = await checkRecordedAuthorship(
      keySource({ tree: [elise] }),
      GROUP,
      await signedBy(elise, GROUP, HELLO)
    );
    expect(check.kind === 'verified' && check.authorUserId).toBe('Élise');
    const alice = await newTestAuthor('ALICE:dev-a');
    const ascii = await checkRecordedAuthorship(
      keySource({ tree: [alice] }),
      GROUP,
      await signedBy(alice, GROUP, HELLO)
    );
    expect(ascii.kind === 'verified' && ascii.authorUserId).toBe('alice');
  });

  it('asks for the pin under the canonical identity, as Rust keys it', async () => {
    const alice = await newTestAuthor('Alice:dev-a');
    const check = await checkRecordedAuthorship(
      keySource({ pinned: [alice] }),
      GROUP,
      await signedBy(alice, GROUP, HELLO)
    );
    expect(check.kind === 'verified' && check.source).toBe('pinned');
  });

  it('neither verifies nor accuses a proof naming no single device - a bare legacy id, or two colons', async () => {
    // A bare `userId` names a user and no device, so no key can be ITS key. And it says nothing
    // about forgery: a signing build always signs as its credential (`user:device`), but nothing
    // here proves a user id can never hold a colon - so such a proof reads as unsigned.
    for (const identity of ['alice', 'a:b:dev']) {
      const author = await newTestAuthor(identity);
      const check = await checkRecordedAuthorship(
        keySource({ tree: [author], pinned: [author] }),
        GROUP,
        await signedBy(author, GROUP, HELLO)
      );
      expect(check.kind).toBe('unproven');
    }
  });

  it('names the group a proof was signed in, so a replay elsewhere is never taken for this one', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, 'g-elsewhere', HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, rec);
    expect(check.kind === 'verified' && check.group).toBe('g-elsewhere');
  });

  it('never verifies a proof whose recorded group was rewritten to this conversation', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, 'g-elsewhere', HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, {
      ...rec,
      group: GROUP,
    });
    expect(check.kind).toBe('unproven');
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

  it('never verifies a body whose text or timestamp was changed after signing', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    for (const altered of [
      { ...HELLO, text: { content: 'goodbye' } },
      { ...HELLO, sentAt: HELLO.sentAt + 1 },
    ]) {
      const forged = { ...rec, body: toBase64(encodeAppMessage(altered)) };
      expect(
        (await checkRecordedAuthorship(keySource({ tree: [alice] }), GROUP, forged)).kind
      ).toBe('unproven');
    }
  });

  it('never verifies a proof signed by one member in another member name', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const mallory = await newTestAuthor('mallory:dev-m');
    // Mallory signs with HER key, claiming to be alice: alice's key does not verify it.
    const rec = await signedBy(mallory, GROUP, HELLO, { claim: 'alice:dev-a' });
    const check = await checkRecordedAuthorship(keySource({ tree: [alice, mallory] }), GROUP, rec);
    expect(check.kind).toBe('unproven');
  });

  it('neither verifies nor accuses an author with no leaf in the tree - the server is no evidence', async () => {
    // A ghost device the server could publish a key for, or an honest author whose keys an erasure
    // deleted: with no TRUSTED key, both read the same - unproven, never verified, never forged.
    const ghost = await newTestAuthor('alice:dev-ghost');
    const rec = await signedBy(ghost, GROUP, HELLO);
    const check = await checkRecordedAuthorship(keySource({ tree: [] }), GROUP, rec);
    expect(check.kind).toBe('unproven');
  });

  it('verifies an author who has left the tree under the key this device pinned for it', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(
      keySource({ tree: [], pinned: [alice] }),
      GROUP,
      rec
    );
    expect(check.kind === 'verified' && check.source).toBe('pinned');
  });

  it('keeps a ghost device unverified - neither in the tree nor pinned', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const ghost = await newTestAuthor('alice:dev-ghost');
    const rec = await signedBy(ghost, GROUP, HELLO);
    // Alice's real device is pinned; the ghost device the proof names is not.
    const check = await checkRecordedAuthorship(
      keySource({ tree: [], pinned: [alice] }),
      GROUP,
      rec
    );
    expect(check.kind).toBe('unproven');
  });

  it('does not accuse on an unanchored pin that contradicts the signature', async () => {
    // A pin may have been re-taken from a server-served key by a heal past the pin cap: a genuine
    // old signature under the real key must not read as a forgery.
    const alice = await newTestAuthor('alice:dev-a');
    const substitute = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(
      keySource({ tree: [], pinned: [substitute], anchored: false }),
      GROUP,
      rec
    );
    expect(check.kind).toBe('unproven');
  });

  it('accuses when an ANCHORED pin contradicts the signature', async () => {
    const alice = await newTestAuthor('alice:dev-a');
    const substitute = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(substitute, GROUP, HELLO);
    const check = await checkRecordedAuthorship(
      keySource({ tree: [], pinned: [alice], anchored: true }),
      GROUP,
      rec
    );
    expect(check.kind).toBe('forged');
  });

  it('does not accuse on a current tree key - it may come from a re-Welcome, not the message epoch', async () => {
    // A re-Welcome tree carries whatever leaf the device holds NOW; the proof names no epoch, so the
    // current tree cannot say it is the tree the message was sent in.
    const alice = await newTestAuthor('alice:dev-a');
    const rewelcomed = await newTestAuthor('alice:dev-a');
    const rec = await signedBy(alice, GROUP, HELLO);
    const check = await checkRecordedAuthorship(
      keySource({ tree: [rewelcomed], pinned: [rewelcomed], anchored: false }),
      GROUP,
      rec
    );
    expect(check.kind).toBe('unproven');
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
