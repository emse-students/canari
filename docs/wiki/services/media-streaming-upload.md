# Media streaming upload and download - bounded memory, parts under 8 MiB

**Status: DESIGN. WP-S1 (the server session routes) is BUILT, awaiting review (2026-10-10, [media-service](media-service.md#upload-sessions-streamed-resumable-every-body-under-8-mib-wp-s1-2026-10-10)); S2 onward and the streamed GET are not.** Decisions taken by delegation, overridable: parts 4 MiB plaintext (about 4 MiB + 64 B on the wire), hard server cap 8 MiB, the 50 MB ceiling stays, resume window 24 h, the CEK may persist in the outbox row later (client WP). Trigger: the prod host's CrowdSec AppSec (school-managed
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
concurrent 50 MB uploads hold up to 1 GB in a container (limit not read). **Owed (WP-S0):** heap
measurements on the Mi 9T and iPhone 12 for 13, 28 and 50 MB; the figures above are arithmetic.

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
| Server `complete` | `fPutObject` reads the file as a stream; **owed**: confirm the minio client does not buffer a 64 MiB part for a 50 MB object | to measure |

## 4. Compatibility, retention, quotas

**Reader before writer (the repo rule).** The reader of the format is shipped and is the floor: the
segmented reader landed in `1.0.0`, `minClientVersion` is `1.0.0`, both stores serve 1.0.x, and the writer
has been on since 2026-10-05 (user's go). Streaming therefore needs NO new reader and NO floor raise for
VIDEO. For other types above the single-POST size (PDF, audio, files) the writer now emits `segmented-v1`
where it emitted single-block: acceptable only if every surface that persists a ref CARRIES `encoding`.
`MediaRef` (chat, proto field 12) and a post's `images[].encoding` do; **comments, the association vault,
channel files and the outbox's `uploadMedia` must be audited (WP-S0)** - a ref that forgets the field is a
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
| **S0** | Measure (heap on Mi 9T and iPhone 12 at 13/28/50 MB), audit every ref-persisting surface for `encoding`, confirm the CrowdSec threshold from a real 10 MiB+1 probe, read the minio `fPutObject` buffering | none (docs) | - |
| **S1** | Server session routes, positional streamed PUT, sidecar, idempotent complete, cancel, open-session cap, streamed GET; tests 2, 4 (server), 6 | medium (new staging state; budget accounting) | S0 |
| **S2** | Client streaming writer, resume with persisted state, progress and cancel; tests 1, 4 (client), 5; behind a flag | medium (the one the user sees) | S1 in prod |
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
cannot read). As defence in depth, ask the school administrators to raise the body limit or exempt
`/api/media/upload` (and the session routes) for authenticated traffic - an ask, not a dependency.
Cloudflare's own request-body limit (100 MB on the plans seen here, not re-measured) is also far above 8 MiB.

## 8. Questions only the user can answer

1. **Part size**: 4 MiB (13 requests for 50 MB) or 1 MiB (RC-5's idea, 50 requests, a cut loses at most 1 MiB)?
2. **Segmenting non-video files above ~8 MiB** is the first time a PDF is written `segmented-v1`; accept once
   the S0 audit is green, or keep PDFs single-block and only raise the single-POST size through the quick fix?
3. **The 50 MB ceiling** stays (video prep is bounded by it) - or is a 100 MB policy ceiling wanted now that size is no longer RAM?
4. **Resume window**: 24 h (today's sweep) or 48 h (MiGallery)?
5. **Persisting the CEK in the outbox row** so a killed app resumes: acceptable given the row holds the file
   in the clear today?
6. **Who asks the school administrators** for the AppSec exemption, and is a reply worth waiting for?
