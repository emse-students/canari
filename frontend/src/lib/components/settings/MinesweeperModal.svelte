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
    fetchMinesweeperBans,
    banMinesweeperUser,
    removeMinesweeperScore,
    unbanMinesweeperUser,
    formatDurationMs,
    MinesweeperBannedError,
    type LeaderboardEntry,
    type MinesweeperBan,
  } from '$lib/minesweeper/api';
  import {
    HAPTIC_FLAG,
    HAPTIC_LONG_PRESS,
    HAPTIC_LOSS,
    HAPTIC_WIN,
    haptic,
  } from '$lib/minesweeper/haptics';
  import {
    DOUBLE_TAP_SCALE,
    MAX_SCALE,
    clampView,
    fitView,
    glideStep,
    minScaleFor,
    releaseVelocity,
    zoomAt,
    type Insets,
    type Sample,
    type View,
  } from '$lib/minesweeper/view';
  import {
    ArrowLeft,
    Ban,
    Bomb,
    Flag,
    Pickaxe,
    RotateCcw,
    Timer,
    Trash2,
    Trophy,
    Undo2,
    X,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { globalAdminState } from '$lib/stores/userState.svelte';

  interface Props {
    /** Whether the modal is visible; becoming true starts a fresh game. */
    open?: boolean;
    /** Called when the modal should be dismissed. */
    onClose: () => void;
  }

  let { open = false, onClose }: Props = $props();

  /** The leaderboard is a sheet over the board, opened from the floating button; the game keeps running under it. */
  let showLeaderboard = $state(false);

  /** How long a touch must be held before it flags a cell instead of digging it. */
  const LONG_PRESS_MS = 350;
  /** Pointer movement (px) past which a pending tap/long-press is treated as a pan gesture instead. */
  const PAN_THRESHOLD_PX = 10;
  /** How far (px) a board larger than the screen may be dragged past its edge. */
  const PAN_MARGIN_PX = 48;
  /** Two taps on the same cell within this window zoom instead of acting twice. */
  const DOUBLE_TAP_MS = 280;
  /** Duration of the animated zoom a double-tap or a reset triggers. */
  const VIEW_TRANSITION_MS = 220;
  /** Room kept free around the board for the floating controls (top bar, mode button). */
  const FIT_INSETS: Insets = { top: 64, right: 8, bottom: 88, left: 8 };

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
  /** Where the long-press progress ring is drawn (viewport coordinates), null when none is pending. */
  let pressRing = $state<{ x: number; y: number } | null>(null);

  const FLAG_PRIMARY_STORAGE_KEY = 'canari.minesweeper.flagPrimary';
  const UNRANKED_STORAGE_KEY = 'canari.minesweeper.unranked';

  function loadFlag(key: string): boolean {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(key) === '1';
  }

  function saveFlag(key: string, value: boolean) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value ? '1' : '0');
  }

  /** Control-inversion setting: when true, short press/left click flags (dig on revealed cells) and long press/right click digs. */
  let flagPrimary = $state(loadFlag(FLAG_PRIMARY_STORAGE_KEY));
  /** Play-unranked setting: when true, the first dig asks the server for NO challenge, so nothing is submitted. */
  let unranked = $state(loadFlag(UNRANKED_STORAGE_KEY));

  function toggleFlagPrimary() {
    flagPrimary = !flagPrimary;
    saveFlag(FLAG_PRIMARY_STORAGE_KEY, flagPrimary);
  }

  /** Only offered before the first dig: a game's ranking is decided when its board is generated. */
  function toggleUnranked() {
    if (board.minesPlaced) return;
    unranked = !unranked;
    saveFlag(UNRANKED_STORAGE_KEY, unranked);
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
  /** Index of the cell whose first dig is being prepared (challenge fetch + generation), shown pressed meanwhile. */
  let pendingCell = $state<number | null>(null);

  let leaderboard = $state<LeaderboardEntry[]>([]);
  let leaderboardLoading = $state(false);
  let submitMessage = $state<string | null>(null);
  let submitError = $state(false);
  let personalBestMs = $state<number | null>(null);
  /** Ranked submit in flight after a win (rank line shows a pending state). */
  let submitPending = $state(false);
  /** Final standing from the last accepted submit (shown on the win overlay). */
  let winRank = $state<number | null>(null);
  let winRanksGained = $state(0);
  /** Server-scored duration when submit succeeds; falls back to local elapsed. */
  let winDurationMs = $state<number | null>(null);

  // --- Pan / zoom state for the game viewport -----------------------------
  let viewportEl = $state<HTMLDivElement | null>(null);
  let layerEl = $state<HTMLDivElement | null>(null);
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  /** Scale at which the whole board fits the screen; the floor of the zoom range on a small screen. */
  let fitScale = $state(1);
  /** False while the view is still the automatic fit, so a resize or rotation refits it; true once the player moved it. */
  let viewAdjusted = false;
  /** True for the short moment an animated zoom (double-tap, reset) is playing; every gesture cancels it. */
  let viewTransition = $state(false);
  let viewTransitionTimer: ReturnType<typeof setTimeout> | null = null;

  /** True once a drag/pinch gesture has moved the view, so the trailing click/tap is swallowed. */
  let justPanned = false;

  let isPanning = false;
  let panPointerId: number | null = null;
  let panOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
  /** Recent positions of the dragging pointer, for the speed a flick leaves with. */
  let panSamples: Sample[] = [];
  let glideFrame: number | null = null;

  let isPinching = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartPanX = 0;
  let pinchStartPanY = 0;
  let pinchStartMid = { x: 0, y: 0 };

  /** Pointers currently down on the viewport, keyed by pointerId (for pinch tracking). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- imperative gesture state, read only in pointer handlers, never in the template
  const activePointers = new Map<number, { x: number; y: number }>();

  /** Single pointer that may turn into a pan if it moves past the threshold. */
  let dragPointerId: number | null = null;
  let dragOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
  let lastPointerType = '';
  /** Cell and time of the last tap that dug, to recognise a double-tap. */
  let lastTap: { cell: number; at: number } | null = null;
  /** Cell under the pointer that is being held for a long press. */
  let pressedCell: number | null = null;

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
    if (isAdmin) await loadBans();
  }

  // ---- Moderation (global admins; the server refuses anyone else) ----
  /** The buttons are drawn for a global admin only - the 403 behind them is the real gate. */
  const isAdmin = $derived(globalAdminState());
  let bans = $state<MinesweeperBan[]>([]);
  /** An admin action failed - said on the tab, never swallowed. */
  let moderationFailed = $state(false);

  async function loadBans() {
    try {
      bans = await fetchMinesweeperBans();
    } catch (err) {
      console.warn('[minesweeper] could not load the bans', err);
      bans = [];
    }
  }

  /** Runs one admin action, then refreshes both lists; a failure is logged and shown. */
  async function moderate(action: () => Promise<void>) {
    moderationFailed = false;
    try {
      await action();
    } catch (err) {
      console.warn('[minesweeper] moderation action failed', err);
      moderationFailed = true;
    }
    await loadLeaderboard();
  }

  async function removeScore(entry: LeaderboardEntry) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_remove({
        name: entry.displayName,
        time: formatDurationMs(entry.durationMs),
      }),
      { danger: true, confirmLabel: m.minesweeper_admin_confirm_remove_label() }
    );
    if (confirmed) await moderate(() => removeMinesweeperScore(entry.scoreId));
  }

  async function banPlayer(entry: LeaderboardEntry) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_ban({ name: entry.displayName }),
      { danger: true, confirmLabel: m.minesweeper_admin_confirm_ban_label() }
    );
    if (confirmed) await moderate(() => banMinesweeperUser(entry.userId));
  }

  async function unbanPlayer(ban: MinesweeperBan) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_unban({ name: ban.displayName }),
      { confirmLabel: m.minesweeper_admin_unban() }
    );
    if (confirmed) await moderate(() => unbanMinesweeperUser(ban.userId));
  }

  /** Opens the scores over the board; refreshes them on entry (the game timer keeps running). */
  function openLeaderboard() {
    showLeaderboard = true;
    void loadLeaderboard();
  }

  // --- View: fit, bounds, animation ----------------------------------------

  /** Viewport and board sizes in CSS px; the board's is its natural (untransformed) size. */
  function geometry() {
    if (!viewportEl || !layerEl) return null;
    return {
      viewport: { width: viewportEl.clientWidth, height: viewportEl.clientHeight },
      board: { width: layerEl.offsetWidth, height: layerEl.offsetHeight },
    };
  }

  /** Puts a view on screen, kept inside the bounds so the board can never be lost off-screen. Returns what was applied. */
  function applyView(next: View): View {
    const g = geometry();
    const v = g ? clampView(next, g.viewport, g.board, PAN_MARGIN_PX) : next;
    scale = v.scale;
    panX = v.panX;
    panY = v.panY;
    viewAdjusted = true;
    return v;
  }

  /** Runs a view change as a short animation; the next gesture cancels it. */
  function animateView(change: () => void) {
    viewTransition = true;
    change();
    if (viewTransitionTimer) clearTimeout(viewTransitionTimer);
    viewTransitionTimer = setTimeout(() => {
      viewTransition = false;
      viewTransitionTimer = null;
    }, VIEW_TRANSITION_MS + 20);
  }

  function cancelViewTransition() {
    if (viewTransitionTimer) clearTimeout(viewTransitionTimer);
    viewTransitionTimer = null;
    viewTransition = false;
  }

  /**
   * Fits the whole board to the screen, as large as it goes, clear of the floating controls, and
   * centres it. Reads the transform layer's natural size, so it must run after the DOM has settled
   * following a board change.
   */
  function centerView() {
    const g = geometry();
    if (!g) return;
    const fit = fitView(g.viewport, g.board, FIT_INSETS);
    fitScale = fit.scale;
    scale = fit.scale;
    panX = fit.panX;
    panY = fit.panY;
    viewAdjusted = false;
  }

  /**
   * Resets to a fresh, blank board. Mines aren't placed and no server challenge is
   * requested yet - both happen lazily on the first dig, via `digWithSeedIfNeeded`.
   */
  function startGame() {
    stopTimer();
    stopGlide();
    clearLongPressTimer();
    moves = [];
    submitMessage = null;
    submitError = false;
    personalBestMs = null;
    submitPending = false;
    winRank = null;
    winRanksGained = 0;
    winDurationMs = null;
    challengeId = null;
    rankedMode = false;
    challengeRoundTripMs = undefined;
    firstClickBusy = false;
    pendingCell = null;
    lastTap = null;
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

  /** Resolves once the browser has painted the current state (two frames: one to schedule, one to paint). */
  function nextPaint(): Promise<void> {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  }

  /**
   * Ensures a real board exists before the very first reveal: tries a ranked seeded
   * challenge, falling back to a casual unseeded board on failure, then performs the
   * dig and starts the local timer. Once mines are placed, this just digs directly.
   * Preserves the current pan/zoom (player may have framed a corner before the first dig).
   */
  /** An unseeded, unranked board: no challenge, nothing to submit. */
  function startCasualBoard() {
    board = createBoard(DEFAULT_CONFIG, null);
    challengeId = null;
    rankedMode = false;
    challengeRoundTripMs = undefined;
  }

  async function digWithSeedIfNeeded(x: number, y: number) {
    if (board.minesPlaced) {
      dig(x, y);
      return;
    }
    if (firstClickBusy) return;
    firstClickBusy = true;
    pendingCell = y * board.width + x;
    try {
      console.debug('[minesweeper] first dig', { unranked });
      if (unranked) {
        // The player chose not to be ranked: no challenge is requested, so there is nothing to refuse.
        startCasualBoard();
      } else {
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
          // A banned player is TOLD, not dropped into an unranked game without a word.
          if (err instanceof MinesweeperBannedError) {
            submitError = true;
            submitMessage = m.minesweeper_banned();
          }
          startCasualBoard();
        }
      }
      // Generation is synchronous and blocks the main thread; paint the pressed cell first
      // so the tap is acknowledged even when the challenge answered within the same frame.
      await nextPaint();
      dig(x, y);
      startTimer();
      // Board size is unchanged — keep the player's framed pan/zoom.
      await tick();
    } finally {
      firstClickBusy = false;
      pendingCell = null;
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
    submitPending = true;
    winRank = null;
    winRanksGained = 0;
    try {
      const result = await submitMinesweeperChallenge(
        challengeId,
        moves,
        claimedDurationMs,
        challengeRoundTripMs
      );
      personalBestMs = result.personalBestMs;
      winDurationMs = result.durationMs;
      winRank = result.rank;
      winRanksGained = result.ranksGained;
      submitError = false;
      submitMessage = m.minesweeper_submit_ok({ time: formatDurationMs(result.durationMs) });
      console.debug('[minesweeper] submit accepted', result);
      await loadLeaderboard();
    } catch (err) {
      console.debug('[minesweeper] submit failed', err);
      submitError = true;
      submitMessage = m.minesweeper_submit_fail();
    } finally {
      submitPending = false;
    }
  }

  /** Stops the timer on win/loss, vibrates, and fires the ranked submission exactly once. */
  function handlePostMove() {
    if (board.status === 'playing') return;
    stopTimer();
    haptic(board.status === 'won' ? HAPTIC_WIN : HAPTIC_LOSS);
    if (board.status === 'won' && rankedMode && challengeId) {
      void submitRankedResult();
    }
  }

  $effect(() => {
    if (!open) return;
    showLeaderboard = false;
    startGame();
    void afterBoardChange();
    void loadLeaderboard();
    return () => {
      stopTimer();
      stopGlide();
      clearLongPressTimer();
      cancelViewTransition();
    };
  });

  /** Keeps the fit current when the screen changes (rotation, window resize, keyboard); refits only a view the player has not moved. */
  $effect(() => {
    if (!viewportEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!viewAdjusted) {
        centerView();
        return;
      }
      const g = geometry();
      if (!g) return;
      fitScale = fitView(g.viewport, g.board, FIT_INSETS).scale;
      applyView({ scale, panX, panY });
    });
    observer.observe(viewportEl);
    return () => observer.disconnect();
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
    pressRing = null;
    pressedCell = null;
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

  /** True when a short press on this cell would flag it rather than dig - so a second quick tap is a real second action, never a zoom. */
  function shortPressFlags(i: number): boolean {
    return board.minesPlaced && flagPrimary && board.cells[i].state !== 'revealed';
  }

  /**
   * Short press / left click: before mines are placed, the very first click always digs
   * (safe-first-click + seeding happens in `digWithSeedIfNeeded`). Afterward, flags hidden
   * cells when inverted, otherwise always digs (revealed cells still chord).
   */
  function primaryAction(x: number, y: number) {
    if (shortPressFlags(y * board.width + x)) {
      haptic(HAPTIC_FLAG);
      flag(x, y);
    } else {
      void digWithSeedIfNeeded(x, y);
    }
  }

  /**
   * Long press / right click: before mines are placed, always digs (same reasoning as
   * `primaryAction`). Afterward, digs when inverted, otherwise flags.
   */
  function secondaryAction(x: number, y: number) {
    if (!board.minesPlaced || flagPrimary) void digWithSeedIfNeeded(x, y);
    else flag(x, y);
  }

  /** The cell a pointer event landed on, by delegation from the grid; null off any cell. */
  function cellIndexOf(e: Event): number | null {
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-cell]');
    return el ? Number(el.dataset.cell) : null;
  }

  /** Tap or left click. A second quick touch-tap on the same cell that dug zooms instead of acting again. */
  function handleGridClick(e: MouseEvent) {
    const i = cellIndexOf(e);
    if (i === null) return;
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
    if (lastPointerType === 'touch' && !shortPressFlags(i)) {
      const now = performance.now();
      if (lastTap && lastTap.cell === i && now - lastTap.at < DOUBLE_TAP_MS) {
        lastTap = null;
        toggleZoomAt(e.clientX, e.clientY);
        return;
      }
      lastTap = { cell: i, at: now };
    } else {
      lastTap = null;
    }
    primaryAction(i % board.width, Math.floor(i / board.width));
  }

  function handleGridContextMenu(e: MouseEvent) {
    e.preventDefault();
    // A touch long press already ran the secondary action (its flag is cleared by the next
    // pointerdown or the swallowed click), and the synthetic contextmenu it raises must not run it twice.
    if (longPressed || lastPointerType === 'touch') return;
    const i = cellIndexOf(e);
    if (i === null) return;
    clearLongPressTimer();
    secondaryAction(i % board.width, Math.floor(i / board.width));
  }

  /** Touch only: arms the long press on the cell under the finger and shows its progress ring. */
  function handleGridPointerDown(e: PointerEvent) {
    if (e.pointerType !== 'touch' || activePointers.size > 0) return;
    const i = cellIndexOf(e);
    if (i === null) return;
    longPressed = false;
    clearLongPressTimer();
    pressedCell = i;
    const rect = viewportEl?.getBoundingClientRect();
    if (rect) pressRing = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      pressRing = null;
      const cell = pressedCell;
      pressedCell = null;
      if (cell === null) return;
      longPressed = true;
      haptic(HAPTIC_LONG_PRESS);
      secondaryAction(cell % board.width, Math.floor(cell / board.width));
    }, LONG_PRESS_MS);
  }

  // --- Viewport pan / zoom --------------------------------------------------

  function stopGlide() {
    if (glideFrame !== null) {
      cancelAnimationFrame(glideFrame);
      glideFrame = null;
    }
  }

  /** Keeps the board travelling after a flick, slowing down, and stopping dead against an edge. */
  function startGlide(vx: number, vy: number) {
    stopGlide();
    if (vx === 0 && vy === 0) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      const g = glideStep(vx, vy, dt);
      const want = { scale, panX: panX + g.dx, panY: panY + g.dy };
      const got = applyView(want);
      vx = got.panX !== want.panX ? 0 : g.vx;
      vy = got.panY !== want.panY ? 0 : g.vy;
      glideFrame = vx !== 0 || vy !== 0 ? requestAnimationFrame(step) : null;
    };
    glideFrame = requestAnimationFrame(step);
  }

  /** Rescales around a point (relative to the viewport's top-left) so that point stays fixed on screen. */
  function zoomViewAt(sx: number, sy: number, newScale: number) {
    applyView(zoomAt({ scale, panX, panY }, sx, sy, newScale, minScaleFor(fitScale)));
  }

  /** Double-tap: zoom in on the tapped point, or back out to the fit when already zoomed in. */
  function toggleZoomAt(clientX: number, clientY: number) {
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    stopGlide();
    animateView(() => {
      if (scale > fitScale * 1.3) {
        centerView();
      } else {
        zoomViewAt(
          clientX - rect.left,
          clientY - rect.top,
          Math.min(MAX_SCALE, fitScale * DOUBLE_TAP_SCALE)
        );
      }
    });
  }

  function handleWheel(e: WheelEvent) {
    if (!viewportEl) return;
    e.preventDefault();
    cancelViewTransition();
    stopGlide();
    const rect = viewportEl.getBoundingClientRect();
    // Proportional to the delta, so a trackpad pinch (ctrl+wheel, small deltas) is as smooth as a mouse notch.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomViewAt(e.clientX - rect.left, e.clientY - rect.top, scale * factor);
  }

  function beginPan(e: PointerEvent) {
    isPanning = true;
    isPinching = false;
    panPointerId = e.pointerId;
    panOrigin = { x: e.clientX, y: e.clientY, panX, panY };
    panSamples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
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

  function handleViewportPointerDown(e: PointerEvent) {
    cancelViewTransition();
    stopGlide();
    lastPointerType = e.pointerType;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      clearLongPressTimer();
      dragPointerId = null;
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

    // Any primary pointer may become a pan once it moves past the threshold - mouse included,
    // so a board can be dragged with a plain click-and-drag, not only with alt or the middle button.
    if (e.button === 0) {
      dragPointerId = e.pointerId;
      dragOrigin = { x: e.clientX, y: e.clientY, panX, panY };
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
      const newScale = Math.min(
        MAX_SCALE,
        Math.max(minScaleFor(fitScale), (pinchStartScale * dist) / pinchStartDist)
      );
      const contentX = (pinchStartMid.x - pinchStartPanX) / pinchStartScale;
      const contentY = (pinchStartMid.y - pinchStartPanY) / pinchStartScale;
      applyView({
        scale: newScale,
        panX: mid.x - contentX * newScale,
        panY: mid.y - contentY * newScale,
      });
      return;
    }

    if (isPanning && e.pointerId === panPointerId) {
      panSamples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
      if (panSamples.length > 8) panSamples.shift();
      applyView({
        scale,
        panX: panOrigin.panX + (e.clientX - panOrigin.x),
        panY: panOrigin.panY + (e.clientY - panOrigin.y),
      });
      return;
    }

    if (dragPointerId === e.pointerId) {
      const dx = e.clientX - dragOrigin.x;
      const dy = e.clientY - dragOrigin.y;
      if (Math.hypot(dx, dy) > PAN_THRESHOLD_PX) {
        clearLongPressTimer();
        longPressed = false;
        dragPointerId = null;
        lastTap = null;
        isPanning = true;
        isPinching = false;
        justPanned = true;
        panPointerId = e.pointerId;
        panOrigin = { ...dragOrigin };
        panSamples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
        viewportEl?.setPointerCapture(e.pointerId);
        applyView({ scale, panX: panOrigin.panX + dx, panY: panOrigin.panY + dy });
      }
    }
  }

  function handleViewportPointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (e.pointerId === dragPointerId) dragPointerId = null;
    // A finger lifted before the long press fired is a tap, not a hold.
    if (!longPressed) clearLongPressTimer();
    if (e.pointerId === panPointerId) {
      isPanning = false;
      panPointerId = null;
      if (e.type === 'pointerup') {
        const { vx, vy } = releaseVelocity(panSamples, performance.now());
        startGlide(vx, vy);
      }
      panSamples = [];
    }
    if (isPinching && activePointers.size < 2) isPinching = false;
    if (activePointers.size === 0) {
      // Deferred so a trailing click on the same tick is still swallowed; clearing it here (and not
      // only when a single-finger pan ends) is what stops a pinch leaving the NEXT tap swallowed.
      setTimeout(() => {
        justPanned = false;
      }, 0);
    }
  }
