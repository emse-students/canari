/**
 * The numbers and labels the Graine protocol is defined by, in one place.
 *
 * Graine is megolm's shape - a per-sender session seed, distributed out of band, rotated on
 * departure - with an MLS group per community as the sealing transport. The design, its
 * measurements and the alternatives it rules out are in
 * `docs/wiki/protocols/channel-encryption.md`; this module is only the constants, so that a value
 * can never mean one thing in the sender and another in the receiver.
 *
 * **The one copy that cannot live here is the native mirror's** (Rust, Kotlin, Swift): a push is
 * decrypted before any WebView runs, so {@link GRAINE_HKDF_INFO} has to be spelled out again on
 * that side. It is the ONLY duplicate, it is deliberate, and it is why the label is a versioned
 * string rather than a bare name - changing it is a protocol change that must be visible in a diff
 * on both sides at once.
 */

/**
 * HKDF `info` for every Graine derivation, and the wire version of the protocol.
 *
 * Deliberately NOT `canari-channel-e2ee-v1`, which the server-derived epoch keys use. Sharing an
 * info string between two mechanisms is what makes a dead one look like the live one while
 * reading - `soft-crypto.ts` did exactly that and was deleted for it (2026-08-17).
 */
export const GRAINE_HKDF_INFO = 'canari-graine-v1';

/** Seed size. 32 bytes because every key derived from it is an AES-256 key. */
export const GRAINE_SEED_BYTES = 32;

/** AES-256-GCM, matching the CEK and the MLS exporter secret used everywhere else here. */
export const GRAINE_MESSAGE_KEY_BYTES = 32;

/** AES-GCM nonce, 96 bits - the size the WebCrypto implementation is specified for. */
export const GRAINE_NONCE_BYTES = 12;

/**
 * Rotation thresholds. Both exist to bound the blast radius of ONE recovered seed, and neither
 * deletes anything: an old seed keeps opening old messages for ever, which is what makes reading
 * the past possible at all.
 *
 * The message count slices a talkative sender; the age slices a rare one, whom a counter would
 * never reach. Matrix's values, which are field-proven at a far larger scale than this.
 *
 * The third trigger - a member leaving - is the only structural one and has no constant: it is an
 * event, and it is what makes leaving a community mean something.
 */
export const GRAINE_ROTATE_AFTER_MESSAGES = 100;
export const GRAINE_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The tighter caps of a session RE-DISTRIBUTED at least once, i.e. kept across an epoch move
 * because nobody left (`docs/wiki/protocols/graine-removal-tracker.md`, the named residual).
 *
 * Rotating on every Add used to bound a stolen copy of a device's seeds by accident; reuse removes
 * that, so these are the stated bound instead: a day, not a week. 50 is above the p99 of messages one
 * sender writes in one salon in one day (38, production 2026-10-22), so the age cap is the one that
 * normally fires. Counted from the MINT, never from the last re-distribution.
 */
export const GRAINE_REUSED_ROTATE_AFTER_MESSAGES = 50;
export const GRAINE_REUSED_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How many sessions per channel the NATIVE mirror keeps, the durable store holding the rest.
 *
 * The mirror exists for exactly one job - decrypting an incoming push before any WebView runs - so
 * it only ever needs the recent end. Epoch keys were few and could be kept whole; seeds accumulate
 * for ever, in an app-private JSON file rewritten on every rotation, which is unbounded growth
 * waiting for a year to pass. A seed too old to be mirrored is not a failure: the notification
 * degrades to a generic "new message", which is the existing behaviour and the correct one.
 */
export const GRAINE_NATIVE_MIRROR_SESSIONS_PER_CHANNEL = 20;

/**
 * Ceiling on the seeds one ANSWER may carry, across all of its pages.
 *
 * Sized on 2026-08-17 for a one-year community with 30 active senders rotating weekly: ~1 500 seeds
 * at ~50 bytes each, about 80 KB in one message. Both factors were wrong by 2026-10-21: a v2 seed is
 * ~330 bytes on the wire and adds rotate sessions (`docs/wiki/protocols/dm-vs-community-encryption.md`).
 * Since 2026-10-22 it no longer bounds a MESSAGE - {@link GRAINE_BUNDLE_PAGE_MAX_BYTES} does - only
 * the work of one answer: ~2.6 MB in about eleven pages. Reaching it is a REFUSAL stated on the
 * wire (`truncated`) rather than a silent cut - a bundle quietly cut short would read as "this is
 * all the history there is", which is the exact silence this protocol exists to remove.
 */
export const GRAINE_HISTORY_BUNDLE_MAX_SEEDS = 8000;

