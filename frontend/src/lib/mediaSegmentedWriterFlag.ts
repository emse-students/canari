/**
 * THE WRITER FLIP - `true` SINCE 2026-10-05 (user's go, `minClientVersion` 1.0.0, both stores on 1.0.x); `false` WAS THE WHOLE OF ITS SAFETY.
 *
 * A client older than the reader (`1.0.0`, #1295), handed a segmented blob, decrypts it as ONE GCM
 * block: the header and every tag are fed in as ciphertext, the final tag fails, and the member
 * sees a broken video that their own phone, not the sender's, is at fault for. So the format ships
 * in two releases, as Graine v2 (channel-encryption section 21) and the state blob's framing did:
 *
 * 1. The reader release reads the format everywhere it is read (web and both app shells, which
 *    embed the same frontend) and writes nothing in it.
 * 2. The flip to `true` is THIS ONE LINE, and it may land only when ALL of these hold:
 *    - `minClientVersion` (the box's `/version`) is at or above the release carrying the reader, so
 *      no client that cannot read a segmented blob is still allowed to connect. **Raising it is the
 *      USER's decision, never an agent's**;
 *    - BOTH stores serve that version - measured with `bun tools/play-vitals/vitals.mjs` and the App
 *      Store, never inferred from a date;
 *    - the media-service serving the estate answers `206` to a `Range` request (shipped with the
 *      reader, `media.controller.ts`), since the streaming reader refuses a `200`.
 *
 * The flip needs no other change: `writesSegmented` and the upload ceiling (`uploadLimits`) read
 * this binding, and `media.segmentedWriter.e2e.test.ts` runs the whole path - prepared video,
 * segmented upload, ranged streaming, seek, whole-blob read - with it ON, so the day it is flipped
 * the path has already been exercised. Only VIDEO is segmented even then (`writesSegmented`).
 * The gate is written down in docs/wiki/services/media-service.md ("The writer flip").
 */
export const SEGMENTED_MEDIA_WRITER_ENABLED = true;