</script>

<Modal
  {open}
  title={m.minesweeper_title()}
  {onClose}
  phoneFullScreen={true}
  showTitleBar={false}
  maxWidth="max-w-none sm:max-w-[min(96vw,90rem)]"
  panelClass="sm:h-[min(96dvh,100%)]! sm:overflow-hidden"
>
  <div class="relative min-h-0 flex-1 overflow-hidden">
    <!-- The board takes the whole screen; every control floats over it. -->
    <div
      bind:this={viewportEl}
      role="presentation"
      class="bg-cn-bg absolute inset-0 overflow-hidden"
      style="touch-action: none;"
      onwheel={handleWheel}
      onpointerdown={handleViewportPointerDown}
      onpointermove={handleViewportPointerMove}
      onpointerup={handleViewportPointerUp}
      onpointercancel={handleViewportPointerUp}
    >
      <div
        bind:this={layerEl}
        class="absolute top-0 left-0 w-fit will-change-transform"
        style="transform: translate3d({panX}px, {panY}px, 0) scale({scale}); transform-origin: 0 0; transition: {viewTransition
          ? `transform ${VIEW_TRANSITION_MS}ms ease-out`
          : 'none'};"
      >
        <!-- One set of handlers for all cells (delegated), instead of five per cell. -->
        <div
          role="presentation"
          class="grid w-max gap-px [--ms-cell:1.75rem] sm:[--ms-cell:2rem]"
          style="grid-template-columns: repeat({board.width}, var(--ms-cell));"
          onclick={handleGridClick}
          oncontextmenu={handleGridContextMenu}
          onpointerdown={handleGridPointerDown}
        >
          {#each board.cells as cell, i (i)}
            <button
              type="button"
              data-cell={i}
              class="box-border flex h-[length:var(--ms-cell)] w-[length:var(--ms-cell)] shrink-0 touch-manipulation items-center justify-center rounded-sm border font-mono text-xs font-bold select-none sm:text-sm {pendingCell ===
              i
                ? 'bg-cn-bg border-cn-border animate-pulse'
                : cell.state !== 'revealed'
                  ? 'bg-cn-yellow/25 hover:bg-cn-yellow/40 active:bg-cn-yellow/60 border-cn-border'
                  : cell.mine
                    ? 'border-transparent bg-red-500/80'
                    : 'bg-cn-bg border-transparent'} {cell.state === 'revealed' &&
              !cell.mine &&
              cell.adjacent > 0
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

      {#if pressRing}
        <!-- Long-press progress, drawn above the finger so the hand does not cover it. -->
        <svg
          class="ms-press-ring pointer-events-none absolute z-10"
          style="left: {pressRing.x - 22}px; top: {pressRing.y -
            76}px; --ms-ring-ms: {LONG_PRESS_MS}ms;"
          width="44"
          height="44"
          viewBox="0 0 44 44"
          aria-hidden="true"
        >
          <circle cx="22" cy="22" r="18" class="stroke-cn-border fill-none" stroke-width="4" />
          <circle
            cx="22"
            cy="22"
            r="18"
            class="stroke-cn-yellow fill-none"
            stroke-width="4"
            stroke-linecap="round"
            transform="rotate(-90 22 22)"
          />
        </svg>
      {/if}

      {#if board.status !== 'playing'}
        {@const isWin = board.status === 'won'}
        <!-- Game-over overlay: scoped to the viewport so the floating controls above it stay reachable. -->
        <div
          class="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4"
          transition:fade={{ duration: 200 }}
        >
          <div
            class="bg-cn-surface pointer-events-auto flex flex-col items-center gap-3 rounded-2xl border px-6 py-6 text-center shadow-2xl {isWin
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
              class="text-2xl font-bold sm:text-3xl {isWin
                ? 'ms-win-pulse text-cn-yellow'
                : 'text-red-500'}"
            >
              {isWin ? m.minesweeper_status_won() : m.minesweeper_status_lost()}
            </p>
            {#if isWin}
              <p
                class="border-cn-yellow/40 bg-cn-yellow/15 text-text-main flex items-center gap-2 rounded-xl border px-4 py-2 font-mono text-xl font-bold tabular-nums sm:text-2xl"
              >
                <Timer size={20} class="text-cn-yellow shrink-0" strokeWidth={2.5} />
                {m.minesweeper_time({
                  time: formatDurationMs(winDurationMs ?? elapsedMs),
                })}
              </p>
              {#if rankedMode}
                {#if submitPending}
                  <p class="text-text-muted text-sm font-semibold">
                    {m.minesweeper_rank_pending()}
                  </p>
                {:else if winRank != null}
                  <p
                    class="border-cn-yellow/30 bg-cn-yellow/10 text-cn-dark inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-bold"
                  >
                    <Trophy size={14} class="text-cn-yellow" strokeWidth={2.5} />
                    {#if winRanksGained > 0}
                      {m.minesweeper_rank_up({
                        rank: String(winRank),
                        gained: String(winRanksGained),
                      })}
                    {:else}
                      {m.minesweeper_rank({ rank: String(winRank) })}
                    {/if}
                  </p>
                {/if}
              {/if}
            {/if}
            <button
              type="button"
              onclick={newGame}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover mt-1 flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition-colors"
            >
              <RotateCcw size={15} strokeWidth={2.5} />
              {m.minesweeper_new_game()}
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Floating top bar: close + game readout on the left, the leaderboard on the right. -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-2"
    >
      <div class="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onclick={onClose}
          aria-label={m.minesweeper_close()}
          class="bg-cn-surface/90 border-cn-border text-text-main pointer-events-auto flex size-11 shrink-0 items-center justify-center rounded-full border shadow-sm backdrop-blur-sm"
        >
          <X size={18} />
        </button>
        <div
          class="bg-cn-surface/90 border-cn-border text-text-main pointer-events-auto flex h-11 items-center gap-3 rounded-full border pr-1 pl-3.5 text-sm font-bold shadow-sm backdrop-blur-sm"
        >
          <span class="flex items-center gap-1.5">
            <Bomb size={16} class="text-cn-dark" />
            {remainingMines(board)}
          </span>
          <span class="text-text-muted flex items-center gap-1 font-mono tabular-nums">
            <Timer size={15} />
            {m.minesweeper_time({ time: formatDurationMs(elapsedMs) })}
          </span>
          {#if rankedMode}
            <span title={m.minesweeper_ranked()} role="img" aria-label={m.minesweeper_ranked()}>
              <Trophy size={14} class="text-cn-yellow" />
            </span>
          {/if}
          <button
            type="button"
            onclick={newGame}
            aria-label={m.minesweeper_new_game()}
            title={m.minesweeper_new_game()}
            class="text-cn-dark hover:bg-cn-yellow/20 flex size-9 items-center justify-center rounded-full transition-colors"
          >
            <RotateCcw size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <button
        type="button"
        onclick={openLeaderboard}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover pointer-events-auto flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold shadow-sm transition-colors"
      >
        <Trophy size={16} strokeWidth={2.5} />
        {m.minesweeper_leaderboard()}
      </button>
    </div>

    {#if submitMessage}
      <p
        role="status"
        class="bg-cn-surface/95 border-cn-border pointer-events-none absolute inset-x-3 top-16 z-20 mx-auto w-fit max-w-full rounded-full border px-3 py-1 text-center text-xs font-semibold shadow-sm {submitError
          ? 'text-red-err'
          : 'text-green-ok'}"
      >
        {submitMessage}
      </p>
    {/if}

    <!-- Mode button, within thumb reach: what a short press does (a long press does the other). -->
    <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center gap-2 p-3">
      <button
        type="button"
        onclick={toggleFlagPrimary}
        aria-pressed={flagPrimary}
        title={m.minesweeper_mode_hint()}
        class="pointer-events-auto flex h-12 items-center gap-2 rounded-full border px-5 text-sm font-bold shadow-md backdrop-blur-sm transition-colors {flagPrimary
          ? 'bg-cn-yellow text-cn-ink border-transparent'
          : 'bg-cn-surface/90 border-cn-border text-text-main'}"
      >
        {#if flagPrimary}
          <Flag size={18} strokeWidth={2.5} />
          {m.minesweeper_mode_flag()}
        {:else}
          <Pickaxe size={18} strokeWidth={2.5} />
          {m.minesweeper_mode_dig()}
        {/if}
      </button>
      <button
        type="button"
        onclick={toggleUnranked}
        disabled={board.minesPlaced}
        aria-pressed={unranked}
        title={m.minesweeper_unranked_hint()}
        class="pointer-events-auto flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-bold shadow-md backdrop-blur-sm transition-colors disabled:opacity-50 {unranked
          ? 'bg-cn-yellow text-cn-ink border-transparent'
          : 'bg-cn-surface/90 border-cn-border text-text-main'}"
      >
        <Trophy size={18} strokeWidth={2.5} class={unranked ? 'opacity-40' : ''} />
        {unranked ? m.minesweeper_casual() : m.minesweeper_ranked()}
      </button>
    </div>

    {#if showLeaderboard}
      <!-- Leaderboard sheet: covers the board and the controls, the game keeps running under it. -->
      <div
        class="bg-cn-surface absolute inset-0 z-30 flex flex-col"
        transition:fade={{ duration: 150 }}
      >
        <div class="border-cn-border flex shrink-0 items-center gap-2 border-b p-2">
          <button
            type="button"
            onclick={() => (showLeaderboard = false)}
            aria-label={m.minesweeper_leaderboard_back()}
            class="text-text-main hover:bg-cn-bg flex size-11 items-center justify-center rounded-full transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <h2 class="text-cn-dark text-base font-semibold">{m.minesweeper_leaderboard()}</h2>
        </div>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-4">
          {#if personalBestMs !== null}
            <p class="text-text-muted mb-2 shrink-0 text-sm">
              {m.minesweeper_personal_best({ time: formatDurationMs(personalBestMs) })}
            </p>
          {/if}

          {#if leaderboardLoading}
            <p class="text-text-muted text-sm">…</p>
          {:else if leaderboard.length === 0}
            <p class="text-text-muted text-sm">{m.minesweeper_empty_leaderboard()}</p>
          {:else}
            <ol class="space-y-1.5">
              {#each leaderboard as entry (entry.userId)}
                <li
                  class="border-cn-border bg-cn-bg flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
                >
                  <span class="flex items-center gap-2.5 truncate">
                    <span class="text-text-muted w-7 shrink-0 font-mono text-sm font-bold">
                      #{entry.rank}
                    </span>
                    <span class="text-text-main truncate text-sm font-semibold">
                      {entry.displayName}
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1">
                    <span class="text-cn-dark font-mono text-sm font-semibold">
                      {formatDurationMs(entry.durationMs)}
                    </span>
                    {#if isAdmin}
                      <button
                        type="button"
                        class="ui-icon-button ui-icon-button--sm text-text-muted rounded-full outline-none hover:text-red-500 focus-visible:ring-2 focus-visible:ring-amber-500"
                        aria-label={m.minesweeper_admin_remove_score()}
                        title={m.minesweeper_admin_remove_score()}
                        onclick={() => void removeScore(entry)}
                      >
                        <Trash2 size={14} strokeWidth={2.25} />
                      </button>
                      <button
                        type="button"
                        class="ui-icon-button ui-icon-button--sm text-text-muted rounded-full outline-none hover:text-red-500 focus-visible:ring-2 focus-visible:ring-amber-500"
                        aria-label={m.minesweeper_admin_ban()}
                        title={m.minesweeper_admin_ban()}
                        onclick={() => void banPlayer(entry)}
                      >
                        <Ban size={14} strokeWidth={2.25} />
                      </button>
                    {/if}
                  </span>
                </li>
              {/each}
            </ol>
          {/if}

          {#if isAdmin}
            {#if moderationFailed}
              <p class="text-red-err mt-2 text-xs font-semibold" role="alert">
                {m.minesweeper_admin_failed()}
              </p>
            {/if}
            {#if bans.length > 0}
              <h3 class="text-text-muted text-2xs mt-4 mb-1.5 font-bold tracking-wider uppercase">
                {m.minesweeper_admin_bans_title()}
              </h3>
              <ul class="space-y-1.5">
                {#each bans as ban (ban.userId)}
                  <li
                    class="border-cn-border bg-cn-bg flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
                  >
                    <span class="min-w-0">
                      <span class="text-text-main block truncate text-sm font-semibold">
                        {ban.displayName}
                      </span>
                      {#if ban.reason}
                        <span class="text-text-muted block truncate text-xs">{ban.reason}</span>
                      {/if}
                    </span>
                    <button
                      type="button"
                      class="ui-icon-button ui-icon-button--sm text-text-muted hover:text-green-ok rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      aria-label={m.minesweeper_admin_unban()}
                      title={m.minesweeper_admin_unban()}
                      onclick={() => void unbanPlayer(ban)}
                    >
                      <Undo2 size={14} strokeWidth={2.25} />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
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

  /* The long-press ring stays invisible for the first third, so a plain tap never flashes it, then fills over the rest of the hold. */
  @keyframes ms-ring-in {
    0%,
    30% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }

  @keyframes ms-ring-fill {
    from {
      stroke-dashoffset: 113;
    }
    to {
      stroke-dashoffset: 0;
    }
  }

  .ms-press-ring {
    animation: ms-ring-in var(--ms-ring-ms) linear forwards;
  }

  .ms-press-ring circle:last-child {
    stroke-dasharray: 113;
    animation: ms-ring-fill var(--ms-ring-ms) linear forwards;
  }
</style>
