/**
 * WHAT THE NEW-POST COMPOSER AND ITS CAMERA'S REEL STEP HAND EACH OTHER, AS ONE OBJECT: the composer
 * opens the step with it (the caption's start, "who is publishing", "Entre étudiants"), and "Garder
 * comme post" hands it back as the step holds it NOW. One object through `PostComposerBar`,
 * `CameraOverlay`, `ReelCapture` and `ReelPublishSheet`, so a field added to the round trip cannot be
 * carried one way and dropped the other (review of #3010, 2026-11-04: the switch was lost both ways).
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
