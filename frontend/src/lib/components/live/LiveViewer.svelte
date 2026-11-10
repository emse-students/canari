<script lang="ts">
  /**
   * THE FULL-SCREEN LIVE VIEWER (WP-L5, viewer half): the live playing as it grows, the LIVE badge,
   * the time on air, who broadcasts, a sound toggle - and a screen for every way a live can refuse:
   * "live complet" with a retry, "le live est terminé", the neutral "live indisponible", and a
   * reconnecting line that never says "complet".
   *
   * Every decision is `$lib/live/livePlayer.ts` (the MSE player and its state machine) and
   * `$lib/live/liveViewerState.ts` (failure -> screen); this file draws the state and owns the
   * `<video>`. Like the reel viewer it is a HISTORY ENTRY (`bindHistoryOverlay`: Android's Back and
   * the browser's close it, the feed under it never leaves the page) and it covers the screen
   * (`coversScreen`: the iOS native tab bar steps aside).
   *
   * The seat on the host's viewer cap goes back when the viewer closes, and on `pagehide` (best
   * effort - the 30 s lease frees it anyway); a page restored from the back-forward cache starts
   * the live again.
   */
  import { onMount, tick } from 'svelte';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { LoaderCircle, MessageCircle, MessageCircleOff, Radio, Share2, X } from '@lucide/svelte';
  import { videoGestures } from '$lib/actions/videoGestures';
  import VideoSoundButton from '$lib/components/ui/player/VideoSoundButton.svelte';
  import MediaSpinner from '$lib/components/shared/MediaSpinner.svelte';
  import VideoFeedbackGlyph, {
    type VideoFeedbackKind,
  } from '$lib/components/ui/player/VideoFeedbackGlyph.svelte';
  import LiveBadge from './LiveBadge.svelte';
  import LiveIdentity from './LiveIdentity.svelte';
  import LiveReportControl from './LiveReportControl.svelte';
  import LiveChatReportDialog from './LiveChatReportDialog.svelte';
  import LiveChatPanel from './LiveChatPanel.svelte';
  import LiveReactionBar from './LiveReactionBar.svelte';
  import LiveReactionsLayer from './LiveReactionsLayer.svelte';
  import LiveViewerCount from './LiveViewerCount.svelte';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { followVideoSound } from '$lib/actions/playWhileVisible';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { LivePlayer, type LivePlayerDeps, type LiveVideoLike } from '$lib/live/livePlayer';
  import { fetchLiveLimits } from '$lib/live/api';
  import { shareLiveLink } from '$lib/live/shareLive';
  import {
    LiveChatSession,
    type LiveChatDeps,
    type LiveChatLine,
    type LiveChatSendFailure,
  } from '$lib/live/liveChat';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { formatLiveElapsed } from '$lib/live/openLives';
  import { isTerminalLiveState, type LiveViewerState } from '$lib/live/liveViewerState';
  import type { LiveListItem } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    live: LiveListItem;
    onClose: () => void;
    /** Replaces the player's outside world - for tests; the browser's otherwise. */
    deps?: Partial<LivePlayerDeps>;
    /** Replaces the chat's outside world - for tests. */
    chatDeps?: Partial<LiveChatDeps>;
    /** Replaces the limits fetch - for tests. */
    fetchLimits?: typeof fetchLiveLimits;
  }

  let { live, onClose, deps, chatDeps, fetchLimits = fetchLiveLimits }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);
  /** The final screen's one button (retry or back), focused when that screen appears. */
  let actionButton = $state<HTMLButtonElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  let viewerState = $state<LiveViewerState>({ kind: 'connecting' });
  /** The buffer ran dry while the live plays: the kit's spinner over the last frame until media comes. */
  let buffering = $state(false);
  let elapsedMs = $state<number | null>(null);
  /** How many watch, from each manifest poll - a number, never who (null: nothing to show). */
  let viewers = $state<number | null>(null);
  let name = $state('');
  let player: LivePlayer | null = null;
  // The live chat (WP-L6): one session riding the player's poll, drawn by the panel and the layer.
  let chat: LiveChatSession | null = null;
  let chatLines = $state<readonly LiveChatLine[]>([]);
  /** The chat line whose report dialog is open (a viewer's flag), or null. */
  let reportedLine = $state<LiveChatLine | null>(null);
  let chatMaxChars = $state<number | null>(null);
  // The key from the player, and the account READ REACTIVELY: an account that loads after the viewer
  // opened enables the composer then, not never.
  let chatKeyed = $state(false);
  /**
   * The server withholds the chat from this named reader (owner, 2026-11-04): the session says. The
   * comments rule exactly (lead, 2026-11-04): no chat area, no toggle, no line explaining it.
   */
  let chatWithheld = $state(false);
  const chatCanWrite = $derived(chatKeyed && !chatWithheld && currentUserId() !== null);
  let chatOpen = $state(true);
  // STAFF HIDE (C14): the server opens the hide route to the broadcaster and to the moderators of
  // THIS live - a platform admin, read reactively, or a BDE whose spaces hold it.
  // A BDE moderator is SCOPED (2026-11-02): the server says per live whether its governed spaces hold
  // it (`viewerModerates`, on the list AND on `GET /lives/:id`). Absent means no button: falling back
  // to the door would draw a control the server refuses.
  const chatCanModerate = $derived(isGlobalAdmin() || live.viewerModerates === true);
  let reactions = $state<LiveReactionsLayer | null>(null);

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      console.debug('[LIVE] viewer closed');
      onClose();
    }
  );

  /**
   * The `<video>` as the player drives it. A `play()` the engine refuses WITH sound (no gesture yet)
   * is tried again muted, so a live never sits paused behind an autoplay rule; the app's answer goes
   * silent for this session only (`muteForRefusedStart`) - the reader's remembered choice is not the
   * engine's refusal - and a tap brings the sound back.
   */
  function videoFor(el: HTMLVideoElement): LiveVideoLike {
    return {
      get currentTime() {
        return el.currentTime;
      },
      set currentTime(t: number) {
        el.currentTime = t;
      },
      get paused() {
        return el.paused;
      },
      get seeking() {
        return el.seeking;
      },
      get readyState() {
        return el.readyState;
      },
      get playbackRate() {
        return el.playbackRate;
      },
      set playbackRate(rate: number) {
        // The pace changes the speed a few percent, never the voice (`LiveBufferPolicy.pace`).
        el.preservesPitch = true;
        el.playbackRate = rate;
      },
      async play() {
        try {
          await el.play();
        } catch (e) {
          if (el.muted) throw e;
          console.warn(`[LIVE] viewer: play() with sound refused (${String(e)}) - muted`);
          videoSound.muteForRefusedStart();
          el.muted = true;
          await el.play();
        }
      },
      pause() {
        el.pause();
      },
    };
  }

  function attachTo(el: HTMLVideoElement): LivePlayerDeps['attach'] {
    return (source) => {
      // ManagedMediaSource plays only with remote playback off (or an AirPlay alternative).
      el.disableRemotePlayback = true;
      const url = URL.createObjectURL(source as unknown as MediaSource);
      el.src = url;
      return () => {
        el.removeAttribute('src');
        el.load();
        URL.revokeObjectURL(url);
      };
    };
  }

  onMount(() => {
    overlay.syncOpen();
    // `focusTrap` keeps Tab inside and gives focus back to the card on close; its own first focus runs
    // before the dialog is in the document, so the X is focused here, once it is.
    closeButton?.focus({ preventScroll: true });
    const el = video;
    if (!el) return;
    console.debug(`[LIVE] viewer opened on ${live.id}`);
    const session = new LiveChatSession({
      liveId: live.id,
      me: currentUserId,
      onChange: (lines) => {
        chatLines = lines;
      },
      onFloat: (kind, count) => reactions?.add(kind, count),
      onWithheld: (withheld) => {
        chatWithheld = withheld;
      },
      // A write answered "the live is over" shows the screen the player's own poll would have shown.
      onLiveOver: (verdict) => player?.refusedElsewhere(verdict),
      deps: chatDeps,
    });
    chat = session;
    fetchLimits().then(
      (limits) => {
        session.setLimits(limits);
        chatMaxChars = session.messageMaxChars;
      },
      (e: unknown) => {
        // The composer still works; a message past the bound is the server's 400, said on its line.
        console.warn(`[LIVE_CHAT] the live limits could not be read (${String(e)})`);
      }
    );
    const p = new LivePlayer({
      liveId: live.id,
      video: videoFor(el),
      onState: (s) => {
        viewerState = s;
      },
      onElapsed: (ms) => {
        elapsedMs = ms;
      },
      onViewers: (count) => {
        viewers = count;
      },
      onBuffering: (dry) => {
        buffering = dry;
      },
      chat: {
        onKey: (key, opened) => {
          session.onKey(key, opened);
          chatKeyed = session.keyed;
        },
        query: () => session.query(),
        receive: (block) => void session.receive(block),
      },
      deps: { attach: attachTo(el), ...deps },
    });
    player = p;
    p.start();

    const onPageHide = () => p.stop();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) p.start();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      p.stop();
      player = null;
      session.stop();
      chat = null;
    };
  });

  /** The composer's send; the session exists from mount to teardown, the panel only between. */
  function sendChat(text: string): Promise<LiveChatSendFailure | null> {
    if (!chat) return Promise.resolve('refused');
    return chat.send(text);
  }

  /** What the last tap on the picture did, for the glyph (`VideoFeedbackGlyph`). */
  let feedback = $state<{ kind: VideoFeedbackKind; n: number } | null>(null);
  let feedbackCount = 0;

  /**
   * The sound, from the speaker or a tap on the picture (owner, 2026-11-09: the tap is the sound on
   * every video). A live has no hold: its player resumes a paused element at the next delivery.
   */
  function toggleSound() {
    videoSound.toggle();
    feedback = { kind: videoSound.muted ? 'sound-off' : 'sound-on', n: ++feedbackCount };
    if (video) video.muted = videoSound.muted;
    // A tap is the gesture an unmuted play() needed.
    if (video?.paused && viewerState.kind === 'playing')
      void video.play().catch((e: unknown) => {
        console.warn(`[LIVE] viewer: play() after the sound toggle refused (${String(e)})`);
      });
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      overlay.dismissFromUi();
    }
  }

  const terminal = $derived(isTerminalLiveState(viewerState));

  // A final screen takes the focus to its button, so a keyboard or screen-reader user lands on the
  // one thing left to do. Keyed on the state's kind; the button is read after it is drawn.
  $effect(() => {
    if (!terminal) return;
    void tick().then(() => actionButton?.focus({ preventScroll: true }));
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div use:portal>
  <div
    use:coversScreen
    use:focusTrap
    class="fixed inset-0 z-(--z-viewer) overflow-hidden bg-black text-white"
    role="dialog"
    aria-modal="true"
    aria-label={m.live_viewer_label({ name })}
    data-live-viewer
    data-live-state={viewerState.kind}
  >
    <!-- svelte-ignore a11y_media_has_caption: a live has no caption track; its sound is the broadcaster's own -->
    <video
      bind:this={video}
      use:followVideoSound
      use:videoGestures={{ onTap: toggleSound, enabled: !terminal }}
      class="absolute inset-0 h-full w-full object-contain [-webkit-touch-callout:none]"
      class:opacity-40={terminal}
      playsinline
      autoplay
      disableremoteplayback
      onwaiting={() => player?.noteStall()}
      onerror={() => player?.noteMediaError()}
      data-live-video
    ></video>
    <!-- A tap's glyph: the feedback of a gesture, never a state. -->
    <VideoFeedbackGlyph {feedback} />
    <!-- THE LAST RESORT: the margin ran out (the broadcaster later than all of it). The kit's spinner
         over the frozen last frame - never a loop, never black - until the next media resumes it.
         "Reconnecting" and the final screens say their own thing instead. -->
    {#if buffering && viewerState.kind === 'playing'}
      <MediaSpinner />
    {/if}

    <div
      class="absolute inset-x-0 top-0 flex items-center gap-2 bg-linear-to-b from-black/60 to-transparent p-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)]"
    >
      <!-- Instagram Live's corner: who, then LIVE, the time and the audience; the controls and the
           close X at the right. -->
      <span class="flex min-w-0 flex-1 flex-col items-stretch gap-1 text-sm">
        <LiveIdentity {live} size="sm" onName={(n) => (name = n)} />
        <span class="flex items-center gap-1.5">
          {#if viewerState.kind !== 'ended'}
            <LiveBadge />
          {/if}
          {#if elapsedMs !== null}
            <span
              class="rounded-full bg-black/40 px-2 py-0.5 text-xs tabular-nums"
              aria-label={m.live_viewer_elapsed({ time: formatLiveElapsed(elapsedMs) })}
              data-live-elapsed
            >
              {formatLiveElapsed(elapsedMs)}
            </span>
          {/if}
          {#if !terminal}
            <LiveViewerCount count={viewers} />
          {/if}
        </span>
      </span>
      <LiveReportControl {live} onBlocked={() => overlay.dismissFromUi()} />
      <!-- The kit's speaker, the same object as on every other video (owner, 2026-11-09). -->
      <VideoSoundButton muted={videoSound.muted} onToggle={toggleSound} data-live-sound />
      <!-- Withheld: no toggle either - a button that shows and hides nothing is a dead control. -->
      {#if !chatWithheld}
        <button
          type="button"
          class="ui-icon-button bg-cn-scrim/40 hover:bg-cn-scrim/60 focus-visible:ring-accent-icon rounded-full outline-none focus-visible:ring-2"
          aria-label={chatOpen ? m.live_chat_toggle_hide() : m.live_chat_toggle_show()}
          title={chatOpen ? m.live_chat_toggle_hide() : m.live_chat_toggle_show()}
          aria-pressed={chatOpen}
          onclick={() => (chatOpen = !chatOpen)}
          data-live-chat-toggle
        >
          {#if chatOpen}
            <MessageCircle size={22} />
          {:else}
            <MessageCircleOff size={22} />
          {/if}
        </button>
      {/if}
      {#if !terminal}
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2"
          aria-label={m.live_share_label()}
          title={m.live_share_label()}
          onclick={() => shareLiveLink(live.id)}
          data-live-share
        >
          <Share2 size={22} />
        </button>
      {/if}
      <button
        bind:this={closeButton}
        type="button"
        class="ui-icon-button focus-visible:ring-accent-icon rounded-full bg-black/30 outline-none hover:bg-black/50 focus-visible:ring-2"
        aria-label={m.live_viewer_close()}
        title={m.live_viewer_close()}
        onclick={() => overlay.dismissFromUi()}
        data-live-close
      >
        <X size={24} strokeWidth={2.5} />
      </button>
    </div>

    <LiveReactionsLayer bind:this={reactions} />

    <LiveChatReportDialog
      liveId={live.id}
      line={reportedLine}
      onClose={() => (reportedLine = null)}
    />

    {#if !terminal}
      <div
        class="from-cn-scrim/60 via-cn-scrim/30 pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 bg-linear-to-t to-transparent p-3 pt-24 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)]"
      >
        <div class="min-w-0 flex-1">
          {#if chatOpen && !chatWithheld}
            <LiveChatPanel
              lines={chatLines}
              canWrite={chatCanWrite}
              maxChars={chatMaxChars}
              canModerate={chatCanModerate}
              hostId={live.broadcasterId}
              send={sendChat}
              retry={(id) => void chat?.retry(id)}
              discard={(id) => chat?.discard(id)}
              hide={(id) => void chat?.hide(id)}
              report={(line) => (reportedLine = line)}
            />
          {/if}
        </div>
        <LiveReactionBar onTap={(kind) => chat?.tap(kind)} />
      </div>
    {/if}

    <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div class="pointer-events-auto max-w-sm text-center" role="status" aria-live="polite">
        {#if viewerState.kind === 'connecting'}
          <LoaderCircle size={32} class="mx-auto motion-safe:animate-spin" aria-hidden="true" />
          <p class="mt-3 text-sm">{m.live_viewer_connecting()}</p>
        {:else if viewerState.kind === 'reconnecting'}
          <p class="rounded-lg bg-black/60 px-3 py-2 text-sm" data-live-reconnecting>
            {viewerState.reason === 'broadcaster'
              ? m.live_viewer_broadcaster_away()
              : m.live_viewer_reconnecting()}
          </p>
        {:else if viewerState.kind === 'full'}
          <Radio size={40} class="mx-auto opacity-80" aria-hidden="true" />
          <h2 class="mt-3 text-lg font-bold">{m.live_viewer_full_title()}</h2>
          <p class="mt-1 text-sm opacity-90">{m.live_viewer_full_body()}</p>
          <button
            type="button"
            class="bg-accent text-on-accent mt-4 min-h-11 rounded-full px-5 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-white"
            bind:this={actionButton}
            onclick={() => player?.retry()}
            data-live-retry
          >
            {m.common_retry_button()}
          </button>
        {:else if viewerState.kind === 'ended' || viewerState.kind === 'unavailable'}
          <h2 class="text-lg font-bold">
            {viewerState.kind === 'ended'
              ? viewerState.cut
                ? m.live_viewer_cut_title()
                : m.live_viewer_ended_title()
              : m.live_viewer_unavailable_title()}
          </h2>
          {#if viewerState.kind === 'unavailable'}
            <p class="mt-1 text-sm opacity-90">{m.live_viewer_unavailable_body()}</p>
          {/if}
          <button
            type="button"
            class="mt-4 min-h-11 rounded-full bg-white/15 px-5 text-sm font-bold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
            bind:this={actionButton}
            onclick={() => overlay.dismissFromUi()}
            data-live-back
          >
            {m.live_viewer_back()}
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>
