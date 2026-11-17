/**
 * A HISTORY ANSWER SEALED TO THE DEVICE THAT ASKED - option B of the P1 "a new member of a group
 * conversation receives its whole past" (docs/wiki/protocols/history-answer-addressing.md, "Sealing
 * the answer to the asker").
 *
 * Step A routes every history answer to the asking device alone, but MLS encrypts it for the whole
 * group: a server that hands the row to another member's device hands it something that device can
 * read. Sealing takes the server out of that trust:
 *
 * - every ask (`history_digest`, `history_pull`, `history_range`) carries `answerKey`, the public
 *   half of an X25519 pair minted for THAT ask, inside the asker's MLS-signed frame;
 * - the answerer seals the answer's CONTENT (messages and conversation state) to it with HPKE; the
 *   frame keeps only what routes it (`to`, `requestId`, `last`) beside the sealed bytes;
 * - the asker opens it with the secret it kept beside the open ask (`historyAddressing.ts`), in
 *   memory, and the secret dies with the ask.
 *
 * The crypto is `mls-core/src/history_seal.rs`, the one implementation on every platform, reached
 * through a {@link HistorySealEngine} (the WASM exports on the web, Tauri commands on the phones).
 * This module holds what is the SAME on both: the AAD, the content's encoding, and the typed refusal.
 */
import { fromBase64, toBase64 } from '$lib/utils/hex';

/** An X25519 public key, as an ask carries it (before base64). */
export const HISTORY_ANSWER_KEY_BYTES = 32;

/** The engine's refusal codes (`HistorySealError::code`). */
export type HistorySealCode =
  | 'malformed-public-key'
  | 'malformed-secret-key'
  | 'malformed-sealed'
  | 'refused'
  | 'randomness';

/** The three operations a sealed answer needs, supplied by the platform's MLS engine. */
export interface HistorySealEngine {
  /** Mints the pair of ONE ask: the secret stays beside the open ask, the public half travels. */
  newAnswerKeyPair(): Promise<{ secret: Uint8Array; publicKey: Uint8Array }>;
  /** Seals `plaintext` to `publicKey`, bound to `aad` (HPKE base mode). */
  seal(publicKey: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Opens what {@link seal} produced; rejects with the engine's code when it does not open. */
  open(secret: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>;
}

/**
 * A sealed answer that could not be sealed or opened, classified by the engine's CODE at the
 * boundary - so no caller reads a sentence to tell a forged answer from a broken bridge. Beyond the
 * engine's own codes: `contract` is OUR engine failing (a rejection that is no known code - a broken
 * bridge, a missing export), and `malformed-content` is bytes that opened under our ask to something
 * that is not an answer's content (the answerer's fault, never ours).
 */
export class HistorySealError extends Error {
  constructor(
    readonly code: HistorySealCode | 'contract' | 'malformed-content',
    detail: string
  ) {
    super(`[HISTORY_SEAL] ${code}: ${detail}`);
    this.name = 'HistorySealError';
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<HistorySealCode>([
  'malformed-public-key',
  'malformed-secret-key',
  'malformed-sealed',
  'refused',
  'randomness',
]);

/**
 * Types a rejection of an engine call. The engines reject with the bare code (a string); anything
 * else is a broken bridge (`contract`), never a verdict about the bytes.
 */
function historySealErrorOf(e: unknown): HistorySealError {
  if (e instanceof HistorySealError) return e;
  const raw = String(e);
  return KNOWN_CODES.has(raw)
    ? new HistorySealError(raw as HistorySealCode, 'the engine refused')
    : new HistorySealError('contract', raw.slice(0, 120));
}

/**
 * The `answerKey` an ask carries, or `undefined` when it carries none usable: absent (an asker that
 * predates sealing), or anything but the base64 of {@link HISTORY_ANSWER_KEY_BYTES} bytes. Checked
 * where it enters, so a malformed key never reaches the engine.
 */
export function parseHistoryAnswerKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    return undefined;
  }
  try {
    return fromBase64(raw).length === HISTORY_ANSWER_KEY_BYTES ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The AAD a sealed answer is bound to: the conversation, the ask, the asker and the ANSWERER - its
 * user AND device, as `digestIdentity` spells them, the identity the open ask counts its answerers
 * by (`takeAddressedAsk`) and the one MLS verified on receipt. A sealed answer relayed by another
 * member inside its own MLS frame, replayed into another ask or another conversation, therefore does
 * not open. Identities compare case-insensitively everywhere in this protocol, so they are lowered.
 */
export function historySealAad(
  groupId: string,
  requestId: string,
  asker: string,
  answerer: string
): Uint8Array {
  return new TextEncoder().encode(
    `canari-history-answer-v1|${groupId}|${requestId}|${asker.toLowerCase()}|${answerer.toLowerCase()}`
  );
}

/** Seals an answer's content object to `answerKey` (base64); answers the sealed bytes, base64. */
export async function sealHistoryContent(
  engine: HistorySealEngine,
  answerKey: string,
  aad: Uint8Array,
  content: Record<string, unknown>
): Promise<string> {
  try {
    const sealed = await engine.seal(
      fromBase64(answerKey),
      aad,
      new TextEncoder().encode(JSON.stringify(content))
    );
    return toBase64(sealed);
  } catch (e) {
    throw historySealErrorOf(e);
  }
}

/**
 * Opens a sealed answer's content. Rejects with a {@link HistorySealError}: `refused` for bytes that
 * do not open under this ask, `malformed-sealed` for bytes that are no sealed answer,
 * `malformed-content` for a plaintext that is not a JSON object (an honest answerer seals one), and
 * `contract` when our own engine failed.
 */
export async function openHistoryContent(
  engine: HistorySealEngine,
  secret: Uint8Array,
  aad: Uint8Array,
  sealedB64: string
): Promise<Record<string, unknown>> {
  let sealed: Uint8Array;
  try {
    sealed = fromBase64(sealedB64);
  } catch {
    throw new HistorySealError('malformed-sealed', 'not base64');
  }
  let plain: Uint8Array;
  try {
    plain = await engine.open(secret, aad, sealed);
  } catch (e) {
    throw historySealErrorOf(e);
  }
  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new HistorySealError('malformed-content', 'the opened content is not JSON');
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new HistorySealError('malformed-content', 'the opened content is not an object');
  }
  return content as Record<string, unknown>;
}

/** The key one ask carries (`answerKey`, base64) and the secret its asker keeps beside it. */
export type HistoryAnswerKey = { answerKey: string; secret: Uint8Array };

/**
 * Mints the key of ONE ask. Rejects with a {@link HistorySealError}: an engine that cannot mint is a
 * defect of this build, and the ask is then not sent - never sent without a key, which would invite
 * an unsealed answer this device asked not to receive.
 */
export async function mintHistoryAnswerKey(engine: HistorySealEngine): Promise<HistoryAnswerKey> {
  try {
    const pair = await engine.newAnswerKeyPair();
    return { answerKey: toBase64(pair.publicKey), secret: pair.secret };
  } catch (e) {
    throw historySealErrorOf(e);
  }
}
