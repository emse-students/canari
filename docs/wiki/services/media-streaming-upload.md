# Media streaming upload and download - bounded memory, parts under 8 MiB

**Status: DESIGN; WP-S0 DONE 2026-10-10 (results in section 9, which CHANGES the design: the Tauri transport, 9.2). WP-S1 (the server session routes) is BUILT, awaiting review ([media-service](media-service.md#upload-sessions-streamed-resumable-every-body-under-8-mib-wp-s1-2026-10-10)); S2 onward and the streamed GET are not.** Decisions taken by delegation, overridable: parts 4 MiB plaintext (about 4 MiB + 64 B on the wire), hard server cap 8 MiB, the 50 MB ceiling stays, resume window 24 h, the CEK may persist in the outbox row later (client WP). Trigger: the prod host's CrowdSec AppSec (school-managed
nginx, not ours) answers `403 CrowdSec Ban` to any request body over 10 MiB (10,485,760 bytes); a 13.4 MB
PDF failed because `encryptAndUpload` sends one multipart POST. A quick fix (single-block threshold
lowered, the existing append route for the rest, an explicit error state) is in flight elsewhere; this page
is the general solution it is a stopgap for. Every figure is tagged **read** (from the code named),
**computed** (arithmetic on read values) or **owed** (needs a device or a bench, WP-S0).

## 1. Today, end to end - where the whole file sits in RAM

| Step | What happens (read) | Whole-file copies |
| --- | --- | --- |
| Pick or outbox | A chat attachment goes through the outbox: `OutboxEntry.media.fileBytes` is a `Uint8Array` in the IndexedDB row, and `sessionAuth.uploadMedia` wraps it in a NEW `File` (`new File([bytes.buffer], ...)`) | 1-2 |
| Video prep | `prepareVideoForUpload` writes into `new mb.BufferTarget()` - the prepared file is built in RAM | 1 |
| Encrypt | `encryptAndUpload`: `file.arrayBuffer()` (plaintext), then `encryptMediaBuffer` / `encryptSegmentedMedia` allocates the WHOLE ciphertext (`new Uint8Array(segmentedCiphertextLength)`) | 2 (plaintext + ciphertext) |
| Send | `new Blob([ciphertext])` inside a `FormData`, one `fetch` POST to `/api/media/upload`; `ciphertext.byteLength > 50 MiB` is the ONLY chunk trigger and the server ceiling is 50 MB, so **the chunk path is unreachable in practice** | +1 (Blob, may spill to disk) |
| Server | `FileInterceptor('file', {storage: undefined})` is multer MEMORY storage: whole body as a `Buffer`; `storage.put` wraps it in `Readable.from(data)` | 1-2 |
| Server, chunk route | `FileInterceptor('chunk')` also memory (limit 50 MB per chunk); `appendChunk` appends to a staging file with NO chunk index, so a retried chunk is appended twice; no route says how many bytes the server holds | 1 chunk |
| Download | `GET /api/media/:id` `readStreamToBuffer` - the whole object in a `Buffer`, then `res.send` (a `Range` is served from `getPartialObject` but still buffered, one segment at a time) | 1 |
| Client download | `res.arrayBuffer()` (ciphertext), `cache.put(new Response(ciphertext))`, then `decryptByEncoding` produces the plaintext, then a Blob for the object URL | 3-4 |

**Computed, a 13.4 MB PDF on the phone:** about 3 whole copies at upload (plaintext, ciphertext, Blob)
plus the outbox copy, i.e. 40-55 MB resident; at the 50 MB ceiling 150-250 MB, on a Mi 9T (a 4 GB phone
whose WebView is killed well below that) a real risk. Server: ~2x the body per concurrent upload, so ten
concurrent 50 MB uploads hold up to 1 GB in a container (limit not read). **Measured (WP-S0, 9.2):** the crypto copies are as computed (+66 MiB renderer at 13.4 MB); the real
cost on the phone is the HTTP plugin, 45-85x the body, and a 50 MB upload KILLS the app.

Two defects found on the way, independent of CrowdSec: the append route is **not idempotent** (a response
lost after a successful write duplicates the chunk and corrupts the blob), and `complete` is not
idempotent either (a lost answer leaves the client with no `mediaId` and a staged file consumed).

## 2. MiGallery - what to take, what to leave

Read in `F:/Programmation/EMSE/MiGallery`: `src/lib/album-operations.ts` (client) and
`src/routes/api/immich/[...path]/+server.ts` (`handleChunkedUpload`).

| Mechanism | MiGallery (read) | For Canari |
| --- | --- | --- |
| Threshold | `SIMPLE_UPLOAD_THRESHOLD = 10 MB` - EXACTLY the limit CrowdSec/Cloudflare-style edges apply (its comment: "to bypass Cloudflare limits") | Take the idea, not the number: the threshold must sit with a margin, see section 3 |
| Part size | `CHUNK_SIZE = 5 MB`, a constant duplicated in client and server ("must match") | Parts 4 MiB, ONE constant, and the part size travels in `init` so the server never assumes it |
| No RAM for the source | `file.slice(start, end)` is a lazy Blob; bytes are read only when fetched. Sent as the raw body (`Content-Type: application/octet-stream`), no multipart | Take: raw body, `File.slice`. Canari must also SEAL each part, so one part (plaintext + ciphertext) is in RAM, never the file |
| Resume | `GET ?chunk-status=1` with `x-file-id` answers `receivedBytes`; the client restarts at `floor(received / CHUNK)`; file id = SHA-256 of `name-size-lastModified` so a retry finds its own partial | Take the status route and "a fact the server reports". Leave the id: it is guessable and not bound to a member; Canari uses the server-issued `uploadId` |
| Per-chunk integrity | `x-chunk-sha256`, verified server-side | Leave: the GCM tag of each segment already authenticates every byte end to end, and TLS covers the hop |
| Server assembly | The proxy buffers each 5 MB chunk (`request.arrayBuffer()`, because adapter-node exposed a null body stream), appends with `flag 'a'`, then streams the assembled file onward | Take "write to disk, stream the finish". Leave the buffering and the append: Canari writes each part at its OFFSET from the request stream |
| Failure modes it found | A request that failed AFTER writing its chunk made the client retry while the server had moved on; the "last chunk" check is only `assembled >= (n-1) * CHUNK` (found live 2026-09-28, truncated result handed on) | Positional writes make a retry idempotent; completion checks the EXACT declared size and every part present |
| Hygiene | 10-min stale-lock takeover, 48 h sweep of `.part` files, run on chunk 0 | Canari already has the 24 h orphan sweep and a per-id promise lock; keep them |

What MiGallery does NOT do: encrypt per chunk, bound its own server memory beyond one 5 MB chunk, or
stream the download. Its design answers the edge limit; Canari's answer must also be E2E and bounded.

## 3. The design

### 3.1 The format is the one already shipped - only the writer changes

`segmented-v1` ([media-service](media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01))
is already the requested construction: 1 MiB segments, AES-256-GCM, `nonce_i = iv[0..7] || be32(i) ||
last-flag` (STREAM), header as additional data, fresh CEK per file, readers shipped (floor `1.0.0`), writer
ON for video since 2026-10-05. **No new envelope, no new reader**: a blob written by the streaming writer is
byte-identical to what `encryptSegmentedMedia` produces, so the whole-blob reader, the ranged reader and the
MSE stream read it as they do today. The work is the writer's MEMORY profile and the transport.

Why this is possible: `segmentedCiphertextLength` depends only on the plaintext length, known up front
from a `File`/`Blob`, and sealing segment `i` needs only the CEK, the IV, the header and segment `i`.

### 3.2 Parts - the transport unit, distinct from the segment

- **Part = 4 segments = 4 MiB of plaintext = 4 MiB + 64 B of ciphertext** (the last part is shorter). A
  part holds WHOLE sealed segments, so the server never needs to know the cipher.
- **Hard invariant: no request body over 8 MiB**, at the client AND the server (`413` on a part over
  `PART_MAX_BYTES = 8 MiB`). 8 MiB leaves 2 MiB under the 10 MiB drop, absorbing the framing a proxy adds.
- **A file whose ciphertext fits one 8 MiB - 64 KiB request stays ONE single-block POST, as today**: same
  bytes, legacy readers read it, native push thumbnails of photos are kept (the NSE/FCM readers withhold
  the key when `encoding != 0`, so segmenting photos would lose them). Above it: a session. The margin is
  measured against the real multipart envelope in the body-size test (section 5), never assumed.
- Concurrency 2 parts in flight (a flag; 1 on a weak link), sealed on demand, never ahead.

### 3.3 Session routes (media-service, additive - the old chunk routes stay untouched)

| Route | Behaviour |
| --- | --- |
| `POST /api/media/upload/session` `{retentionClass, totalBytes, partBytes, header}` | Validates `totalBytes <= ceiling`, that `header` (the 20 public header bytes, hex) parses and that `segmentedCiphertextLength(header.plaintextLength) == totalBytes` - a keyless structural check; reserves the `chat-reel` budget as today; creates a sparse staging file; returns `{uploadId, partBytes, expiresAt}` |
| `PUT /api/media/upload/session/:id/parts/:index` | Raw `application/octet-stream` body, `Content-Length` REQUIRED and checked against the expected length of that part (`partBytes`, or the remainder for the last), body piped to an open handle written at `index * partBytes` (`fs.write` with a position, ~64 KiB buffers, no `FileInterceptor`). Idempotent: rewriting a part writes the same bytes. Marks the part in a small sidecar file |
| `GET /api/media/upload/session/:id` | `{totalBytes, partBytes, received: [indexes]}` - the server's fact, never the client's guess. Survives a media-service restart (sidecar on the same volume as the staging file) |
| `POST .../:id/complete` | Requires every part present and the file size equal to `totalBytes` EXACTLY; re-reads the first 20 bytes and checks them against the header declared at init; `fPutObject` from the staged file; remembers `uploadId -> mediaId` for 24 h so a repeated `complete` (lost answer) returns the same id |
| `DELETE .../:id` | Cancel: removes the staging file and RELEASES the reservation now rather than at the 24 h sweep |

Class, ownership and budget reuse the machinery of the `chat-reel` section: declared at `init`, a part past
the declared total is refused, completion by another member is `403`. New: a **cap of open sessions per
owner (4)**, because only `chat-reel` is bounded today (500 MB / 100 MB), and a `totalBytes` reservation
against a staging-volume budget.

### 3.4 Client writer

`encryptAndUpload(file, ...)` keeps its signature (REQUIRED class). Above the single-POST size it:
generates CEK and IV, builds the header from `file.size`, opens the session, then for each part: read
`file.slice(a, b)` (4 MiB), seal its 4 segments in order (segment `i` with `last = i === count - 1`),
`PUT` the part, drop both buffers. **Resume is deterministic**: sealing the same segment with the same CEK,
IV and plaintext yields the same bytes, so a part may be re-sealed and re-sent after any failure with no
nonce-reuse risk (same plaintext, same nonce). After a failure, `GET` the session, send only the missing
indexes. A killed app resumes from a persisted `{uploadId, keyHex, ivHex, fileHandle}` - the outbox row
already holds the file bytes in the clear today, so persisting the key adds no new exposure (confirm, Q5).
Progress is `received / totalParts`; cancel is `AbortController` plus the `DELETE`.

### 3.5 Streamed download and decrypt

- **Server**: `GET /api/media/:id` pipes `storage.get()` / `getRange()` to the response (`stream.pipe(res)`
  with `Content-Length`) instead of `readStreamToBuffer`; memory per download falls from the object size to
  the stream's high-water mark. Range behaviour, `206`, tombstones and the access clock stay as documented.
- **Client, files and images**: fetch ciphertext in `Range` parts of 4 MiB (2 in flight), open each
  segment as it lands (`openSegment`), append the plaintext to a list of Blobs, free the ciphertext. Peak =
  the plaintext (the browser may spill a Blob to disk) + 2 parts, instead of 3-4 whole copies. The ciphertext
  cache (`caches.put`) is fed from the response stream, never from a whole `ArrayBuffer`.
- **Video**: already streamed through MSE by `segmentedMediaReader` for refs naming codecs; the work is
  bounding what it keeps (SourceBuffer eviction behind the playhead - **owed, not read**) and not adopting
  the whole file into the blob pool for a stream nobody downloads.
- A single-block blob (every legacy ref, every photo under the threshold) is unchanged and read whole: AES-GCM
  cannot release a byte before its tag, so bounded memory is not available for it, and none is promised.

### 3.5b Memory bounds (computed; the tests of section 5 are what hold them)

| Side | Bound | Independent of file size |
| --- | --- | --- |
| Client upload | 2 parts in flight x (4 MiB plaintext + 4 MiB sealed) = 16 MiB worst, 8 MiB at concurrency 1 | yes |
| Client download | 2 ciphertext parts + the plaintext Blob list (+ 8 MiB) | the plaintext, not the ciphertext, is held |
| Server upload | 64 KiB stream buffers per open PUT; the staging file is on disk; no `Buffer` of a body | yes (was 1-2x the body) |
| Server download | the stream high-water mark per request (64 KiB) | yes (was 1x the object) |
| Server `complete` | **`fPutObject` does NOT stream below 64 MiB** (9.3): `partSize` defaults to 64 MiB, so any object up to the 50 MB ceiling is read whole into a `Buffer` (~2x). Bounded only with `partSize` set (>= 5 MiB) on the client | no, until S1 sets it |

## 4. Compatibility, retention, quotas

**Reader before writer (the repo rule).** The reader of the format is shipped and is the floor: the
segmented reader landed in `1.0.0`, `minClientVersion` is `1.0.0`, both stores serve 1.0.x, and the writer
has been on since 2026-10-05 (user's go). Streaming therefore needs NO new reader and NO floor raise for
VIDEO. For other types above the single-POST size (PDF, audio, files) the writer now emits `segmented-v1`
where it emitted single-block: acceptable only if every surface that persists a ref CARRIES `encoding`.
`MediaRef` (chat, proto field 12) and a post's `images[].encoding` do; **the audit is DONE (9.1): comments, channel files and the outbox DO carry it; the association
vault is a separate format and must stay single-block** - a ref that forgets the field is a
segmented blob decrypted as one block, a "corrupt" file. Until the audit is green the writer stays behind
a constant in the style of `mediaSegmentedWriterFlag.ts`, and a legacy-compatibility entry names the shim.

**Order of releases.** S1 (server routes, additive) deploys first: no client calls it, old clients keep
the old routes. S2 (the writer) ships as a pre-release to dev and testers, then a stable, only after S1 is
in production (a writer calling a route that is not there is a 404 for every large file).

**The quick fix coexists.** Its single-block-over-the-append-route path produces single-block blobs of any
size, readable by everyone for ever; it keeps working for old clients. After S2 and a floor past the quick
fix's version, the old `upload/chunk/*` routes lose their callers and are removed (a dated entry in
[legacy-compatibility](../legacy-compatibility.md), removal gated on the floor, never on a date).

**Retention.** The object is registered at `complete`, so `createdAt` and the `chat-reel` 30-day clock start
there, as today; staging has the existing 24 h orphan sweep (the resume window; MiGallery uses 48 h, Q4).
The class is declared at `init`; it can only shorten a life. **Quotas.** The 500 MB/day `chat-reel` budget is
reserved ONCE at `init` from `totalBytes` and released on complete, cancel, error or sweep - a resumed part
is never counted again, a session that outlives its sweep loses its reservation and is told `404`, and the
client restarts with a new session (an explicit, visible state, not a silent retry). Other classes keep no
daily budget, hence the open-session cap.

## 5. Tests and gates that prove it

1. **Body-size invariant (client).** `encryptAndUpload` over a fake `fetch` recording every body length,
   for 0, 1 B, 4 MiB, `threshold - 1`, `threshold`, 13.4 MB, 50 MB: every body `<= 8 MiB`, the multipart
   envelope included. A boundary test pins the single-POST threshold so it cannot drift to 10 MiB.
2. **Body-size invariant (server).** A part over `PART_MAX_BYTES` is `413` before it is written; the
   session route declares no `FileInterceptor` (a spec reads the route metadata).
3. **End to end behind a 10 MiB wall.** The bench puts a ~20-line proxy in front of a REAL media-service
   that answers `403` to any body over 10,485,760 bytes - the CrowdSec behaviour reproduced - and uploads a
   13.4 MB PDF and a 50 MB video. This is the gate the 2026-10-10 failure would have tripped; unit specs
   over stubs are blind to it (the `chat-reel` section records the same gap).
4. **Memory bound.** Client: a synthetic 200 MiB `File` whose `slice` yields generated bytes, a counting
   seal wrapper, and an assertion that live buffers never exceed 3 parts. Server: stream 50 MiB through
   the PUT handler and assert `process.memoryUsage().arrayBuffers` grows by under 16 MiB.
5. **Crypto and resume.** Seal-by-part equals `encryptSegmentedMedia` byte for byte; a dropped, duplicated,
   reordered or truncated part fails the reader (existing STREAM tests extended to the parts); an upload
   killed after each stage resumes to the same blob; a repeated `complete` returns one `mediaId`.
6. **Quota.** Init over budget is `429` with nothing staged; cancel and sweep release; a resumed part never
   double-counts; the open-session cap refuses the fifth.

## 6. Work packages

| WP | What | Risk | Needs |
| --- | --- | --- | --- |
| **S0 DONE 2026-10-10 (section 9)** | Measure (heap on Mi 9T and iPhone 12 at 13/28/50 MB), audit every ref-persisting surface for `encoding`, confirm the CrowdSec threshold from a real 10 MiB+1 probe, read the minio `fPutObject` buffering | none (docs) | - |
| **S1** | Server session routes, positional streamed PUT, sidecar, idempotent complete, cancel, open-session cap, streamed GET; tests 2, 4 (server), 6 | medium (new staging state; budget accounting) | S0 |
| **S2** | Client streaming writer, resume with persisted state, progress and cancel; tests 1, 4 (client), 5; behind a flag. **Its part transport on Tauri is DECIDED: the WebView's own `fetch`, not the HTTP plugin** (which inflates a body ~85x and crashes at 50 MB), already routed by `shouldUseNativeFetch` for any binary body to Canari's API (**pre-release builds bake `dev.canari-emse.fr`, whose old-VM relay answers 413 above 1 MiB: a part over 1 MiB cannot be proven there until the relay sets `client_max_body_size`; an unanswered part now ends in `UploadAnswerTimeoutError` (`uploadXhr.ts`, the same typed transport failure as the XHR path)**) - numbers in [mobile](../frontend/mobile.md#a-binary-body-through-the-http-plugin-costs-85-times-its-size-and-50-mb-crashes-the-app) | medium (the one the user sees) | S1 in prod |
| **S3** | Streamed download and decrypt for files, cache fed from the stream, MSE eviction | medium | S2 |
| **S4** | The outbox holds a `Blob`/OPFS handle instead of `fileBytes`; `BufferTarget` replaced by a file-backed target in video prep | **high** (outbox is the delivery path; RC-5 territory) | S2, measured need |
| **S5** | Gate 3 (the 10 MiB wall bench) in the cross-client harness | low | S1 |
| **S6** | Retire `upload/chunk/*` and the quick-fix path | low | floor past the quick fix |

S1 and S5 can start immediately after S0; S4 is deliberately last because without it the outbox still
holds one whole copy and the "do not load the RAM" goal is only met from the network down.
This supersedes the 1 MiB-parts idea of RC-5 in [reels-in-chat](../frontend/modules/reels-in-chat.md): RC-5
shrinks to wiring this API into the outbox states. The weak-network page
([offline-and-weak-network](../frontend/offline-and-weak-network.md)) owns the retry policy this reuses.

## 7. What we cannot do about CrowdSec

The AppSec layer belongs to the school's host ([estate-migration](../infrastructure/estate-migration.md)).
From our account `cscli` answers permission denied and `/etc/crowdsec/appsec-configs` is unreadable, so we
can neither read the rule that drops bodies over 10 MiB nor exempt a path, nor test a change. This design
works WITHOUT any change on their side (every body under 8 MiB, the only claim we can make about a rule we
cannot read). No request goes to the school administrators (user, 2026-10-10): the rule is theirs and stays as it is.
Cloudflare's own request-body limit is 100 MB on Free and Pro, 200 MB Business (Cloudflare docs, read 2026-10-10, not probed): far above 8 MiB.

## 8. Questions only the user can answer

1. **Part size**: 4 MiB (13 requests for 50 MB) or 1 MiB (RC-5's idea, 50 requests, a cut loses at most 1 MiB)?
2. **Segmenting non-video files above ~8 MiB** is the first time a PDF is written `segmented-v1`; accept once
   the S0 audit is green, or keep PDFs single-block and only raise the single-POST size through the quick fix?
3. **The 50 MB ceiling** stays (video prep is bounded by it) - or is a 100 MB policy ceiling wanted now that size is no longer RAM?
4. **Resume window**: 24 h (today's sweep) or 48 h (MiGallery)?
5. **Persisting the CEK in the outbox row** so a killed app resumes: acceptable given the row holds the file
   in the clear today?
6. ~~Who asks the school administrators for the AppSec exemption~~ - dropped (user, 2026-10-10): no request is made.
7. **The Tauri part transport (9.4, S2)**: the WebView's native fetch with CORS for the Tauri origins, or a Rust command that streams a file part? Measured: `window.fetch` through the HTTP plugin costs about 85x the body and crashes the app at 50 MB.

## 9. WP-S0 results (2026-10-10) - what the audit, the phone and the code say

### 9.1 Audit: does every surface that persists or reads a media ref carry `encoding`?

The writer sets `ref.encoding` in ONE place (`media.ts`, end of `encryptAndUpload`); every row below is what
happens to that ref afterwards. Paths are `frontend/src/lib/` unless noted.

| Surface | Persists / forwards `encoding` | Reader gets it | Action |
| --- | --- | --- | --- |
| Chat ref, MLS DM and group (outbox) | Yes: `utils/chat/outbox.ts:427` (stored `uploadedRef`, type `db/types.ts:116`), `:460` (envelope), `:476` (proto field 12) | `utils/chat/messageUtils.ts:222` (proto to envelope), `envelope.ts:245` (JSON), `utils/mediaBlobCache.ts:261` (`decryptByEncoding`) | none |
| Outbox `uploadMedia` | Yes: `composables/session/sessionAuth.ts:244` returns the WHOLE ref, `outbox.ts:427` copies `encoding` | n/a | none (it holds `fileBytes` whole: S4) |
| Channel files (server-authoritative) | Yes: `composables/useMessaging.svelte.ts:1169` | same readers | none |
| Forward (DM and channel) | Yes: `useMessaging.svelte.ts:1740`, `:1787` | same readers | none |
| Voice notes | Same chat path (`voiceNote` + `encoding`); far under the single-POST size, so single-block | same | none |
| Post media (create / edit) | Yes: `components/posts/CreatePostForm.svelte:388`, `EditPostForm.svelte:270` spread the ref; server `apps/social-service/src/posts/dto/post.dto.ts:94-102` declares `encoding` with `@IsIn(['segmented-v1'])`, stored as JSON | `components/posts/PostMedia.svelte:148` rebuilds the ref WITH `encoding` | none |
| Reels (post and chat message) | Yes: `reels/publishReel.ts:45,64`; chat reels use the chat path | `PostMedia.svelte`, `reels/saveReel.ts:67`, `reels/reelPreload.ts:46` pass the stored ref | none (video is already segmented) |
| Post comments | Stored, but UNDECLARED: `AddCommentDto.media` (`post.dto.ts`, ~379) is a bare `@IsObject()` with no nested type, so `whitelist` keeps `encoding` by accident and nothing validates it. Client spreads the ref: `PostComments.svelte:138-146` | `PostComments.svelte:453` gives the object to `PostImage`, which forwards it to `PostMedia` (its TS `Props` omits `encoding`; runtime is fine) | **declare `encoding` (same `@IsIn`) on the comment media type, add it to `PostImage` Props, add a DTO spec like `post-media.dto.spec.ts`** |
| Post link preview | Server skips any entry with `encoding` (`post-preview.service.ts:133`), decrypts single-block only | n/a | none: images only, and a compressed image never reaches the threshold |
| Native push thumbnails (Android FCM service, iOS NSE) | n/a | the shared Rust parse `src-tauri/src/mobile/proto_fields.rs:445-458` WITHHOLDS key and IV when `encoding != 0`; Kotlin and Swift read that JSON | none: a segmented image would lose its banner thumbnail (section 3.2 keeps images single-block) |
| Association vault | NO, and cannot: its own format (`associations/vaultCrypto.ts:136-170`, packed `iv + ct`, per-document key), no `encoding` column in `association_documents`, uploaded by `components/associations/AssociationDocumentManager.svelte:213-233` with its OWN single multipart POST (not `encryptAndUpload`) | `associations/vaultDownload.ts:27` + `decryptDocument`, whole blob | **keep single-block for ever. It hits the same 10 MiB wall (a 13 MB vault PDF fails today) and needs the session transport in an OPAQUE mode (size only, no segmented header check), see 9.4** |
| Avatars, logos, icons, form images | n/a: unencrypted public blobs (`uploadRaw`, `associations/api.ts` multiparts) | n/a | none (one small POST each) |
| `media-service` itself | Never reads it (opaque bytes) | n/a | S1's header check must be skippable for the vault mode |

Verdict: **for chat, channels, posts, reels and forwards a non-video file written `segmented-v1` is read
correctly today** (`decryptByEncoding` decides by the ref, never by the bytes). Open before the flag may
cover non-video: the comment DTO/typing hardening, and one test that a PDF ref survives outbox persist, send,
receive and `acquireDecryptedMediaBlobUrl` (non-A/V segmented goes to the whole-blob path,
`utils/segmentedMediaStream.ts:71-72`). The vault is outside the `encoding` question and inside 9.4.

### 9.2 Measured: today's single-block path on the Mi 9T (Tauri WebView, Android 16, 5.6 GB RAM)

Method: the real `encryptMediaBuffer` / `encryptSegmentedMedia` bundled with the exact `encryptAndUpload`
steps 1-3 (`file.arrayBuffer()`, encrypt, `Blob` in `FormData`, ONE `fetch` POST), injected into the running
app 1.2.2 over CDP; resident memory polled from `/proc/<pid>/statm` every ~20 ms for the app process and the
WebView renderer; target `https://dev.canari-emse.fr/api/media/upload` with a deliberately invalid token
(stores nothing; dev's legacy relay answers `413` over 1 MiB, the known
[P1](../infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09),
which does not matter here: every client-side cost is paid before the response). Peaks are resident MiB above
the pre-run baseline; the renderer does not hand memory back between runs, so later deltas are lower bounds.
The throwaway harness is not in the repo; this paragraph is enough to rebuild it. `performance.memory` stayed
flat (ArrayBuffers are external to the JS heap) and was discarded.

| Body | Path | Renderer peak (delta) | App (Rust) process peak (delta) | Result |
| --- | --- | --- | --- | --- |
| 13.4 MB | crypto only, no POST (clean restart) | +66 | +36 | matches the computed 40-55 |
| 50 MB | crypto only, no POST | +240 | +33 | about 5x the file, as computed |
| 13.4 MB | segmented writer, no POST | same as single-block | - | segmenting does not change the copy count |
| 4.2 MB | through the app's `fetch` | +176 | +331 | 3 s |
| 8 MB | through the app's `fetch` | +200 (lower bound) | +679 | 5 s |
| 13.4 MB | through the app's `fetch`, picker file | +650 (peak 791) | +1176 (peak 1488) | 7.6 s |
| 13.4 MB | same, outbox path (bytes in RAM, new `File`), and segmented | +585 to +610 | +1141 to +1153 | same as picker |
| 28 MB | through the app's `fetch` | +1156 (peak 1463) | +2209 (peak 2517) | 21.6 s |
| 50 MB | through the app's `fetch` | **render process killed, the whole app crashes** (`Render process's crash wasn't handled ... triggering application crash`) | - | what a 50 MB upload does today on this phone |

**The computed 40-55 MB / 150-250 MB were the SMALL part of the cost.** The large one is absent from section 1:
on Tauri (Android, iOS, desktop) `hooks.client.ts` replaces `window.fetch` with `@tauri-apps/plugin-http`, whose
JS (`dist-js/index.js`, installed 2.6.1) does
`const buffer = await req.arrayBuffer(); const data = Array.from(new Uint8Array(buffer))` and ships `data`
through `invoke` as JSON: one JS number per body byte, then a JSON string of the whole array, then a Rust
`Vec<u8>`. Measured: **about 85x the body in the Rust process and 45-50x in the renderer**. The WebView's own
fetch has none of it (a native POST of the same body added nothing over the crypto copies). iOS runs the same
code (not measured, 9.5).

Consequences: (a) the 2026-10-10 failure is not only CrowdSec: nothing above ~25 MB can be uploaded from a
phone at all; (b) even the design's 4 MiB part costs ~340 MiB (app) + ~190 MiB (renderer) through the plugin,
two in flight double it, so the streaming writer MUST NOT send parts through `window.fetch` on Tauri; (c) gate
4 of section 5 would pass in a desktop browser and still crash the phone, so it needs a Tauri-transport leg.

### 9.3 Read: minio `fPutObject`, and the Cloudflare figure

- `apps/media-service/src/media/storage.service.ts` builds `new Minio.Client({...})` with NO `partSize`.
  minio 8.0.7 (`src/internal/client.ts`): `partSize` defaults to 64 MiB, and `putObject` does
  `if (size <= partSize) { buf = await readAsBuffer(stream); uploadBuffer(...) }` where `readAsBuffer` is a
  `Buffer.concat` of every chunk. So `fPutObject` (the chunked `complete` today, and S1's `complete`) holds the
  WHOLE object, about 2x transiently, for every object up to the 50 MB ceiling; `put()` (single POST) does the
  same through `Readable.from(data)`. Dev's media-service container is capped at 768 MiB
  (`docker-compose.dev.yml`); no cap was found for prod. **S1 fix: construct the client with
  `partSize: 5 * 1024 * 1024` (the minimum), which sends objects over 5 MiB through `uploadStream` (multipart,
  one part buffered).** DONE in S1 (`STORE_PART_BYTES`); note `fPutObject` itself takes no part size, only
  the client does, and the setting also covers `put()`'s buffers. Verify on dev with a 50 MB object and a `process.memoryUsage()` probe.
- Cloudflare request body: 100 MB on Free and Pro, 200 MB Business, Enterprise up to 5 GB (Cloudflare docs,
  cache / default-cache-behavior, read 2026-10-10, not probed). 8 MiB parts are 12x under it.
- Met on the way: dev's legacy name still answers `413` above 1 MiB (the relay's nginx), so no upload over
  1 MiB can be tested end to end on `dev.canari-emse.fr` until that owed gesture is done; `canari.emse.fr` has
  no such limit.

### 9.4 What S0 changes in the work packages

| WP | Change |
| --- | --- |
| S1 | Set `partSize` on the minio client (9.3). Add an OPAQUE session mode (no segmented header; size and part count only) so the vault can use it. Declare `encoding` on the comment DTO (9.1). |
| S2 | **The part transport on Tauri cannot be `fetch`.** Candidates, to decide with the user (question 7): (i) the WebView's native fetch for `/api/media/*` (needs CORS for the Tauri origins, which is why the plugin was introduced; measure); (ii) a Rust command taking a RAW `invoke` payload, or better a file path and offset, and streaming the part itself; (iii) a newer plugin-http if it drops `Array.from` (the Rust crate is 2.8, the JS 2.6.1, re-read). (ii) also unlocks S4. The flag stays off for non-video until the 9.1 open items are done. |
| S3 | The download side was not measured (the plugin returns bodies in chunks through `fetch_read_body`, a different path); measure before promising numbers. |
| S4 | The crypto copies (about 5x the file) remain even with a perfect transport, but the transport is what hits first, so S4 follows it. |
| S5 | The 10 MiB-wall bench must run through the Tauri transport on a phone, not only in Chrome. |
| New | A vault upload through the session API in opaque mode (9.1), or the quick fix's append route: a vault PDF over 10 MiB fails today. |

### 9.5 Not measured, and why

- **iPhone 12**: the installed app is a store build; `pymobiledevice3 webinspector cdp` lists NO inspectable
  page (the harness notes a bench build with `tauri/devtools` is needed), so the bench cannot be injected, and
  an in-app upload would go to production, which was forbidden above 10 MiB. What WORKS:
  `python -m pymobiledevice3 developer dvt sysmon process single` over the no-root userspace tunnel returns
  `physFootprint` per process, `Canari` and `com.apple.WebKit.WebContent` included. With a bench build the same
  bundle plus a sysmon poll gives the iOS numbers. The plugin code path is identical.
- **Desktop Chrome**: not run; the native-fetch leg on the phone already isolates the browser cost.
- **Server heap**: read (9.3), not measured; the figures in 3.5b stay computed.
