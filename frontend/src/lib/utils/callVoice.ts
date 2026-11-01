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

/** What {@link primeCallVoice} reads of the element, to tell a handover from a refusal. */
export interface PrimableVoiceElement extends VoiceElement {
  srcObject: MediaProvider | null;
  isConnected: boolean;
}

/**
 * The empty `play()` that unlocks the element inside a gesture, BEFORE any stream exists (WebKit
 * lets the later `play()` through once an earlier one ran in a tap). With no source it stays
 * pending, and what settles it is the thing it waits for: the stream arriving (`srcObject` set) or
 * the surface going (element removed) rejects it with `AbortError`, per the media element's load
 * algorithm. That is the prime HANDING OVER - its unlock was spent and `startCallVoice` reports the
 * real start - so it is told apart BY STATE (a source is attached, or the element left the
 * document), never by the error's message. Anything else (a refusal, a missing codec) is logged.
 */
export async function primeCallVoice(el: PrimableVoiceElement, why: string): Promise<void> {
  try {
    await el.play();
  } catch (e) {
    const handedOver =
      e instanceof DOMException &&
      e.name === 'AbortError' &&
      (el.srcObject !== null || !el.isConnected);
    if (handedOver) return;
    appendLog(`[Call] voice primed (${why}): ${String(e)}`);
  }
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
