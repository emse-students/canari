# The video player - one player, one controls kit, one gesture map (owner, 2026-11-09)

**Why this page exists.** The owner, 2026-11-09: *"revoir toute l'UI des lecteurs de videos,
notamment le bouton play et tout, qui ne sont pas beaux. Je veux du liquid glass"* and *"Cliquer sur
la video doit mettre le son, comme sur instagram"*. Five player modes lived in three components
(`InlineVideo` x2, `VideoPlayer` x2, `LiveViewer`'s raw `<video>`) with four vocabularies for the same
two verbs: two sizes of a solid-amber play disc, a scrim-disc speaker, a bar speaker, a rail speaker,
a corner speaker. The history of the player before this page (the bar, the fade, resuming, the
arbiter, the lightbox's zoom) is in [posts](posts.md#a-video-is-canaris-to-play-videoplayer-never-controls-2026-10-01).


## A tap in full screen never mutes (owner, 2026-11-10)

*"c'est insupportable que le clic coupe le son en plein ecran ... n'importe quel clic sur l'interface coupe le son."*
The cause: the `reel` and `lightbox` rows of `utils/videoTapAction.ts` answered `toggle-sound`, so
every tap meant to raise the bar silenced the video. The rule now follows TikTok, YouTube Shorts and
Instagram Reels, which all pause on a single tap (Instagram dropped tap-to-mute in March 2026;
sources: [9to5Google](https://9to5google.com/2026/03/19/instagram-finally-settles-on-pause-for-a-tap-on-reels-instead-of-mute/),
[Social Media Today](https://www.socialmediatoday.com/news/instagram-adds-ability-to-pause-reels-with-a-single-tap/815150/)):

- In a full-screen viewer (reel, lightbox, conversation, native fullscreen) a single tap PLAYS or
  PAUSES; it NEVER mutes. A MUTED video's tap turns the sound ON instead (the autoplay-refused case).
- Sound goes off only through the speaker button or the `m` key.
- A viewer opens with the app's sound answer. If the engine refuses that audible autoplay, the
  minimal player plays muted for this session (`videoSound.muteForRefusedStart`, the stored choice
  kept) and logs a WARN - it replaces the 2026-11-04 rule that left a refused reel paused.
- A double tap (the Reels like) is no single tap (`videoGestures` reports the pair only), so it leaves
  playback as it was. The live viewer has no pause: its tap only turns the sound on.
- The inline feed player is unchanged: muted at start, its tap opens the viewer, its chip is the sound.

## The owner's decisions (2026-11-09, final)

1. **ONE player for every surface** - feed, CanaReels, chat video, lightbox, live viewer - with a
   `variant` (`VideoPlayer`'s: `lightbox`, `reel`; `feed` and `chat` with step D) and ONE controls kit. The composer's previews (`PickedMediaPreview`, `ReelReview`, the
   editor, the publish sheet) are not players and stay as they are.
2. **Liquid Glass**, from the existing `.glass-chrome` recipe plus one sibling token set
   (`--glass-video-*`), degrading without a timer. No SVG `feDisplacementMap` lensing: WebKit does
   not apply an SVG filter to a live `<video>` (Aave, "Building Glass for the Web"), so it cannot be
   the same on the iPhone. **Android is flat until a Mi 9T measurement shows no janky-frame
   regression** ([the glass budget](#the-glass-budget)).
3. **The gestures, the same everywhere**: a single TAP toggles the SOUND (amended 2026-11-10: in full screen it plays or pauses and never mutes, see below) (a speaker glyph pops and
   fades); a PRESS HELD pauses while held and resumes on release; a DOUBLE TAP likes where likes
   exist (CanaReels, a feed post) and leaves the sound as it was. A small speaker stays visible on
   the video for discoverability (feed: bottom-right, Instagram's ~24 dp). The lightbox and full
   screen keep a scrubber (a time bubble, no frame thumbnail) and a play/pause button. Where a tap used
   to OPEN the lightbox (feed, chat), an expand chip takes that job. **Amended 2026-11-10**: a feed tap
   opens full screen again, and a conversation's viewer taps to pause -
   [the decisions of 2026-11-10](#the-owners-decisions-of-2026-11-10---full-screen-is-canareels).
4. **The sound is remembered per device** (this replaces the 2026-09-29 rule "muted at every start,
   in memory only"): across videos, sessions and cold starts; never audible on the first ever run;
   unmuting is always a gesture; it should follow the device volume where the platform exposes it
   ([not yet](#the-sound-state)).
5. **Accessibility**: keyboard (space/k, m, arrows, f, Home/End), Paraglide labels in fr/en, a
   visible focus ring, `prefers-reduced-motion`, 44 px targets.

**Instagram, measured on the Mi 9T (454.0.0.54.77, 2026-11-09)** - what the decisions were compared
against, not copied: a reel autoplays with sound, a 1.5 dp always-visible line at the bottom; a feed
video has a ~24 dp dark translucent round speaker bottom-right and no scrubber; a reel tap PAUSES
(a ~65 dp play disc and a ~36 dp speaker above it); a tap on a feed video opens the viewer; a hold in a
reel does NOT pause (it opens a speed sheet); the mute state carries from reel to reel and through a
background; at device volume 0 the glyph is the struck speaker. **Canari departs from it on purpose
in two places** (owner): the tap is the sound everywhere, and the hold pauses.

## The owner's decisions of 2026-11-10 - full screen is CanaReels

Readers disliked 1.6.9's feed tap (the sound), the conversation viewer was "moche et casse"
(`0:23 / 0:00`, a line that never moved) and "on ne peut plus avancer dans les videos".

1. **A tap on a feed video opens full screen, and full screen IS the CanaReels viewer**, on that video,
   at the time it had reached; a swipe continues to the following reels. A CanaReel and a post of one
   video open as a `reel` page; a video cell of a grid opens the `carousel` page on THAT media
   (`ReelViewer`'s `startMediaIndex`). A post the viewer cannot draw (`fullScreenPageOf` is `null`: a
   poll, a file, a linked event beside the video) keeps the media viewer. The expand chip does the
   same; the speaker chip is the feed's sound. `PostContent.videoOpener` decides, from the post.
2. **In full screen a tap is the sound, a hold pauses** - the reel and lightbox variants already did
   (step C); the table is now ONE pure function, `utils/videoTapAction.ts`, tested as a table.
3. **Entering or leaving full screen never restarts at 0.** The key is the MEDIA (`positionKey`, a
   post's media id), not the URL: the feed card and the CanaReels viewer hold two downloads of one
   video. Entering: the inline player notes its time (`rememberVideoPosition`), the viewer's player
   takes it at mount and seeks at `loadedmetadata`. Leaving: the inline player that opened the viewer
   WAITS (`awaitVideoHandBack`), and every viewer player hands back where it got to as it is torn down
   (`handBackVideoPosition`) - an event, never a clock. A viewer nobody opened from inline hands back
   into nothing. `PostContent` ends the wait once its `ReelViewer` is torn down (`endVideoHandBack`,
   after a `tick`, so the hand-back the teardown makes still lands).
   **A STREAMED card takes the handed-back time only if it buffers it** (review of #3311,
   `isTimeBuffered`): the CanaReels viewer is its OWN `PostMedia` and its own stream, so a card sought
   outside its buffer would fetch every segment up to there - a third download of the clip - or stall
   behind a cut; it stays where it was instead. A whole file seeks for free. **Why not a fork of the
   card's stream** (`SegmentedStreamHandle.fork`, which the post's media viewer uses): a fork dies with
   its root, and the root here is a feed card in another component tree, which a feed refresh or the
   viewport band can close while the viewer plays - the viewer would freeze. Sharing a root across
   trees needs an owner that outlives both (a stream registry by media id), left for when the double
   download is measured to matter.
4. **The conversation viewer is minimal** (`variant="conversation"`, `MessageMediaRenderer` and
   `ConversationMediaPanel`): the `line` scrubber on the bottom edge, dragged to seek; the speaker
   chip in the bottom-right corner; the glass play glyph while paused; a TAP PAUSES AND PLAYS; no pill,
   no timecode, no fade (so the viewer's header never hides). Never looped; its sound stays `local`.
5. **The feed video draws its first frame before its bytes** (owner, same day: a dark box with a play
   icon, then the frame with white bands, then the blur - three stages): `PostMedia` draws the sharp
   first frame this session decoded (`reelPosters`), else the publisher's ThumbHash, WITH its blurred
   bands, from the first paint - and hands the same picture to the player, which keeps it (and builds
   the bands from it, no second capture) and keeps its `<video>` invisible until its own frame is in.
   Posts now carry that ThumbHash: the publish queue makes it from the PREPARED file
   (`firstFramePlaceholder`) and puts it on the media ref (`PostMediaDto.placeholder`, accepted since
   CanaReels - no server change). The poster is fitted as the video will be (`posterFit`: a cropped
   grid cell crops its poster too), so nothing changes stage. **A video published before 2026-11-10 has no ThumbHash**: it shows
   Canari's poster until this device has decoded it once - there is no picture of it anywhere else,
   and none is invented.
6. **A video's stream opens a screen ahead** (`PostContent`, `VIDEO_NEAR_MARGIN = '100% 0px'`, given
   back at `200%`): one height of the scroll box, whatever the phone, instead of the 400 px pictures
   use. A distance, not a timer.

### Why seeking stopped - the cause, measured

**Every video Canari uploads declared NO LENGTH.** `prepareVideoForUpload` writes a fragmented MP4
(mediabunny, `fastStart: 'fragmented'`); the muxer writes the `moov` before the first fragment, so the
`mvhd` duration is 0 and there is no `mehd` - read on the muxer's own output (10 s clip: `mvhd`
timescale 57600, duration 0; `mdhd` 0; ten `moof`; an `mfra`). Chromium's file demuxer and its MSE
parser take the movie's length from those boxes, so the `<video>` reported 0 or `Infinity`:
`formatVideoTime` drew `0:00`, `VideoScrubber` (`known` needs a finite, positive length) refused every
press, and the engine's own `seekable` range was empty or stopped at what was buffered. A stream made
it worse: an MSE source with no declared length reads `Infinity` until its LAST segment is appended,
which a paced viewer stream (1.6.9, #3228) never does.

**Hit**: the conversation viewer and the conversation inline line (whole files), the CanaReels viewer
line and the post viewer (streams). The feed card has no scrubber. **Ruled out**: HTTP Range - the
element never sees an HTTP URL (a `blob:` file or an MSE source), and the range reader refuses a `200`
outright (`MediaRangeUnsupportedError`) rather than play it unseekable. The shared player's seek code
did not change (the same `Number.isFinite(duration)` guard as before step B).

**The fix, at the container** (`utils/mp4Duration.ts`): the samples' own length (per track, the
end of its last `trun` minus its FIRST `tfdt`, in its `mdhd` timescale) is written into the `mvhd`
duration field IN PLACE (same width; `trun` offsets are `moof`-relative and the `mfra`'s absolute, so
nothing moves). Only a file whose top-level boxes tile its bytes exactly is written - a truncated one
measures its part, not the movie - and a fuzz test (every prefix of a real upload, 400 seeded byte
flips, size-0 and 64-bit boxes, a zero timescale) pins that the reader never throws and never writes
outside the `mvhd`:

- by the writer, once, before upload (`prepareVideoForUpload`) - every video from now on;
- by the reader, for a file uploaded before (`mediaBlobCache.declareVideoDuration`, on the whole
  decrypted file) - logged at info with what it found, so the share of old files is countable;
- by a finished stream, on its HEAD ONLY (`writeMvhdDuration` on a copy of the first segment, which
  holds the `moov`, with the length the source measured after `endOfStream`, else the declared one):
  the rest stays the feed's segment `Blob`s, which the engine spills to disk - reading them back into
  one array held 2-3x a 35 MB reel in the JS heap (review of #3311);
- a stream is given the SENDER'S DECLARED length on its `MediaSource` as it opens, before any buffer
  (`segmentedMediaStream.declareStreamDuration`): a conversation's video now carries `durationMs`
  (`MediaMsg.duration_ms`, the optional field CanaReels-in-chat added, written WITHOUT the reel intent -
  a client older than the field skips it, a client since reads it on a reel's tile only), and a reel
  passes its `post.durationMs`.

**A declared length makes the whole clip seekable to the engine, but a stream never appends a
segment twice**: what its own quota trim removed (`StreamProgress.trimmedBefore`, reported before the
removal) or the engine evicted (Safari's `ManagedMediaSource` under pressure) is gone. `VideoPlayer.seekTo`
clamps a streamed source to `streamSeekFloor` - the later of the cut and `buffered.start(0)` - rather
than leave a seek waiting for ever (logged at debug when it clamps).

**Not verified on a device**: that WebKit's fragmented-MP4 reader honours the `mvhd` (Chromium's
does) - the iPhone reading below.

### A stream learns its length from its tail (2026-11-11)

**Production `1.6.10`, web (owner): no seek line at all on CanaReels and on wide feed videos opened
full screen.** The log: `[VideoPlayer] reel: the engine knows no duration (Infinity, stream)`, the
same for `feed:`, and `[media] ...: undeclared movie duration (0 s) - 61.37 s read from its fragments`.
**The cause**: every video uploaded before the writer fix declares no length, and the declared
`durationMs` reaches only a reel PAGE's stream (`ReelSlide`: `page === 'reel' ? post.durationMs : null`;
a carousel page, a post video, an old reel without it get nothing). Such an MSE source reads
`Infinity` until `endOfStream` - which a paced viewer stream reaches only at the last segment - so
`VideoScrubber` (`known` needs a finite length) drew an empty track and refused every press.
`mediaBlobCache` reads the length from the fragments only for a WHOLE file; a stream never held one.

**The fix, in the stream** (`segmentedMediaStream.ts`, `readTailSeconds`; the reader is
`mp4Duration.readMp4TailDuration`): the muxer ends every file with an `mfra` and an `mfro`. A consumer
whose pacing `readsLength` (the viewer's, `VIEWER_STREAM_PACING`; a feed card draws no line and does
not pay it) fetches the LAST segment through the shared feed and reads three things:
- the `mfro`, which gives the `mfra`'s size;
- the `tfra` entries, which say WHERE each track's last fragment starts;
- that fragment's `tfdt` and `trun`s.

It hands the length to `MediaSource.duration` **inside the append chain**: the spec refuses a
`duration` while a `SourceBuffer` updates, and the chain is the one place that knows none is.

- **The length is the ABSOLUTE end of the walked samples**, which is what an MSE duration is. The
  first decode time is not subtracted.
- **A `tfra` time is never trusted.** It is used only by a `traf` with no `tfdt`, and never compared
  with a walked end. A length that would make the file cheaper than `MIN_VIDEO_BYTES_PER_SECOND`
  (2.5 kB/s, a twentieth of the writer's lowest target `VIDEO_MIN_BITRATE`) is refused as
  implausible, with the reason. A fuzz test pins that every length it does give is finite, positive
  and plausible.
- **It never competes with playback.**
  - It starts only once the in-order buffer holds the pacing's `aheadSeconds` (30 s) past the
    playhead. That is a fact of the element, never a timer.
  - Its requests wait in the gate's `background` lane (a `GateRank`). An in-order ask of the same
    segment promotes it and holds it.
  - Closing the viewer cancels it on the wire, unless an in-order ask holds it.
  - A clip that ends before 30 s are buffered is fetched to its end, and `endOfStream` measures it.
- It is never set below what is buffered, and never over a length the engine already knows.
- When the last fragment starts before the tail, it reaches back one segment at a time, at most
  three (a stream-level test covers it).
- The tail segment stays in the feed, so the in-order fetch takes it from memory. Nothing is
  downloaded twice (test: each segment requested once).

- **A seek ahead of what is fetched fills the gap IN ORDER, and that costs every byte before the
  target.** The segments are byte ranges, not fragments, so one cannot be appended alone. A
  `seeking` element with nothing buffered at its new time is a demand (`wanted`), and the loop runs
  up to the target. A seek to 90 % of a 60 MB video downloads 54 MB first: minutes on a weak link.
  The `mfra` this reader now parses is the time-to-byte index a direct seek needs, which is
  [its own entry](../../backlog.d/p2-a-seek-ahead-in-a-stream-fetches-every-segment-before-it.md).
- **A stream that cannot learn its length** says why, once, at WARN (a fallback is a signal): `[media-seg] <label> <id>: no
  declared length, and none read from its tail - <why>` (`no mfro at the end of the file`, `no moov in
  the head`, its last segments did not arrive, ...). Its line still draws: `videoPlayback.scrubLength`
  maps it onto the end of the element's `seekable` range - what is buffered - so it moves and seeks
  within what is there instead of vanishing. The bar's BUFFERED part is drawn only against a real
  length: mapped onto what is buffered it would always read full.
- **The player's line** `the engine knows no duration` is gone for streams (at their metadata they
  hold only their head; the stream speaks for them). A FILE that declares none still says so:
  `[VideoPlayer] <variant>: the file declares no duration`.
- **"Voir plus" did nothing on `1.6.10`** (owner, same evening): on that build the caption sat 1rem
  above the frame's edge, inside the line's 2rem touch zone (`z-40` over the caption's `z-20`), so the
  LINE took the click - and with no length it refused it (`known` false), so nothing happened at all.
  `elementFromPoint` at the button's centre on a model of both geometries: the seek line at 1rem, the
  button at `clearanceAboveSeekLineRem` (#3355, on `main`, not yet released). Nothing more to fix here.
- **Phones**: Android's WebView is Chromium (`MediaSource`); iOS's WKWebView has only
  `ManagedMediaSource` (17.1+), chosen by `chooseSegmentedPlayback` (`managed`). Both take the same
  path - `duration` is the same attribute - but neither is read on a device yet (below).

### Readings owed (both phones, a pre-release carrying this)

- a feed tap on a post video and on a CanaReel opens the CanaReels viewer at the time it had reached;
  closing resumes the feed video there; a grid video opens on its cell;
- in the viewer, a tap toggles the sound, a hold pauses;
- the conversation viewer: line + corner speaker, tap pauses/plays, the line drags and the time moves
  (a video sent BEFORE this build, and one sent after);
- the CanaReels line drags to a point not yet downloaded and plays from there;
- **an OLD video (uploaded before 2026-11-10) streamed full screen** - a carousel page and a reel:
  the line is there within a second of the first frame, the log carries `read from its last
  fragments`, and no `none read from its tail` line (Mi 9T WebView; iPhone 12 WKWebView, whose
  `ManagedMediaSource` takes the same `duration`);
- a NEW post video draws its frozen first frame and its bands at once; an old one Canari's poster;
- **the cost of the `100%` band, on the Mi 9T**: after a fast fling through ~20 video posts, the count
  of open streams (`[media-seg] stream` lines minus their closes, or `streamProgressOf` entries) and
  the WebView's JS heap (`chrome://inspect` memory) - against the same fling on a build with the old
  400 px band. If either grows with the fling instead of settling, the band is too wide.

## The kit (`src/lib/components/ui/player/`)

In `ui/` because they are primitives with raw `<button>`s, the one place `controlsGuard.test.ts`
allows them ([controls](../controls.md)).

| Piece | What it is |
| --- | --- |
| `VideoChipButton` | the kit's one button: a transparent 44 px `.ui-icon-button` holding a 28 px round `glass-video` chip (`glass` off inside a glass bar, so blurs never stack); stops its press from the player's tap |
| `VideoSoundButton` | the speaker: state by shape (struck / waves) and `aria-pressed`; the sound-on glyph is the only yellow glyph |
| `VideoExpandButton` | opens the full-screen viewer where a tap used to |
| `VideoPlayGlyph` | the play button: a rounded triangle that IS the glass, no disc, in an invisible 64 px (72 px `lg`) hit square; shown only when it answers "is this playing?" |
| `VideoGlassGlyph` | the shape itself - play triangle or pause bars - clipped out of a `.glass-video-shape` layer, with an SVG rim and a sibling shadow; also the feedback glyph's play/pause and the poster's triangle |
| `VideoScrubber` | `line` (2 px, 32 px to touch, thickens with a handle while touched) and `bar` (4 px with buffered); the played part is yellow; a glass time bubble above the handle while dragged |
| `VideoFeedbackGlyph` | the pop of what a gesture just did (sound on/off, pause, play), a CSS animation that ends invisible - no timer; a sound change is announced (`aria-live="polite"`), an autoplay never is |

The gesture map is `actions/videoGestures.ts`; the glass decision `utils/videoGlass.ts`; the sound
`stores/videoSound.svelte.ts`.

## The gestures (`videoGestures.ts`)

- **The tap is the engine's `click`.** A press that scrolled, panned or pinched never makes one, so a
  swipe in the reel pager or the lightbox is never a sound toggle. `detail === 0` (a keyboard or a
  screen reader activation) is not a tap: the player's keyboard map answers those.
- **The hold** is a press that stays down `HOLD_TO_PAUSE_MS` (= `GESTURE.TAP_MAX_MS`, 300 ms, the
  length past which the app already says a press is not a tap) within `GESTURE.TAP_SLOP_PX`. One
  timer, armed at the press and cleared at its end: it decides which gesture a press was and nothing
  else - not a retry, not a guess about the network. A travel past the slop, a second finger or a
  `pointercancel` ends a hold and resumes. The click a held mouse press still makes is swallowed, and
  the next press clears that flag, so an Android long press (which makes no click) cannot eat the tap
  after it. The phone's long-press menu (save video) is prevented on the picture.
- **The double tap.** Where it likes (`waitForDouble`), the single tap waits for
  `GESTURE.DOUBLE_TAP_MS` through `createTapDisambiguator` - the window `doubleTapLike` on the surface
  reads, so the two cannot disagree - and a pair is a double tap, never two sound toggles: the sound is
  never audible for a quarter second. The like itself stays the surface's (`doubleTapLike`). Where no
  double tap means anything, the tap acts at once.
- **The picture's tap goes no further** (`stopPropagation`): a message bubble or a card around the
  player never also takes it; a surface's double tap still sees it, `doubleTapLike` listening in the
  capture phase.
- **Controls are never the gesture's**: anything inside `[data-video-controls]` or a nested control
  (`tapBelongsToInnerControl`).
- Tests: `videoGestures.test.ts` - the pointer sequence with fake timers, never a wall clock.

## The sound state

`videoSound` is ONE answer for every `app`-scoped video, stored on the device under
`canari-video-sound` (`'on'` / `'off'`, absent until the reader first chooses). A device preference
like the theme: not per account, not wiped by a sign-out.

- **First ever run: muted.** Only a reader's gesture (`setMuted` / `toggle` from a tap, the speaker,
  the `m` key, a viewer's sound button) writes the choice.
- **A stored "on" is honoured at start only where an audible start needs no gesture**: the phone
  apps, whose WebViews are configured so (`mediaPlaybackRequiresUserGesture = false` in the patched
  wry `RustWebView.kt`, WKWebView `mediaTypesRequiringUserActionForPlayback = None`). A browser tab
  that has had no gesture yet (`navigator.userActivation.hasBeenActive === false`) would REFUSE an
  audible autoplay and leave the video still - so there the session starts muted and the stored "on"
  is kept for the next tap. A fact read once at start, never a refusal provoked to learn it.
- **A conversation's video keeps its own sound** (owner, 2026-10-02, unchanged): pressing play is the
  reader asking for that video, so it plays audible and its speaker mutes that element only
  (`soundScope="local"`); it neither reads nor writes `videoSound`.
- **An engine's refusal is not the reader's choice** (step E). The live viewer, refused an audible
  `play()`, retries muted so a live never sits paused; it calls `videoSound.muteForRefusedStart()`
  first, which silences THIS session without writing the store, so the element's `volumechange`
  (forwarded by `followVideoSound`) finds the answer already muted and writes nothing. Before, that
  retry would have remembered "off" for good - a refusal turned into a preference.
- **One volume LEVEL, and a desktop slider** (owner, 2026-11-11). `videoSound.level` is the last
  NON-ZERO level in (0, 1], stored under `canari-video-volume` (every read and write in try/catch) and
  applied to every video's `volume` (`VideoPlayer`'s effect, `LiveViewer`'s, `followVideoSound` for
  the native-controls viewer, which also takes a native drag back as the level). A drag ticks the level
  IN MEMORY (`setLevel`/`setVolume`, nothing written or logged per tick); the gesture ends in
  `commitLevel` (the range's `change`, a wheel notch, a viewer closing): one write, one log line.
  Mute stays its own toggle: the speaker unmutes at the stored level, `setVolume(0)` is mute and keeps
  the level, a drag up from mute unmutes.
- **The slider** is `VideoVolumeSlider` (a real vertical `<input type=range>`, `aria-valuetext` a
  percentage, `data-video-controls`), mounted by `VideoSoundButton` ONLY when it is given `onLevel`
  and `(hover: hover) and (pointer: fine)` holds (`watchFineHover`); a phone keeps its hardware
  buttons. Behaviours pinned (reviewed 2026-11-11, checked in a real Chrome):
  - **Position**: the caller's corner classes sit on an OUTER box alone, the pill's anchor is an inner
    `relative` box - never two position classes on one element.
  - **Open**: `pointerenter`/`pointerleave` of a MOUSE pointer only (a hybrid laptop's touch never
    sticks it open); keyboard focus only after a Tab (one shared modality flag), so a click-focused
    speaker does not hold it open. A thumb drag leaving the pill keeps it open until the release.
  - **Escape** closes the pill alone (not the lightbox behind) and returns focus to the speaker.
  - **Top layer**: the pill is a `popover="manual"` shown while open, so no `overflow-hidden` card or
    bubble clips it; it stays a DOM child of the speaker's host, which keeps hover and focus continuous.
    Closed, it is `inert` and hidden - neither Tab nor a screen reader meets it.
  - **Inputs**: every key the range handles (not Tab, not Escape) stops at the slider, so Space, `m`,
    `f`, `k`, arrows never reach the player's keyboard map; the wheel over the pill is the volume's
    (non-passive, 5 % a notch, stopped there; `wheelOverVolume` also guards the reel viewer and the
    lightbox, which would page and zoom).
  - **Glass**: its own `glass-video` blur on the feed, the rail and the conversation viewer; the FLAT
    tint (`--glass-video-flat-bg`, no blur) inside the lightbox's glass bar - never a second blur
    ([design-reference](../design-reference.md)).
  - **A chat video's slider mutes only that video** (`soundScope="local"`): it moves the shared level
    for everyone, but dragging to 0 or up from 0 mutes or unmutes only that element, and never writes
    the app's mute answer. A `silent` take has no slider.
  - Surfaces: the feed, the lightbox bar, the conversation viewer, the reel rail, the live viewer, the
    chat video. Tests: `volumeSlider.svelte.test.ts`, `volumeSlider.twoPlayers.svelte.test.ts`.
- **Not yet: the device volume.** No WebView exposes the system volume; following it (the struck
  glyph at volume 0, as Instagram does) needs a native bridge on each phone - owed in
  [backlog](../../backlog.d/video-sound-follows-the-device-volume.md).
- Tests: `videoSound.svelte.test.ts`.

## Loudness

**The owner's decisions (2026-11-11).** *Some videos are loud, others very quiet.* Measure at send,
apply at playback, as YouTube and Spotify do; the file is never altered; an old video with no
measurement plays exactly as today. Live streams are out of scope.

**Measured on the author's device** - the server holds ciphertext and can measure nothing.
`prepareVideoForUpload` decodes the KEPT audio window once more (`AudioSampleSink`, the same window
the conversion reads, a reel's trim included) IN PARALLEL with the conversion and feeds
`LoudnessMeter` (`src/lib/video/loudnessMeter.ts`): ITU-R BS.1770-4 / EBU R128 - K-weighting (two
biquads derived per sample rate with libebur128's derivation, which reproduces the 48 kHz table),
400 ms blocks on a 100 ms hop, an absolute gate at -70 LUFS and a relative gate at -10 LU. It also
keeps the SAMPLE peak (one comparison a sample); a true peak would need a 4x resampler per channel,
so the player keeps 1 dB of headroom instead. Silence (nothing over -70 LUFS) and a clip under one
block have NO measurement. A failed decode is `null` and a `warn`, never a refusal of the video. A
decode beside the conversion was chosen over the conversion's own audio hook because a COPIED AAC
track (the common case, [video-preparation](../video-preparation.md#an-aac-lc-track-is-copied-and-a-firefox-avcc-is-rebuilt-2026-10-14))
is never decoded by the conversion at all.

**What it costs.** The meter alone: 72 ms for 90 s of 48 kHz stereo on the Windows desktop (bun),
about 8.6 million samples through two biquads. Then the decode of the audio, on the CPU, while the
video encode runs on the hardware encoder. Neither has been timed on the Mi 9T: **owed** - the
`[video-prep] loudness: ... measured in N ms` line against the `done in N ms` line of the same send,
for a 90 s reel.

**Where it travels** - one optional field, `loudness: { integratedLufs, samplePeakDbfs }`:

| Surface | Carried by | An older build |
| --- | --- | --- |
| Feed post, CanaReel (publish queue, `publishReel`, the post editor) | the post's media JSON; social-service declares it (`PostMediaLoudnessDto`, so `whitelist: true` keeps it, bounded) | ignores the key and plays as before |
| Chat video, a CanaReel take sent in a conversation (the outbox, an adopted reel upload) | `MediaMsg.loudness` (field 18, a `MediaLoudness` message), and the stored envelope's JSON | protobuf skips field 18 and plays as before |
| Live replay | nothing: its segments are not prepared by the seam | - |

A server still running the code before this change strips the post field: those posts play
unmeasured. A reader checks every value (`isMediaLoudness`) and plays as is what no real signal gives.

**The law** (`loudnessGainDb`, `src/lib/video/loudnessPlayback.ts`): toward **-14 LUFS**; a loud video
is lowered without floor; a quiet one is raised by at most **+6 dB** and never past a sample peak of
**-1 dBFS** (the clamp only limits a raise: a quiet video already peaking over -1 dBFS plays at 0 dB,
never lower); within **0.5 dB** nothing is applied and no graph is built. No measurement, no gain.

**No `DynamicsCompressorNode` as a limiter**: the spec's compressor adds an automatic make-up gain
(`(1/fullRangeGain)^0.6`) that would move every routed video's level and colour its transients; the
measured peak clamp already proves a raise cannot clip on the samples measured.

**The route** (`LoudnessAudio.attach`, one handle per `<video>` ELEMENT in `VideoPlayer`, which
every surface feeds its `MediaRef.loudness`: the feed, the lightbox, CanaReels, a chat's inline video
and both conversation viewers; the measurement is applied by a second effect keyed on its two
NUMBERS, so a new object with the same values changes nothing): `MediaElementAudioSourceNode ->
GainNode -> destination`, on ONE `AudioContext` for the app.

| Constraint | How it is met |
| --- | --- |
| A context runs only after a gesture | the reader's unmute PRIMES it synchronously inside the gesture (`videoSound.setMuted(false)` -> `primeLoudnessAudio`, and the player's own speaker): the context is made and `resume()` called there, where WebKit honours it; the graph is built the first time the element is AUDIBLE (unmuted AND playing) |
| Muted autoplay must not need the context | a muted element never asks for it (a test says so) |
| A context that will not run | the element is left UNROUTED, so it is never silenced; the fallback below. A `resume()` that never answers is said once (`has not answered ... unrouted, without its gain`) |
| The app holds no audio output when nothing plays (the Pixel 6a AAudio defect, `utils/toneOutput.ts`) | the context is SUSPENDED when no routed element plays (`pause`, `ended`, unmount), resumed on a routed `play`, and CLOSED when no routed element is mounted - never under a mounted one, since an element takes one source node in its life. **The app leaving the screen is NOT a second source** (review of #3394): on a native phone the playback arbiter (`actions/playbackArbiter.ts`) pauses every registered media then, and those `pause` events suspend the context; on web and desktop the arbiter keeps a note or a video the reader started playing behind another tab, and the old screen-leave suspend silenced it. So ONLY an element registered with the arbiter is routed (`isArbitrated`; an unregistered one is refused at `error` and takes the fallback), and every `VideoPlayer` variant and `VoiceMessagePlayer` registers (tests) |
| Once routed, an element sounds only through the graph | a new measurement only changes the gain (none = unity); a routed `play` whose context is not `running` after `resume()`, or a source left on a closed context, is logged at `error`: `routed and SILENT` |
| `element.volume` and `muted` | applied by the engine BEFORE the source node, so the reader's mute silences the graph and the shared level of PR #3372 multiplies with the gain; nothing on this route writes them |
| A blob source | same-origin, routed |
| A STREAM on WebKit (`ManagedMediaSource` / MSE) | NOT routed (review of #3378): it may play silent through Web Audio with no exception. It takes only the fallback's attenuation, said once per element, until the iPhone 12 reading below proves sound |
| Unmount | the source and the gain are disconnected: the graph keeps no element alive |

**The fallback, and it is one** (`warn`, `[LOUDNESS] FALLBACK: <cause>`): no Web Audio, a source node
the engine refuses, a context that stays suspended, a WebKit stream. A LOWERING then goes through
`element.volume`; a raise cannot (a volume stops at 1) and the video plays as is. The written volume
is READ BACK: iOS ignores it, and the line says so. **ONE rule decides an element's volume, in
`utils/videoVolume.ts` (#3372's one place for `video.volume`): `applyVideoLevel` writes the reader's
level TIMES the fallback's factor (`elementVolumeFor`), and `readVideoLevel` divides it back out
(`readerLevelOf`)**, so the slider never erases the attenuation and the attenuation is never
remembered as the reader's level (`videoVolume.test.ts`, on a loud WebKit stream). On the Web Audio
route the factor is 1 and the gain is the graph's: the two multiply in the engine.

**What a reader trusts.** The numbers come from another device. A loudness over 0 LUFS, or a peak more
than 3 dB under the loudness, is no signal's and could only be a crafted entry meant to silence the
video: `isMediaLoudness` refuses it and the video plays as is.

**iOS (WKWebView).** `element.volume` is read-only there, so Web Audio is the ONLY way a gain reaches
an iPhone. The silent switch is not a new risk: `audioSession.ts` already sets `playback` while an
unmuted media plays (`reportAudibleMedia`), which covers a routed element. NOT known, and owed on the
iPhone 12: a `ManagedMediaSource` stream through `createMediaElementSource` (older WebKit gave silence
for MSE sources - so streams are not routed yet), whether a suspended context resumes on a routed
`play` without a fresh gesture under `mediaTypesRequiringUserActionForPlayback = None` (the next reel
after a swipe), and its `interrupted` state after a background.

**Readings owed** (a pre-release carrying this; both phones):

- the cost: `[video-prep] loudness` against `done in` for a 90 s reel, Mi 9T and iPhone 12;
- a quiet clip and a loud clip, posted and sent in a chat: each logs `routed through Web Audio at
  +x / -y dB`, and they sound alike - on the feed after the tap, in CanaReels, inline in a chat and in
  the conversation viewer;
- **iPhone 12, the gate that would route WebKit streams:** a STREAMED (segmented) reel, routed by hand
  on a bench build, has sound; until then `stream on WebKit is not routed` is the expected line;
- the next reel after a swipe on the iPhone: no `routed and SILENT` line, sound present;
- a routed video after the app went to the background and back: sound present; and on the Mi 9T,
  `dumpsys audio` shows no started AAudio stream for the app while it is in the background;
- the silent switch ON, a routed reel unmuted: it plays, as before;
- an old video: `no measurement: played as is`, and no change by ear.

### Voice notes take the same loudness (owner, 2026-11-12)

A voice note in a DM, a group or a salon is measured and played through the SAME two halves - no
second meter, no second law, no second route.

- **Measured WHILE it is recorded** (review of #3394: an offline decode after the finger lifted
  delayed the send by a whole decode, unbounded in the note's length). `VoiceRecorder` starts
  `tapRecordingLoudness` (`src/lib/utils/audio/recordingLoudness.ts`) on the microphone's stream:
  `MediaStreamSource -> AudioWorkletNode (workers/loudnessTap.worklet.ts) ->
  MediaStreamAudioDestinationNode`, on a context of its own, closed with the recording. The worklet
  only COPIES samples, in batches of 2048 frames (~43 ms) posted with their buffers transferred; the
  page feeds them to the one `LoudnessMeter`. The recorder's `onstop` reads the result synchronously
  and hands it with the blob (`onRecordingComplete(blob, loudness)` -> `ChatComposer` -> `ChatArea`
  -> `MainChatPage` -> `sendVoiceNote(file, ctx, loudness)`): **the send waits for nothing and the
  recording is never decoded again.** The sink is never the speaker (the call microphone's pattern);
  a realtime context still holds a platform stream while it exists, for exactly the recording, in the
  foreground.
- **What the tap does not see**: the samples before the worklet module has loaded (the first tens of
  ms of the first recording of a session) and a batch in flight at the stop (at most ~43 ms). The
  integrated loudness is a gated mean over 400 ms blocks, so neither moves it measurably; the stop's
  line says `N s of M s` measured.
- **Never a refusal**: no AudioWorklet, a module that does not load, a refused graph, or silence -
  the note is sent UNMEASURED with a `warn` naming the cause.
- From `sendVoiceNote` it is a video's path: `voiceNoteEntry` (`utils/chat/voiceNote.ts`) puts the
  loudness next to `voiceNote: true`, and DM, group and salon all leave through `buildMediaMessage`,
  into `MediaMsg.loudness` (field 18) and the stored envelope's JSON.
- **At playback**, `VoiceMessagePlayer` attaches its `<audio>` element to `loudnessAudio` exactly as
  `VideoPlayer` attaches its `<video>` (one handle per element, the measurement applied keyed on its
  two numbers). Its play tap PRIMES the context - every tap, a routed element's suspended context
  included - and, when a `resume()` was asked, calls `play()` only once it answered: the graph is
  then built at the note's gain on that `play`, and the first syllable is never heard at the
  uncorrected level. **Only a `suspended` context's resume is waited on - decided from its STATE,
  never a timer**: a context `interrupted` (WebKit, during a phone call) or closed may hold its
  `resume()` unanswered for as long as the cause lasts, so the tap plays at once, unrouted, with the
  element-volume fallback for the gain (`[LOUDNESS] FALLBACK: the AudioContext is interrupted`, at
  `warn`). Nothing asked (an old note, a context already running): `play()` runs in the tap's own
  turn. `MessageMediaRenderer` hands it `mediaRef.loudness`.
- **Safari on the web, not verified**: after a waited resume, `play()` runs once the resume has
  answered - the device's start time after the tap, not within it. Whether WebKit still counts it
  as the gesture is not known here (no WebKit in the test rig). The alternative - `play()` muted inside the tap, unmuted when the resume answers - is NOT taken
  blind, because WebKit's autoplay policy pauses a muted-autoplayed element that is unmuted outside a
  gesture: it would trade one unverified risk for another. A reading decides (below); the native
  shells play media without a gesture requirement.
- **No WebKit bypass.** A voice note is a decrypted BLOB URL, never a `MediaSource` stream, so it is
  attached with `streamed: false` and IS routed on WebKit - the only way a gain reaches an iPhone,
  whose `element.volume` is read-only. The element-volume factor stays the fallback for an engine
  without Web Audio, as for videos.
- **Old notes**, and the composer's own preview, carry no loudness: `no measurement: played as is`,
  no context is made.
- Tests: `recordingLoudness.test.ts` (the worklet driven with 128-frame quanta gives the measurement
  of the whole recording; the tap's stop returns it and closes its context; no worklet, or a module
  that fails, sends unmeasured), `useMessaging.voiceNoteLoudness.svelte.test.ts` (`sendVoiceNote`:
  the loudness reaches `buildMediaMessage`'s proto and envelope; an unmeasured note is still sent),
  `voiceNote.test.ts`, `VoiceMessagePlayer.loudness.svelte.test.ts` (the real route and the real
  arbiter over a fake `AudioContext`: the law's gains, `play()` only after the resume, a tab hidden on
  web leaves the note sounding, a native screen-leave pauses it and that pause suspends, an old note
  unrouted), `workerScope.test.ts` (the worklet loads in an AudioWorklet scope).

**Readings owed** (a pre-release; both phones):

- a whispered and a shouted note: `voice note measured while recorded: ... LUFS` on the sender, with
  `N s of M s` close to the recording's length, `routed through Web Audio at ... dB` on the reader,
  and the two sounding alike;
- **send latency**, iPhone 12 and Mi 9T, for a 1-minute and a 5-minute note: the finger's lift to the
  outbox entry (`[MEDIA]` / outbox lines) - no wait on a decode;
- the first syllable at its corrected level, never loud for a moment;
- the silent switch ON on the iPhone 12, a voice note played: it sounds (the `playback` category);
- 1.5x and 2x, and a seek, while routed: the gain holds, no glitch;
- a Bluetooth headset, on both phones: a routed note plays through it, and a recording through its
  microphone is measured;
- on the iPhone 12, a routed note has sound on the first tap and after a background; the recorder's
  tap context starts after `getUserMedia` (no gesture of its own);
- on the Mi 9T, no started AAudio stream once the note ends or the app leaves the screen
  (`dumpsys audio`);
- on web, a note started then the tab switched: it keeps playing;
- **Safari on macOS / iOS web**, a measured note's first tap from a suspended context: it plays (no
  `play() refused` NotAllowedError line); if refused, the muted-inside-the-tap variant above is built
  and its unmute read on the same engine;
- a phone call arriving on the iPhone 12, then a note tapped: it plays at once, with `FALLBACK: the
  AudioContext is interrupted`;
- an old note unchanged.

## The glass play glyph - a triangle with no disc (owner, 2026-11-09)

> *"J'aurais juste fait le triangle en liquid glass."* The play glyph ITSELF is the glass: no circle
> behind it, on every surface at once (viewer, reels, feed, chat, live, the poster before a first
> frame). The pause bars the same way where they are shown (the gesture's feedback glyph).

How it is built (`VideoGlassGlyph`, geometry in `utils/videoGlassGlyph.ts`): a rounded triangle path
authored on 64 units and scaled to the box in pixels, used three times - the `clip-path: path()` of a
`.glass-video-shape` layer (the video's blur and dark tint exist only inside the shape), a thin light
stroke along it (the rim, a gradient bright at the top-left edge, in SVG because a clipped element
cannot carry a border), and a blurred copy beneath as the soft shadow. The shadow is a SIBLING of the
glass: a `filter` on an ancestor would make that ancestor the backdrop root and the glass would blur
nothing but its own box.

- **One glyph everywhere (owner, 2026-11-11)**: the chat reel tile (64 px), the replay card (64 px)
  and the shared-media grid thumbnail (32 px) once drew their own disc around a Lucide `Play`; they
  now render `VideoGlassGlyph kind="play"` directly (decorative, `pointer-events-none`: the tile's
  own button stays the hit target). The blur samples whatever is behind it, so a poster or a video
  thumbnail works as a frame does. `ChatReelTile`, `ReplayCard` and `SharedMediaThumb` each have a render
  test asserting the glass glyph is mounted and no `.lucide-play` is. Left alone on purpose: the control-bar play/pause chips and the voice-message player.
- **Hit target**: the button is an invisible 64 px square (72 px `lg`) around the triangle - the 44 px
  minimum holds whatever the glyph draws.
- **Legibility**: the fill is white over the dark tint plus the shadow, so a white frame and a black
  frame both leave it readable (not yet read on a device - the readings below).
- **Flat / reduced transparency / no `backdrop-filter` / more contrast**: `.glass-video-shape` reads
  the same `--glass-video-*` variables as `.glass-video`, so every fallback that flattens the chip
  flattens it: a solid dark tint in the shape of the triangle, rim and shadow kept.
- **WebKit - NOT VERIFIED**: a `backdrop-filter` on an element cut by `clip-path` renders in Chromium,
  and WebKit has reports of ignoring the blur on clipped or masked elements. No test can say, and none
  was run on the iPhone 12. If WebKit draws the triangle without the blur it falls to the same solid
  tint as the flat form (still a triangle, still legible) - the honest equivalent, not a fake. The
  iPhone 12 reading (a paused viewer over a white frame, a black frame, a bright photo) is owed and
  decides whether the blur is kept there or `videoGlass()` returns `flat` for the glyph.

## The glass

`.glass-video` in `app.css`, beside `.glass-chrome` and built the same way, with what makes it read
as Liquid Glass rather than frosted grey: a specular rim (`--glass-video-rim`, an inset top line), a
sheen (`--glass-video-sheen`, a top-down white gradient) and a dark tint (`--glass-video-bg`, black at
28 %) - one set for both themes, because a video is dark whatever the app's theme and a surface-coloured
tint would leave a white glyph unreadable on a white frame. The blur is 12 px, not the chrome's 18 px.
**The glyph is white and its state is its shape; the yellow is only the played part of a scrubber and
the sound-on glyph** - the 2026-10-01 fix ("the button took the colour of the green clip") kept: the
disc may take the frame's colour through its blur, the glyph cannot.

**Degrading, with no timer - decided at parse time or once at the first player:**

- `@supports not (backdrop-filter)` and `prefers-reduced-transparency: reduce`: the existing fallback
  block flattens the video glass too (`--glass-video-flat-bg`, black at 62 %, no sheen, no blur);
- `prefers-contrast: more` flattens the video glass - the one such query WebKit exposes, so the one that
  reaches an iPhone reader who asked for legibility (WebKit has no `prefers-reduced-transparency`);
- `data-glass="flat"` on the element, from `videoGlass()`: **Android** (the app's WebView or a browser
  on Android) **until its measurement** (`ANDROID_VIDEO_GLASS`, one constant), and once that flips, a
  low-end Android (`deviceMemory` <= 4 GB or <= 4 cores). Off Android the numbers are not read: WebKit
  hides the memory and rounds the core count;
- a hidden control is UNMOUNTED, never `opacity: 0`: a transparent layer with a backdrop filter still
  pays. At most one glass layer per element; the bar's buttons draw no chip of their own.

Tests: `styles/videoGlass.test.ts` (each fallback line), `utils/videoGlass.test.ts`.

## The glass budget

The Android default is flat until a reading on the Mi 9T says the blur costs no janky frames
(owner, 2026-11-09). **The lead takes the readings, on a pre-release carrying the lightbox migration;
nothing here was measured yet.** No published benchmark of `backdrop-filter` over a live `<video>` in
an Android WebView exists - only bug reports (Mozilla 1927619 and 1732817: Mali needs several render
targets, older Adreno pays framebuffer copies, cost grows with the radius and the blurred area) - so
this is a hypothesis to measure, not a finding.

**What the budget is.** One glass layer per visible player at most (the lightbox bar, ~360 x 56 px,
or a 64 px disc), unmounted when hidden; an idle video (bar faded, nothing touched) pays no extra
layer. The pass mark: with the bar held up over a playing 1080p H.264 clip for 30 s, the janky-frame
share rises by **no more than 3 points** and the median frame time by **no more than 1 ms** over the
same run with the flat chip.

**The switch under test.** `ANDROID_VIDEO_GLASS` in `src/lib/utils/videoGlass.ts`. For the readings
only, a build with it `true` (glass) is compared against the shipped `false` (flat); the comparison is
made on ONE build by flipping the element's `data-glass` from the remote inspector (below), which
avoids a second install.

### The Mi 9T (Snapdragon 730, Adreno 618) - the decisive reading

1. Install the pre-release (the store tester track or the APK). Open a post holding a **1080p H.264
   video of at least 30 s** (record one on the phone, publish it to a test account), open it in the
   lightbox, let it play and loop.
2. Keep the bar up for the run: with `chrome://inspect` attached to the app's WebView, run once in the
   console `document.querySelector('[data-video-player]').dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerType: 'mouse'}))`
   every 2 s (`setInterval`, cleared after), which is the mouse path that raises the bar - the
   worst case, a bar that never fades.
3. **Flat run**: `adb shell dumpsys gfxinfo fr.emse.canari reset`, wait 30 s,
   `adb shell dumpsys gfxinfo fr.emse.canari > flat.txt`. Read `Janky frames: N (P%)` and the
   `50th percentile` line.
4. **Glass run**: in the console,
   `document.querySelectorAll('[data-glass]').forEach(e => e.dataset.glass = 'glass')` - and re-run it
   if the bar remounts (it does after a fade; the interval in step 2 prevents that). Reset, wait 30 s,
   dump to `glass.txt`.
5. Repeat 3 and 4 twice more, alternating; record the six pairs (janky %, median ms). The WebView's
   frames are the app's frames in `gfxinfo` (one `SurfaceView`), so the comparison is like for like.
6. **Decision**: if the glass runs stay within the pass mark of the flat ones, flip
   `ANDROID_VIDEO_GLASS` to `true` in one PR quoting the six pairs here; otherwise keep it `false` and
   write the numbers here as the reason. Either way, record the date, the build and the clip.
   A Chrome trace (`chrome://inspect` > Performance, 10 s, with the bar up) is the deeper reading if the
   numbers are near the line: look for `Paint` / `RasterTask` time per frame with glass vs flat.

### The iPhone 12 - a check, not a gate

The iPhone draws glass already (WebKit, `decideVideoGlass`). The reading confirms it does not cost a
dropped frame there: on the pre-release, the same 30 s clip in the lightbox with the bar held up
(Safari Web Inspector on the Mac, the same console line as step 2), and the device log read with
`python -m pymobiledevice3 syslog live` filtered on the app for `[VIDEO]` and WebKit's
`compositing` warnings; Instruments' Core Animation FPS template (a Mac with Xcode) is the frame-rate
reading if one is at hand. A visible stutter, or an FPS under 55 with the bar up and 59-60 without,
would be the finding that sends iOS to the flat chip too - a decision for the owner, not this page.

### What else to look at during the same session (both phones)

- the bar's legibility over a WHITE frame and over a saturated green one (the 2026-10-01 report);
- a tap toggles the sound with the glyph; a hold pauses and resumes; the bar comes back on a tap;
- the flat chip (Android) still reads as the same design: same shapes, a darker solid tint.

## The lightbox, on the kit (step B)

`VideoPlayer`'s full mode - the single-media viewer, the gallery viewer, the chat viewer, the
conversation media panel:

- **One floating glass pill** (`data-video-bar`, `.glass-video`, the 18 px `rounded-3xl`) over the
  free bottom scrim gradient: play/pause, `elapsed / duration`, the `bar` scrubber, the speaker, full
  screen where the engine offers it. Its buttons are `VideoChipButton glass={false}`: one blur.
- **UNMOUNTED when faded**, not `opacity-0` (`{#if controlsVisible}`): the fade rule itself is
  unchanged (`CONTROLS_FADE_MS` of playback without a touch; a mouse move, a key, a pause, keyboard
  focus bring it back). It comes in with a 150 ms opacity animation, none under reduced motion.
- **A tap toggles the sound and RAISES the bar**; it no longer hides it (the 2026-10-02 toggle is
  retired: the tap is the sound now, and the bar leaves by itself). A `silent` video's tap only
  raises the bar. **A held press pauses** and draws neither the disc nor the bar for that pause; the
  release resumes only what the hold paused.
- **The glass play triangle** (`VideoPlayGlyph`) when paused, `tabindex="-1"` because the bar repeats it.
- The reel mode (`variant="reel"`, step C) shares three pieces: the `lg` glass disc on an autoplay
  refusal, `VideoFeedbackGlyph` for its gestures, and the `line` scrubber (its played part yellow).
  Since step C its tap is the sound and its hold the pause, like every player's.
- **A surface that likes on double tap** (`doubleTapLike` on, `data-double-tap-likes`) makes the
  player's single tap wait for the double-tap window - so on a reel the like never flips the sound.

### The viewer's bars follow the player's controls (owner, 2026-11-09, production 1.6.8)

The owner: the header ("Aujourd'hui 19:24", the back arrow) "sometimes does not leave" while a video
plays. Cause: two clocks. The viewer's bars (`MediaLightbox.chromeHidden`) toggled only on the
viewer's own tap, while the player's glass bar faded after `CONTROLS_FADE_MS` and was unmounted - a
tap on a playing video is the player's, so the header never saw one. `utils/videoViewerChrome.svelte.ts`
joins them: the viewer provides it, a `lightbox` `VideoPlayer` reports `controlsVisible` through it, and
the header, the side arrows and the footer hide exactly when the bar is faded and return with it. The
other way: a mouse over the header or a focus on one of its buttons asks the player to raise its
controls (otherwise a focused Back button sat at opacity 0). A player that leaves gives the bars back. The review
of the PR closed three more ways the header could stay hidden: an engine error while the bar had faded (the
message replaced the bar and the header stayed gone - the controls now come back and no longer fade over
an `unplayable` video), a photo tapped to hide the bars and a video swiped to next (a video's tap is its
sound, so nothing there could bring the header back - `ViewerChrome.present` clears the toggle while a
player is on screen), and a slide change mounting the next player before the previous one tore down (the
leaver's `leave(owner)` is ignored once another player has reported).
One test each in `MediaLightbox.videoChrome.svelte.test.ts`: the fade, a pause (an arbiter's included),
a mouse reaching the player, a mouse resting on the header, a key focus on Back, a touch on the header
(raises nothing), the next video of a gallery, a photo after a video, a photo alone.

## The feed and a conversation, on the kit (step D)

`InlineVideo` is DELETED: the feed's and a conversation's inline video are `VideoPlayer` variants,
so every video in the app but the live one (step E) is one component. The variant picks, once at
mount, how the element takes turns - `feed` `playWhileVisible`, `chat` `arbitratePlayback`, a viewer
`followVideoSound` - and nothing else differs in kind: the gestures, the glyph, the keyboard map, the
poster and the unplayable notice are the same code.

- **Superseded 2026-11-10 for the tap and the viewer** ([above](#the-owners-decisions-of-2026-11-10---full-screen-is-canareels)):
  the feed tap opens the CanaReels viewer; the conversation viewer is `variant="conversation"`.
- **`feed`** (`PostMedia`, a post card, a reel card, a post page): plays muted while on screen and
  loops, `#t=0.1` on a decrypted file (never on a stream), the blurred first-frame `backdrop` in the
  contained bands. **Minimal corners (owner, 2026-11-10, amending the two chips): no expand chip
  (the tap opens the viewer; the card root carries the caller's `openLabel` as its aria-label and
  Enter opens, `f` too); the speaker is `VideoSoundButton quiet` - a bare 18 px white glyph with a
  drop shadow, no chip, no yellow, in a 44 px invisible target - drawn ONLY while the video plays.**
  The placeholder's glass triangle (`VideoPoster`) is 48 px (36 compact). The CHAT keeps its expand
  chip. No bar, no play disc - it plays by being on screen, as Instagram's does. **A tap is the app's sound**,
  remembered (`videoSound.setMuted`); inside a post card that likes on double tap it waits for the
  window. **On a video on screen but PAUSED** (an autoplay the engine refused, the reader's own
  pause) the tap gives the sound and then plays it - there is no disc to press. `f` opens the
  viewer, the inline video's only full screen.
- **A pause the reader makes on the feed stays made** (stack review, 2026-11-09). A hold, Space or
  `k` calls `markReaderPaused` before `pause()`: the pause's own `pause` event made the arbiter
  report idle, and `resumeVisible` replayed the video last come into view - the one just paused.
  Until it plays again (the reader's play, a hold released) or LEAVES the screen, neither the idle
  resume nor its intersection starts it (`VideoPlayer.inline.svelte.test.ts`, through the real
  `playWhileVisible`).
- **`chat`** (`MessageMediaRenderer`): played when asked, never looped, **its sound its own**
  (`local`: audible from the start, neither reading nor writing the app's answer). **The glass play
  disc** until it is started, and again on a pause or at its end; **the first tap plays it**, audible,
  as the disc does, and **once started the tap is its sound**. Once started, **a pause/play chip
  bottom-left, its speaker bottom-right and the `line` scrubber stay**. The expand chip (top-right)
  opens the viewer, which resumes where it was (`videoResume`); on a phone **the message's actions
  chip** (top-left, `onActions`, the bubble's sheet) sits opposite it - see the next bullet.
- **What the expand chip changed**: the whole picture was the viewer's button
  (`data-double-tap-defers`, the click held for the double-tap window). The picture's tap is now the
  sound, which waits by itself where a like exists; the chip is a button and opens at once.
- **A hold on a chat video pauses it and ONLY that** (owner, 2026-11-09): the bubble's long-press
  action sheet does not open over the video, and stays reachable from the rest of the bubble.
  `MessageBubble` reads the fact at the press - the target is inside a `[data-video-player]` - and
  then arms no sheet timer and ignores the `contextmenu` a phone raises for a touch hold
  (`MessageBubble.videoHold.svelte.test.ts`). **A bubble that is nothing but its video** has no
  "rest" to hold, so the bubble hands the player `onActions` on a phone: the `...` chip opens the
  same sheet (`msg_more_actions_label`). On a desktop the hover toolbar is the menu, as before.

## The live viewer, on the kit (step E)

`LiveViewer` keeps its own `<video>` - `LivePlayer` drives it (MSE, the latency policy, the stall
judge) and it is not a clip with a duration - and takes the kit around it:

- **The kit's speaker** (`VideoSoundButton`, glass chip, `data-live-sound`) replaces the top bar's
  own button and its two labels (`live_viewer_mute` / `live_viewer_unmute`, deleted): the same
  object, name and `aria-pressed` as on every other video.
- **A tap on the picture is the sound**, with the `VideoFeedbackGlyph` and its announcement
  (`videoGestures` on the `<video>`; the top bar, the chat and the reactions are siblings, so their
  taps are theirs). Off on a terminal screen.
- **NO HOLD: a live does not pause** (decided here, reversible). `LivePlayer.resume()` plays a paused
  element again at its next delivery, so a held pause would fight the player within a second, and
  pausing a live only puts it behind its own edge; Instagram Live has no pause either. `videoGestures`
  takes the hold as optional for this: without `onHoldStart` no hold timer is armed.
- **The refused audible start no longer writes "off"**: [the sound state](#the-sound-state).

## Where the migration stands

| Step | Surface | State |
| --- | --- | --- |
| A | tokens, fallback, the kit, the gestures, the remembered sound | built |
| B | lightbox (`VideoPlayer` full mode) on the kit; the measurement protocol | built - readings owed ([the glass budget](#the-glass-budget)) |
| C | CanaReels (`variant="reel"`): tap = sound, hold = pause, the rail's speaker is the kit's | built - readings owed (a reel tap, a hold, a double-tap like on both phones) |
| D | feed (`variant="feed"`) and chat (`variant="chat"`); `InlineVideo` deleted | built - readings owed (a feed tap and the expand chip, a chat disc, a hold that opens no sheet) |
| E | the live viewer: the kit's speaker, tap = sound, no hold; a refused audible start no longer remembered as "off" | built - readings owed (a live tap and the speaker on both phones) |

## A link slower than the video: one honest load (2026-11-11)

**The defect** (slow-link chantier, [gap 6](../../backlog.d/slow-link-local-first-chantier.md)). On
the owner's link (about 262 KB/s) a reel at about 318 KB/s stalled 29 times: every segment that
landed was appended at once, the engine resumed on it, played its 3 s and starved again. A longer
lookahead does not help - the buffer never grows past what the link brings - and the total waiting is
about `size / link - duration` whatever the rule. Draft #3322 (an adaptive lookahead) was closed for
that reason; its rate measurement and its fake-fetch tests were kept. Its wording also read the
ratio backwards ("slower than 0.8x the media" for a test that fired at `media / link >= 0.8`, i.e.
for a link up to 1.25x the media): every ratio here is `link / media`, said that way round.

**The rule** (`utils/segmentedMediaStream.ts`, `holdTargetSeconds`). When `link / media < 1` and the
element has fired `waiting`, the stream keeps fetching but APPENDS NOTHING until it holds, buffered
plus kept back, `B >= R x (1 - link / media)` - `R` the playing time left - times a 1.1 margin, and
never more than the slow cap (30 s or 6 MiB of media, whichever is less). It computes the same bound
as `B >= (U / m) x (m / l - 1)` from the bytes `U` still to fetch, so it never needs the element's
`duration`. Then it appends everything in one go and the element plays to the end. A slow link also
fetches WITHOUT a pause up to that cap, rather than idling at the pacing's 10 s.

**When a hold ends** - the precise claim (review of #3333). A hold starts only on a `waiting`. It ends
at its target, or EARLIER, on purpose, when: the link is called fast again (slow below 1x, fast again
only from 1.15x - the hysteresis is on the link's verdict, so a rate hovering around 1x flips
nothing); the element is paused, played, sought into what it buffers (it fires `playing`) or
detached; every segment is fetched (`fetchedAll`, a FACT - not `U` reaching 0, which a wrong or
absent `ref.size`, or a partial last segment, would never let happen). **A drain, once started,
appends everything held** and does not re-check the hold: those bytes are already here, and the
burst is what the element was waiting for, so no new `waiting` can arise mid-burst. A failed range or
append rejects `done` as before, and a closed stream holds nothing. The `[media-seg]` log says when a
hold starts (with what is in and its target) and when it is released; that is its only trace.

**The cap is a bound kept small, not a measured quota.** A hold appends all of it at once, so it is
6 MiB (it was 12 in the first draft). The engines' quotas were not measured here; an append the
engine refuses (`QuotaExceededError`) goes through `appendSegmentEvicting`, which trims what was
played (keeping 10 s behind the playhead) and tries once more - tested on a drain.

**The measure** (`utils/segmentedMediaReader.ts`, `httpRangeSource`). Each ranged read reports its
bytes and the seconds from the moment `mediaRequestGate` GRANTED its slot to its last byte - the queue
is not the link. The feed smooths them (half weight to the newest read; reads under 64 KiB are not
samples). The media's rate is `size / durationMs`, else bytes appended over seconds buffered.

**What the reader sees: nothing new - the owner's decision, 2026-11-11.** *"Tout doit etre invisible
pour l'utilisateur."* A hold has no label, no percent and no control. The element is simply waiting,
so the player draws what it draws for any wait (the reel's spinner on `waiting`, nothing new
elsewhere). This replaces two things the lead had built the same day and that were removed before
merge: a "Chargement pour une lecture sans coupure... n %" label, and a reversible "Lire quand meme"
button that let the reader take the stalls instead. A link faster than the media never holds, so it
starts as soon as before.

**Measured in the model** (`segmentedMediaStream.slowLink.test.ts`: an element whose buffer grows by
what is appended and whose playhead advances on a fake clock, resuming as soon as it has data, as an
engine does; a link at a set rate). A 30-segment reel (99 s) at 318 KB/s on a 262 KB/s link: **29
stalls before, 1 after** (the 6 MiB cap splits that long reel's wait in two: a first hold before it
starts, one later); it starts at 27 s instead of 4.5 s and ends at 139.5 s instead of 138 s. On a 2
MB/s link: 0 stalls, the same start to the clock's step. The same file pins the end below the target
(an unknown size, a size declared too large), a refused append in a drain, a pause and a seek
during a hold, and the cap. A hold is observed there as segments fetched and not yet appended.

**What it does NOT do.** A reel whose autoplay is asked only at `loadedmetadata` (`variant="reel"`)
has its first segment appended while paused, so it plays that segment and holds ONCE at its end;
only an element already asked to play (a feed card on screen) holds before its first frame. A
very long video on a very slow link meets the cap and holds again later. **The other route, a
lower-bitrate rendition for a slow link, is not built**: it is the follow-up that would remove the
wait itself rather than group it.

**Readings owed.** A reel and a feed video on a throttled link (about 250 KB/s) on both phones: one
wait, then no stop.
