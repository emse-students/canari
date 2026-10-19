import type { CallService, CallState } from '$lib/services/CallService';
import { callStatusKind, type CallStatusKind } from '$lib/stores/callView.svelte';
import { callElapsedMs, formatCallDuration } from '$lib/utils/callClock';

/**
 * The call as the two call surfaces read it (`CallOverlay`, `CallBanner`): the service's stores
 * mirrored into runes, the status KIND and the duration text. Call it during a component's
 * initialisation; it follows `getService` and drops its subscriptions with the component.
 *
 * THE CLOCK. The duration is derived from `connectedAt` / `endedAt` (`utils/callClock.ts`); `now`
 * is only a repaint trigger. It is re-read on `visibilitychange` too, so the first frame after the
 * app comes back from the background shows the right time rather than the last painted one.
 */
export function useCallModel(getService: () => CallService | null | undefined) {
  let callState = $state<CallState>('idle');
  let isMuted = $state(false);
  let isVideoOff = $state(true);
  let connectedAt = $state<number | null>(null);
  let endedAt = $state<number | null>(null);
  let isReconnecting = $state(false);
  let localStream = $state<MediaStream | null>(null);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced whole by the service's store, never mutated here
  let remoteStreams = $state<Map<string, MediaStream>>(new Map());
  let remoteStream = $state<MediaStream | null>(null);
  let now = $state(Date.now());

  $effect(() => {
    const service = getService();
    if (!service) return;
    const unsubs = [
      service.callState.subscribe((v) => (callState = v)),
      service.isMuted.subscribe((v) => (isMuted = v)),
      service.isVideoOff.subscribe((v) => (isVideoOff = v)),
      service.connectedAt.subscribe((v) => (connectedAt = v)),
      service.endedAt.subscribe((v) => (endedAt = v)),
      service.reconnecting.subscribe((v) => (isReconnecting = v)),
      service.localStreamStore.subscribe((v) => (localStream = v)),
      service.remoteStreams.subscribe((v) => (remoteStreams = v)),
      service.remoteStream.subscribe((v) => (remoteStream = v)),
    ];
    return () => unsubs.forEach((u) => u());
  });

  const kind = $derived<CallStatusKind>(callStatusKind(callState, connectedAt, isReconnecting));

  // Repaint once a second while the timer runs, and at once when the app is visible again.
  $effect(() => {
    if (connectedAt === null || endedAt !== null) return;
    now = Date.now();
    const tick = () => (now = Date.now());
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  });

  const duration = $derived(formatCallDuration(callElapsedMs(connectedAt, endedAt, now)));

  return {
    get callState() {
      return callState;
    },
    get kind() {
      return kind;
    },
    get isMuted() {
      return isMuted;
    },
    get isVideoOff() {
      return isVideoOff;
    },
    get connectedAt() {
      return connectedAt;
    },
    /** `mm:ss` since the media path connected; frozen once the call ended. */
    get duration() {
      return duration;
    },
    get localStream() {
      return localStream;
    },
    get remoteStreams() {
      return remoteStreams;
    },
    get remoteStream() {
      return remoteStream;
    },
  };
}

export type CallModel = ReturnType<typeof useCallModel>;
