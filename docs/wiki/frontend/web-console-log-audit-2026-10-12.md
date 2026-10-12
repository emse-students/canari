# Web console log audit - 2026-10-12

One exported Firefox console of the production web client (`canari.emse.fr`, `v1.2.4`), opened on
`/communities` and left there: 2583 lines, 10:21:40 to 10:24:57 (3 min 17 s). Nothing was clicked
after the load; everything below is what the client did ON ITS OWN while a community salon with two
PDF attachments was on screen. Identities are rewritten as roles
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).

## The counts, read from the log

| What | Count in 3 min 17 s |
| --- | --- |
| Incoming MLS payload frames / drains | 48 / 44 (every drain `messages=1`) |
| `POST /api/mls/messages/ack` | 44 (one per drain) |
| `GET /api/channels/<id>/messages?limit=200` + `/read-marks` | 22 + 22 (18 + 18 on ONE salon) |
| `GET .../pdf.worker.min.*.mjs` | 36 (exactly 2 after each of the 18 refetches of that salon) |
| `[MLS] Encrypted state checkpoint persisted` | 39 - median 348 ms, p90 585 ms, max 998 ms, 15.4 s in all |
| `GET /api/mls/groups/<id>/user-members` | 80, one per held group, 10:21:47.07-10:21:53.39 (6.3 s), all `304` |
| `GET /api/users/<id>/avatar` | 28, of which 10 `404` |
| `GET /api/mls/groups/<id>` (key-distribution groups) | 16 = the same 8 groups, swept twice 1 s apart |
| `[GRAINE] absorbed N/M seed(s)` | 19 bundles; this device asked for nothing, 4 were this user's own answers |

## Ranked findings

| # | Evidence | Cause | Cost | Disposition |
| --- | --- | --- | --- | --- |
| A | Every `GET .../feca872d.../messages` is followed by exactly two `pdf.worker.min` loads (18 refetches, 36 loads); the other salon's 4 refetches load none | `MessageBubble`'s download effect read the `mediaRef` OBJECT. A refetch hands each row a new message with the same content, the envelope is re-parsed into a new object, the effect re-ran: `blobUrl = null` unmounted `PdfThumbnail`, the re-download set it back, and the remount opened the PDF again - and every `openPdfDocument` spawns its own pdf.js worker | Per refetch and per visible PDF: a worker spawn (1 MB script, from cache), a document parse, a page render, a WebP encode, and a re-decrypt of every attachment on screen (images and videos included) | **Fixed in #1760**: the effect is keyed on `mediaId`, a string ([MessageBubble.mediaRefetch test](../../../frontend/src/lib/components/messages/MessageBubble.mediaRefetch.svelte.test.ts)). Not a `1.2.4` regression: the thumbnail and the effect both predate #1747 |
| B | 18 refetches of one salon, each right after `[GRAINE] absorbed 1/1 seed(s)` (or 6/6, 63/63, 111/111); this device sent no request, so every one of the 19 bundles answered somebody else | A seed bundle is sent on the community's distribution group, so all of its members receive it. `storeIncomingSeed` returns `true` "including when it already was" held, and `absorbSeedBundle` announces every salon named by a held seed as REPAIRED - so every online member re-reads the salon's history whenever anybody's request is answered. Whether those seeds were already held the log cannot say - `absorbed` counted both - which is the second half of the fix | 2 requests per bundle per online member (`limit=200` messages + read-marks), plus the re-render that drives A; on a 200-leaf community every answer is a fan-out of refetches | **Fix in draft #1761**: only a seed that is NEW, or that lowers a held floor, makes a salon repaired. Deterministic, no clock, and the bundle line now says how many were already held. Coalescing after a burst is NOT needed once the duplicates are gone |
| C | 39 checkpoints in 197 s, one per single-message drain, 214-998 ms each | `onBulkIngestEnd` sets `dirtyEncrypted = true` unconditionally and flushes. Each WebSocket frame is its own drain here, so every application message costs a full encrypted export of the whole MLS state - though the file's own header says routine ratchet advances stay in memory | 15.4 s of checkpoint wall time in 3 min; how much is main thread (WASM export) and how much is IndexedDB is not measured | [Backlog](../backlog.md#seen-in-the-2026-10-12-web-console-log---what-the-audit-left-open): MLS durability, not a small change - needs a trace and an answer to "what does losing an application-only advance cost" |
| D | 80 `user-members` reads in 6.3 s right after `/mls/users/<me>/groups` | `removeStrayLeaves` (run per connection by `initializeConnection`) compares each held group's tree with its roster, one request per group | 80 requests per connection, all `304` | [Backlog](../backlog.md#seen-in-the-2026-10-12-web-console-log---what-the-audit-left-open): a batched roster read is a server endpoint |
| E | 10 avatar `404`s, each logged `absent for the rest of the session` | The client already remembers a 404 for the session ([userAvatarCache](../../../frontend/src/lib/utils/userAvatarCache.ts)); these are the FIRST asks for people with no photo. Only MiGallery knows who has one | 10 requests per load, one network-panel line each | [Backlog](../backlog.md#seen-in-the-2026-10-12-web-console-log---what-the-audit-left-open): the user record would have to carry "has a photo", which needs MiGallery |
| F | `[SYNC] WASM kept <id> - key-distribution group` for the same 8 groups at 10:21:56.4-57.1 and again at 57.4-58.3, one `GET /mls/groups/<id>` each | Both `initializeConnection` and the discovery pass in `actions.ts` run `forgetGroupsAbsentFromServer`, and each asks the server about the key-distribution groups - which the registry restored at 10:21:45 (`8 group(s)`) already names | 16 requests per connection, 8 of them a repeat | [Backlog](../backlog.md#seen-in-the-2026-10-12-web-console-log---what-the-audit-left-open) |
| G | `answered <requester> with 1 seed(s)` followed 38 ms later by `absorbed 1/1 seed(s) from <this user>` | A request names its answerer by USER; every device of that user that holds the seed answers. The second bundle arrives at the first device too | One duplicate bundle per extra device of the answerer; harmless once B ships, since it holds nothing new | Recorded only |
| H | `Past-epoch application frame, unreadable for good: msg_epoch=120 group_epoch=133` | A member sent on a community distribution group 13 epochs behind | One frame unreadable; the client acknowledged it and said where the seed comes back from | Recorded only, already handled by design |

## Why A and B multiplied each other

B decides how often a salon is re-read; A decides what each re-read costs. With both, one member's
history request answered by somebody else became, on every other open client, a full history
refetch, a re-decrypt of every attachment on screen, and one pdf.js worker per PDF thumbnail. Either
fix alone removes most of it: A makes a refetch cheap, B makes it rare.

## How to re-measure

Open a salon holding a PDF attachment on the web client with the console persisted, wait for a seed
bundle on its community (any member returning, or a new member), then count:

```sh
grep -c "pdf.worker" console.log                    # expected 1 per PDF per mount, not per refetch
grep -c "/messages?limit" console.log               # expected only for bundles that were new
grep -o "checkpoint persisted. ([0-9]* ms)" console.log | wc -l
```
