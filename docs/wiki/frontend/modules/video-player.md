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
   `variant` and ONE controls kit. The composer's previews (`PickedMediaPreview`, `ReelReview`, the
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
| `VideoPlayDisc` | the 64 px (72 px `lg`) glass play disc, white glyph; shown only when it answers "is this playing?" |
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
- **Not yet: the device volume.** No WebView exposes the system volume; following it (the struck
  glyph at volume 0, as Instagram does) needs a native bridge on each phone - owed in
  [backlog](../../backlog.d/video-sound-follows-the-device-volume.md).
- Tests: `videoSound.svelte.test.ts`.

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
(owner). The protocol is written with the lightbox's migration, the first surface that can be measured
with its bar up; the lead takes the readings.

## Where the migration stands

| Step | Surface | State |
| --- | --- | --- |
| A | tokens, fallback, the kit, the gestures, the remembered sound | built |
| B | lightbox (`VideoPlayer` full mode) on the kit; the measurement protocol | next |
| C | CanaReels (`ReelSlide`, the minimal mode) | |
| D | feed and chat (`InlineVideo`, deleted) | |
| E | the live viewer | |
