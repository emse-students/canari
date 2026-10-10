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

### Measured (2026-10-02)

A bench page mounts the OLD renderers (copied from `main`) and the NEW ones side by side, in a
436 px scroller with filler rows, holds every medium in its "decrypting" state, then hands every row
its bytes at once and reads each row's height before and after. Same build, same assets, three
engines asked; the numbers are row heights in CSS px.

| Row | OLD before -> after | NEW, first time on the device | NEW, every later time |
| --- | --- | --- | --- |
| photo 1080x1920, size declared | 57 -> 405 | 398 -> 398 | 398 -> 398 |
| photo 1600x900 + caption | 164 -> 191 | 191 -> 191 | 191 -> 191 |
| video 720x1280, size declared | 32 -> 398 | 398 -> 398 | 398 -> 398 |
| video 720x1280, OLD message (no size) | 32 -> 126 | 126 -> 398 | 398 -> 398 |
| GIF file 320x240, OLD message (no size) | 32 -> 175 | 168 -> 168 | 168 -> 168 |
| GIF link 498x280, size in the fragment | 28 -> 246 | 246 -> 246 | 246 -> 246 |
| GIF link 320x240, OLD link (no size) | 28 -> 268 | 284 -> 268 | 268 -> 268 |
| voice note | 56 -> 84 | 84 -> 84 | 84 -> 84 |
| **sum of row height changes** | **1464** | **288** (old messages only) | **0** |
| **reader's row, reading history** | **moved 629** | **moved 0-1** | 0 |
| Chromium CLS over the load | 0.79-1.04 | 0.0000-0.0001 | 0.0001 |

Read on desktop Chromium at a 436x945 phone viewport and in **Chrome on the Mi 9T** (Android 10,
same numbers to the pixel; the 629 px is the Mi 9T's). Two things the "before" column shows that
reading the source did not: the old photo and video skeletons were 32-57 px tall, not the 4:3 /
16:9 box the code seemed to ask for - `w-full` inside a `w-fit` bubble resolves against nothing and
the skeleton shrank to its 32 px icon - so EVERY photo and video grew by 300+ px on arrival, sized
or not; and the GIF link was 0 px.

**The iPhone 12 (iOS 27.0.1) was NOT read**: opening the bench in Safari raised iOS's
default-browser choice screen, a decision that is the owner's, so the session was abandoned
untouched (WDA stopped, Canari back in front). Owed: one pass on the iPhone, after that choice is
made once, or in a bench build.

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
- **`placeholder`** is a base64 ThumbHash, painted as the frame's background (`placeholderDataUrl`,
  `frontend/src/lib/utils/mediaPlaceholder.ts`) until the child covers it; for an old message the
  frame's surface tone stands in. The sender computes it for every IMAGE (photos and GIF files) in
  `prepareMediaFiles` (`placeholderForImageFile`: decode, scale to at most 100 px, hash) and it
  travels in `MediaMsg.placeholder` (proto field 13) and in the stored `MediaRef` JSON. **A video
  carries none yet** - its poster frame needs the chat video path, so it is owed with it.
  Measured on a 3000x4000 JPEG: 21 bytes; 129 ms first / ~48 ms warm on desktop Chromium, 726 ms
  first / 200-390 ms warm on the Mi 9T's Chrome. It runs once per picture at prepare time, beside the
  compression that already decodes the file. **Wire compatibility is a test, not a hope**:
  `codec.mediaPlaceholder.test.ts` decodes new bytes with the pre-field schema parsed by protobufjs
  and the reverse, and asserts a ref with no placeholder encodes byte for byte as before.
- **A GIF FILE now declares its size** too (`readImageDimensions` in the GIF branch of
  `prepareMediaFiles`), so a GIF sent from the gallery no longer opens at the fallback ratio.
