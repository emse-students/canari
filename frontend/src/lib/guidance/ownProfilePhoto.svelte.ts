import { avatarPhotoPresence } from '$lib/utils/avatarPresence';
import { Log } from '$lib/utils/Log';

/**
 * WHETHER THE SIGNED-IN ACCOUNT HAS A PROFILE PHOTO, as a reactive fact the guide scheduler can read
 * (`eligible` of the profile-photo prompt, docs/wiki/frontend/guided-help.md).
 *
 * The answer is the gallery's own, through the same batched presence call every avatar uses
 * (`avatarPhotoPresence`) - never a second way to learn it. `null` is "nobody could say" (the gallery
 * is down, a server without the route): it stays `null` and the prompt is NOT shown, because an
 * invitation to add a photo to an account that may have one is a wrong statement, and the next
 * opening asks again. Only the account last passed to {@link OwnProfilePhoto.load} is held, so an
 * account switch never reads the previous account's answer.
 */
export class OwnProfilePhoto {
  #account: string | null = null;
  #hasPhoto = $state<boolean | null>(null);

  /** `true`/`false` for the loaded account, `null` while unknown. Reactive. */
  get hasPhoto(): boolean | null {
    return this.#hasPhoto;
  }

  /** Asks the gallery about `userId`; a repeat for the same account that has an answer is a no-op. */
  async load(userId: string): Promise<void> {
    if (this.#account === userId && this.#hasPhoto !== null) return;
    if (this.#account !== userId) {
      this.#account = userId;
      this.#hasPhoto = null;
    }
    const answer = await avatarPhotoPresence(userId);
    if (this.#account !== userId) return;
    this.#hasPhoto = answer;
    Log.d('ownProfilePhoto', `presence for the signed-in account: ${String(answer)}`);
  }

  /** Forgets the account (sign-out). */
  reset(): void {
    this.#account = null;
    this.#hasPhoto = null;
  }
}

/** The app's one store. */
export const ownProfilePhoto = new OwnProfilePhoto();
