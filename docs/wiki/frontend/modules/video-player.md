# The video player - one player, one controls kit, one gesture map (owner, 2026-11-09)

**Why this page exists.** The owner, 2026-11-09: *"revoir toute l'UI des lecteurs de videos,
notamment le bouton play et tout, qui ne sont pas beaux. Je veux du liquid glass"* and *"Cliquer sur
la video doit mettre le son, comme sur instagram"*. Five player modes lived in three components
(`InlineVideo` x2, `VideoPlayer` x2, `LiveViewer`'s raw `<video>`) with four vocabularies for the same
two verbs: two sizes of a solid-amber play disc, a scrim-disc speaker, a bar speaker, a rail speaker,
a corner speaker. The history of the player before this page (the bar, the fade, resuming, the
arbiter, the lightbox's zoom) is in [posts](posts.md#a-video-is-canaris-to-play-videoplayer-never-controls-2026-10-01).

## The owner's decisions (2026-11-09, final)

1. **ONE player for every surface** - feed, CanaReels, chat video, lightbox, live viewer - with a
   `variant` (`VideoPlayer`'s: `lightbox`, `reel`; `feed` and `chat` with step D) and ONE controls kit. The composer's previews (`PickedMediaPreview`, `ReelReview`, the
   editor, the publish sheet) are not players and stay as they are.
2. **Liquid Glass**, from the existing `.glass-chrome` recipe plus one sibling token set
   (`--glass-video-*`), degrading without a timer. No SVG `feDisplacementMap` lensing: WebKit does
   not apply an SVG filter to a live `<video>` (Aave, "Building Glass for the Web"), so it cannot be
   the same on the iPhone. **Android is flat until a Mi 9T measurement shows no janky-frame
   regression** ([the glass budget](#the-glass-budget)).
3. **The gestures, the same everywhere**: a single TAP toggles the SOUND (a speaker glyph pops and
   fades); a PRESS HELD pauses while held and resumes on release; a DOUBLE TAP likes where likes
   exist (CanaReels, a feed post) and leaves the sound as it was. A small speaker stays visible on
   the video for discoverability (feed: bottom-right, Instagram's ~24 dp). The lightbox and full
   screen keep a scrubber (a time bubble, no frame thumbnail) and a play/pause button. Where a tap used
   to OPEN the lightbox (feed, chat), an expand chip takes that job.
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
- **Not yet: the device volume.** No WebView exposes the system volume; following it (the struck
  glyph at volume 0, as Instagram does) needs a native bridge on each phone - owed in
  [backlog](../../backlog.d/video-sound-follows-the-device-volume.md).
- Tests: `videoSound.svelte.test.ts`.

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

- **`feed`** (`PostMedia`, a post card, a reel card, a post page): plays muted while on screen and
  loops, `#t=0.1` on a decrypted file (never on a stream), the blurred first-frame `backdrop` in the
  contained bands. **The kit's speaker chip bottom-right, always drawn** (28 px glass in a 44 px
  target), **the expand chip top-right** (`VideoExpandButton`, the caller's `openLabel`). No bar, no
  play disc - it plays by being on screen, as Instagram's does. **A tap is the app's sound**,
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