- **`tag="span"`** where the frame sits in phrasing content (a GIF inside a message's `<p>`).
- **`data-media-size`** on the frame says what it was drawn from (`498x280`, or `fallback`) - the
  attribute the component tests read, since happy-dom cannot parse `width: min(...)`.
- **The feed (`PostContent`) keeps calling `mediaAspectStyle`**, which IS the frame's `fill` style
  (`mediaFrameStyle` delegates to it), so the ceiling has one implementation; a feed attachment
  already reserved its box before this work, and a post without a size letterboxes rather than
  shifts.

**For a GIF sent by URL**, the size rides in the URL's FRAGMENT, which no server ever receives and
every old client ignores: `withGifSize(url, w, h)` writes `#cn-size=<w>x<h>`, `gifSizeFromUrl(url)`
reads it (`frontend/src/lib/utils/chat/messageDisplay.ts`). **A GIF picker passes its result through
`withGifSize` before `onSendGif`**, with the dimensions of the variant it sends - that is the whole
of what the GIF panel owes this page. A GIF tile in the panel renders a `MediaFrame
sizing="intrinsic"` from the provider's dimensions, so the grid does not reflow as tiles arrive.

## 4. The pane keeps the reader's row, whatever grows

`observeThreadGrowth` (`frontend/src/lib/utils/chat/threadGrowthObserver.ts`, taken out of
`ChatArea` so the bench drives the real wiring) anchors on the row AT THE TOP OF THE VIEWPORT
(`firstRowBelow`), not the topmost rendered one, compensates a change above it in BOTH directions,
and watches every child's box as well as the mutations - so a medium settling anywhere is either
followed (reader at the bottom) or compensated (reader above it).

**It switches the browser's own anchoring OFF (`overflow-anchor: none`), and that was measured, not
chosen.** The first bench run of the new code moved the reader's row by 253 px UPWARD: Chromium had
already moved `scrollTop` by the 272 px an old video grew above the reader, and the observer added
272 more. Native anchoring exists in Chromium and from Safari 27 - the iPhone 12 runs iOS 27.0.1 -
and not before it, so leaving it on makes one piece of code right on one phone and wrong on the
next. With it off, the same run moved the row by 0 px on desktop Chromium and 1 px on the Mi 9T.
It also explains a remark in [local-first-ui](local-first-ui.md): a prepend at `scrollTop` 0 is
never natively anchored (the spec selects no anchor there), which is why only the top of the pane
ever showed the slide.

## 5. Old messages, honestly

A message sent before this work has no size (videos and GIFs) and no placeholder (everything). Its
frame opens at the fallback ratio and, the FIRST time its media loads on a device, takes the real
ratio - **one shift, once per old message per device** - then files it in the measured-size cache, so
every later render of that row, in this session or after a restart, opens at the right size. A new
message never shifts.

## 7. An orphan media row, and a card with no bubble

**An own file card assumed an amber bubble** (`text-cn-ink`, `bg-black/10`), but a media-only message has none (`MessageBubble` `isMediaOnly`): in dark theme the navy ink sat on the black page. `MessageMediaRenderer` takes `onBubble` (`!isMediaOnly`); amber tones apply only when `isOwn && onBubble`, otherwise the theme pair (`bg-black/5 dark:bg-white/10`, `text-text-main`). The ring and buttons use `currentColor`, so they follow.

**An orphan** is a ref with an empty `mediaId` that no upload view advances (`isOrphanMediaRef`, `utils/chat/orphanMedia.ts`; `upload` is non-null exactly while the outbox owns the entry). It shows `media_orphan_label` and the delete instead of the queued spinner, for received rows too. Origin and what is still open: [backlog](../backlog.md).

## 6. Where it stands

| Half | Pull request | State |
| --- | --- | --- |
| This contract and the research | #1339 | merged |
| `MediaFrame`, the chat photo / video / GIF-link / voice renderers on it, the measured-size cache, the pane's anchor | #1346 | merged |
| Sender side: GIF file sizes, the ThumbHash placeholder on the wire (images) | this page's third pull request | see its state on GitHub |
| GIF URL sizes from the picker (`withGifSize`), tiles on `MediaFrame` | the GIF panel's follow-up | see its state on GitHub |
| Video placeholder (poster frame) | with the chat video path | owed |
| A reading on the iPhone 12 | - | owed: Safari's first launch asks the owner to choose a default browser |
