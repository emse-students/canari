import { appendLog } from '$lib/utils/sessionLog';

/**
 * Starting the call's voice, and what a REFUSAL means.
 *
 * The remote stream usually arrives seconds after the last tap (the callee answered, ICE connected),
 * and a WebView may refuse `play()` without a user gesture - WKWebView and Android System WebView
 * both can, with `NotAllowedError`. A refusal there is not a failure of the call: the voice is
 * ready and waiting for one tap. So it is told apart from every other rejection, the surfaces say
 * "tap to hear", and the next tap anywhere starts it - a call left silent with nothing on screen
 * saying why is exactly the state this exists to prevent.
 */
export type CallVoiceOutcome = 'playing' | 'blocked' | 'failed';

/** The subset of an audio element this touches, so a test can hand in its own. */
export interface VoiceElement {
  play(): Promise<void>;
}

/** Starts the voice element; `why` names the moment in the log (a stream arrived, a tap, a return). */
export async function startCallVoice(el: VoiceElement, why: string): Promise<CallVoiceOutcome> {
  try {
    await el.play();
    appendLog(`[Call] voice playing (${why})`);
    return 'playing';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      appendLog(`[Call] WARN voice refused without a gesture (${why}) - waiting for a tap`);
      return 'blocked';
    }
    appendLog(`[Call] voice did not start (${why}): ${String(e)}`);
    return 'failed';
  }
}
