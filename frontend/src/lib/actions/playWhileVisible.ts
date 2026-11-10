import {
  arbitratePlayback,
  claimPlayback,
  isForegroundPlaying,
  isVideoPlaying,
  onPlaybackIdle,
  pausePlayback,
} from '$lib/actions/playbackArbiter';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { isAppOnScreen } from '$lib/utils/appForeground';
import { Log } from '$lib/utils/Log';
import { playRejectionName } from '$lib/utils/videoAutoplay';

/**
 * Plays a video while most of it is on screen and pauses it when it leaves.
 *
 * WHAT IT IS FOR: the feed's and a conversation's videos play by themselves, as Instagram's do
 * (user, 2026-09-29: *"la video doit se lire directement"*) - but only the one being looked at. A
 * video scrolled past keeps decoding for nothing, and with the sound on it would keep talking over
 * the next one, so leaving the viewport pauses it.
 *
 * `threshold` defaults to 0.6: a video counts as looked at once more than half of it is visible,
 * which on a phone is at most one video at a time.
 *
 * A REFUSED `play()` IS LOGGED, NEVER SWALLOWED. A browser refuses to autoplay a video with sound
 * before the page has seen a gesture; that is a policy answer, and the reader sees a paused first
 * frame they can tap. The log is what says which one happened.
 *
 * WITHOUT `IntersectionObserver` IT DOES NOTHING - a capability check, not a fallback: the video
 * stays a paused first frame, which is what every video here was before this existed.
 */
export interface PlayWhileVisibleOptions {
  /** Share of the video that must be visible for it to play. Defaults to 0.6. */
  threshold?: number;
}

/** Inline videos currently on screen, in the order they came into view. */
const visibleInline = new Set<HTMLVideoElement>();

/** Feed videos the READER paused ({@link markReaderPaused}): nothing ambient starts them again. */
const readerPaused = new WeakSet<HTMLVideoElement>();

/**
 * THE READER PAUSED THIS FEED VIDEO - a held press, Space or `k` (stack review, 2026-11-09). The
 * pause's own `pause` event makes the arbiter report idle, and {@link resumeVisible} then replayed
 * the video last come into view: the very one just paused, so a hold or a key on the feed was undone
 * at once. Until the element plays again (the reader's play, a hold released) or LEAVES the screen,
 * neither `resumeVisible` nor its intersection starts it. Called BEFORE `pause()`.
 */
export function markReaderPaused(video: HTMLVideoElement): void {
  Log.d('VIDEO', 'playWhileVisible: the reader paused a feed video - the feed will not replay it');
  readerPaused.add(video);
}
/** Viewers open: while one is, no inline video starts. */
let openViewers = 0;

/** Holds taken ({@link holdPlayback}) and not yet released. */
let holds = 0;
/** Whether a video was playing when the first of the current holds was taken. */
let videoWasPlaying = false;

/**
 * A FULL-SCREEN VIEWER IS OPEN, WHETHER OR NOT IT HAS A PLAYER YET (owner, 2026-11-06: opening a
 * CanaReel left the feed's video playing behind it).
 *
 * `followVideoSound` counts a viewer only once its `<video>` is MOUNTED, and a reel mounts its player
 * after the download or the stream's first segment - seconds on a weak link - while a photo page or a
 * reel that fails never mounts one. In that gap nothing said "a viewer is open": the feed's ambient
 * video behind kept decoding, talking if unmuted, and a card scrolling into view started too. A viewer
 * that is a page of its own (`ReelViewer`) holds playback from its first line instead, so the answer
 * does not depend on what it later mounts.
 *
 * Holding PAUSES EVERY registered VIDEO at once (the feed, a post page's, a lightbox's) and never an
 * audio-only media: a voice note playing in a chat plays on when a photo opens. The viewer's own
 * players register later and claim playback themselves. No inline video starts until the LAST hold is
 * released; then the video last come into view plays again only if a video was playing when the FIRST
 * hold was taken - a viewer never starts a video the reader had not playing. Returns the release,
 * idempotent.
 */
export function holdPlayback(reason: string): () => void {
  Log.d('VIDEO', `playback held: ${reason}`);
  if (holds === 0) videoWasPlaying = isVideoPlaying();
  holds += 1;
  openViewers += 1;
  pausePlayback(undefined, false, reason, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openViewers -= 1;
    holds -= 1;
    Log.d('VIDEO', `playback released: ${reason}`);
    if (holds === 0 && videoWasPlaying && !isForegroundPlaying() && isAppOnScreen()) {
      resumeVisible();
    }
  };
}

/**
 * WHETHER A REJECTED feed `play()` WAS INTERRUPTED BY A DECISION, classified at the throw from facts
 * the caller reads when the rejection lands (owner's console export, 2026-11-10: ten `AbortError`
 * lines on a slow link, each a video scrolled past before its first bytes arrived).
 *
 * An `AbortError` is the engine saying "a `pause()` or a new load came while this was pending". The
 * feed itself pauses a video that leaves the screen, and on a weak link a play stays pending for
 * seconds, so scrolling on aborts it. That is the feed's own decision, not a refusal:
 * - the video left the viewport (`!stillVisible`) or is paused: the leave (or the arbiter) did it;
 * - the element's `src` changed: a new load replaced the one asked on.
 * An `AbortError` with none of those facts is unexplained and stays a warning.
 */
