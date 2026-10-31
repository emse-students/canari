import type { CallService, CallState } from '$lib/services/CallService';
import type { CameraFacing } from '$lib/utils/callVideo';
import { callStatusKind, type CallStatusKind } from '$lib/stores/callView.svelte';
import { callElapsedMs, formatCallDuration } from '$lib/utils/callClock';
import type { NoiseSuppressionView } from '$lib/utils/callNoiseSuppression';

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
  let cameraFacing = $state<CameraFacing>('user');
  let canSwitchCamera = $state(false);
  // The camera TRACK, not the stream: a switch or an off/on swaps the track inside the SAME
  // stream object, which a stream-valued rune would not see change.
  let localVideoTrack = $state<MediaStreamTrack | null>(null);
  let connectedAt = $state<number | null>(null);
  let endedAt = $state<number | null>(null);
  let isReconnecting = $state(false);
  let e2eProven = $state(false);
  let localMicSuspended = $state(false);
  let peerMicSuspended = $state(false);
  let videoSendReduced = $state(false);
  let noiseSuppression = $state<NoiseSuppressionView>({ enabled: true, state: 'pending' });
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
      service.cameraFacing.subscribe((v) => (cameraFacing = v)),
      service.canSwitchCamera.subscribe((v) => (canSwitchCamera = v)),
      service.connectedAt.subscribe((v) => (connectedAt = v)),
      service.endedAt.subscribe((v) => (endedAt = v)),
      service.reconnecting.subscribe((v) => (isReconnecting = v)),
      service.e2eProven.subscribe((v) => (e2eProven = v)),
      service.localMicSuspended.subscribe((v) => (localMicSuspended = v)),
      service.peerMicSuspended.subscribe((v) => (peerMicSuspended = v)),
      service.videoSendReduced.subscribe((v) => (videoSendReduced = v)),
      service.noiseSuppression.subscribe((v) => (noiseSuppression = v)),
      service.localStreamStore.subscribe((v) => {
        localStream = v;
        localVideoTrack = v?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;
      }),
      service.remoteStreams.subscribe((v) => (remoteStreams = v)),
      service.remoteStream.subscribe((v) => (remoteStream = v)),
    ];
    return () => unsubs.forEach((u) => u());
  });

  /**
   * The peer's picture, when there is one to show: a remote video track that is live AND unmuted.
   * A muted one is the peer's camera OFF (its side went `recvonly`) or no frame yet - the avatar
   * shows, never a frozen last frame. Re-read at every publish of the remote stream, which the
   * service does on each `mute` / `unmute` / `ended` of a remote track.
   */
  const remoteVideoTrack = $derived.by<MediaStreamTrack | null>(() => {
    for (const [, stream] of remoteStreams) {
      const track = stream.getVideoTracks().find((t) => t.readyState === 'live' && !t.muted);
      if (track) return track;
    }
    return null;
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
    /** Which camera is sending (`user` = the screen side): the self view is mirrored for it only. */
    get cameraFacing() {
      return cameraFacing;
    },
    /** Whether the device has a second camera to switch to (known once a camera was opened). */
    get canSwitchCamera() {
      return canSwitchCamera;
    },
    /** The live local camera track, or `null` when the camera is off. */
    get localVideoTrack() {
      return localVideoTrack;
    },
    /** The peer's live, unmuted video track, or `null` (avatar). */
    get remoteVideoTrack() {
      return remoteVideoTrack;
    },
    get connectedAt() {
      return connectedAt;
    },
    /**
     * Whether THIS call's media was seen crossing the E2E worker both ways (`CallService.e2eProven`).
     * The screen claims "end-to-end encrypted" on this evidence only, never on a transform attached.
     */
    get e2eProven() {
      return e2eProven;
    },
    /** THIS device's OS holds the microphone (`CallService.localMicSuspended`). */
    get localMicSuspended() {
      return localMicSuspended;
    },
    /** The other party's OS holds ITS microphone, as it told us (`CallService.peerMicSuspended`). */
    get peerMicSuspended() {
      return peerMicSuspended;
    },
    /** THIS side's picture is sent reduced by the quality ladder (`CallService.videoSendReduced`). */
    get videoSendReduced() {
      return videoSendReduced;
    },
    /** The microphone's noise suppression for this call (`CallService.noiseSuppression`). */
    get noiseSuppression() {
      return noiseSuppression;
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
