/**
 * The progress and the cancel of ONE video being prepared on a screen - what the post composer, the
 * post editor and the chat composer each hold while `prepareVideoForUpload` runs, and what
 * `VideoPreparationProgress.svelte` draws.
 *
 * One at a time per screen: a screen prepares its videos in order, and starting the next one drops
 * the previous controller (which is finished by then).
 */
import type { PrepareVideoOptions } from './prepareVideoForUpload';

export class VideoPreparationState {
  /** Share done, 0 to 1, while a video is being encoded; `null` when none is. */
  fraction = $state<number | null>(null);
  #abort: AbortController | null = null;

  /**
   * The options for the next `prepareVideoForUpload` call: progress lands in {@link fraction} and
   * {@link cancel} aborts it. Harmless to pass for a file that turns out not to be a video - the
   * options are then never read and nothing is shown.
   *
   * @param maxBytes The plaintext ceiling, from `MediaService.uploadLimits()`.
   */
  optionsFor(maxBytes: number | undefined): PrepareVideoOptions {
    const abort = new AbortController();
    this.#abort = abort;
    return {
      maxBytes,
      signal: abort.signal,
      onProgress: (fraction) => {
        // A late frame of a cancelled run must not redraw the line after it was taken down.
        if (!abort.signal.aborted) this.fraction = fraction;
      },
    };
  }

  /** Takes the line down - the video is ready, failed, or was never one. */
  finish(): void {
    this.fraction = null;
    this.#abort = null;
  }

  /** Stops the running preparation; it rejects with the `aborted` fault. */
  cancel(): void {
    console.debug('[video-prep] cancelled by the member');
    this.#abort?.abort();
    this.fraction = null;
  }
}
