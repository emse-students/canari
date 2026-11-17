<script lang="ts">
  import { onMount } from 'svelte';
  import { Pause, Play, RotateCcw } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MinesweeperCell from '$lib/components/settings/MinesweeperCell.svelte';
  import { fetchMinesweeperReplay, formatDurationMs } from '$lib/minesweeper/api';
  import type { MinesweeperReplayData } from '$lib/minesweeper/api';
  import { EMPTY_CELL_VIEWS, syncCellViews } from '$lib/minesweeper/cellViews';
  import { createReplay, type Replay } from '$lib/minesweeper/replay';
  import { m } from '$lib/paraglide/messages';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';

  /**
   * A MODERATOR'S REPLAY of one won ranked game (owner, 2026-11-17): the board is regenerated from the
   * stored seed and the timed moves are played back at their own pace - or faster - so a global admin
   * can judge whether the game was played by a hand. Opened from the Games page, global admins only;
   * the 403 behind the route is the real gate. docs/wiki/frontend/modules/minesweeper.md, "The replay".
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

  const lastMove = $derived(data && shown > 0 ? data.moves[shown - 1] : null);
  /** Where the game ends: its last move. */
  const lengthMs = $derived(data ? (data.moves[data.moves.length - 1]?.t ?? 0) : 0);
  const markedCell = $derived(
    lastMove && data ? lastMove.y * data.config.width + lastMove.x : null
  );
  const atEnd = $derived(positionMs >= lengthMs);

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
    : m.minesweeper_admin_replay()}
  {onClose}
  maxWidth="max-w-xl"
>
  {#if phase === 'loading'}
    <p class="text-text-muted text-sm" role="status">{m.minesweeper_replay_loading()}</p>
  {:else if phase === 'missing'}
    <p class="text-text-muted text-sm" role="status">{m.minesweeper_replay_missing()}</p>
  {:else if phase === 'failed' || !data}
    <p class="text-red-err text-sm font-semibold" role="alert">{m.minesweeper_replay_failed()}</p>
  {:else}
    <div class="space-y-3">
      <p class="text-text-muted text-xs" data-testid="replay-summary">
        {m.minesweeper_replay_summary({
          time: formatDurationMs(data.durationMs),
          generator: String(data.generatorVersion),
          moves: String(data.moves.length),
        })}
      </p>

      <div class="bg-cn-bg flex max-h-[58dvh] justify-center overflow-auto rounded-lg p-2">
        <div
          role="presentation"
          class="grid w-max gap-px"
          style="--ms-cell: min(1.25rem, calc((100vw - 3.5rem) / {data.config.width +
            0.5})); grid-template-columns: repeat({data.config.width}, var(--ms-cell));"
          data-testid="replay-board"
        >
          {#each views.views as cell, i (i)}
            <MinesweeperCell {cell} index={i} pending={false} marked={markedCell === i} />
          {/each}
        </div>
      </div>

      <p class="text-text-muted min-h-4 text-xs" data-testid="replay-last" aria-live="off">
        {#if lastMove}
          {m.minesweeper_replay_last({
            action: actionLabel(lastMove.type),
            cell: `${lastMove.x + 1},${lastMove.y + 1}`,
            time: formatDurationMs(lastMove.t),
          })}
        {/if}
      </p>

      <div class="flex items-center gap-2">
        <Button
          icon
          size="compact"
          variant="secondary"
          aria-label={playing ? m.minesweeper_replay_pause() : m.minesweeper_replay_play()}
          title={playing ? m.minesweeper_replay_pause() : m.minesweeper_replay_play()}
          onclick={togglePlay}
        >
          {#if playing}
            <Pause size={14} strokeWidth={2.25} />
          {:else}
            <Play size={14} strokeWidth={2.25} />
          {/if}
        </Button>
        <Button
          icon
          size="compact"
          variant="ghost"
          aria-label={m.minesweeper_replay_restart()}
          title={m.minesweeper_replay_restart()}
          onclick={restart}
        >
          <RotateCcw size={14} strokeWidth={2.25} />
        </Button>
        <input
          type="range"
          class="accent-accent min-w-0 flex-1"
          min="0"
          max={lengthMs}
          step="1"
          value={positionMs}
          aria-label={m.minesweeper_replay_position()}
          oninput={(e) => seek(Number(e.currentTarget.value))}
        />
        <span class="text-text-main shrink-0 font-mono text-xs" data-testid="replay-clock">
          {formatDurationMs(positionMs)}
        </span>
      </div>

      <div class="flex items-center justify-between gap-2">
        <span class="text-text-muted text-xs" data-testid="replay-count">
          {m.minesweeper_replay_move({ n: String(shown), total: String(data.moves.length) })}
        </span>
        <span
          class="flex items-center gap-1"
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
