/**
 * Visibility of the in-app biometric bottom sheet that accompanies the OS prompt.
 *
 * The system fingerprint/Face ID sheet carries no application context, and on Android it can
 * take a moment to appear; the in-app sheet says what is being asked and why. It is held in a
 * store rather than in component state because the enrolment prompt is raised from a composable
 * ({@link enrollBiometricImpl}) on behalf of two unrelated call sites - the post-login offer and
 * the Settings toggle - while the sheet itself is rendered once, in `ChatBackgroundService`.
 */
class BiometricPromptState {
  /** True while an enrolment biometric prompt is on screen. */
  enrolling = $state(false);

  /** Raises the in-app sheet for an enrolment prompt. */
  openEnroll(): void {
    this.enrolling = true;
  }

  /** Hides the in-app sheet. Safe to call when it is already hidden. */
  close(): void {
    this.enrolling = false;
  }
}

export const biometricPrompt = new BiometricPromptState();
