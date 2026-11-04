import { isAndroidTauriRuntime } from '$lib/utils/appVersion';
import { Log } from '$lib/utils/Log';

/**
 * ON ANDROID THE APP'S TONES OBEY THE RINGER MODE (iPhone report of 2026-11-04, checked on the other
 * platform).
 *
 * The WebView plays Web Audio on the MEDIA stream (`usage MEDIA`, measured 2026-10-09 with `dumpsys
 * audio`, `toneOutput.ts`), and the media stream does not follow the ringer: a send trill sounded
 * on a phone set to silent or vibrate. No web API exposes the ringer mode, so `MainActivity`
 * registers `window.canariAudio.ringerMode()` (`AudioManager.getRingerMode()`, read at each tone -
 * the user changes it at any moment) and an app tone plays only at `RINGER_MODE_NORMAL`. The rule
 * is the one the in-app incoming ring already keeps natively (`IncomingRing.plan`).
 */

/** `AudioManager.RINGER_MODE_*`, the twins of `IncomingRing.kt`'s. */
export const RINGER_MODE_SILENT = 0;
export const RINGER_MODE_VIBRATE = 1;
export const RINGER_MODE_NORMAL = 2;
/** What the bridge answers when `AudioManager` could not be read (it logs the cause natively). */
export const RINGER_MODE_UNREADABLE = -1;

/** `window.canariAudio`, registered by `MainActivity.onWebViewCreate`. */
interface CanariAudioBridge {
  ringerMode(): number;
}

let absenceSaid = false;
/** The modes outside the three known ones already said: each is logged ONCE, not once per tone. */
const unknownSaid = new Set<number>();

/**
 * Whether the phone's ringer mode silences the app's own tones: silent or vibrate. An unknown mode
 * (a newer platform, or {@link RINGER_MODE_UNREADABLE}) does not silence - as `IncomingRing.plan`
 * reads it - and is logged once per value. Off Android, never.
 */
export function ringerSilencesAppTones(): boolean {
  if (!isAndroidTauriRuntime()) return false;
  const bridge = (window as Window & { canariAudio?: CanariAudioBridge }).canariAudio;
  if (!bridge) {
    // The build lost its registration: the tones would ignore the ringer again. Said once, loudly.
    if (!absenceSaid) {
      absenceSaid = true;
      console.error(
        '[AUDIO] window.canariAudio is absent - app tones cannot follow the ringer mode'
      );
    }
    return false;
  }
  let mode: number;
  try {
    mode = bridge.ringerMode();
  } catch (e) {
    console.error('[AUDIO] reading the ringer mode failed:', e);
    return false;
  }
  if (mode === RINGER_MODE_SILENT || mode === RINGER_MODE_VIBRATE) return true;
  if (mode !== RINGER_MODE_NORMAL && !unknownSaid.has(mode)) {
    unknownSaid.add(mode);
    if (mode === RINGER_MODE_UNREADABLE) {
      console.error('[AUDIO] the ringer mode could not be read natively - tones play');
    } else {
      Log.i('AUDIO', `unknown ringer mode ${mode} - tones play`);
    }
  }
  return false;
}

/** Test seam: forgets the one-time lines. */
export function resetAndroidRingerForTest(): void {
  absenceSaid = false;
  unknownSaid.clear();
}
