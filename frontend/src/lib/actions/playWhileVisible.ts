import {
  arbitratePlayback,
  claimPlayback,
  isForegroundPlaying,
  onPlaybackIdle,
} from '$lib/actions/playbackArbiter';
import { videoSound } from '$lib/stores/videoSound.svelte';
import { Log } from '$lib/utils/Log';

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
/** Viewers open: while one is, no inline video starts. */
let openViewers = 0;

function tryPlay(video: HTMLVideoElement) {
  video.play().catch((err: unknown) => {
    console.warn('[video] playWhileVisible: play() refused', {
      name: err instanceof Error ? err.name : String(err),
      muted: video.muted,
    });
  });
}

/**
 * ONE MEDIA PLAYS AT A TIME is `playbackArbiter`'s rule; this file is the feed's side of it. Once
 * nothing plays any more (a viewer closed, a voice note ended) the video last come into view plays
 * again - and never before, so the background does not take playback back from the reader's choice.
 */
function resumeVisible() {
  const resume = [...visibleInline].at(-1);
  if (openViewers === 0 && resume && resume.paused) tryPlay(resume);
}
onPlaybackIdle(resumeVisible);

export function playWhileVisible(video: HTMLVideoElement, options: PlayWhileVisibleOptions = {}) {
  if (typeof IntersectionObserver === 'undefined') return {};

  const registration = arbitratePlayback(video, { ambient: true });

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      if (entry.isIntersecting) {
        visibleInline.add(video);
        // Not while a viewer or another media of the reader's is playing: the background never
        // takes playback back from what was chosen. `resumeVisible` brings it back afterwards.
        if (openViewers === 0 && !isForegroundPlaying(video)) tryPlay(video);
      } else {
        visibleInline.delete(video);
        if (!video.paused) video.pause();
      }
    },
    { threshold: options.threshold ?? 0.6 }
  );
  observer.observe(video);

  return {
    destroy() {
      observer.disconnect();
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
 * - `local`: a conversation's. A video there is its own thing and nobody asked for the feed's answer:
 *   it starts AUDIBLE (the reader pressed play or tapped it open) and its control mutes only this
 *   element. It neither reads `videoSound` - the feed autoplays muted and may have left it muted,
 *   which would open a conversation video silent - nor writes it.
 */
export type VideoSoundScope = 'app' | 'local';

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
  Log.d('VIDEO', `viewer opens with ${scope === 'app' ? "the app's" : 'its own'} sound`);
  openViewers += 1;
  const onVolumeChange = () => videoSound.setMuted(video.muted);
  const registration = arbitratePlayback(video);
  if (scope === 'app') {
    video.muted = videoSound.muted;
    video.addEventListener('volumechange', onVolumeChange);
  } else {
    video.muted = false;
  }
  // Taking over from whatever plays behind it at once, not on its `play`: an `autoplay` that the
  // browser delays would otherwise leave both audible for that delay.
  claimPlayback(video);
  return {
    destroy() {
      openViewers -= 1;
      video.removeEventListener('volumechange', onVolumeChange);
      // Back to the feed: unregistering says the viewer is quiet, and `resumeVisible` picks up the
      // video last come into view there. What the reader had playing inline stays paused.
      registration.destroy();
    },
  };
}
