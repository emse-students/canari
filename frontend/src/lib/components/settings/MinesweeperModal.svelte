<script lang="ts">
  import { tick } from 'svelte';
  import { fade, scale as scaleTransition } from 'svelte/transition';
  import { backOut } from 'svelte/easing';
  import Modal from '$lib/components/shared/Modal.svelte';
  import {
    createBoard,
    revealCell,
    toggleFlag,
    remainingMines,
    DEFAULT_CONFIG,
    type MinesweeperBoard,
    type MinesweeperMove,
  } from '$lib/minesweeper/game';
  import {
    startMinesweeperChallenge,
    submitMinesweeperChallenge,
    fetchMinesweeperLeaderboard,
    formatDurationMs,
    type LeaderboardEntry,
  } from '$lib/minesweeper/api';
  import { Bomb, Flag, Maximize2, RotateCcw, Timer, Trophy, ZoomIn, ZoomOut } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible; becoming true starts a fresh game. */
    open?: boolean;
    /** Called when the modal should be dismissed. */
    onClose: () => void;
  }

  let { open = false, onClose }: Props = $props();

  /** How long a touch must be held before it flags a cell instead of digging it. */
  const LONG_PRESS_MS = 450;
  /** Touch movement (px) past which a pending tap/long-press is treated as a pan gesture instead. */
  const PAN_THRESHOLD_PX = 10;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3;

  /** Tailwind text-color classes for revealed adjacent-mine counts 1-8. */
  const NUMBER_COLORS: Record<number, string> = {
    1: 'text-blue-600',
    2: 'text-green-600',
    3: 'text-red-600',
    4: 'text-purple-700',
    5: 'text-orange-700',
    6: 'text-cyan-700',
    7: 'text-text-main',
    8: 'text-text-muted',
  };

  let board = $state<MinesweeperBoard>(createBoard(DEFAULT_CONFIG));
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressed = false;

  const FLAG_PRIMARY_STORAGE_KEY = 'canari.minesweeper.flagPrimary';
  /** Control-inversion setting: when true, short press/left click flags (dig on revealed cells) and long press/right click digs. */
  let flagPrimary = $state(loadFlagPrimary());

  function loadFlagPrimary(): boolean {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(FLAG_PRIMARY_STORAGE_KEY) === '1';
  }

  function toggleFlagPrimary() {
    flagPrimary = !flagPrimary;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(FLAG_PRIMARY_STORAGE_KEY, flagPrimary ? '1' : '0');
    }
  }

  /** Recorded player actions for the current game; replayed server-side for ranked anti-cheat. */
  let moves = $state<MinesweeperMove[]>([]);
  /** Set once `startMinesweeperChallenge` succeeds; null means casual (unranked) play. */
  let challengeId = $state<string | null>(null);
  let rankedMode = $state(false);
  /** ~10x/s while playing, frozen on win/loss. */
  let elapsedMs = $state(0);
  let startTimeMs = 0;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  /** Measured RTT of POST /challenges; sent on submit to size network credit. */
  let challengeRoundTripMs = $state<number | undefined>(undefined);
  /** True while the first-dig challenge request is in flight, to guard against double-taps. */
  let firstClickBusy = $state(false);

  let leaderboard = $state<LeaderboardEntry[]>([]);
  let leaderboardLoading = $state(false);
  let submitMessage = $state<string | null>(null);
  let submitError = $state(false);
  let personalBestMs = $state<number | null>(null);

  // --- Pan / zoom state for the game viewport -----------------------------
  let viewportEl: HTMLDivElement | null = null;
  let layerEl: HTMLDivElement | null = null;
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);

  /** True once a drag/pinch gesture has moved the view, so the trailing click/tap is swallowed. */
  let justPanned = false;

  let isPanning = false;
  let panPointerId: number | null = null;
  let panOrigin = { x: 0, y: 0, panX: 0, panY: 0 };

  let isPinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartPanX = 0;
  let pinchStartPanY = 0;
  let pinchStartMid = { x: 0, y: 0 };

  /** Pointers currently down on the viewport, keyed by pointerId (for pinch tracking). */
  const activePointers = new Map<number, { x: number; y: number }>();

  /** Single touch pointer that may turn into a pan if it moves past the threshold. */
  let touchDragPointerId: number | null = null;
  let touchDragOrigin = { x: 0, y: 0, panX: 0, panY: 0 };

  const statusMessage = $derived.by(() => {
    if (board.status === 'won') return m.minesweeper_status_won();
    if (board.status === 'lost') return m.minesweeper_status_lost();
    return m.minesweeper_status_playing();
  });

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function stopTimer() {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
  }

  function startTimer() {
    stopTimer();
    startTimeMs = performance.now();
    elapsedMs = 0;
    timerHandle = setInterval(() => {
      elapsedMs = performance.now() - startTimeMs;
    }, 100);
  }

  async function loadLeaderboard() {
    leaderboardLoading = true;
    try {
      leaderboard = await fetchMinesweeperLeaderboard(10);
    } catch (err) {
      console.debug('[minesweeper] leaderboard load failed', err);
      leaderboard = [];
    } finally {
      leaderboardLoading = false;
    }
  }

  /**
   * Fits the board to the viewport (scaling down if it would otherwise overflow, never
   * scaling up past 1x) and centers it. Reads the transform layer's natural
   * (untransformed) size, so it must run after the DOM has settled following a board change.
   */
  function centerView() {
    if (!viewportEl || !layerEl) return;
    const vw = viewportEl.clientWidth;
    const vh = viewportEl.clientHeight;
    const boardW = layerEl.offsetWidth;
    const boardH = layerEl.offsetHeight;
    const fitScale = boardW > 0 && boardH > 0 ? Math.min(1, vw / boardW, vh / boardH) : 1;
    scale = clamp(fitScale, MIN_SCALE, MAX_SCALE);
    panX = (vw - boardW * scale) / 2;
    panY = (vh - boardH * scale) / 2;
  }

  /**
   * Resets to a fresh, blank board. Mines aren't placed and no server challenge is
   * requested yet - both happen lazily on the first dig, via `digWithSeedIfNeeded`.
   */
  function startGame() {
    stopTimer();
    moves = [];
    submitMessage = null;
    submitError = false;
    personalBestMs = null;
    challengeId = null;
    rankedMode = false;
    challengeRoundTripMs = undefined;
    firstClickBusy = false;
    elapsedMs = 0;
    board = createBoard(DEFAULT_CONFIG, null);
  }

  /** Waits for the DOM to settle after a board change, then fits/centers the viewport. */
  async function afterBoardChange() {
    await tick();
    centerView();
  }

  function newGame() {
    startGame();
    void afterBoardChange();
  }

  /**
   * Ensures a real board exists before the very first reveal: tries a ranked seeded
   * challenge, falling back to a casual unseeded board on failure, then performs the
   * dig and starts the local timer. Once mines are placed, this just digs directly.
   * Preserves the current pan/zoom (player may have framed a corner before the first dig).
   */
  async function digWithSeedIfNeeded(x: number, y: number) {
    if (board.minesPlaced) {
      dig(x, y);
      return;
    }
    if (firstClickBusy) return;
    firstClickBusy = true;
    try {
      console.debug('[minesweeper] first dig, attempting ranked challenge start');
      try {
        const t0 = performance.now();
        const challenge = await startMinesweeperChallenge();
        challengeRoundTripMs = Math.round(performance.now() - t0);
        board = createBoard(DEFAULT_CONFIG, challenge.seed);
        challengeId = challenge.challengeId;
        rankedMode = true;
        console.debug('[minesweeper] ranked challenge started', {
          challengeId: challenge.challengeId,
          challengeRoundTripMs,
        });
      } catch (err) {
        console.debug('[minesweeper] ranked start failed, falling back to casual', err);
        board = createBoard(DEFAULT_CONFIG, null);
        challengeId = null;
        rankedMode = false;
        challengeRoundTripMs = undefined;
      }
      dig(x, y);
      startTimer();
      // Board size is unchanged — keep the player's framed pan/zoom.
      await tick();
    } finally {
      firstClickBusy = false;
    }
  }

  async function submitRankedResult() {
    if (!challengeId) return;
    // Nest `IsInt` rejects floats; performance.now()-based elapsed must be rounded.
    const claimedDurationMs = Math.round(elapsedMs);
    console.debug('[minesweeper] submitting ranked result', {
      challengeId,
      moveCount: moves.length,
      claimedDurationMs,
      challengeRoundTripMs,
    });
    try {
      const result = await submitMinesweeperChallenge(
        challengeId,
        moves,
        claimedDurationMs,
        challengeRoundTripMs
      );
      personalBestMs = result.personalBestMs;
      submitError = false;
      submitMessage = m.minesweeper_submit_ok({ time: formatDurationMs(result.durationMs) });
      console.debug('[minesweeper] submit accepted', result);
      await loadLeaderboard();
    } catch (err) {
      console.debug('[minesweeper] submit failed', err);
      submitError = true;
      submitMessage = m.minesweeper_submit_fail();
    }
  }

  /** Stops the timer on win/loss and fires the ranked submission exactly once. */
  function handlePostMove() {
    if (board.status === 'playing') return;
    stopTimer();
    if (board.status === 'won' && rankedMode && challengeId) {
      void submitRankedResult();
    }
  }

  $effect(() => {
    if (!open) return;
    startGame();
    void afterBoardChange();
    void loadLeaderboard();
    return () => {
      stopTimer();
    };
  });

  /**
   * Forces reactivity after the game helpers mutate `board` in place: the cell
   * array is shallow-copied so Svelte's `$state` proxy detects the change.
   */
  function sync() {
    board = { ...board, cells: board.cells.map((cell) => ({ ...cell })) };
  }

  function clearLongPressTimer() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function dig(x: number, y: number) {
    if (board.status !== 'playing') return;
    const cell = board.cells[y * board.width + x];
    // Ghost taps after a long-press flag must not log a no-op reveal (breaks server replay).
    if (cell.state === 'flagged') return;
    moves.push({ type: 'reveal', x, y });
    revealCell(board, x, y);
    sync();
    handlePostMove();
  }

  function flag(x: number, y: number) {
    if (board.status !== 'playing') return;
    const cell = board.cells[y * board.width + x];
    if (cell.state === 'revealed') return;
    moves.push({ type: 'flag', x, y });
    toggleFlag(board, x, y);
    sync();
    handlePostMove();
  }

  /**
   * Short press / left click: before mines are placed, the very first click always digs
   * (safe-first-click + seeding happens in `digWithSeedIfNeeded`). Afterward, flags hidden
   * cells when inverted, otherwise always digs (revealed cells still chord).
   */
  function primaryAction(x: number, y: number) {
    if (!board.minesPlaced) {
      void digWithSeedIfNeeded(x, y);
      return;
    }
    if (flagPrimary) {
      const cell = board.cells[y * board.width + x];
      if (cell.state === 'revealed') void digWithSeedIfNeeded(x, y);
      else flag(x, y);
    } else {
      void digWithSeedIfNeeded(x, y);
    }
  }

  /**
   * Long press / right click: before mines are placed, always digs (same reasoning as
   * `primaryAction`). Afterward, digs when inverted, otherwise flags.
   */
  function secondaryAction(x: number, y: number) {
    if (!board.minesPlaced) {
      void digWithSeedIfNeeded(x, y);
      return;
    }
    if (flagPrimary) void digWithSeedIfNeeded(x, y);
    else flag(x, y);
  }

  function handleCellClick(x: number, y: number) {
    if (justPanned) {
      // The gesture that just ended panned the view; swallow the trailing click.
      justPanned = false;
      return;
    }
    if (longPressed) {
      // The long-press timer already ran secondary action; swallow the trailing click/pointerup.
      longPressed = false;
      return;
    }
    primaryAction(x, y);
  }

  function handleContextMenu(e: MouseEvent, x: number, y: number) {
    e.preventDefault();
    // Touch long-press already ran secondaryAction; ignore the synthetic contextmenu.
    if (longPressed) {
      longPressed = false;
      return;
    }
    const pointerType = 'pointerType' in e ? (e as PointerEvent).pointerType : '';
    if (pointerType === 'touch') return;
    clearLongPressTimer();
    secondaryAction(x, y);
  }

  function handlePointerDown(e: PointerEvent, x: number, y: number) {
    if (e.pointerType !== 'touch') return;
    longPressed = false;
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      longPressed = true;
      secondaryAction(x, y);
    }, LONG_PRESS_MS);
  }

  function handlePointerRelease() {
    clearLongPressTimer();
  }

  // --- Viewport pan / zoom --------------------------------------------------

  /** Rescales around a point (relative to the viewport's top-left) so that point stays fixed on screen. */
  function zoomAt(sx: number, sy: number, newScale: number) {
    const clamped = clamp(newScale, MIN_SCALE, MAX_SCALE);
    const contentX = (sx - panX) / scale;
    const contentY = (sy - panY) / scale;
    panX = sx - contentX * clamped;
    panY = sy - contentY * clamped;
    scale = clamped;
  }

  function zoomBy(factor: number) {
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, scale * factor);
  }

  function zoomIn() {
    zoomBy(1.25);
  }

  function zoomOut() {
    zoomBy(1 / 1.25);
  }

  function handleResetView() {
    centerView();
  }

  function handleWheel(e: WheelEvent) {
    if (!viewportEl) return;
    e.preventDefault();
    const rect = viewportEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(sx, sy, scale * factor);
  }

  function beginPan(e: PointerEvent) {
    isPanning = true;
    isPinching = false;
    panPointerId = e.pointerId;
    panOrigin = { x: e.clientX, y: e.clientY, panX, panY };
    justPanned = true;
    viewportEl?.setPointerCapture(e.pointerId);
  }

  function beginPinch() {
    if (!viewportEl) return;
    const pts = [...activePointers.values()].slice(0, 2);
    if (pts.length < 2) return;
    isPanning = false;
    panPointerId = null;
    isPinching = true;
    justPanned = true;
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchStartScale = scale;
    pinchStartPanX = panX;
    pinchStartPanY = panY;
    const rect = viewportEl.getBoundingClientRect();
    pinchStartMid = {
      x: (pts[0].x + pts[1].x) / 2 - rect.left,
      y: (pts[0].y + pts[1].y) / 2 - rect.top,
    };
  }

  function endPan() {
    isPanning = false;
    panPointerId = null;
    // Defer clearing justPanned so a trailing click on the same tick is still swallowed.
    setTimeout(() => {
      justPanned = false;
    }, 0);
  }

  function handleViewportPointerDown(e: PointerEvent) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      clearLongPressTimer();
      beginPinch();
      return;
    }

    const isMiddleButton = e.button === 1;
    const isAltDrag = e.button === 0 && e.altKey;
    if (isMiddleButton || isAltDrag) {
      e.preventDefault();
      beginPan(e);
      return;
    }

    if (e.pointerType === 'touch') {
      touchDragPointerId = e.pointerId;
      touchDragOrigin = { x: e.clientX, y: e.clientY, panX, panY };
    }
  }

  function handleViewportPointerMove(e: PointerEvent) {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (isPinching && activePointers.size >= 2 && viewportEl) {
      const pts = [...activePointers.values()].slice(0, 2);
      if (pinchStartDist === 0) return;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const rect = viewportEl.getBoundingClientRect();
      const mid = {
        x: (pts[0].x + pts[1].x) / 2 - rect.left,
        y: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
      const newScale = clamp((pinchStartScale * dist) / pinchStartDist, MIN_SCALE, MAX_SCALE);
      const contentX = (pinchStartMid.x - pinchStartPanX) / pinchStartScale;
      const contentY = (pinchStartMid.y - pinchStartPanY) / pinchStartScale;
      scale = newScale;
      panX = mid.x - contentX * newScale;
      panY = mid.y - contentY * newScale;
      return;
    }

    if (isPanning && e.pointerId === panPointerId) {
      panX = panOrigin.panX + (e.clientX - panOrigin.x);
      panY = panOrigin.panY + (e.clientY - panOrigin.y);
      return;
    }

    if (touchDragPointerId === e.pointerId) {
      const dx = e.clientX - touchDragOrigin.x;
      const dy = e.clientY - touchDragOrigin.y;
      if (Math.hypot(dx, dy) > PAN_THRESHOLD_PX) {
        clearLongPressTimer();
        longPressed = false;
        touchDragPointerId = null;
        isPanning = true;
        isPinching = false;
        justPanned = true;
        panPointerId = e.pointerId;
        panOrigin = { ...touchDragOrigin };
        viewportEl?.setPointerCapture(e.pointerId);
        panX = panOrigin.panX + dx;
        panY = panOrigin.panY + dy;
      }
    }
  }

  function handleViewportPointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (e.pointerId === touchDragPointerId) {
      touchDragPointerId = null;
    }
    if (e.pointerId === panPointerId) {
      endPan();
    }
    if (isPinching && activePointers.size < 2) {
      isPinching = false;
    }
  }
