/**
 * WHETHER THE iPHONE APP IS ACTIVE - a dedicated signal for two decisions only: may the page consume
 * a queued frame now, and may it raise a message banner.
 *
 * Out of front on iOS the SERVER is the one announcer: the page consumes no queued frame while
 * inactive, so the row stays queued, the server pushes it, and the notification extension decrypts
 * it FIRST and announces it with its content (docs/wiki/frontend/mobile.md, "out of front, the server
 * announces"). Consuming it here would spend the frame's secret, and the extension, which decrypts
 * read-only from `mls.bin`, would then show a banner with no content.
 *
 * TOLD AND ASKED. `CanariPushActiveToPage` (canari_ios.mm) writes the global on `didBecomeActive` /
 * `willResignActive` and after every page load. A push can be lost (`evaluateJavaScript` failed), so
 * the page also ASKS the native side - `ios_app_active`, the App Group flag the extension reads - on
 * load and on every `visibilitychange` ({@link installIosActiveQuery}). NOT `isAppInForeground()`
 * (`appForeground.ts`): ten other iOS consumers read that one with its own meaning.
 *
 * ONE EXCEPTION, BY GROUP: the group of a LIVE CALL ({@link setIosLiveCallGroup}). A call runs with
 * the app in the background, and its signalling (`call_hangup`, the answer, a renegotiation) travels
 * as MLS frames of that group; withholding them would leave the call deaf. The fact is the call's
 * own state, typed, never read off a frame's content.
 */
import { isIosTauriRuntime } from '$lib/utils/appVersion';

/** The global the iOS bootstrap writes on every active/inactive transition. */
const FLAG = '__canariActive';

/** The event it dispatches at the same moment. */
export const APP_ACTIVE_EVENT = 'canari:active';

/** Why a withheld frame may have become consumable - what a listener re-decides on. */
export type QueueGateRelease = 'active' | 'call';

/** The group of the call that is ringing, calling or connected, or null (`CallService`). */
let liveCallGroup: string | null = null;

/** Listeners of {@link setIosLiveCallGroup}'s release - the window event carries the other kind. */
const callReleaseListeners = new Set<(why: QueueGateRelease) => void>();

/** Counts every active event seen, so a native answer overtaken by a push is not applied. */
let activeEvents = 0;

/**
 * True when this is the iOS app AND it said it is inactive. False everywhere else - Android, web,
 * desktop, and an iOS page not told yet - so every other runtime keeps today's behaviour.
 *
 * READ, NEVER CACHED, and synchronous: the queue reads it at the instant a frame would start to be
 * decrypted, and the transition arrives as a JS task, so the two can never interleave.
 */
export function isIosAppInactive(): boolean {
  if (typeof window === 'undefined' || !isIosTauriRuntime()) return false;
  return (window as unknown as Record<string, unknown>)[FLAG] === false;
}

/**
 * Whether a queued frame of `groupId` must be left queued now: the app is inactive and the frame is
 * not of the live call's group. A frame with no known group is never the call's.
 */
export function withholdsQueuedFrame(groupId: string | undefined): boolean {
  if (!isIosAppInactive()) return false;
  return groupId === undefined || groupId !== liveCallGroup;
}

/**
 * Records the group of the live call (`null` when no call is live). Written by `CallService` on
 * every state change. A group that BECOMES live releases its withheld frames to its listeners.
 */
export function setIosLiveCallGroup(groupId: string | null): void {
  if (groupId === liveCallGroup) return;
  console.log(
    `[APP_ACTIVE] live call group ${groupId ? `${groupId.slice(0, 8)}...` : 'none'} - its frames ${groupId ? 'are consumed even out of front' : 'follow the active rule again'}`
  );
  liveCallGroup = groupId;
  if (groupId === null) return;
  for (const listener of callReleaseListeners) {
    try {
      listener('call');
    } catch (e) {
      console.error('[APP_ACTIVE] a call-release listener threw:', e);
    }
  }
}

/**
 * Calls `onRelease` whenever a withheld frame may have become consumable: the app became active,
 * or a call's group became live. Returns the unsubscribe.
 */
export function onIosQueueGateRelease(onRelease: (why: QueueGateRelease) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ active?: unknown }>).detail;
    if (detail?.active === true) onRelease('active');
  };
  window.addEventListener(APP_ACTIVE_EVENT, handler);
  callReleaseListeners.add(onRelease);
  return () => {
    window.removeEventListener(APP_ACTIVE_EVENT, handler);
    callReleaseListeners.delete(onRelease);
  };
}

/** The native question: `true|false` on iOS, `null` where it has no answer. */
export type AskNativeActive = () => Promise<boolean | null>;

const askNative: AskNativeActive = async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<boolean | null>('ios_app_active');
};

/**
 * Asks the native side whether the app is active and, when the page holds another value, writes it
 * and dispatches the same event a push would. An answer overtaken by a push while it was asked is
 * dropped: the push is newer. A page that held a DIFFERENT told value is a lost transition, logged
 * as an error.
 */
export async function syncIosActiveFromNative(
  why: string,
  ask: AskNativeActive = askNative
): Promise<void> {
  if (typeof window === 'undefined' || !isIosTauriRuntime()) return;
  const seen = activeEvents;
  let native: boolean | null;
  try {
    native = await ask();
  } catch (e) {
    console.error(`[APP_ACTIVE] the native active state could not be asked (${why}):`, e);
    return;
  }
  if (native === null) {
    console.error(`[APP_ACTIVE] the native side has no active state to give (${why})`);
    return;
  }
  if (seen !== activeEvents) {
    console.log(`[APP_ACTIVE] asked (${why}) but a native transition arrived meanwhile - it wins`);
    return;
  }
  const held = (window as unknown as Record<string, unknown>)[FLAG];
  if (held === native) return;
  if (held === true || held === false) {
    console.error(
      `[APP_ACTIVE] the page held active=${String(held)} but the app is active=${native} - a native transition never reached the page (${why}); corrected`
    );
  } else {
    console.log(`[APP_ACTIVE] active=${native}, asked (${why}) before any transition was told`);
  }
  (window as unknown as Record<string, unknown>)[FLAG] = native;
  window.dispatchEvent(new CustomEvent(APP_ACTIVE_EVENT, { detail: { active: native } }));
}

/**
 * On iOS: asks the native active state now and on every `visibilitychange`, and counts the told
 * transitions so a late answer never overwrites a newer one. Returns the uninstall; a no-op
 * elsewhere.
 */
export function installIosActiveQuery(ask: AskNativeActive = askNative): () => void {
  if (typeof window === 'undefined' || !isIosTauriRuntime()) return () => {};
  const count = () => {
    activeEvents += 1;
  };
  const onVisibility = () => void syncIosActiveFromNative('visibilitychange', ask);
  window.addEventListener(APP_ACTIVE_EVENT, count);
  document.addEventListener('visibilitychange', onVisibility);
  void syncIosActiveFromNative('page load', ask);
  return () => {
    window.removeEventListener(APP_ACTIVE_EVENT, count);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
