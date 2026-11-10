/**
 * WHAT THE NEW-POST COMPOSER HANDS ITS CAMERA'S REEL STEP, AS ONE OBJECT: the caption's start, "who
 * is publishing", "Entre étudiants". One object through `PostComposerBar`, `CameraOverlay`,
 * `ReelCapture` and `ReelPublishSheet`, so a field added cannot be dropped on the way (review of
 * #3010, 2026-11-04). The way BACK ("Garder comme post") was removed on 2026-11-09: every vertical
 * video of 90 s or less is a CanaReel (`reels/reelRule.ts`).
 */
export interface ComposerReelState {
  /** The text: the composer's markdown, the reel's caption. */
  caption: string;
  /** The identity picker's value: '' for the member, an association id, or the anonymous marker. */
  identity: string;
  /**
   * The "Entre étudiants" switch as the author left it. Each side sends it only where it is offered
   * (`studentsOnlyOffered`), so a value carried across an identity that does not offer it is inert.
   */
  studentsOnly: boolean;
}

/** The state of a step opened from nowhere (the CanaReels tab): empty, the switch OFF. */
export const EMPTY_COMPOSER_REEL_STATE: ComposerReelState = {
  caption: '',
  identity: '',
  studentsOnly: false,
};
