# A heavy store phone, read - 2026-10-13

A read-only observation of a store `1.2.6` Android build on a Pixel 6a: a 15.5 MB MLS state, 85
groups, and one 208-member community. It found five things, plus a logging gap. Each was checked
against the code and, where a bench could, on the Mi 9T (`1.2.6` bench build on dev). Identities are
roles, never people
([durable-rules](../durable-rules.md#a-measurement-taken-from-production-names-roles-and-counts-never-people---this-repository-is-public)).
Companions:
[performance-audit-2026-10-12](performance-audit-2026-10-12.md) and
[startup-load-audit-2026-10-12](startup-load-audit-2026-10-12.md).

| # | Observation | Verdict | Where |
| --- | --- | --- | --- |
| 1 | Every salon open re-mirrors every face (7/50/11/24 writes, the same on each repeat) | Defect, fixed | #1811, [mobile](mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none) |
| 2 | `general` (50 faces) freezes the list ~1.6 s with no press feedback | One synchronous mount, plus #1; the press is now painted first | #1812, [performance-audit](performance-audit-2026-10-12.md) |
| 3a | 86 `[HISTORY]` "requests", 210 of 258 `after=X until=X entries=0` | A misleading SERVER log line; 2 batch requests per launch | #1813, [history-reconciliation](../protocols/history-reconciliation.md#and-on-the-server-side-a-history-line-names-who-asked) |
| 3b | 358 `SELECT * FROM graine` in 30 s | Held seeds re-read per arriving copy (fixed); misses re-read per row (open) | #1813 |
| 4 | The MLS state is rewritten in full on each save | Yes, the KeyPackage share needlessly; a format decision | [open-questions](../open-questions.md#decision-owed---should-the-keypackage-pile-leave-the-blob-every-checkpoint-rewrites) |
| 5 | 9 past-epoch frames dropped on each cold start | By design if they are new frames; a defect if they are the same ones | below |
| 6 | No JS console in 805 logcat lines | The layout comment is wrong; there is no in-app log | below |

## 1. The avatar mirror

Each salon open re-mirrored every face. Three facts produce that:

- The avatar answers `no-cache` + ETag, so each mount revalidates it.
- The production edge log over 24 h shows `11929 x 304`, `3143 x 404` and `261 x 200`, and the
  Tauri WebView's own UA is among the `304`s. The WebView's HTTP cache turns each `304` back into
  the same bytes.
- The blob pool forgets a face with its last mount (`evictDelayMs: 0`).

So every salon open is a load, and every load mirrored. One mirror cost ~8 ms of main thread on the
Mi 9T, almost all of it the IPC building and serialising a JSON number array.

| 50 invokes of 7.5 KB | Main thread (n=3) |
| --- | ---: |
| As a number array | 360-440 ms |
| As base64 | 130-150 ms |

The 7.5 KB is the production median (p90 12.4 KB). #1811 writes the same bytes once per process,
keyed by SHA-256, and sends base64. A raw IPC body stays impossible: Android IPC is JSON, and a
raw-body version was already refused on the Mi 9T.

## 2. The frozen list

A 48-message salon on the Mi 9T opened in one 441 ms frame. 382 ms of it was the Svelte flush that
the click handler started: selection, conversation and history load ran in one synchronous run. On
the Pixel, the 50 mirrors of #1 land on the same main thread. #1812 paints the row's highlight first
and mounts after that paint. The mount itself is not cheaper.

## 3. The history lines and the `graine` reads

**The `[HISTORY]` lines are the server's**, one per group of a batch request. 85 groups make 2
requests (50 + 35), not 86. The client sends only its cursor. The line printed the head it had just
read as `until=`, so a caught-up group read `after=X until=X entries=0`. The client keeps asking
because nothing it holds says the stream did not move. #1813 makes the line honest and turns
caught-up groups into a count.

**The `graine` reads.** The full statement is `SELECT * FROM graine WHERE session_id = $1` (sqlx's
`summary` truncates it to `SELECT * FROM graine ...`). It has two sources:

- **`storeIncomingSeed`** reads it once per arriving copy of a seed. #1813 makes it ask the seed
  cache first.
- **`openChannelMessage`** reads it once per row whose session is MISSING, on every salon load.
  Only answers are cached, because a repair may fill a miss. Unchanged.

**Owed:** the Pixel's lines split by `rows_returned`. `1` is a re-checked held seed; `0` is a miss.

## 4. The MLS state rewritten in full

Native keeps every MLS row in one `MemoryStorage` map. Each checkpoint re-encodes all of it into one
CBOR blob (`mls-core/src/state.rs` `serialize_state`), seals it whole and rewrites the whole
`mls.bin`. There is no dirtiness per group or per label.

A KeyPackage bundle (`key_package`, `private_init_key`, `private_encryption_key`, JSON) is written
once when minted and only ever deleted. So on the Pixel ~6 MB of the 15.5 MB is rewritten
unchanged on every save. The pile grows because a bundle a peer CLAIMED leaves the server but stays
local until a Welcome consumes it or its 84-day expiry
([key-package-pool](../protocols/key-package-pool.md)).

**Measured** (`heavy_state_checkpoint.rs` `key_package_share_of_a_checkpoint`, desktop x86,
release):

| State | Size | Encrypted checkpoint |
| --- | ---: | ---: |
| 80 groups | 7.70 MB | 16-20 ms |
| + 2535 KeyPackages | 12.54 MB | 27 ms |

The 2535 bundles are 4.8 MB, ~1.9 KB each against ~2.4 KB on a phone. They add ~60 % of the bytes
and ~40-70 % of the time. The phone's checkpoint time at 15.5 MB is not measured.

**#1793 does not touch this.** The WebCrypto v2 seal is web-only, ships with its writer off, and is
still one AEAD over the whole state, with no segment a KeyPackage share could live in. Splitting or
shrinking the pile is a format or server decision, so it is written in
[open-questions](../open-questions.md) and not built.

## 5. The past-epoch frames dropped on each cold start

`Past-epoch application frame, unreadable for good` (`mls-core/src/messaging.rs`) and
`[GAP] ... escalating to the frontend` (`commands/mls.rs` `recevoir_message_bytes`) come from the
single-frame path: the queue drain, a live frame, or a key-group frame. The archive replay uses
`recevoir_messages_batch`, which writes no `[GAP]`.

The frame is sealed 8-13 epochs behind a group whose past-epoch window is 2, so its keys are gone.
The frontend counts it permanent and ACKs it:

- **Key group:** `dispositionOfUnreadableFrame`.
- **Conversation:** `handleUnreadableFrame`, which also asks a peer to reconcile.

The ACK deletes the queue row. **That is by design**: the loss is the sender's, who sealed at an epoch
the group had left.

**When it would be a defect.** The 9 frames carry the same epoch spread (196-201 against 209) on
every start, which hints that they are the same frames. A sender stuck behind would send at ONE
epoch. If they are the same frames, the ACK is not landing. One code path makes that possible:

- The drain-end ACK is fire-and-forget (`announceAck`).
- Its retry is kept only in `sessionStorage` (`ackRetry.ts`), which a killed Android process loses.

**How to tell.** Compare across two cold starts:

- the `[QUEUE] Processing message ... qId=` of those frames;
- the client's `[ACK] N message(s) acknowledged` or `persisted for retry`;
- the server's `[ACK] ... DONE deleted=N`.

The same qIds twice means the ACK is the defect. New qIds mean lagging senders, which is the open
item of [channel-encryption](../protocols/channel-encryption.md).

## 6. Why logcat holds no JavaScript, and how a phone could hand us a log

**The comment is wrong.** `routes/+layout.svelte` says `attachConsole()` redirects `console.*` to
the plugin log and logcat. It does the opposite:

- `attachConsole()` (`@tauri-apps/plugin-log`) LISTENS for `log://log` and writes Rust records into
  the JS console.
- That event is only emitted by a `Webview` target, and `lib.rs` configures none (the defaults are
  `Stdout` and `LogDir`). So the call is a dead listener everywhere.
- The `sessionLog.ts` docblock repeats the claim. `appendLog` is a bare `console.log`.

**What really carries JS output into logcat** is wry's `RustWebChromeClient.onConsoleMessage`
(`Tauri/Console`). It is gated on `BuildConfig.DEBUG`, so a release build writes no JS line at all.
Rust `log::` lines DO reach logcat in release (`android_logger`), and also a Rust-only `Canari.log`
in the app's private data directory (40 KB, one file kept), which nothing reads.

**There is no in-app log feature**: no viewer, export, copy or share, in settings or elsewhere.

**A proposal (not built):**

1. Forward `console.*` to the plugin log at `info` and above, from the one console wrapper that
   already exists (`installConsoleIdTruncation`). JS lines then reach the `LogDir` file and logcat
   in release.
2. Raise `max_file_size` and keep a few rotated files.
3. Add a Settings > About action that reads the file through a command and hands it to the share
   sheet, with the user's consent and identifiers already truncated.

Until then, a store phone's JS side can only be read through Android's "Take bug report" (logcat,
Rust lines only) or a bench build.

## What was NOT measured

- **The Pixel 6a itself.** It is the user's phone, never a bench device.
- **Any after-build on a phone.** APKs were built for #1811 and #1812. At 12:03 another session
  installed a production APK on the Mi 9T, so neither was installed.
- **A salon of faces with photos.** dev serves no avatar.
- **The `graine` split by source.**
- **The KeyPackage share on a phone.**
- **Which of the two readings in #5 holds.**
