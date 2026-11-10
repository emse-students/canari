<script lang="ts">
  /**
   * A LIVE REPLAY AS A CANAREELS PAGE (docs/wiki/live-replays.md, WP-R4; owner, 2026-11-09): the
   * finished live drawn like a reel - the same frame, the shared video player in its `reel` variant
   * (its thin progress line seeks, its gestures, the app's one sound answer) - fed not by a file but
   * by the live's own segments through `ReplayPlayer` and a MediaSource.
   *
   * ONLY THE ACTIVE PAGE MOUNTS A PLAYER, like every reel: a player on a neighbour would claim
   * playback. The player's whole lifetime is one `$effect` on `active`: leaving the page stops it and
   * gives the buffers back. The TIME LEFT is drawn on a replay and on nothing else (owner,
   * 2026-11-09): a reel's month surprises nobody, a replay's three days do. It comes from the replay
   * route's own pair of database times (`replayTimeLeft`), never from this phone's clock. THE COVER
   * (its live's last preview, served on the post row) stands over the page until the picture plays,
   * on a neighbour page too, and gives way to any screen the player itself must show (a blocked
   * autoplay's button, a failure).
   *
   * Every way the replay can fail has a screen and no other: `gone` (expired, deleted, a block, a
   * removal: the same neutral line, by the server's design), `unavailable` (this engine cannot play
   * it, with a retry), and `reconnecting` over the picture - never a spinner that never ends.
   */
  import { untrack } from 'svelte';
  import { CircleAlert, History, LoaderCircle } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import {
    isTerminalReplayState,
    ReplayPlayer,
    type ReplayPlayerDeps,
    type ReplayState,
  } from '$lib/live/replayPlayer';
  import type { LiveVideoLike } from '$lib/live/livePlayer';
  import LivePosterImage from '$lib/components/live/LivePosterImage.svelte';
  import { replayCoverOf, replayTimeLeft } from '$lib/live/replayTimeline';
  import type { loadLivePoster } from '$lib/live/livePosterView';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import { replayTimeLeftText } from '$lib/live/replayLabels';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    post: PostEntity;
    /** The page on screen: a player is mounted and the replay plays. */
    active: boolean;
    /** Whether the frame reaches the screen bottom: the player's progress line clears the inset. */
    playerSafeBottom: boolean;
    /** The page has SETTLED: playing, or decidedly failed - the viewer then may preload the next. */
    onReady?: () => void;
    /** Replaces the player's outside world - for tests. */
    deps?: Partial<Omit<ReplayPlayerDeps, 'attach'>>;
    /** The cover's loader; the real one unless a test hands its own. */
    loadCover?: typeof loadLivePoster;
  }

  let { post, active, playerSafeBottom, onReady, deps, loadCover }: Props = $props();

  const cover = $derived(replayCoverOf(post));

  /** The MediaSource's object URL once the player made one; the shared player mounts on it. */
  let src = $state<string | null>(null);
  let videoEl = $state<HTMLVideoElement | null>(null);
  let replayState = $state<ReplayState>({ kind: 'connecting' });
  let meta = $state<{ expiresAt: string; serverNow: string } | null>(null);
  /** The shared player has started playing (`playing` event). */
  let playing = $state(false);
  let blocked = $state<string | null>(null);
  let player: ReplayPlayer | null = null;

  const timeLeft = $derived(meta ? replayTimeLeft(meta.expiresAt, meta.serverNow) : null);

  /**
   * The `<video>` as the player drives it. The element exists only once the shared player mounted on
   * the MediaSource's URL - which the player itself waits for (`sourceopen`) before it touches any of
   * this - so the defaults below are never read for a decision.
   */
  const video: LiveVideoLike = {
    get currentTime() {
      return videoEl?.currentTime ?? 0;
    },
    set currentTime(t: number) {
      if (videoEl) videoEl.currentTime = t;
    },
    get paused() {
      return videoEl?.paused ?? true;
    },
    get seeking() {
      return videoEl?.seeking ?? false;
    },
    get readyState() {
      return videoEl?.readyState ?? 0;
    },
    // A replay plays at its own pace: nothing here moves the rate, the shared shape asks for it.
    get playbackRate() {
      return videoEl?.playbackRate ?? 1;
    },
    set playbackRate(rate: number) {
      if (videoEl) videoEl.playbackRate = rate;
    },
    async play() {
      await videoEl?.play();
    },
    pause() {
      videoEl?.pause();
    },
  };

  $effect(() => {
    const liveId = active ? post.liveId : null;
    if (!liveId) return;
    console.debug(`[LIVE_REPLAY] page ${post.id} active - player for live ${liveId}`);
    const next = new ReplayPlayer({
      liveId,
      video,
      onState: (s) => (replayState = s),
      onMeta: (facts) => (meta = { expiresAt: facts.expiresAt, serverNow: facts.serverNow }),
      deps: {
        ...deps,
        attach: (source) => {
          const url = URL.createObjectURL(source as unknown as MediaSource);
          src = url;
          return () => {
            URL.revokeObjectURL(url);
            if (src === url) src = null;
          };
        },
      },
    });
    player = next;
    next.start();
    return () => {
      console.debug(`[LIVE_REPLAY] page ${post.id} left the screen - player stopped`);
      next.stop();
      player = null;
      src = null;
      playing = false;
      blocked = null;
      meta = null;
      replayState = { kind: 'connecting' };
    };
  });

  /** Hooks the shared player's `<video>` to the replay player; the returned function unhooks it. */
  function bindVideo(el: HTMLVideoElement): () => void {
    videoEl = el;
    const time = () => player?.noteTime();
    const seeking = () => player?.noteSeeking();
    const waiting = () => player?.noteStall();
    const error = () => player?.noteMediaError();
    el.addEventListener('timeupdate', time);
    el.addEventListener('seeking', seeking);
    el.addEventListener('waiting', waiting);
    el.addEventListener('error', error);
    return () => {
      el.removeEventListener('timeupdate', time);
      el.removeEventListener('seeking', seeking);
      el.removeEventListener('waiting', waiting);
      el.removeEventListener('error', error);
      if (videoEl === el) videoEl = null;
    };
  }

  $effect(() => {
    if (!active) return;
    if (!playing && !blocked && !isTerminalReplayState(replayState)) return;
    console.debug(`[LIVE_REPLAY] page ${post.id} settled (${blocked ?? replayState.kind})`);
    untrack(() => onReady?.());
  });
