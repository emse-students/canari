# MediaFrame - the box a picture, a GIF or a video holds BEFORE it arrives

> User, 2026-10-02: *"pour les GIFs, retravailler le systeme pour que des placeholders DE LA TAILLE
> DES IMAGES apparaissent avant leur chargement, parce que le LAYOUT SHIFTING c'est tres mauvais. Sur
> TOUS les medias en conversation en general il faut repenser le systeme. Regarde comment DISCORD
> gere ses GIFs et medias."*

**One rule, and every renderer of a visual medium obeys it: the box is the size of the media before
a byte of it is downloaded, and it does not change when the media lands.** The size travels INSIDE
the end-to-end message, because the server stores ciphertext and cannot be asked. `MediaFrame` is
the one primitive that turns what the message declares into that box; a renderer never computes a
media box itself.

**STATUS (2026-10-02): CONTRACT PUBLISHED FIRST, ON PURPOSE** - so the GIF panel can build its tiles
against it in parallel. Sections 3 to 5 describe the primitive as it lands; section 6 says which
pull request carries which half, and is the only place a reader learns whether a half is in.

This page holds: what the other apps do (sourced), what Canari did (audited, then measured), the
contract of the primitive, and what still shifts. Sections marked **CONTRACT** are what another
work package builds against - the GIF keyboard panel's tiles first among them.

## 1. What the others do - sourced, fetched 2026-10-02

Each line is a fact read on the page linked; **INFERENCE** marks what is not.