</script>

<Modal
  {open}
  title={m.minesweeper_title()}
  {onClose}
  fullViewport={true}
  maxWidth="max-w-none sm:max-w-[min(96vw,90rem)]"
  bodyClass="overflow-hidden flex flex-col min-h-0 !px-3 !py-3 sm:!px-4 sm:!py-4"
>
  <!-- HUD: mines left + timer must stay visible at all times, so this row never scrolls away. -->
  <div class="shrink-0">
    <div class="flex items-center justify-between gap-2 mb-1">
      <div class="flex items-center gap-3 text-base font-bold text-text-main sm:text-lg">
        <span class="flex items-center gap-1.5">
          <Bomb size={18} class="text-cn-dark" />
          {m.minesweeper_mines_left({ count: remainingMines(board) })}
        </span>
        <span class="flex items-center gap-1 font-mono text-sm text-text-muted">
          <Timer size={16} />
          {m.minesweeper_time({ time: formatDurationMs(elapsedMs) })}
        </span>
      </div>
      <button
        type="button"
        onclick={newGame}
        class="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold bg-cn-yellow/10 text-cn-dark hover:bg-cn-yellow/20 transition-colors"
      >
        <RotateCcw size={14} strokeWidth={2.5} />
        {m.minesweeper_new_game()}
      </button>
    </div>

    <div class="flex items-center justify-between gap-2 mb-1.5">
      <p class="text-xs font-semibold text-text-muted truncate">{statusMessage}</p>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onclick={toggleFlagPrimary}
          aria-pressed={flagPrimary}
          title={m.minesweeper_flag_primary_hint()}
          class="flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide transition-colors {flagPrimary
            ? 'bg-cn-yellow/20 text-cn-dark'
            : 'text-text-muted hover:bg-cn-bg'}"
        >
          <Flag size={11} />
          {m.minesweeper_flag_primary()}
        </button>
        <span
          class="text-[0.65rem] font-bold uppercase tracking-wide {rankedMode
            ? 'text-cn-yellow'
            : 'text-text-muted'}"
        >
          {rankedMode ? m.minesweeper_ranked() : m.minesweeper_casual()}
        </span>
      </div>
    </div>
  </div>

  <div
    bind:this={viewportEl}
    role="presentation"
    class="flex-1 min-h-0 relative overflow-hidden rounded-xl border border-cn-border bg-cn-bg/40"
    style="touch-action: none;"
    onwheel={handleWheel}
    onpointerdown={handleViewportPointerDown}
    onpointermove={handleViewportPointerMove}
    onpointerup={handleViewportPointerUp}
    onpointercancel={handleViewportPointerUp}
  >
    <div
      bind:this={layerEl}
      class="absolute left-0 top-0 w-fit"
      style="transform: translate({panX}px, {panY}px) scale({scale}); transform-origin: 0 0;"
    >
      <div
        class="grid gap-px w-max [--ms-cell:1.75rem] sm:[--ms-cell:2rem]"
        style="grid-template-columns: repeat({board.width}, var(--ms-cell));"
      >
        {#each board.cells as cell, i (i)}
          {@const x = i % board.width}
          {@const y = Math.floor(i / board.width)}
          <button
            type="button"
            disabled={board.status !== 'playing' || firstClickBusy}
            onclick={() => handleCellClick(x, y)}
            oncontextmenu={(e) => handleContextMenu(e, x, y)}
            onpointerdown={(e) => handlePointerDown(e, x, y)}
            onpointerup={handlePointerRelease}
            onpointerleave={handlePointerRelease}
            onpointercancel={handlePointerRelease}
            class="h-[length:var(--ms-cell)] w-[length:var(--ms-cell)] shrink-0 box-border flex items-center justify-center select-none touch-manipulation rounded-sm border font-mono font-bold text-xs sm:text-sm
              {cell.state === 'hidden'
              ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 border-cn-border'
              : cell.state === 'flagged'
                ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 border-cn-border'
                : cell.mine
                  ? 'bg-red-500/80 border-transparent'
                  : cell.adjacent === 0
                    ? 'bg-cn-bg/60 border-transparent'
                    : 'bg-cn-bg/80 border-transparent'}
              {cell.state === 'revealed' && !cell.mine && cell.adjacent > 0
              ? NUMBER_COLORS[cell.adjacent]
              : ''}"
          >
            {#if cell.state === 'flagged'}
              <Flag size={14} class="text-cn-dark" />
            {:else if cell.state === 'revealed' && cell.mine}
              <Bomb size={14} class="text-white" />
            {:else if cell.state === 'revealed' && cell.adjacent > 0}
              {cell.adjacent}
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <div class="absolute bottom-2 right-2 flex flex-col gap-1">
      <button
        type="button"
        onclick={zoomIn}
        aria-label={m.minesweeper_zoom_in()}
        class="flex items-center justify-center size-8 rounded-lg bg-cn-surface/90 border border-cn-border shadow-sm text-text-main hover:bg-cn-bg transition-colors"
      >
        <ZoomIn size={15} />
      </button>
      <button
        type="button"
        onclick={zoomOut}
        aria-label={m.minesweeper_zoom_out()}
        class="flex items-center justify-center size-8 rounded-lg bg-cn-surface/90 border border-cn-border shadow-sm text-text-main hover:bg-cn-bg transition-colors"
      >
        <ZoomOut size={15} />
      </button>
      <button
        type="button"
        onclick={handleResetView}
        aria-label={m.minesweeper_zoom_reset()}
        class="flex items-center justify-center size-8 rounded-lg bg-cn-surface/90 border border-cn-border shadow-sm text-text-main hover:bg-cn-bg transition-colors"
      >
        <Maximize2 size={15} />
      </button>
    </div>

    {#if board.status !== 'playing'}
      {@const isWin = board.status === 'won'}
      <!-- Game-over overlay: sits above the zoom controls, scoped to the viewport only so
           the Modal header/close button above it stays reachable at all times. -->
      <div
        class="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
        transition:fade={{ duration: 200 }}
      >
        <div
          class="pointer-events-auto flex flex-col items-center gap-2 rounded-2xl border px-6 py-6 text-center shadow-2xl bg-cn-surface/95 {isWin
            ? 'border-cn-yellow/50 shadow-[0_0_40px_-12px_rgba(246,194,50,0.45)]'
            : 'border-red-500/40 shadow-[0_0_40px_-12px_rgba(239,68,68,0.35)]'}"
          transition:scaleTransition={{ duration: 280, start: 0.9, easing: backOut }}
        >
          {#if isWin}
            <Trophy size={28} class="text-cn-yellow" />
          {:else}
            <Bomb size={28} class="text-red-500" />
          {/if}
          <p
            class="text-2xl font-extrabold sm:text-3xl {isWin
              ? 'ms-win-pulse text-cn-yellow'
              : 'text-red-500'}"
          >
            {isWin ? m.minesweeper_status_won() : m.minesweeper_status_lost()}
          </p>
          {#if isWin}
            <p class="flex items-center gap-1.5 font-mono text-sm font-semibold text-text-muted">
              <Timer size={14} />
              {m.minesweeper_time({ time: formatDurationMs(elapsedMs) })}
            </p>
          {/if}
          <button
            type="button"
            onclick={newGame}
            class="mt-1 flex items-center gap-1.5 rounded-lg bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark transition-colors hover:bg-cn-yellow-hover"
          >
            <RotateCcw size={15} strokeWidth={2.5} />
            {m.minesweeper_new_game()}
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!--
    Compact bottom strip: control/zoom hints on one line + a scrollable leaderboard capped
    to a small share of the modal height, so it never eats into the game viewport above.
  -->
  <div class="shrink-0 max-h-[22%] overflow-y-auto mt-2 border-t border-cn-border pt-1.5">
    <p class="truncate text-center text-[11px] text-text-muted">
      <span class="hidden sm:inline">
        {flagPrimary ? m.minesweeper_hint_desktop_flag_primary() : m.minesweeper_hint_desktop()}
      </span>
      <span class="sm:hidden">
        {flagPrimary ? m.minesweeper_hint_touch_flag_primary() : m.minesweeper_hint_touch()}
      </span>
      &middot; {m.minesweeper_hint_zoom()}
    </p>

    <div class="mt-1.5">
      {#if submitMessage}
        <p class="mb-1 text-xs font-semibold {submitError ? 'text-red-600' : 'text-green-600'}">
          {submitMessage}
        </p>
      {/if}
      {#if personalBestMs !== null}
        <p class="mb-1 text-xs text-text-muted">
          {m.minesweeper_personal_best({ time: formatDurationMs(personalBestMs) })}
        </p>
      {/if}

      <div class="mb-1 flex items-center gap-1.5 text-xs font-bold text-text-main">
        <Trophy size={13} class="text-cn-yellow" />
        {m.minesweeper_leaderboard()}
      </div>

      {#if leaderboardLoading}
        <p class="text-xs text-text-muted">…</p>
      {:else if leaderboard.length === 0}
        <p class="text-xs text-text-muted">{m.minesweeper_empty_leaderboard()}</p>
      {:else}
        <ol class="space-y-0.5 text-xs">
          {#each leaderboard as entry (entry.userId)}
            <li class="flex items-center justify-between gap-2 rounded-lg bg-cn-bg/60 px-2 py-1">
              <span class="flex items-center gap-1.5 truncate">
                <span class="w-5 shrink-0 font-mono font-bold text-text-muted">#{entry.rank}</span>
                <span class="truncate">{entry.displayName}</span>
              </span>
              <span class="shrink-0 font-mono font-semibold text-cn-dark">
                {formatDurationMs(entry.durationMs)}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* One-shot glow pulse on the win title; kept CSS-only since it's cheaper than a JS-driven effect. */
  @keyframes ms-win-pulse {
    0%,
    100% {
      text-shadow: 0 0 0 rgba(246, 194, 50, 0);
    }
    50% {
      text-shadow: 0 0 18px rgba(246, 194, 50, 0.85);
    }
  }

  .ms-win-pulse {
    animation: ms-win-pulse 900ms ease-out 150ms 1;
  }
</style>
