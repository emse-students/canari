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
    Radio,
    RefreshCcw,
    ShieldAlert,
    ShieldCheck,
    SwitchCamera,
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
  import LiveBroadcasterChat from './LiveBroadcasterChat.svelte';
  import LiveViewerCount from './LiveViewerCount.svelte';

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
  let video = $state<HTMLVideoElement | null>(null);

  const onAir = $derived(broadcast.phase === 'live' || broadcast.phase === 'away');

  /** Whether a Back should ask before ending - the overlay's history entry reads it. */
  export function holdsBack(): boolean {
    return onAir;
  }

  /** Asks, then ends the live: the End button, Back and the edge swipe all come here. */
  export async function confirmEnd(): Promise<void> {
    console.debug('[LIVE-SCREEN] end asked');
    const ok = await showConfirm(m.live_end_confirm(), {
      danger: true,
      confirmLabel: m.live_end_confirm_button(),
      cancelLabel: m.live_end_keep(),
    });
    if (!ok) {
      console.debug('[LIVE-SCREEN] end declined - still on air');
      return;
    }
    await broadcast.end();
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

  // The element follows the session's stream; `muted` as a PROPERTY (CameraScreen: a cloned element
  // does not take its muted state from the attribute, and the microphone played back as an echo).
  $effect(() => {
    frameReady = false;
    if (!video) return;
    video.muted = true;
    video.srcObject = camera.stream;
  });

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

  const START_TEXT: Record<LiveStartProblem, () => string> = {
    muted: m.live_start_muted,
    'rules-not-accepted': m.live_start_rules_not_accepted,
    suspended: suspendedText,
    withdrawn: m.live_start_withdrawn,
    'already-open': m.live_start_already_open,
    'association-forbidden': m.live_start_association_forbidden,
    'rate-limited': m.live_start_rate_limited,
    disabled: m.live_limits_disabled,
    offline: m.live_start_offline,
    unsupported: m.live_unsupported,
    failed: m.live_start_failed,
  };

  const LIMITS_TEXT: Record<LiveLimitsProblem, () => string> = {
    disabled: m.live_limits_disabled,
    offline: m.live_limits_offline,
    failed: m.live_limits_failed,
  };

  // A moderation cut has its own TITLE and no sentence under it, so it is not in this table.
  const END_TEXT: Record<Exclude<LiveEndCause, 'cut'>, () => string> = {
    broadcaster: m.live_ended_broadcaster,
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
  const iconButton =
    'ui-icon-button rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2 focus-visible:ring-amber-500';
</script>

<section
  class="relative h-full w-full overflow-hidden bg-black text-white"
  aria-label={m.live_overlay_label()}
  data-live-phase={broadcast.phase}
>
  <!-- One element per stream: WKWebView keeps a video's layer at its FIRST layout's size, and a
       re-acquired camera is a new stream (CameraScreen, iPhone 12, 2026-10-02). -->
  {#key camera.stream}
    <video
      bind:this={video}
      class="absolute inset-0 h-full w-full object-cover {camera.facing === 'user'
        ? '-scale-x-100'
        : ''} {camera.phase === 'live' && frameReady
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

  <!-- The top row: close (never while on air: End is the way out) and the lens. -->
  <div
    class="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
  >
    {#if onAir || broadcast.phase === 'starting' || broadcast.phase === 'ending'}
      <div class="flex flex-col items-start gap-2" role="status">
        {#if onAir}
          <span
            class="inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-bold tracking-wide uppercase"
          >
            <span class="h-2 w-2 rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true"
            ></span>
            {m.live_on_air()}
            <span
              role="timer"
              aria-label={m.live_elapsed_label()}
              class="font-semibold tabular-nums">{clock(elapsedMs)}</span
            >
          </span>
          <LiveViewerCount count={viewers} />
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
      <button
        type="button"
        class={iconButton}
        aria-label={m.common_close_label()}
        title={m.common_close_label()}
        onclick={close}
        data-live-close
      >
        <X size={24} strokeWidth={2.5} />
      </button>
    {/if}

    {#if broadcast.phase === 'preview' && camera.phase === 'live'}
      <button
        type="button"
        class={iconButton}
        aria-label={m.reels_camera_switch()}
        title={m.reels_camera_switch()}
        onclick={() => void camera.switchFacing()}
      >
        <SwitchCamera size={22} strokeWidth={2.25} />
      </button>
    {/if}
  </div>

  {#if broadcast.phase === 'preview' || broadcast.phase === 'starting'}
    <div
      class="absolute inset-x-0 bottom-0 flex max-h-[calc(100%-var(--safe-area-inset-top,0px)-4rem)] flex-col gap-3 overflow-y-auto bg-linear-to-t from-black/90 via-black/70 to-transparent px-4 pt-12 pb-[calc(var(--safe-area-inset-bottom,0px)+1.25rem)]"
    >
      <h2 class="text-lg font-bold">{m.live_prelive_title()}</h2>
      <p class="text-sm text-white/80">
        {associationId && associationName
          ? m.live_prelive_as_association({ name: associationName })
          : m.live_prelive_as_member()}
      </p>
      <ul class="flex flex-col gap-2 text-sm text-white/90">
        <li class="flex items-start gap-2.5">
          <Eye size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
          {associationId ? m.live_rule_audience_association() : m.live_rule_audience_member()}
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
          class="flex items-start gap-2.5 rounded-2xl bg-amber-500/20 px-3 py-2 text-sm text-amber-200"
          data-live-battery
        >
          <BatteryWarning size={18} strokeWidth={2.25} class="mt-0.5 shrink-0" />
          {m.live_battery_warning({ percent: Math.round((batteryLevel ?? 0) * 100) })}
        </p>
      {/if}

      {#if !broadcast.supported}
        <p class="text-sm font-semibold text-red-300" role="alert">{m.live_unsupported()}</p>
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
      class="pointer-events-none absolute inset-x-0 top-1/3 bottom-[calc(var(--safe-area-inset-bottom,0px)+5rem)]"
      data-live-broadcaster-chat-box
    >
      {#key broadcast.liveId}
        <LiveBroadcasterChat
          liveId={broadcast.liveId}
          keyHex={broadcast.chatKey}
          onEnded={(verdict) => broadcast.chatHeardEnd(verdict)}
          onViewers={(count) => (viewers = count)}
        />
      {/key}
    </div>
  {/if}

  {#if broadcast.phase === 'away'}
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

  {#if onAir}
    <div
      class="absolute inset-x-0 bottom-0 flex justify-center pb-[calc(var(--safe-area-inset-bottom,0px)+1.5rem)]"
    >
      <button
        type="button"
        class="{pill} bg-red-600 hover:bg-red-500"
        onclick={() => void confirmEnd()}
        data-live-end
      >
        <X size={18} strokeWidth={2.5} />
        {m.live_end_button()}
      </button>
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