| App | Size in the message | Placeholder in the message | Source |
| --- | --- | --- | --- |
| **Discord** | Attachment `width` / `height` "(if image or video)"; embed `image` / `thumbnail` / `video` objects carry `width` / `height` too | Attachment and embed `placeholder`: "thumbhash placeholder (if image or video)", with a `placeholder_version` | [message resource](https://docs.discord.com/developers/resources/message) |
| **WhatsApp** | `ImageMessage` and `VideoMessage`: `height = 6`, `width = 7` | `jpegThumbnail = 16` (bytes); `VideoMessage.gifPlayback = 13` is how a GIF travels - as a video | [Baileys `WAProto.proto`](https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/WAProto/WAProto.proto) |
| **Telegram** | `documentAttributeVideo` `w` / `h` | `photoStrippedSize` (type `i`): "an extremely low-res thumbnail, embedded directly inside media location objects", shown while the larger sizes download | [files](https://core.telegram.org/api/files), [photoStrippedSize](https://core.telegram.org/constructor/photoStrippedSize), [documentAttributeVideo](https://core.telegram.org/constructor/documentAttributeVideo) |
| **Slack** | `original_w` / `original_h` | server-made `thumb_64` ... `thumb_1024`, `thumb_360_gif` for animations | [file object](https://docs.slack.dev/reference/objects/file-object) |
| **Messenger** | nothing public found | - | - |

**The pattern is unanimous: the size is metadata of the message, written by whoever had the file,
and a tiny placeholder rides beside it.** Discord and Slack can also resize server-side - Discord's
Media Proxy resizes on request, GIFs through giflib, and extracts a video's first frame
([engineering blog](https://discord.com/blog/how-discord-resizes-150-million-images-every-day-with-go-and-c)).
**That half is closed to Canari by construction**: the server holds ciphertext, so a preview can
only be made by the sender and carried encrypted, which is what WhatsApp's `jpegThumbnail` and
Telegram's stripped size are.

**GIF providers declare dimensions in their search results**: Tenor's media object has `dims`
("width and height of the media in pixels",
[Tenor](https://developers.google.com/tenor/guides/response-objects-and-errors)); Giphy's
`fixed_height` rendition has `width`, `height`, and `mp4` / `webp` variants
([Giphy](https://developers.giphy.com/docs/api/schema)). KLIPY's schema (the provider Canari uses)
could not be fetched - its docs render client-side - so whether `file.<size>.gif` carries
`width` / `height` is **UNVERIFIED** and is the GIF panel's to read off a live response. Discord has
a `gifv` embed type whose `video` object carries `width` / `height`; that it plays a provider's MP4
rather than the GIF is **INFERENCE** from that type, not stated in the docs.

**Placeholder format.** ThumbHash "encodes more detail in the same space" than BlurHash, "also
encodes the aspect ratio", "supports images with alpha"; a BlurHash at recommended settings is
"roughly the same size as a ThumbHash encoded using base64"
([thumbhash](https://evanw.github.io/thumbhash/); MIT, Evan Wallace,
[repo](https://github.com/evanw/thumbhash)). It is what Discord ships.

**The web platform.** `<img width height>` maps to `aspect-ratio: auto w / h` as a presentational
hint ([HTML rendering](https://html.spec.whatwg.org/multipage/rendering.html)) - the same mechanism
this primitive uses, with the numbers coming from the message instead of attributes. CLS counts a
visible element moving between frames; scrolling is not excluded the way recent input is
([web.dev/cls](https://web.dev/articles/cls)). **`overflow-anchor` is NOT something to lean on**:
WebKit shipped scroll anchoring only in Safari 27
([WebKit blog](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/), MDN marks
it Baseline 2026), so every iPhone below iOS 27 has none - the chat pane keeps its own anchor
(section 4).

## 2. What Canari did, per medium - read from source 2026-10-02

The wire already had the size: `MediaMsg.width = 9` / `height = 10`, mirrored by `MediaRef.width` /
`height` in the JSON envelope. Who wrote it, and who read it:

| Medium | Size written at send? | Box before load | Box after load | Shift |
| --- | --- | --- | --- | --- |
| Photo (`MessageMediaRenderer`) | yes (`compressImage`) | `w-full max-w-[14rem] sm:w-56` | `w-56`, or `w-68` when the caption bleeds | width differs on a phone and under a caption, so height does too |
| Video | NO in chat until #1327 | `aspect-video`, `max-w-[16rem]`, whatever the clip | `w-56` at the clip's real ratio | every portrait clip: 16:9 to 9:16 |
| GIF file (picked, Gboard) | NO - `image/gif` skips the compressor that measures | as a photo, at the 4:3 fallback | the GIF's ratio | every one |
| GIF link (picker, pasted URL) | NO - the message is plain text, a bare URL | **nothing**: an `<img>` with no size, 0 px | up to `max-h-64` (256 px) | **the whole GIF, every time, every device** - the user's report |
| Voice note | n/a | `h-14 sm:w-56` skeleton | `w-[20rem]` player | width, and the player's own height |
| File | n/a | same row, spinner | same row, button | none measured by reading |
| Failure box | - | `max-w-xs sm:w-64`, video `aspect-video` | - | a failure re-shapes the row |

**And the pane did not follow what it could not see.** `ChatArea`'s growth observer is a
`MutationObserver` plus a `ResizeObserver` on the SCROLLER's own box. An `<img>` decoding to its
size is neither a DOM mutation nor a change of the scroller's box, so a GIF arriving at the bottom of
the thread pushed the last message under the composer and nothing re-pinned it; and the anchor it
keeps is the TOPMOST rendered row, so growth between that row and the reader's viewport slid the
reader down.

## 3. MediaFrame - CONTRACT

`frontend/src/lib/components/shared/MediaFrame.svelte`, with its pure arithmetic in
`frontend/src/lib/utils/mediaFrame.ts`.

```svelte
<MediaFrame
  width={ref.width}            <!-- declared by the sender; absent on old messages -->
  height={ref.height}
  measureKey={ref.mediaId}     <!-- what the measured-size cache files an OLD message under -->
  sizing="fill"                <!-- or "intrinsic" -->
  placeholder={ref.placeholder} <!-- ThumbHash, base64; absent on old messages -->
  class="w-56"
>
  {#snippet children(frame)}
    <img src={url} onload={frame.onLoad} class="h-full w-full object-cover" alt="" />
  {/snippet}
</MediaFrame>
```

- **`sizing="fill"`** - the frame's WIDTH comes from its class, its height from the ratio, capped by
  `--media-max-height`. A chat photo, a chat video, a feed attachment. This is `mediaAspectStyle`,
  which the frame now owns.
- **`sizing="intrinsic"`** - Discord's: the frame IS the media's own size, scaled down (never up) to
  fit `maxWidth` x `maxHeight`, entirely in CSS: `width: min(<w>px, 100%, <maxHeight> * <ratio>)`
  plus `aspect-ratio`. A GIF, and a GIF tile.
- **`frame.onLoad`** - hand it to the `<img>`'s `load` or the `<video>`'s `loadedmetadata`. When the
  message declared a size it does nothing; when it did not, it files the natural size under
  `measureKey` (section 5).
- **The skeleton, the decrypting state, the failure state and the media are ALL children of the same
  frame.** A renderer that draws its failure box at a different size than its picture has
  re-introduced the shift through the back door - that is exactly what the audit found.
- **`placeholder`** is painted as the frame's background until the child covers it; with none, the
  frame's surface tone is the placeholder.

**For a GIF sent by URL**, the size rides in the URL's FRAGMENT, which no server ever receives and
every old client ignores: `withGifSize(url, w, h)` writes `#cn-size=<w>x<h>`, `gifSizeFromUrl(url)`
reads it (`frontend/src/lib/utils/chat/messageDisplay.ts`). **A GIF picker passes its result through
`withGifSize` before `onSendGif`**, with the dimensions of the variant it sends - that is the whole
of what the GIF panel owes this page. A GIF tile in the panel renders a `MediaFrame
sizing="intrinsic"` from the provider's dimensions, so the grid does not reflow as tiles arrive.

## 4. The pane keeps the reader's row, whatever grows

`ChatArea` anchors on the row AT THE TOP OF THE VIEWPORT, not the topmost rendered one, and its
growth observer also watches the message list's own box - so a medium settling anywhere is either
followed (reader at the bottom) or compensated (reader above it). `overflow-anchor` is not used
(section 1).

## 5. Old messages, honestly

A message sent before this work has no size (videos and GIFs) and no placeholder (everything). Its
frame opens at the fallback ratio and, the FIRST time its media loads on a device, takes the real
ratio - **one shift, once per old message per device** - then files it in the measured-size cache, so
every later render of that row, in this session or after a restart, opens at the right size. A new
message never shifts.

## 6. Where it stands

| Half | Pull request | State |
| --- | --- | --- |
| This contract and the research | the page's first commit | merged with it |
| `MediaFrame`, every chat renderer and the feed on it, the measured-size cache, the pane's anchor | next | not yet |
| Sender side: GIF sizes (files and URLs), the ThumbHash placeholder on the wire | after it | not yet |
