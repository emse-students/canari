# Sharing out of Canari (lot S3)

"Partager" opens the operating system's share sheet, the way Messenger or Discord offer it: a
message's text, a message's attachment (decrypted), a post's or a reel's public link. Phone apps
only (`canShareOut`); the web and the desktop app have no native sheet, and there a post's share
sheet simply has no "Partager via..." row. It is half of the sharing chantier (user, 2026-10-11;
a priority since 2026-10-21) - the other half, sharing INTO Canari, is on `sharing.md` once its
pull request merges, and this page is folded into it then.

## What is shared, from where

| Control | Shared | Code |
| --- | --- | --- |
| A message's long-press sheet, "Partager" | the attachment, decrypted, or else the text | `MessageBubble` -> `sharing/shareOut.ts` (`shareMediaOut`, `shareTextOut`) |
| A post's or a reel's share sheet, "Partager via..." (the post menu's "Partager", the CanaReels rail's send) | its public link (`postShareUrl`) | `posts/sharePost.ts` (`sharePostLinkOut`), sheet in [sharing S6](sharing.md#a-post-or-a-reel-shared-from-its-sheet---lot-s6) |
| The same sheet, "Copier le lien" (every build) | the same link, copied | `copyPostLink` |

**Not offered**: on a CanaReel received in a conversation (it is not forwarded either, and it
expires), on an attachment still uploading (no blob to decrypt yet), on a deleted message.

## The path of a file

1. **Decrypted from the media cache** the way the bubble draws it
   (`acquireDecryptedMediaBlobUrl`, released whatever happens next).
2. **Staged into the app cache in base64 chunks** (`stageBlob`, `append_video_chunk`): the same
   staging as saving a reel to the gallery, for the same reason - on Android every IPC call is JSON,
   so a raw body would cross as an array of numbers ([reels](modules/reels.md), "The bytes are
   STAGED").
3. **`share_staged` moves it into `cache/share_out/`** - emptied first, one file shared out at a
   time - under a name reduced to a last segment of safe characters (`sharedFileName`, then Rust's
   `valid_name`) and a plain `type/subtype` (`valid_mime`, which refuses parameters).
   `share_out/` is the ONE cache directory the app's FileProvider exposes
   (`res/xml/file_paths.xml`, `exported=false`): never the cache around it, which holds the
   gallery's staging and the WebView's own files.
4. **The sheet opens on it**. Android: `ACTION_SEND` with `EXTRA_STREAM`, the read grant carried in
   the intent's ClipData so `createChooser` passes it to the app the member picks and to no other.
   iOS: `UIActivityViewController` on the file URL, anchored as a popover at the centre on an iPad;
   refused at once (`busy`) when another sheet is already presented, because UIKit would then never
   call the completion and the promise would hang. `share_file` (Rust -> native) is not in
   `build.rs`'s `COMMANDS`, so the page can only reach the sheet through `share_staged`.

A failure on any step discards the staged copy (`discard_video`) and says so in a toast
(`share_out_failed`).

## The decrypted copy, and how long it lives

The copy in `share_out/` is the only plaintext that leaves the WebView, and it **cannot be deleted
when the sheet closes**: the receiving app reads it on its own schedule, after the sheet is gone. So
it is deleted by the next of three events:

- **the next share out** (`share_staged` empties the directory first);
- **a sign-out** (`clearAuth` / `clearAuthLocally` -> `discardSharedOut` ->
  `discard_shared_out`) - plaintext does not outlive the session it was decrypted in;
- **the next launch** (`sweep_staged` at plugin setup, with the gallery's `gallery-*` files).

**THE TRADE-OFF, TAKEN KNOWINGLY: a fast second share deletes the first file while its reader may
still be using it.** An app that keeps reading the `content://` URI (an upload that starts later, a
draft that re-reads its attachment) then fails on the first file. The alternative - one directory
per share, kept until a launch - lets decrypted attachments accumulate on disk for as long as the
app stays alive, which is the worse failure for an end-to-end encrypted messenger. The sign-out and
launch sweeps bound that copy to one at a time.

**Nothing logs a file name**: the attachment's name is the member's (`share_staged` logs the size
and the type, Kotlin the type, the page the size).

## Verified, and owed

- `cargo test -p tauri-plugin-gallery` (name and type refusals), `galleryCommands.test.ts` (every
  command declared, listed, granted, with the arguments the page sends), `shareOut.test.ts` (names
  never a path, the copy discarded on a failure, the decrypted URL released).
- Android: the Kotlin compiles locally (`compileArm64DebugKotlin`). iOS: the Swift is **not compiled
  here**; the CI iOS job is the judge.
- **Owed on the Mi 9T and the iPhone 12**: a message's text to another app; a picture and a PDF to
  Files or a mail app; a video; a post's link; a share then a sign-out (the copy is gone). An iPad
  popover is not on the bench.
