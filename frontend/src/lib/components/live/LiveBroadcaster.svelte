<script lang="ts">
  /**
   * THE BROADCASTER'S SCREEN (WP-L5): the pre-live preview with the rules of a live, the broadcast
   * on air, the camera away, and the end. Every decision is the state machine's
   * (`$lib/live/liveBroadcast.svelte.ts`); this draws it and feeds it the page's visibility.
   *
   * THE RULES ARE ONE SCREEN, SHOWN BEFORE EVERY LIVE (L11): who sees it (the audience of a post by
   * the same identity), that moderation can cut it, how long it may last and how long the camera may
   * be away - the last two read from the server (`GET /api/lives/limits`), never compiled in. Pressing
   * Start is the acceptance; nothing records it on the server yet (docs/wiki/frontend/modules/live.md).
   *
   * NO KEYBOARD TRAP: every control is a native button, the layer is a labelled dialog, and Escape is
   * the history's Back like any overlay's.
   */
  import { onDestroy, onMount } from 'svelte';
  import {
    BatteryWarning,
    CameraOff,
    Eye,
    LoaderCircle,
    MessageCircle,
    MessageCircleOff,
    Mic,
    MicOff,
    Pencil,
    Radio,
    RefreshCcw,
    ShieldAlert,
    ShieldCheck,
    Share2,
    SwitchCamera,
    Video,
    VideoOff,
    Volume2,
    WifiOff,
    X,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { CameraSession } from '$lib/reels/cameraSession.svelte';
  import type { CameraFault } from '$lib/reels/cameraAccess';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import {
    LiveBroadcast,
    type LiveEndCause,
    type LiveLimitsProblem,
    type LiveStartProblem,
  } from '$lib/live/liveBroadcast.svelte';
  import { batteryWarrantsWarning, openLiveCamera, readBatteryLevel } from '$lib/live/liveDevice';
  import { liveRecordingGap, type LiveRecordingGap } from '$lib/live/liveRecorder';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { shareLiveLink } from '$lib/live/shareLive';
  import { replayFollows, replaysAvailable } from '$lib/live/replayAvailability';
  import { serverLiveReplaysMode, serverRetention } from '$lib/stores/appVersionCheck.svelte';
  import { retentionInForce } from '$lib/legal/retention';
  import { durationLabel } from '$lib/legal/retentionLabel';
  import { grabPosterFrame } from '$lib/live/livePoster';
  import { clampLiveTitleInput, liveTitleLength } from '$lib/live/liveTitle';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import LiveBadge from './LiveBadge.svelte';
  import LiveIdentity from './LiveIdentity.svelte';
  import LiveBroadcasterChat from './LiveBroadcasterChat.svelte';
  import LiveViewerCount from './LiveViewerCount.svelte';
  import LiveSceneBar from './LiveSceneBar.svelte';
  import LiveOverlayHandle from './LiveOverlayHandle.svelte';
  import CameraControlButton from '$lib/components/ui/CameraControlButton.svelte';
  import RotateButton from '$lib/components/ui/player/RotateButton.svelte';
  import { useScreenOrientation } from '$lib/mobile/screenOrientation.svelte';
  import { previewDoubleTap } from '$lib/reels/previewDoubleTap';
  import { sideSafePadding } from '$lib/utils/sideSafeArea';

  interface Props {
    /** Broadcast AS this association (`POST_AS_ASSO` there), or null for the member. */
    associationId?: string | null;
    /** The association's name, for the identity line. */
    associationName?: string | null;
    /** The screen asks to be unmounted (Close, after an end or from the preview). */
    onclose: () => void;
    /** The machine, injectable for tests; made here otherwise. */
    broadcast?: LiveBroadcast;
    /** The battery reading, injectable for tests. */
    readBattery?: () => Promise<number | null>;
  }

  let {
    associationId = null,
    associationName = null,
    onclose,
    broadcast = new LiveBroadcast(new CameraSession(openLiveCamera), associationId),
    readBattery = readBatteryLevel,
  }: Props = $props();

  const camera = $derived(broadcast.camera);
  /** The scenes of a desktop live, or null on a phone (the camera recorded directly). */
  const studio = $derived(broadcast.studio);
  /**
   * WHAT THE PREVIEW SHOWS: on a desktop, the COMPOSED picture itself - the frames the recorder gets,
   * black bars included, drawn `contain` so nothing sent is hidden from the member (owner, reading of
   * `1.6.12-alpha.2`: "pour éviter les angles morts"); on a phone, the camera.
   */
  const shownStream = $derived(studio ? studio.previewStream : camera.stream);
  /** The preview's drawn size, for placing the overlay handle over the picture. */
  let displayWidth = $state(0);
  let displayHeight = $state(0);
  let batteryLevel = $state<number | null>(null);
  /** Re-read every second on air, only to redraw the elapsed time. */
  let elapsedMs = $state(0);
  /**
   * How many watch, from the chat loop's poll - a number, never who (null: nothing to show). The
   * chat sets it back to null on a failed poll and when it unmounts (off air, or keyed anew for a
   * new live), so no live opens on the previous one's audience.
   */
  let viewers = $state<number | null>(null);
  let ticker: ReturnType<typeof setInterval> | null = null;
  let frameReady = $state(false);
  /** Whether the chat is drawn over the video; the toggle at the top right flips it. */
  let chatOpen = $state(true);
  /** Who broadcasts, for the corner identity: the signed-in member, or the association they speak as. */
  const broadcasterId = $derived(currentUserId());
  let video = $state<HTMLVideoElement | null>(null);

  const onAir = $derived(broadcast.phase === 'live' || broadcast.phase === 'away');

  /**
   * THE BROADCASTER CHOOSES THE ORIENTATION IN THE PREVIEW AND KEEPS IT (owner, 2026-11-09;
   * screen-orientation.md): the screen turns with the phone (under its rotation lock) or by the rotate
   * button until Start, then it is FROZEN for the whole live - one recorder records one track size, and
   * a live filmed in landscape stays landscape for its viewers. Portrait again at unmount.
   */
  const orientation = useScreenOrientation('live-broadcaster');
  $effect(() => orientation.hold(broadcast.phase !== 'preview'));

  /**
   * The lens may flip now, with a second lens: in the preview, on a desktop live at any time (the
   * studio follows the new stream), and ON AIR on a phone (owner, 2026-11-14: a new recorder on the
   * same live, `switchLens`). The preview's double tap flips only before the live (owner,
   * 2026-11-09): on air it would cut a gap into the broadcast on a stray tap.
   */
  const flipAllowed = $derived(
    camera.phase === 'live' &&
      camera.canSwitch &&
      !broadcast.lensSwitching &&
      (broadcast.phase === 'preview' || broadcast.phase === 'live' || (studio !== null && onAir))
  );

  function flip() {
    if (!flipAllowed) {
      console.debug('[LIVE-SCREEN] flip asked while it is not allowed - ignored');
      return;
    }
    console.debug(`[LIVE-SCREEN] flip in ${broadcast.phase}`);
    void broadcast.switchLens();
  }

  /** The two switches are offered from the preview to the end; they never end anything. */
  const switchesShown = $derived(broadcast.phase === 'preview' || onAir);

  /** Whether a Back should ask before ending - the overlay's history entry reads it. */
  export function holdsBack(): boolean {
    return onAir;
  }

  /**
   * How long a replay stays visible, as the server applies it to a replay published now (the admin
   * setting, `GET /api/version`'s `retention.liveReplayDays`) - never a number this build carries.
   */
  function replayDaysLabel(): string {
    return durationLabel(retentionInForce(serverRetention()).days.liveReplayDays);
  }

  /** Asks, then ends the live: the End button, Back and the edge swipe all come here. */
  export async function confirmEnd(): Promise<void> {
    console.debug(`[LIVE-SCREEN] end asked in ${broadcast.phase}`);
    // The promise of a replay is made only to a live long enough to leave one (`replayFollows`).
    const keepsReplay = replayFollows(serverLiveReplaysMode(), broadcast.elapsedMs());
    const ok = await showConfirm(
      keepsReplay ? m.live_end_confirm_replay({ days: replayDaysLabel() }) : m.live_end_confirm(),
      {
        danger: true,
        confirmLabel: m.live_end_confirm_button(),
        cancelLabel: m.live_end_keep(),
      }
    );
    if (!ok) {
      console.debug('[LIVE-SCREEN] end declined - still on air');
      return;
    }
    await broadcast.end();
    // The line that decides a "stayed up after Terminer" report: the phase the End left behind.
    console.debug(
      `[LIVE-SCREEN] end returned in ${broadcast.phase} (${broadcast.endCause ?? 'no cause'})`
    );
  }

  function close() {
    console.debug(`[LIVE-SCREEN] close in ${broadcast.phase}`);
    broadcast.dispose();
    onclose();
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') broadcast.appHidden();
    else broadcast.appVisible();
  }

  /** The page itself goes (a tab closed, a reload): nothing may stay on air behind it. */
  function onPageHide() {
    console.debug('[LIVE-SCREEN] pagehide - ending what is on air');
    broadcast.dispose();
  }

  function onFrame() {
    if (!video || video.videoWidth === 0 || frameReady) return;
    frameReady = true;
  }

  // The element follows the shown stream; `muted` as a PROPERTY (CameraScreen: a cloned element
  // does not take its muted state from the attribute, and the microphone played back as an echo).
  $effect(() => {
    frameReady = false;
    if (!video) return;
    video.muted = true;
    video.srcObject = shownStream;
  });

  // A phone's switches live on the tracks: every new camera stream (a flip) takes them again.
  $effect(() => {
    if (camera.stream) broadcast.syncTrackSwitches();
  });

  // The preview still (owner, 2026-11-07) is grabbed from THIS element, the one the member sees:
  // the camera or the shared screen alike. The broadcast asks for it on its segment cadence.
  $effect(() => {
    const el = video;
    broadcast.setPosterCapture(el ? () => grabPosterFrame(el) : null);
    return () => broadcast.setPosterCapture(null);
  });

  /** The on-air title editor: null when closed, the draft while open. */
  let titleDraft = $state<string | null>(null);
  const titleMax = $derived(broadcast.limits?.titleMaxChars ?? null);

  const TITLE_TEXT: Record<'invalid' | 'offline' | 'failed', () => string> = {
    invalid: () => m.live_title_invalid({ max: titleMax ?? 0 }),
    offline: m.live_title_offline,
    failed: m.live_title_failed,
  };

  /**
   * A title field after a keystroke: one line, cut at the bound - written back into the element too,
   * because a cut that leaves the state unchanged would not redraw the field.
   */
  function clampTitleField(input: HTMLInputElement, max: number): string {
    const next = clampLiveTitleInput(input.value, max);
    if (next !== input.value) input.value = next;
    return next;
  }

  function openTitleEditor() {
    console.debug('[LIVE-SCREEN] title editor opened');
    titleDraft = broadcast.title;
  }

  async function saveTitleDraft() {
    if (titleDraft === null) return;
    const taken = await broadcast.saveTitle(titleDraft);
    console.debug(`[LIVE-SCREEN] title edit ${taken ? 'taken' : 'not taken'}`);
    if (taken) titleDraft = null;
  }

  $effect(() => {
    if (!onAir) return;
    elapsedMs = broadcast.elapsedMs();
    const t = setInterval(() => (elapsedMs = broadcast.elapsedMs()), 1000);
    ticker = t;
    return () => {
      clearInterval(t);
      ticker = null;
    };
  });

  onMount(() => {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    const releaseBar = themeStore.holdNativeBar('dark');
    void broadcast.loadLimits();
    readBattery().then(
      (level) => (batteryLevel = level),
      (err: unknown) => console.warn('[LIVE-SCREEN] battery not read', err)
    );
    if (document.visibilityState !== 'hidden') void camera.start();
    void studio?.open();
    return () => releaseBar();
  });

  onDestroy(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    if (ticker) clearInterval(ticker);
    broadcast.dispose();
  });

  /** `m:ss` or `h:mm:ss`. */
  function clock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }

  /** The suspension sentence, with its end date in the reader's locale when the server sent one. */
  function suspendedText(): string {
    const until = broadcast.startSuspendedUntil ? new Date(broadcast.startSuspendedUntil) : null;
    if (!until || Number.isNaN(until.getTime())) return m.live_start_suspended_no_date();
    return m.live_start_suspended({
      date: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long' }).format(until),
    });
  }

  /** Why THIS browser cannot broadcast, in plain words and with what to do (live.md, "Firefox"). */
  const UNSUPPORTED_TEXT: Record<LiveRecordingGap, () => string> = {
    firefox: m.live_unsupported_firefox,
    outdated: m.live_unsupported_outdated,
    other: m.live_unsupported,
  };
  /** Asked ONCE per sheet (it logs): an engine's recording support does not change while open. */
  const recordingGap = liveRecordingGap();
  function unsupportedText(): string {
    return UNSUPPORTED_TEXT[recordingGap ?? 'other']();
  }

  const START_TEXT: Record<LiveStartProblem, () => string> = {
    muted: m.live_start_muted,
    'rules-not-accepted': m.live_start_rules_not_accepted,
    suspended: suspendedText,
    withdrawn: m.live_start_withdrawn,
    'already-open': m.live_start_already_open,
    'association-forbidden': m.live_start_association_forbidden,
    'association-archived': m.live_start_association_archived,
    'rate-limited': m.live_start_rate_limited,
    disabled: m.live_limits_disabled,
    offline: m.live_start_offline,
    unsupported: unsupportedText,
    failed: m.live_start_failed,
  };

  const LIMITS_TEXT: Record<LiveLimitsProblem, () => string> = {
    disabled: m.live_limits_disabled,
    offline: m.live_limits_offline,
    failed: m.live_limits_failed,
  };

  /**
   * What the broadcaster's own end says: "Rien n'en est gardé" is true only without a replay - with
   * one (a live of at least 30 s while replays are on) it says how long the replay is visible. The
   * length is the last second the screen counted on air.
   */
  function endedByBroadcasterText(): string {
    return replayFollows(serverLiveReplaysMode(), elapsedMs)
      ? m.live_ended_broadcaster_replay({ days: replayDaysLabel() })
      : m.live_ended_broadcaster();
  }

  // A moderation cut has its own TITLE and no sentence under it, so it is not in this table.
  const END_TEXT: Record<Exclude<LiveEndCause, 'cut'>, () => string> = {
    broadcaster: endedByBroadcasterText,
    server: m.live_ended_server,
    'server-while-away': m.live_ended_server_away,
    failed: m.live_ended_failed,
    'connection-lost': m.live_ended_connection_lost,
    'upload-too-slow': m.live_ended_upload_too_slow,
  };

  const CAMERA_FAULT_TEXT: Record<CameraFault, () => string> = {
    denied: m.reels_camera_denied_body,
    unavailable: m.reels_camera_unavailable_body,
    busy: m.reels_camera_busy_body,
    interrupted: m.reels_camera_interrupted_body,
  };

  const pill =
    'inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50';
