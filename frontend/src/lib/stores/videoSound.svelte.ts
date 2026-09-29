import { Log } from '$lib/utils/Log';

/**
 * WHETHER THE APP'S VIDEOS MAKE SOUND - ONE ANSWER FOR ALL OF THEM (user, 2026-09-29).
 *
 * A video in the feed or in a conversation plays by itself as soon as it is on screen, the way
 * Instagram's do, and the button that turns its sound on turns it on for every video in the app:
 * a reader who wants to hear the feed should not have to ask once per post, and the full-screen
 * viewer follows the same answer, including when its own controls change it.
 *
 * MUTED AT EVERY START AND DELIBERATELY NOT PERSISTED (user: *"defaut sans son a l'ouverture de
 * l'app"*). Opening the app must never be loud, whatever the last session chose, so the state lives
 * in memory and a reload returns it to silence.
 */
let muted = $state(true);

export const videoSound = {
  /** True while every video in the app is silent. */
  get muted(): boolean {
    return muted;
  },
  /** Sets the answer for every video; a no-op when it is already that. */
  setMuted(next: boolean): void {
    if (next === muted) return;
    Log.d('VIDEO', `sound ${next ? 'off' : 'on'} for every video`);
    muted = next;
  },
  /** Flips it - the sound button's action. */
  toggle(): void {
    videoSound.setMuted(!muted);
  },
};