</script>

<div
  class="relative flex h-full w-full items-center justify-center bg-black"
  data-replay-pane
  data-replay-state={replayState.kind}
  onplayingcapture={() => {
    if (active && !playing) playing = true;
  }}
>
  {#if active && src && !isTerminalReplayState(replayState)}
    <VideoPlayer
      variant="reel"
      {src}
      streamed
      disableRemotePlayback
      class="h-full w-full"
      safeBottom={playerSafeBottom}
      poster={TRANSPARENT_VIDEO_POSTER}
      onVideo={bindVideo}
      onPlaybackBlocked={(cause) => {
        console.debug(`[LIVE_REPLAY] page ${post.id} will not play by itself (${cause})`);
        blocked = cause;
      }}
    />
  {/if}

  {#if cover && !playing && !blocked && !isTerminalReplayState(replayState)}
    <div class="pointer-events-none absolute inset-0" data-replay-cover>
      <LivePosterImage
        live={cover}
        alt={m.replay_cover_alt({ name: postAuthorName(post) })}
        load={loadCover}
        placeholder={false}
      />
    </div>
  {/if}

  {#if replayState.kind === 'connecting'}
    <div
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-white/70"
      role="status"
      aria-label={m.replay_loading()}
      data-replay-loading
    >
      <LoaderCircle size={28} strokeWidth={2} class="animate-spin" />
    </div>
  {:else if replayState.kind === 'reconnecting'}
    <div
      class="pointer-events-none absolute inset-x-0 bottom-24 flex justify-center"
      role="status"
      data-replay-reconnecting
    >
      <span class="rounded-full bg-black/60 px-3 py-1 text-xs font-semibold text-white">
        {m.replay_reconnecting()}
      </span>
    </div>
  {:else if replayState.kind === 'gone'}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/80"
      role="status"
      data-replay-gone
    >
      <CircleAlert size={26} strokeWidth={2} class="opacity-70" />
      <span class="text-sm font-semibold">{m.replay_gone()}</span>
    </div>
  {:else if replayState.kind === 'unavailable'}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white/80"
      role="status"
      data-replay-unavailable={replayState.reason}
    >
      <CircleAlert size={26} strokeWidth={2} class="opacity-70" />
      <span class="text-sm font-semibold">{m.replay_unavailable()}</span>
      <Button type="button" variant="secondary" onclick={() => player?.retry()} data-replay-retry>
        {m.replay_retry()}
      </Button>
    </div>
  {/if}

  <!-- THE MARK, AND THE TIME LEFT (owner, 2026-11-09): on a replay only. Pointer-transparent. -->
  <div
    class="pointer-events-none absolute top-[calc(var(--safe-area-inset-top,0px)+3.75rem)] left-3 z-30 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-bold text-white"
    data-replay-chip
  >
    <History size={13} strokeWidth={2.5} aria-hidden="true" />
    <span>{m.replay_badge()}</span>
    {#if timeLeft}
      <span class="font-medium opacity-80" data-replay-time-left
        >&middot; {replayTimeLeftText(timeLeft)}</span
      >
    {/if}
  </div>
</div>