</script>

<!-- A DOUBLE TAP ON THE PREVIEW FLIPS THE LENS (previewDoubleTap.ts), only while the lens button
     would: the controls are never counted, and the pre-live sheet and the chat are out of it. -->
<section
  class="relative h-full w-full overflow-hidden bg-black text-white"
  aria-label={m.live_overlay_label()}
  data-live-phase={broadcast.phase}
  data-live-scenes={studio ? 'on' : 'off'}
  bind:clientWidth={displayWidth}
  bind:clientHeight={displayHeight}
  use:previewDoubleTap={{
    onDoubleTap: flip,
    enabled: flipAllowed && broadcast.phase === 'preview' && studio === null,
  }}
>
  <!-- One element per stream: WKWebView keeps a video's layer at its FIRST layout's size, and a
       re-acquired camera is a new stream (CameraScreen, iPhone 12, 2026-10-02). On a desktop the
       stream is the composed picture, drawn `contain` and never mirrored: exactly what is sent. -->
  {#key shownStream}
    <video
      bind:this={video}
      class="absolute inset-0 h-full w-full {studio
        ? 'object-contain'
        : `object-cover ${camera.facing === 'user' ? '-scale-x-100' : ''}`} {(studio ||
        camera.phase === 'live') &&
      frameReady
        ? 'opacity-100'
        : 'opacity-0'} transition-opacity duration-200 motion-reduce:transition-none"
      poster={TRANSPARENT_VIDEO_POSTER}
      onloadeddata={onFrame}
      onplaying={onFrame}
      autoplay
      muted
      playsinline
      aria-hidden="true"
    ></video>
  {/key}

  {#if studio && studio.scene === 'screen-camera' && (broadcast.phase === 'preview' || onAir)}
    <LiveOverlayHandle {studio} display={{ width: displayWidth, height: displayHeight }} />
  {/if}

  {#if !studio && broadcast.cameraOff && (broadcast.phase === 'preview' || onAir)}
    <!-- A phone's camera switched off sends black frames; the member sees why, not a frozen black. -->
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80"
      data-live-camera-off
    >
      <VideoOff size={40} strokeWidth={1.5} />
      <p class="text-sm font-semibold">{m.live_scene_camera_off_card()}</p>
    </div>
  {/if}

  <!-- The top row: close (never while on air: End is the way out) and the lens. -->
  <div
    class="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
    style={sideSafePadding('0.75rem')}
  >
    {#if onAir || broadcast.phase === 'starting' || broadcast.phase === 'ending'}
      <div class="flex flex-col items-start gap-2" role="status">
        {#if onAir}
          <!-- Who is on air, then the badge, the time and the audience: Instagram Live's corner. -->
          {#if broadcasterId}
            <span class="text-sm" data-live-identity>
              <LiveIdentity live={{ broadcasterId, associationId }} size="sm" />
            </span>
          {/if}
          <span class="flex items-center gap-1.5">
            <LiveBadge />
            <span
              role="timer"
              aria-label={m.live_elapsed_label()}
              class="bg-cn-scrim/40 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
              >{clock(elapsedMs)}</span
            >
            <LiveViewerCount count={viewers} />
          </span>
          {#if titleMax}
            <!-- The title, editable on air (owner, 2026-11-07): what the feed card shows. -->
            {#if titleDraft === null}
              <Button
                variant="secondary"
                size="compact"
                class="max-w-64"
                aria-label={m.live_title_edit_label()}
                onclick={openTitleEditor}
                data-live-title-chip
              >
                <Pencil size={12} strokeWidth={2.5} aria-hidden="true" />
                <span class="truncate">{broadcast.title || m.live_title_add()}</span>
              </Button>
            {:else}
              <form
                class="flex max-w-72 flex-col gap-1.5 rounded-lg bg-black/60 p-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  void saveTitleDraft();
                }}
                data-live-title-editor
              >
                <Input
                  density="compact"
                  aria-label={m.live_title_edit_label()}
                  placeholder={m.live_title_placeholder()}
                  value={titleDraft}
                  oninput={(e) => (titleDraft = clampTitleField(e.currentTarget, titleMax))}
                  disabled={broadcast.titleSaving}
                  data-live-title-input
                />
                <span class="flex items-center justify-between gap-2 text-xs">
                  <span class="text-white/70 tabular-nums"
                    >{m.live_title_counter({
                      count: liveTitleLength(titleDraft),
                      max: titleMax,
                    })}</span
                  >
                  <span class="flex gap-1.5">
                    <Button variant="secondary" size="compact" onclick={() => (titleDraft = null)}
                      >{m.common_cancel_button()}</Button
                    >
                    <Button
                      type="submit"
                      size="compact"
                      disabled={broadcast.titleSaving}
                      data-live-title-save>{m.common_save_button()}</Button
                    >
                  </span>
                </span>
              </form>
            {/if}
            {#if broadcast.titleProblem}
              <span class="max-w-72 text-xs text-white/80" data-live-title-problem
                >{TITLE_TEXT[broadcast.titleProblem]()}</span
              >
            {/if}
          {/if}
        {/if}
        {#if onAir && broadcast.health === 'retrying'}
          <span
            class="inline-flex items-center gap-1.5 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold"
            data-live-reconnecting
          >
            <WifiOff size={14} strokeWidth={2.5} />
            {m.live_reconnecting()}
            {#if broadcast.backlog > 0}
              <span class="text-white/70">{m.live_backlog({ count: broadcast.backlog })}</span>
            {/if}
          </span>
        {/if}
      </div>
    {:else}
      <CameraControlButton label={m.common_close_label()} onclick={close} data-live-close>
        <X size={24} strokeWidth={2.5} />
      </CameraControlButton>
    {/if}

    <div class="flex shrink-0 items-center gap-2">
      {#if broadcast.phase === 'preview' && orientation.canRotate}
        <RotateButton onrotate={orientation.rotate} />
      {/if}
      {#if flipAllowed}
        <CameraControlButton label={m.reels_camera_switch()} onclick={flip} data-live-switch>
          <SwitchCamera size={22} strokeWidth={2.25} />
        </CameraControlButton>
      {/if}
      {#if switchesShown}
        <!-- The microphone and the camera switched off and on WITHOUT ending the live (owner,
             2026-11-14): `pressed` is "switched off", the state the member must not forget. -->
        <CameraControlButton
          label={broadcast.micMuted ? m.live_mic_unmute_label() : m.live_mic_mute_label()}
          pressed={broadcast.micMuted}
          class={broadcast.micMuted ? 'bg-red-600/80 hover:bg-red-600' : ''}
          onclick={() => broadcast.toggleMic()}
          data-live-mic-toggle
        >
          {#if broadcast.micMuted}
            <MicOff size={20} strokeWidth={2.25} />
          {:else}
            <Mic size={20} strokeWidth={2.25} />
          {/if}
        </CameraControlButton>
        <CameraControlButton
          label={broadcast.cameraOff ? m.live_camera_unmute_label() : m.live_camera_mute_label()}
          pressed={broadcast.cameraOff}
          class={broadcast.cameraOff ? 'bg-red-600/80 hover:bg-red-600' : ''}
          onclick={() => broadcast.toggleCamera()}
          data-live-camera-toggle
        >
          {#if broadcast.cameraOff}
            <VideoOff size={20} strokeWidth={2.25} />
          {:else}
            <Video size={20} strokeWidth={2.25} />
          {/if}
        </CameraControlButton>
      {/if}
      {#if onAir}
        <!-- The on-air controls, together at the top right: share the link, show or hide the chat
             (the old eye-off icon hid ONE LINE and is now in that line's tap menu), and the small
             End - destructive, so it asks (`confirmEnd`). -->
        {#if broadcast.liveId}
          {@const sharedId = broadcast.liveId}
          <CameraControlButton
            label={m.live_share_label()}
            onclick={() => shareLiveLink(sharedId)}
            data-live-share
          >
            <Share2 size={20} strokeWidth={2.25} />
          </CameraControlButton>
        {/if}
        <CameraControlButton
          label={chatOpen ? m.live_chat_toggle_hide() : m.live_chat_toggle_show()}
          pressed={chatOpen}
          onclick={() => (chatOpen = !chatOpen)}
          data-live-chat-toggle
        >
          {#if chatOpen}
            <MessageCircle size={20} strokeWidth={2.25} />
          {:else}
            <MessageCircleOff size={20} strokeWidth={2.25} />
          {/if}
        </CameraControlButton>
        <!-- A compact X like the other controls, tinted red because it is destructive; its name is
             "Terminer" and the confirmation stays. -->
        <button
          type="button"
          class="ui-icon-button rounded-full bg-red-600/80 outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-white"
          aria-label={m.live_end_button()}
          title={m.live_end_button()}
          onclick={() => void confirmEnd()}
          data-live-end
        >
          <X size={20} strokeWidth={2.75} />
        </button>
      {/if}
    </div>
  </div>

  {#if broadcast.phase === 'preview' || broadcast.phase === 'starting'}
    <!-- Turned, the sheet takes the left side and leaves the picture on the right. -->
    <div
      class="absolute inset-x-0 bottom-0 flex max-h-[calc(100%-var(--safe-area-inset-top,0px)-4rem)] flex-col gap-3 overflow-y-auto bg-linear-to-t from-black/90 via-black/70 to-transparent px-4 pt-12 pb-[calc(var(--safe-area-inset-bottom,0px)+1.25rem)] landscape:max-w-md"
      style={sideSafePadding('1rem')}
      data-no-double-tap
      data-live-prelive-sheet
    >
      <h2 class="text-lg font-bold">{m.live_prelive_title()}</h2>
      <p class="text-sm text-white/80">
        {associationId && associationName
          ? m.live_prelive_as_association({ name: associationName })
          : m.live_prelive_as_member()}
      </p>
      {#if titleMax}
        {@const max = titleMax}
        <label class="flex flex-col gap-1 text-sm" data-live-title-field>
          <span class="flex items-center justify-between gap-2">
            <span class="font-semibold">{m.live_title_label()}</span>
            <span class="text-xs text-white/70 tabular-nums"
              >{m.live_title_counter({ count: liveTitleLength(broadcast.title), max })}</span
            >
          </span>
          <Input
            placeholder={m.live_title_placeholder()}
            value={broadcast.title}
            oninput={(e) => (broadcast.title = clampTitleField(e.currentTarget, max))}
            disabled={broadcast.phase !== 'preview'}
            data-live-title-input
          />
        </label>
      {/if}
      {#if studio}
        <LiveSceneBar {studio} showHint />
        {#if studio.micPhase === 'error'}
          <div class="flex items-center justify-between gap-3" role="alert" data-live-mic-fault>
            <p class="text-sm text-white/80">{m.live_mic_fault()}</p>
            <Button
              variant="secondary"
              size="compact"
              class="shrink-0"
              onclick={() => void studio.reopenMicrophone()}
            >
              <RefreshCcw size={16} strokeWidth={2.5} />
              {m.reels_camera_retry()}
            </Button>
          </div>
        {/if}
      {/if}

      <ul class="flex flex-col gap-2 text-sm text-white/90">
        <li class="flex items-start gap-2.5">
          <Eye size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
          {#if replaysAvailable(serverLiveReplaysMode())}
            {associationId
              ? m.live_rule_audience_association_replay({ days: replayDaysLabel() })
              : m.live_rule_audience_member_replay({ days: replayDaysLabel() })}
          {:else}
            {associationId ? m.live_rule_audience_association() : m.live_rule_audience_member()}
          {/if}
        </li>
        <li class="flex items-start gap-2.5">
          <ShieldAlert size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
          {m.live_rule_moderation()}
        </li>
        {#if broadcast.limits}
          <li class="flex items-start gap-2.5">
            <CameraOff size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
            {m.live_rule_background({
              seconds: Math.floor(broadcast.limits.reconnectWindowMs / 1000),
            })}
          </li>
        {/if}
      </ul>

      {#if broadcast.rulesPending}
        <section class="flex flex-col gap-2 rounded-2xl bg-white/10 px-3 py-3" data-live-rules>
          <h3 class="text-base font-bold">{m.live_rules_title()}</h3>
          <p class="text-sm text-white/80">{m.live_rules_intro()}</p>
          <ul class="flex list-disc flex-col gap-1 ps-5 text-sm text-white/90">
            <li>{m.live_rules_no_illegal()}</li>
            <li>{m.live_rules_no_sexual()}</li>
            <li>{m.live_rules_no_harassment()}</li>
            <li>{m.live_rules_no_malware()}</li>
          </ul>
          <p class="text-sm text-white/80">{m.live_rules_sanction()}</p>
          <a
            href="/legal/cgu#regles"
            class="text-sm font-semibold underline underline-offset-2"
            data-live-rules-terms
          >
            {m.live_rules_terms_link()}
          </a>
        </section>
      {/if}

      {#if batteryWarrantsWarning(batteryLevel)}
        <p
          class="bg-accent/20 text-accent-text flex items-start gap-2.5 rounded-2xl px-3 py-2 text-sm"
          data-live-battery
        >
          <BatteryWarning size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
          {m.live_battery_warning({ percent: Math.round((batteryLevel ?? 0) * 100) })}
        </p>
      {/if}

      {#if !broadcast.supported}
        <p class="text-sm font-semibold text-red-300" role="alert">{unsupportedText()}</p>
      {:else if broadcast.limitsProblem}
        <div class="flex items-center justify-between gap-3" role="alert">
          <p class="text-sm font-semibold text-red-300">
            {LIMITS_TEXT[broadcast.limitsProblem]()}
          </p>
          {#if broadcast.limitsProblem !== 'disabled'}
            <button
              type="button"
              class="{pill} shrink-0 bg-white/15 hover:bg-white/25"
              onclick={() => void broadcast.loadLimits()}
            >
              <RefreshCcw size={16} strokeWidth={2.5} />
              {m.live_retry()}
            </button>
          {/if}
        </div>
      {:else if !broadcast.limits}
        <p class="text-sm text-white/70">{m.live_limits_loading()}</p>
      {/if}

      {#if broadcast.startProblem}
        <p class="text-sm font-semibold text-red-300" role="alert" data-live-start-problem>
          {START_TEXT[broadcast.startProblem]()}
        </p>
      {/if}

      {#if camera.phase === 'error' && camera.fault}
        <div class="flex items-center justify-between gap-3" role="alert">
          <p class="text-sm text-white/80">{CAMERA_FAULT_TEXT[camera.fault]()}</p>
          <button
            type="button"
            class="{pill} shrink-0 bg-white/15 hover:bg-white/25"
            onclick={() => void camera.start()}
          >
            <RefreshCcw size={16} strokeWidth={2.5} />
            {m.reels_camera_retry()}
          </button>
        </div>
      {/if}

      {#if broadcast.rulesPending}
        <button
          type="button"
          class="{pill} justify-center bg-white text-black hover:bg-white/90"
          onclick={() => broadcast.acceptRules()}
          data-live-rules-accept
        >
          <ShieldCheck size={18} strokeWidth={2.5} />
          {m.live_rules_accept()}
        </button>
      {:else}
        <button
          type="button"
          class="{pill} justify-center bg-red-600 hover:bg-red-500"
          disabled={!broadcast.canStart}
          onclick={() => void broadcast.start()}
          data-live-start
        >
          {#if broadcast.phase === 'starting'}
            <LoaderCircle size={18} strokeWidth={2.5} class="motion-safe:animate-spin" />
            {m.live_starting()}
          {:else}
            <Radio size={18} strokeWidth={2.5} />
            {m.live_start_button()}
          {/if}
        </button>
      {/if}
    </div>
  {/if}

  <!-- The chat while on air (WP-L6): its own ONE loop, a hide button on every line, above the End
       button. Under the away layer in paint order, and kept mounted through it, so its lines and
       cursors survive a camera taken away. A verdict that the live is over goes to the machine. -->
  {#if onAir && broadcast.liveId && broadcast.chatKey}
    <div
      class="pointer-events-none absolute inset-x-0 top-1/4 bottom-(--safe-area-inset-bottom,0px) landscape:max-w-sm"
      style={sideSafePadding()}
      data-no-double-tap
      data-live-broadcaster-chat-box
    >
      {#key broadcast.liveId}
        <LiveBroadcasterChat
          liveId={broadcast.liveId}
          keyHex={broadcast.chatKey}
          visible={chatOpen}
          onEnded={(verdict) => broadcast.chatHeardEnd(verdict)}
          onViewers={(count) => (viewers = count)}
        />
      {/key}
    </div>
  {/if}

  {#if studio && onAir}
    <!-- The desktop's scene bar on air (owner, 2026-11-14), at the bottom right, clear of the chat
         at the left; the sound and the microphone say so here when they need a click. -->
    <div
      class="pointer-events-none absolute right-0 bottom-0 flex max-w-xl flex-col items-end gap-2 p-3 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)] *:pointer-events-auto"
      style={sideSafePadding('0.75rem')}
      data-no-double-tap
      data-live-onair-scenes
    >
      {#if !studio.audioRunning}
        <Button
          variant="danger-outline"
          size="compact"
          onclick={() => studio.wakeAudio()}
          data-live-audio-suspended
        >
          <Volume2 size={16} strokeWidth={2.5} />
          {m.live_audio_suspended()}
        </Button>
      {/if}
      {#if studio.micPhase === 'error'}
        <Button
          variant="danger-outline"
          size="compact"
          onclick={() => void studio.reopenMicrophone()}
          data-live-mic-fault
        >
          <RefreshCcw size={16} strokeWidth={2.5} />
          {m.live_mic_fault()}
        </Button>
      {/if}
      <LiveSceneBar {studio} />
    </div>
  {/if}

  {#if broadcast.phase === 'away' && broadcast.lensSwitching}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/40 text-center"
      role="status"
      data-live-lens-switching
    >
      <LoaderCircle size={32} strokeWidth={2} class="motion-safe:animate-spin" />
      <p class="text-sm">{m.live_lens_switching()}</p>
    </div>
  {:else if broadcast.phase === 'away'}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center"
      role="alert"
      data-live-away
    >
      <CameraOff size={40} strokeWidth={1.5} class="text-white/70" />
      <h2 class="text-base font-bold">{m.live_away_title()}</h2>
      <p class="text-sm text-white/70">{m.live_away_body()}</p>
      {#if broadcast.awayProblem === 'unsendable'}
        <p class="text-sm text-white/70" data-live-away-problem>{m.live_away_unsendable()}</p>
      {:else if broadcast.awayProblem === 'audio'}
        <p class="text-sm text-white/70" data-live-away-problem>{m.live_away_audio()}</p>
      {/if}
      {#if camera.phase === 'error' && camera.fault}
        <p class="text-sm text-white/70">{CAMERA_FAULT_TEXT[camera.fault]()}</p>
      {/if}
      {#if camera.phase !== 'starting'}
        <button
          type="button"
          class="{pill} bg-white/15 hover:bg-white/25"
          onclick={() => void broadcast.reacquire()}
          data-live-retry-camera
        >
          <RefreshCcw size={16} strokeWidth={2.5} />
          {m.live_away_retry()}
        </button>
      {/if}
    </div>
  {/if}

  {#if broadcast.phase === 'ending'}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center"
      role="status"
      data-live-ending
    >
      <LoaderCircle size={32} strokeWidth={2} class="motion-safe:animate-spin" />
      <p class="text-sm">{m.live_ending()}</p>
      <!-- The wait is the network's alone (the camera is already given back), and bounded - but it
           is never the member's to sit through: leaving ends the live best-effort. -->
      <p class="text-xs text-white/70">{m.live_ending_waiting()}</p>
      <button
        type="button"
        class="{pill} mt-2 bg-white/15 hover:bg-white/25"
        onclick={close}
        data-live-ending-leave
      >
        {m.live_ending_leave()}
      </button>
    </div>
  {/if}

  {#if broadcast.phase === 'ended' && broadcast.endCause}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-8 text-center"
      role="alert"
      data-live-ended={broadcast.endCause}
    >
      {#if broadcast.endCause === 'cut'}
        <h2 class="text-lg font-bold">{m.live_broadcast_cut_title()}</h2>
      {:else}
        <h2 class="text-lg font-bold">{m.live_ended_title()}</h2>
        <p class="text-sm text-white/80">{END_TEXT[broadcast.endCause]()}</p>
      {/if}
      <button type="button" class="{pill} mt-2 bg-white/15 hover:bg-white/25" onclick={close}>
        {m.common_close_label()}
      </button>
    </div>
  {/if}
</section>
