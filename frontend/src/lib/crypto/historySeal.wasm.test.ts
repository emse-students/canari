/**
 * Option B against the BUILT engine: the TS half of a sealed history answer (`historySeal.ts` - the
 * AAD, the content encoding, the typed refusal) on the real WASM exports of
 * `mls-core/src/history_seal.rs`, not on the fake the surrounding tests use. The WASM is a build
 * artefact (`bun run generate` locally, `build-mls-wasm` in CI before the frontend tests); it is
 * required, never skipped.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as wasm from '$lib/wasm/mls_wasm.js';
import {
  HISTORY_ANSWER_KEY_BYTES,
  HistorySealError,
  historySealAad,
  mintHistoryAnswerKey,
  openHistoryContent,
  parseHistoryAnswerKey,
  sealHistoryContent,
  type HistorySealEngine,
} from './historySeal';

beforeAll(() => {
  const bytes = readFileSync(fileURLToPath(new URL('../wasm/mls_wasm_bg.wasm', import.meta.url)));
  wasm.initSync({ module: bytes });
});

/** The web engine's shape over the synchronous exports (`wasmHistorySealEngine` awaits a loader). */
const engine: HistorySealEngine = {
  async newAnswerKeyPair() {
    const pair = wasm.history_answer_keypair() as { secret: Uint8Array; public: Uint8Array };
    return { secret: pair.secret, publicKey: pair.public };
  },
  async seal(publicKey, aad, plaintext) {
    return wasm.seal_history_answer(publicKey, aad, plaintext);
  },
  async open(secret, aad, sealed) {
    return wasm.open_history_answer(secret, aad, sealed);
  },
};

const AAD = historySealAad('group-1', 'req-00000001', 'Alice:phone', 'Bob-Laptop');
const CONTENT = { messages: [{ id: 'm1', content: 'hello', timestamp: 1 }], floor: 5 };

describe('a history answer sealed by the built engine', () => {
  it('opens with the secret of the key the ask carried, to the content that was sealed', async () => {
    const key = await mintHistoryAnswerKey(engine);
    expect(parseHistoryAnswerKey(key.answerKey)).toBe(key.answerKey);

    const sealed = await sealHistoryContent(engine, key.answerKey, AAD, CONTENT);

    expect(await openHistoryContent(engine, key.secret, AAD, sealed)).toEqual(CONTENT);
  });

  it('does not open with another ask secret: refused, by its code', async () => {
    const asker = await mintHistoryAnswerKey(engine);
    const other = await mintHistoryAnswerKey(engine);
    const sealed = await sealHistoryContent(engine, asker.answerKey, AAD, CONTENT);

    await expect(openHistoryContent(engine, other.secret, AAD, sealed)).rejects.toMatchObject({
      code: 'refused',
    });
  });

  it('does not open when relayed by another device, into another ask or another conversation', async () => {
    const key = await mintHistoryAnswerKey(engine);
    const sealed = await sealHistoryContent(engine, key.answerKey, AAD, CONTENT);

    for (const aad of [
      historySealAad('group-1', 'req-00000001', 'alice:phone', 'carol-tablet'),
      historySealAad('group-1', 'req-00000002', 'alice:phone', 'bob-laptop'),
      historySealAad('group-2', 'req-00000001', 'alice:phone', 'bob-laptop'),
    ]) {
      const refusal = await openHistoryContent(engine, key.secret, aad, sealed).catch((e) => e);
      expect(refusal).toBeInstanceOf(HistorySealError);
      expect(refusal.code).toBe('refused');
    }
  });

  it('binds identities case-insensitively, as the protocol compares them', async () => {
    const key = await mintHistoryAnswerKey(engine);
    const sealed = await sealHistoryContent(engine, key.answerKey, AAD, CONTENT);

    const lowered = historySealAad('group-1', 'req-00000001', 'alice:phone', 'bob-laptop');
    expect(await openHistoryContent(engine, key.secret, lowered, sealed)).toEqual(CONTENT);
  });

  it('types bytes that are no sealed answer as malformed, never as a refusal', async () => {
    const key = await mintHistoryAnswerKey(engine);

    await expect(openHistoryContent(engine, key.secret, AAD, 'AAAA')).rejects.toMatchObject({
      code: 'malformed-sealed',
    });
  });
});

describe('parseHistoryAnswerKey', () => {
  it(`accepts the base64 of ${HISTORY_ANSWER_KEY_BYTES} bytes and nothing else`, () => {
    const good = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    expect(parseHistoryAnswerKey(good)).toBe(good);
    expect(parseHistoryAnswerKey(btoa('short'))).toBeUndefined();
    expect(parseHistoryAnswerKey(`${good.slice(0, 43)}!`)).toBeUndefined();
    expect(parseHistoryAnswerKey(42)).toBeUndefined();
    expect(parseHistoryAnswerKey(undefined)).toBeUndefined();
  });
});
