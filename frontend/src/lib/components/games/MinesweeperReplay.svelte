<script lang="ts">
  import { onMount } from 'svelte';
  import { Pause, Play, RotateCcw } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperCell from '$lib/components/settings/MinesweeperCell.svelte';
  import { fetchMinesweeperReplay, formatDurationMs } from '$lib/minesweeper/api';
  import type { MinesweeperReplayData } from '$lib/minesweeper/api';
  import { EMPTY_CELL_VIEWS, syncCellViews } from '$lib/minesweeper/cellViews';
  import { createReplay, fitCellSize, type Replay } from '$lib/minesweeper/replay';
  import { m } from '$lib/paraglide/messages';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';

  /**
   * THE REPLAY of one won ranked game (owner, 2026-11-17; open to every member, 2026-11-18): the board
   * is regenerated from the stored seed and the timed moves are played back at their own pace - or
   * faster - so anyone can see how a record was played, and a moderator can judge whether a hand did
   * it. Opened from a row of the Games ranking. docs/wiki/frontend/modules/minesweeper.md, "The replay".
   *
   * The screen is the board: full-screen on a phone, the whole grid fitted to the space it is given
   * (`fitCellSize`, re-fitted on every resize or rotation), the controls in one bar under it.
   */
  interface Props {
    /** The score to replay. */
    scoreId: string;
    onClose: () => void;
  }

  let { scoreId, onClose }: Props = $props();

  /** Playback speeds offered: a real game is often a minute or more. */
  const SPEEDS = [1, 2, 4, 8] as const;
  type Speed = (typeof SPEEDS)[number];

  type Phase = 'loading' | 'ready' | 'missing' | 'failed';

  let phase = $state<Phase>('loading');
  let data = $state.raw<MinesweeperReplayData | null>(null);
  /** The engine's replay: its board mutates in place, so it stays out of the reactive graph. */
  let replay: Replay | null = null;
  let views = $state.raw(EMPTY_CELL_VIEWS);
  /** How many moves the board shows, and where the clock stands. */
  let shown = $state(0);
  let positionMs = $state(0);
  let playing = $state(false);
  let speed = $state<Speed>(1);
  /** The board's room, measured, and the cell size at which the whole grid fits it. */
  let stage = $state<HTMLDivElement | null>(null);
  let cellPx = $state(20);
  /** Breathing room around the grid inside the stage, in px. */
  const STAGE_PADDING_PX = 16;

  const lastMove = $derived(data && shown > 0 ? data.moves[shown - 1] : null);
  /** Where the game ends: its last move. */
  const lengthMs = $derived(data ? (data.moves[data.moves.length - 1]?.t ?? 0) : 0);
  const markedCell = $derived(
    lastMove && data ? lastMove.y * data.config.width + lastMove.x : null
  );
  const atEnd = $derived(positionMs >= lengthMs);

  /** Keeps the grid fitted to its room: the cell size follows the stage (rotation, window resize). */
  $effect(() => {
    if (!stage || !data || typeof ResizeObserver === 'undefined') return;
    const { width: cols, height: rows } = data.config;
    const el = stage;
    const fit = () => {
      cellPx = fitCellSize(
        el.clientWidth - STAGE_PADDING_PX,
        el.clientHeight - STAGE_PADDING_PX,
        cols,
        rows
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  });

  onMount(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchMinesweeperReplay(scoreId);
        if (cancelled) return;
        const built = createReplay(loaded);
        // Generation is the slow part: do it now, behind the loading line, not on the first Play.
        built.boardAfter(1);
        replay = built;
        data = loaded;
        showMoves(0);
        phase = 'ready';
        Log.d('games', `replay loaded score=${scoreId} moves=${loaded.moves.length}`);
      } catch (e) {
        if (cancelled) return;
        // A 404 is an answer ("none was kept"), anything else is a failure to load.
        phase = refusalStatus(e) === 404 ? 'missing' : 'failed';
        Log.d('games', `replay not loaded score=${scoreId}: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  /** Puts the board as it stands after `count` moves on screen. */
  function showMoves(count: number) {
    if (!replay) return;
    const board = replay.boardAfter(count);
    views = syncCellViews(board.cells, views).next;
    shown = count;
  }

  /** Moves the clock to `ms` and shows the board of that moment. */
  function seek(ms: number) {
    if (!replay) return;
    positionMs = Math.min(Math.max(ms, 0), lengthMs);
    const count = replay.movesAt(positionMs);
    if (count !== shown) showMoves(count);
  }

  function togglePlay() {
    if (playing) {
      playing = false;
      return;
    }
    // Play from the end starts the game over, as a video does.
    if (atEnd) seek(0);
    playing = true;
  }

  function restart() {
    playing = false;
    seek(0);
  }

  /** One animation frame loop while playing: the clock advances by real time times the speed. */
  $effect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      seek(positionMs + (now - last) * speed);
      last = now;
      if (positionMs >= lengthMs) {
        playing = false;
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  });

  const actionLabel = (type: 'reveal' | 'flag') =>
    type === 'reveal' ? m.minesweeper_replay_action_reveal() : m.minesweeper_replay_action_flag();
</script>

<Modal
  open={true}
  title={data
    ? m.minesweeper_replay_title({ name: data.displayName })
    : m.minesweeper_replay_open()}
  {onClose}
  phoneFullScreen={true}
  maxWidth="max-w-none sm:max-w-3xl"
  panelClass="sm:h-[min(94dvh,56rem)]!"
>
  {#if phase === 'loading'}
    <p class="text-text-muted p-4 text-sm" role="status">{m.minesweeper_replay_loading()}</p>
  {:else if phase === 'missing'}
    <p class="text-text-muted p-4 text-sm" role="status">{m.minesweeper_replay_missing()}</p>
  {:else if phase === 'failed' || !data}
    <p class="text-red-err p-4 text-sm font-semibold" role="alert">
      {m.minesweeper_replay_failed()}
    </p>
  {:else}
    <p class="text-text-muted shrink-0 px-4 py-2 text-xs" data-testid="replay-summary">
      {m.minesweeper_replay_summary({
        time: formatDurationMs(data.durationMs),
        generator: String(data.generatorVersion),
        moves: String(data.moves.length),
      })}
    </p>

    <!-- The stage takes every pixel the controls leave; the grid is fitted to it, never scrolled. -->
    <div
      bind:this={stage}
      class="bg-cn-bg flex min-h-0 flex-1 items-center justify-center overflow-auto p-2"
    >
      <div
        role="presentation"
        class="grid w-max gap-px"
        style="--ms-cell: {cellPx}px; grid-template-columns: repeat({data.config
          .width}, var(--ms-cell));"
        data-testid="replay-board"
      >
        {#each views.views as cell, i (i)}
          <MinesweeperCell {cell} index={i} pending={false} marked={markedCell === i} />
        {/each}
      </div>
    </div>

    <div
      class="border-cn-border shrink-0 space-y-3 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div class="flex items-center gap-3">
        <Button
          icon
          variant="primary"
          aria-label={playing ? m.minesweeper_replay_pause() : m.minesweeper_replay_play()}
          title={playing ? m.minesweeper_replay_pause() : m.minesweeper_replay_play()}
          onclick={togglePlay}
        >
          {#if playing}
            <Pause size={18} strokeWidth={2.25} />
          {:else}
            <Play size={18} strokeWidth={2.25} />
          {/if}
        </Button>
        <Button
          icon
          variant="ghost"
          aria-label={m.minesweeper_replay_restart()}
          title={m.minesweeper_replay_restart()}
          onclick={restart}
        >
          <RotateCcw size={18} strokeWidth={2.25} />
        </Button>
        <span class="text-text-main ml-auto shrink-0 font-mono text-sm" data-testid="replay-clock">
          {formatDurationMs(positionMs)}
        </span>
      </div>

      <input
        type="range"
        class="accent-accent h-6 w-full"
        min="0"
        max={lengthMs}
        step="1"
        value={positionMs}
        aria-label={m.minesweeper_replay_position()}
        oninput={(e) => seek(Number(e.currentTarget.value))}
      />

      <div class="flex items-center justify-between gap-3">
        <span class="min-w-0 text-xs">
          <span class="text-text-main block font-semibold" data-testid="replay-count">
            {m.minesweeper_replay_move({ n: String(shown), total: String(data.moves.length) })}
          </span>
          <span class="text-text-muted block truncate" data-testid="replay-last" aria-live="off">
            {#if lastMove}
              {m.minesweeper_replay_last({
                action: actionLabel(lastMove.type),
                cell: `${lastMove.x + 1},${lastMove.y + 1}`,
                time: formatDurationMs(lastMove.t),
              })}
            {/if}
          </span>
        </span>
        <span
          class="flex shrink-0 items-center gap-1"
          role="group"
          aria-label={m.minesweeper_replay_speed()}
        >
          {#each SPEEDS as s (s)}
            <Button
              size="compact"
              variant={speed === s ? 'secondary' : 'ghost'}
              aria-pressed={speed === s}
              onclick={() => (speed = s)}
            >
              {s}x
            </Button>
          {/each}
        </span>
      </div>
    </div>
  {/if}
</Modal>