export function isExpectedPlayInterruption(
  name: string,
  facts: { stillVisible: boolean; paused: boolean; sourceChanged: boolean }
): boolean {
  return name === 'AbortError' && (!facts.stillVisible || facts.paused || facts.sourceChanged);
}

function tryPlay(video: HTMLVideoElement) {
  const askedSrc = video.currentSrc || video.src;
  video.play().catch((err: unknown) => {
    const name = playRejectionName(err);
    if (
      isExpectedPlayInterruption(name, {
        stillVisible: visibleInline.has(video),
        paused: video.paused,
        sourceChanged: (video.currentSrc || video.src) !== askedSrc,
      })
    ) {
      Log.d('VIDEO', `playWhileVisible: play() interrupted (${name}) by a pause or a new load`);
      return;
    }
    console.warn('[video] playWhileVisible: play() refused', { name, muted: video.muted });
  });
}

/**
 * ONE MEDIA PLAYS AT A TIME is `playbackArbiter`'s rule; this file is the feed's side of it. Once
 * nothing plays any more (a viewer closed, a voice note ended) the video last come into view plays
 * again - and never before, so the background does not take playback back from the reader's choice.
 */
function resumeVisible() {
  const resume = [...visibleInline].at(-1);
  if (openViewers === 0 && resume && resume.paused && !readerPaused.has(resume)) tryPlay(resume);
}
onPlaybackIdle(resumeVisible);

export function playWhileVisible(video: HTMLVideoElement, options: PlayWhileVisibleOptions = {}) {
  if (typeof IntersectionObserver === 'undefined') return {};

  const registration = arbitratePlayback(video, { ambient: true });
  // The reader's own play (or a hold released) ends their pause.
  const onPlay = () => readerPaused.delete(video);
  video.addEventListener('play', onPlay);

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      if (entry.isIntersecting) {
        visibleInline.add(video);
        // Not while a viewer or another media of the reader's is playing: the background never
        // takes playback back from what was chosen. `resumeVisible` brings it back afterwards.
        // Nor off screen: Android reports intersections in the background, and the arbiter paused
        // the feed on leaving; coming back resumes it through `onPlaybackIdle`.
        if (
          openViewers === 0 &&
          !readerPaused.has(video) &&
          !isForegroundPlaying(video) &&
          isAppOnScreen()
        )
          tryPlay(video);
      } else {
        visibleInline.delete(video);
        // Gone from the screen: the reader's pause is spent, coming back plays it as any other.
        readerPaused.delete(video);
        if (!video.paused) video.pause();
      }
    },
    { threshold: options.threshold ?? 0.6 }
  );
  observer.observe(video);

  return {
    destroy() {
      observer.disconnect();
      video.removeEventListener('play', onPlay);
      visibleInline.delete(video);
      registration.destroy();
    },
  };
}

/**
 * WHOSE ANSWER A VIEWER'S SOUND IS (user, 2026-10-02: the mute button should not appear in
 * conversations - tapping it changed ALL the buttons on the page).
 *
 * - `app`: the feed's. Every video follows `videoSound`, and the viewer's own control changes it.
 * - `silent`: a take whose sound the member REMOVED (the reel review). The element is muted whatever
 *   the app's answer is and nothing is written back: what is heard is what will be published.
 * - `local`: a conversation's. A video there is its own thing and nobody asked for the feed's answer:
 *   it starts AUDIBLE (the reader pressed play or tapped it open) and its control mutes only this
 *   element. It neither reads `videoSound` - the feed autoplays muted and may have left it muted,
 *   which would open a conversation video silent - nor writes it.
 */
export type VideoSoundScope = 'app' | 'local' | 'silent';

/**
 * Makes a video with its own controls - the full-screen viewer's - follow the sound answer of its scope.
 *
 * In the `app` scope (the default) it opens at `videoSound`'s answer, and a change made through its
 * native controls BECOMES that answer, so turning the sound on in the viewer leaves it on in the feed
 * behind it: one answer for every video, whichever control gave it. In the `local` scope see
 * {@link VideoSoundScope}. Either way, while it is open it is the only media playing (it registers
 * with `playbackArbiter` and claims at once), and closing it resumes the video on screen behind it.
 */
export function followVideoSound(video: HTMLVideoElement, scope: VideoSoundScope = 'app') {
  Log.d('VIDEO', `viewer opens with ${scope === 'app' ? "the app's" : `its ${scope}`} sound`);
  openViewers += 1;
  const onVolumeChange = () => videoSound.setMuted(video.muted);
  const registration = arbitratePlayback(video);
  /** Puts the element on `next`'s answer; callable again when the scope changes under a live element. */
  const apply = (next: VideoSoundScope) => {
    video.removeEventListener('volumechange', onVolumeChange);
    if (next === 'app') {
      video.muted = videoSound.muted;
      video.addEventListener('volumechange', onVolumeChange);
    } else {
      video.muted = next === 'silent';
    }
  };
  apply(scope);
  // Taking over from whatever plays behind it at once, not on its `play`: an `autoplay` that the
  // browser delays would otherwise leave both audible for that delay.
  claimPlayback(video);
  return {
    update(next: VideoSoundScope = 'app') {
      Log.d('VIDEO', `viewer sound scope is now ${next}`);
      apply(next);
    },
    destroy() {
      openViewers -= 1;
      video.removeEventListener('volumechange', onVolumeChange);
      // Back to the feed: unregistering says the viewer is quiet, and `resumeVisible` picks up the
      // video last come into view there. What the reader had playing inline stays paused.
      registration.destroy();
    },
  };
}