/**
 * Ceiling on the `page_count` of one answer that a RECEIVER believes - the most pages an honest
 * answerer can write, derived rather than chosen.
 *
 * `pageGraineBundle` puts at least one entry (a seed or a declined session id) on every page, and an
 * answer carries at most {@link GRAINE_HISTORY_BUNDLE_MAX_SEEDS} entries: a history answer at most
 * that many seeds and no decline, a named request at most that many ids split between seeds and
 * declines (`gatherNamedSessions` reads only the first {@link GRAINE_HISTORY_BUNDLE_MAX_SEEDS}). So no
 * honest answer has more pages than that, and in practice it has about eleven.
 *
 * The count arrives as a `uint32` from ANY member of the key group, and the receiver walks and
 * stores page numbers up to it (`pagedHistoryAnswer.ts`) - so a count above this is refused, never
 * allocated by.
 */
export const GRAINE_BUNDLE_MAX_PAGES = GRAINE_HISTORY_BUNDLE_MAX_SEEDS;

/**
 * Ceiling on ONE bundle message, in bytes of the encoded `AppMessage` handed to MLS - so an answer
 * larger than this is sent as several pages (`GraineBundleMsg.page_index` / `page_count`).
 *
 * A seed count could not bound a message once a seed was ~330 bytes and its identifiers free to
 * grow. Every hop the frame crosses, read from code and config on 2026-10-22 (the frame travels as
 * base64 of the MLS frame, which adds 165-170 bytes of framing to its plaintext, measured; no
 * padding is configured):
 *
 * | Hop | Limit |
 * | --- | --- |
 * | `POST /api/mls/send`, nginx `client_max_body_size` | 100 MB |
 * | chat-delivery `bodyParser.json` | 10 MB of JSON |
 * | `queued_message.proto` (Postgres `varchar`, no length) | 1 GB |
 * | Redis `chat:messages` publish to the gateway | 512 MB |
 * | gateway -> device WebSocket (tungstenite defaults on both ends, no override) | 16 MiB frame, 64 MiB message |
 * | **the pending-queue page, `PENDING_PAGE_MAX_BYTES`** | **1 MiB of base64** |
 * | a push carrying the ciphertext inline | ~3.7 KB - never a bundle page; fetched by `queuedMessageId` |
 *
 * The binding hop is the pending page: it is the unit an offline device catches up in, sized to
 * cross a poor mobile link, and a single row larger than it is still delivered, alone and over
 * budget. A page is sized so that THREE fit one pending page, so a page never crowds a catch-up:
 *
 * - three base64 frames fit 1 048 576 characters when each is <= 349 525, i.e. each MLS frame is
 *   <= 262 143 bytes (4 x ceil(262 143 / 3) = 349 524);
 * - 255 KiB = 261 120 bytes of plaintext leaves 1 023 bytes for MLS framing, which measures 170
 *   (`frontend/mls-core/tests/application_frame_overhead.rs` pins it): a full page is a 261 290-byte
 *   frame, 348 388 base64 characters, three of them 1 045 164 - 3 412 under the pending page.
 *
 * 256 KiB did NOT fit three: its frame is 349 752 characters, three of them 680 over. Against the
 * 10 MB body limit a page is 1/29. Today's largest community (~150 KB) still answers in one message.
 */
export const GRAINE_BUNDLE_PAGE_MAX_BYTES = 255 * 1024;

/**
 * What a community lets a newcomer read. Per community, not per channel: a member belongs to the
 * community, and a rule that differed per salon would be a rule nobody could state.
 *
 * `shared` is the default and hands over the past. `joined` is for a sensitive community and hands
 * over nothing written before the join. The consequence of `shared` is deliberate and recorded:
 * "read the past" and "the past's keys disappear" cannot both be true, in any protocol.
 */
export type GraineHistoryVisibility = 'shared' | 'joined';

export const GRAINE_DEFAULT_HISTORY_VISIBILITY: GraineHistoryVisibility = 'shared';

/**
 * Graine v2's two domain labels (channel-encryption §21). Each begins the structure it names, as a
 * length-prefixed field, so a message signature can never verify as an endorsement or the reverse -
 * and, through that leading length, no Graine structure can ever be an MLS `SignContent` (see
 * `mls-core/src/graine_signature.rs`). Mirrored by `mobile/graine.rs`, held by the shared vectors.
 */
export const GRAINE_V2_HEADER_LABEL = 'canari-graine-v2';
export const GRAINE_V2_ENDORSEMENT_LABEL = 'canari-graine-v2-endorse';

/** Ed25519 sizes: a session or device public key, and a signature. */
export const GRAINE_PUBLIC_KEY_BYTES = 32;
export const GRAINE_SIGNATURE_BYTES = 64;
