/**
 * No-guess Minesweeper: mine layouts are accepted only when a logical solver
 * (basic chords + frontier CSP / "tank" enumeration) can clear the board from
 * the first click without guessing.
 *
 * Generation follows Simon Tatham's approach from SGT Puzzles `mines.c`
 * (MIT): place mines, solve with local deductions, and when stuck call
 * `mineperturb`-style set fill/empty swaps until the grid is uniquely
 * soluble or a fresh layout is tried. See:
 * https://www.chiark.greenend.org.uk/~sgtatham/puzzles/
 *
 * During play, flags are placed only when the player clicks a revealed number
 * whose remaining mine count equals its hidden neighbors; opening chords stay
 * manual on a second click when flags already match.
 */

export type CellState = 'hidden' | 'revealed' | 'flagged';

export interface Cell {
  mine: boolean;
  adjacent: number;
  state: CellState;
}

export type GameStatus = 'playing' | 'won' | 'lost';

/** Player action recorded for ranked replay / anti-cheat verification. */
export type MinesweeperMove =
  | { type: 'reveal'; x: number; y: number }
  | { type: 'flag'; x: number; y: number };

/** Deterministic [0, 1) generator used for seeded ranked boards. */
export type Rng = () => number;

export interface MinesweeperBoard {
  width: number;
  height: number;
  mineCount: number;
  cells: Cell[];
  status: GameStatus;
  /** True after the first reveal places mines (safe first click). */
  minesPlaced: boolean;
  revealedCount: number;
  flagCount: number;
  /**
   * Ranked seed from the server. When set, mine placement is deterministic
   * for `(seed, firstClickIndex)` so the server can replay the solve.
   */
  seed: string | null;
  /** Lazily created from `seed`; advances during generation only. */
  rng: Rng | null;
}

export interface MinesweeperConfig {
  width: number;
  height: number;
  mineCount: number;
}

/** Challenge board: 18×32 with 150 mines (~26% density, no-guess). */
export const CHALLENGE: MinesweeperConfig = { width: 18, height: 32, mineCount: 150 };

/** Default easter-egg difficulty. */
export const DEFAULT_CONFIG: MinesweeperConfig = CHALLENGE;

/** @deprecated Prefer DEFAULT_CONFIG / CHALLENGE. */
export const INTERMEDIATE: MinesweeperConfig = CHALLENGE;

/** @deprecated Prefer DEFAULT_CONFIG / CHALLENGE. */
export const BEGINNER: MinesweeperConfig = { width: 9, height: 9, mineCount: 10 };

/** Full board restarts when perturbation loops stall. */
const MAX_GENERATION_RESTARTS = 80;
/** Set fill/empty perturbations per restart while the solver is stuck. */
const MAX_PERTURBATIONS = 200;
/** After this many local set perturbs fail, allow whole-unknown reshuffles. */
const BIG_PERTURB_AFTER = 40;
/** Cheaper CSP during generation (full MAX_CSP_VARS used for final verify). */
const GENERATION_CSP_VARS = 12;

/** Frontier CSP enumeration limit; larger components are split or skipped. */
const MAX_CSP_VARS = 16;

const NEIGHBOR_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function idx(board: Pick<MinesweeperBoard, 'width'>, x: number, y: number): number {
  return y * board.width + x;
}

function inBounds(
  board: Pick<MinesweeperBoard, 'width' | 'height'>,
  x: number,
  y: number
): boolean {
  return x >= 0 && y >= 0 && x < board.width && y < board.height;
}

/**
 * FNV-1a style hash so a server hex seed maps to a stable mulberry32 state.
 * @param seed - Opaque ranked seed string from the server.
 */
export function hashSeedToU32(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — small, fast, good enough for board generation. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngOf(board: MinesweeperBoard): Rng {
  if (!board.seed) return Math.random;
  if (!board.rng) board.rng = mulberry32(hashSeedToU32(board.seed));
  return board.rng;
}

/**
 * Creates an empty board; mines are placed on the first reveal.
 * @param seed - When set, enables deterministic ranked generation for anti-cheat replay.
 */
export function createBoard(
  config: MinesweeperConfig = DEFAULT_CONFIG,
  seed: string | null = null
): MinesweeperBoard {
  const { width, height, mineCount } = config;
  const total = width * height;
  const cappedMines = Math.max(1, Math.min(mineCount, total - 1));
  return {
    width,
    height,
    mineCount: cappedMines,
    cells: Array.from({ length: total }, () => ({
      mine: false,
      adjacent: 0,
      state: 'hidden' as const,
    })),
    status: 'playing',
    minesPlaced: false,
    revealedCount: 0,
    flagCount: 0,
    seed,
    rng: null,
  };
}

function forEachNeighbor(
  board: Pick<MinesweeperBoard, 'width' | 'height' | 'cells'>,
  x: number,
  y: number,
  fn: (nx: number, ny: number, cell: Cell, i: number) => void
): void {
  for (const [dy, dx] of NEIGHBOR_DELTAS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(board, nx, ny)) continue;
    const i = idx(board, nx, ny);
    fn(nx, ny, board.cells[i], i);
  }
}

function clearMineLayout(board: MinesweeperBoard): void {
  for (const cell of board.cells) {
    cell.mine = false;
    cell.adjacent = 0;
  }
}

function computeAdjacents(board: MinesweeperBoard): void {
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const i = idx(board, x, y);
      if (board.cells[i].mine) {
        board.cells[i].adjacent = 0;
        continue;
      }
      let count = 0;
      forEachNeighbor(board, x, y, (_nx, _ny, cell) => {
        if (cell.mine) count++;
      });
      board.cells[i].adjacent = count;
    }
  }
}

/** Places mines randomly, keeping `safeIndex` and its neighborhood mine-free. */
function placeMinesRandom(board: MinesweeperBoard, safeIndex: number): void {
  clearMineLayout(board);

  const forbidden = new Set<number>([safeIndex]);
  const sx = safeIndex % board.width;
  const sy = Math.floor(safeIndex / board.width);
  forEachNeighbor(board, sx, sy, (_nx, _ny, _c, i) => {
    forbidden.add(i);
  });

  const candidates: number[] = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (!forbidden.has(i)) candidates.push(i);
  }

  const rng = rngOf(board);
  for (let m = 0; m < board.mineCount && candidates.length > 0; m++) {
    const pick = Math.floor(rng() * candidates.length);
    const mineIdx = candidates.splice(pick, 1)[0];
    board.cells[mineIdx].mine = true;
  }

  computeAdjacents(board);
}

interface SolveState {
  width: number;
  height: number;
  mineCount: number;
  cells: Cell[];
  revealedCount: number;
  flagCount: number;
  status: GameStatus;
}

function cloneSolveState(board: MinesweeperBoard): SolveState {
  return {
    width: board.width,
    height: board.height,
    mineCount: board.mineCount,
    cells: board.cells.map((c) => ({ ...c, state: 'hidden' as const })),
    revealedCount: 0,
    flagCount: 0,
    status: 'playing',
  };
}

function revealFlood(board: SolveState | MinesweeperBoard, startX: number, startY: number): void {
  const stack: Array<[number, number]> = [[startX, startY]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const i = idx(board, x, y);
    const cell = board.cells[i];
    if (cell.state !== 'hidden') continue;
    cell.state = 'revealed';
    board.revealedCount++;
    if (cell.adjacent === 0 && !cell.mine) {
      forEachNeighbor(board, x, y, (nx, ny, n) => {
        if (n.state === 'hidden') stack.push([nx, ny]);
      });
    }
  }
}

function safeCellsTotal(board: Pick<MinesweeperBoard, 'cells' | 'mineCount'>): number {
  return board.cells.length - board.mineCount;
}

function isWon(board: Pick<MinesweeperBoard, 'revealedCount' | 'cells' | 'mineCount'>): boolean {
  return board.revealedCount >= safeCellsTotal(board);
}

function checkWin(board: MinesweeperBoard): void {
  if (!isWon(board)) return;
  board.status = 'won';
  for (const cell of board.cells) {
    if (cell.mine && cell.state === 'hidden') {
      cell.state = 'flagged';
      board.flagCount++;
    }
  }
}

/**
 * Flag chord: when a revealed number N has exactly N remaining hidden neighbors
 * (flags already placed counted), flag all of them. Loops until stable.
 * Used during play and inside the generation solver.
 */
function applyAutoFlags(board: SolveState | MinesweeperBoard): boolean {
  let any = false;
  let changed = true;
  let guard = 0;
  while (changed && guard < 200) {
    guard++;
    changed = false;
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        const cell = board.cells[idx(board, x, y)];
        if (cell.state !== 'revealed' || cell.adjacent === 0) continue;

        let flagged = 0;
        const hiddenCoords: Array<[number, number]> = [];
        forEachNeighbor(board, x, y, (nx, ny, n) => {
          if (n.state === 'flagged') flagged++;
          else if (n.state === 'hidden') hiddenCoords.push([nx, ny]);
        });

        const remaining = cell.adjacent - flagged;
        if (remaining <= 0 || remaining !== hiddenCoords.length) continue;

        for (const [nx, ny] of hiddenCoords) {
          const n = board.cells[idx(board, nx, ny)];
          if (n.state !== 'hidden') continue;
          n.state = 'flagged';
          board.flagCount++;
          changed = true;
          any = true;
        }
      }
    }
  }
  return any;
}

/** Basic single-cell deductions (auto-flag + auto-open chords). Returns whether anything changed. */
function applyBasicAssists(board: SolveState | MinesweeperBoard): boolean {
  let changed = applyAutoFlags(board);

  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const cell = board.cells[idx(board, x, y)];
      if (cell.state !== 'revealed' || cell.adjacent === 0) continue;

      let flagged = 0;
      const hiddenCoords: Array<[number, number]> = [];
      forEachNeighbor(board, x, y, (nx, ny, n) => {
        if (n.state === 'flagged') flagged++;
        else if (n.state === 'hidden') hiddenCoords.push([nx, ny]);
      });

      if (flagged !== cell.adjacent || hiddenCoords.length === 0) continue;

      for (const [nx, ny] of hiddenCoords) {
        const n = board.cells[idx(board, nx, ny)];
        if (n.state !== 'hidden') continue;
        if (n.mine) {
          // Should never happen on a consistent no-guess board during solve verification.
          n.state = 'revealed';
          board.revealedCount++;
          board.status = 'lost';
          return true;
        }
        revealFlood(board, nx, ny);
        changed = true;
      }
    }
  }

  return changed;
}

interface Constraint {
  /** Indices of still-hidden cells this number constrains. */
  vars: number[];
  /** Mines still required among those vars. */
  count: number;
}

function collectConstraints(board: SolveState | MinesweeperBoard): {
  constraints: Constraint[];
  frontier: number[];
  sea: number[];
} {
  const frontierSet = new Set<number>();
  const constraints: Constraint[] = [];

  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const cell = board.cells[idx(board, x, y)];
      if (cell.state !== 'revealed' || cell.adjacent === 0) continue;

      let flagged = 0;
      const vars: number[] = [];
      forEachNeighbor(board, x, y, (_nx, _ny, n, i) => {
        if (n.state === 'flagged') flagged++;
        else if (n.state === 'hidden') {
          vars.push(i);
          frontierSet.add(i);
        }
      });

      const count = cell.adjacent - flagged;
      if (vars.length === 0) continue;
      if (count < 0 || count > vars.length) continue;
      constraints.push({ vars, count });
    }
  }

  const sea: number[] = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i].state !== 'hidden') continue;
    if (!frontierSet.has(i)) sea.push(i);
  }

  return { constraints, frontier: [...frontierSet], sea };
}

/**
 * Splits frontier indices into connected components linked by shared constraints.
 */
function frontierComponents(constraints: Constraint[], frontier: number[]): number[][] {
  if (frontier.length === 0) return [];

  const parent = new Map<number, number>();
  for (const v of frontier) parent.set(v, v);

  function find(a: number): number {
    let p = parent.get(a)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(a, p);
    return p;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const c of constraints) {
    for (let i = 1; i < c.vars.length; i++) union(c.vars[0], c.vars[i]);
  }

  const groups = new Map<number, number[]>();
  for (const v of frontier) {
    const root = find(v);
    const list = groups.get(root) ?? [];
    list.push(v);
    groups.set(root, list);
  }
  return [...groups.values()];
}

/**
 * Enumerates valid mine assignments on `vars`.
 * When `useGlobalMineBounds` is true, solutions must leave a feasible mine count for `seaSize`.
 */
function deduceForced(
  vars: number[],
  constraints: Constraint[],
  remainingMinesAfterFlags: number,
  seaSize: number,
  useGlobalMineBounds: boolean
): { forcedMines: number[]; forcedSafe: number[] } {
  const exact = constraints.filter((c) => c.vars.every((v) => vars.includes(v)));
  const n = vars.length;
  if (n === 0 || n > MAX_CSP_VARS) return { forcedMines: [], forcedSafe: [] };
  // Local component solve needs at least one fully-contained equation.
  if (!useGlobalMineBounds && exact.length === 0) {
    return { forcedMines: [], forcedSafe: [] };
  }

  const indexOf = new Map(vars.map((v, i) => [v, i]));
  const solutions: boolean[][] = [];

  const maxMines = useGlobalMineBounds ? Math.min(n, remainingMinesAfterFlags) : n;
  const minMines = useGlobalMineBounds ? Math.max(0, remainingMinesAfterFlags - seaSize) : 0;

  function valid(assignment: boolean[]): boolean {
    let mines = 0;
    for (const bit of assignment) if (bit) mines++;
    if (mines < minMines || mines > maxMines) return false;

    for (const c of exact) {
      let sum = 0;
      for (const v of c.vars) {
        if (assignment[indexOf.get(v)!]) sum++;
      }
      if (sum !== c.count) return false;
    }
    return true;
  }

  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    const assignment = Array.from({ length: n }, (_, i) => ((mask >> i) & 1) === 1);
    if (valid(assignment)) solutions.push(assignment);
  }

  if (solutions.length === 0) return { forcedMines: [], forcedSafe: [] };

  const forcedMines: number[] = [];
  const forcedSafe: number[] = [];
  for (let i = 0; i < n; i++) {
    const allMine = solutions.every((s) => s[i]);
    const allSafe = solutions.every((s) => !s[i]);
    if (allMine) forcedMines.push(vars[i]);
    else if (allSafe) forcedSafe.push(vars[i]);
  }
  return { forcedMines, forcedSafe };
}

/** Frontier CSP + sea mine-count deductions. Returns whether anything changed. */
function applyCspAssists(
  board: SolveState | MinesweeperBoard,
  maxVars: number = MAX_CSP_VARS
): boolean {
  const { constraints, frontier, sea } = collectConstraints(board);
  if (frontier.length === 0 && sea.length === 0) return false;

  const remaining = board.mineCount - board.flagCount;
  let changed = false;

  const applyForced = (forcedMines: number[], forcedSafe: number[]): boolean => {
    let local = false;
    for (const i of forcedMines) {
      if (board.cells[i].state !== 'hidden') continue;
      board.cells[i].state = 'flagged';
      board.flagCount++;
      local = true;
    }
    for (const i of forcedSafe) {
      if (board.cells[i].state !== 'hidden') continue;
      if (board.cells[i].mine) {
        board.status = 'lost';
        return true;
      }
      revealFlood(board, i % board.width, Math.floor(i / board.width));
      local = true;
    }
    return local;
  };

  // Sea-only certainty when nothing remains on the numbered frontier.
  if (frontier.length === 0) {
    if (remaining === 0) {
      for (const i of sea) {
        const cell = board.cells[i];
        if (cell.state !== 'hidden') continue;
        if (cell.mine) {
          board.status = 'lost';
          return true;
        }
        revealFlood(board, i % board.width, Math.floor(i / board.width));
        changed = true;
      }
    } else if (remaining === sea.length && sea.length > 0) {
      for (const i of sea) {
        if (board.cells[i].state !== 'hidden') continue;
        board.cells[i].state = 'flagged';
        board.flagCount++;
        changed = true;
      }
    }
    return changed;
  }

  // Always split into components — joint 2^n on a wide frontier is too costly at high density.
  for (const component of frontierComponents(constraints, frontier)) {
    if (component.length > maxVars) continue;
    const { forcedMines, forcedSafe } = deduceForced(
      component,
      constraints,
      remaining,
      sea.length,
      component.length === frontier.length
    );
    if (applyForced(forcedMines, forcedSafe)) changed = true;
    if (board.status === 'lost') return true;
  }

  return changed;
}

/**
 * Runs logical assists until the board stabilizes (basic chords + CSP).
 * Used for no-guess generation / solvability checks only — not during play.
 * During play, flag-then-open chords are manual via {@link chordCell}.
 */
export function runAutoAssists(
  board: MinesweeperBoard | SolveState,
  maxCspVars: number = MAX_CSP_VARS
): void {
  if (board.status !== 'playing') return;
  if ('minesPlaced' in board && !board.minesPlaced) return;

  let changed = true;
  let guard = 0;
  while (changed && board.status === 'playing' && guard < 400) {
    guard++;
    changed = applyBasicAssists(board);
    if (board.status !== 'playing') return;
    if (applyCspAssists(board, maxCspVars)) changed = true;
  }

  if ('minesPlaced' in board && board.status === 'playing') {
    checkWin(board as MinesweeperBoard);
  }
}

/**
 * Click on a revealed number:
 * 1. If remaining mines == hidden neighbors, flag them all.
 * 2. Else if flags already == the number, open every remaining hidden neighbor.
 */
export function chordCell(board: MinesweeperBoard, x: number, y: number): MinesweeperBoard {
  if (board.status !== 'playing' || !inBounds(board, x, y)) return board;

  const cell = board.cells[idx(board, x, y)];
  if (cell.state !== 'revealed' || cell.adjacent === 0) return board;

  let flagged = 0;
  const hiddenCoords: Array<[number, number]> = [];
  forEachNeighbor(board, x, y, (nx, ny, n) => {
    if (n.state === 'flagged') flagged++;
    else if (n.state === 'hidden') hiddenCoords.push([nx, ny]);
  });

  const remaining = cell.adjacent - flagged;

  // Step 1: place flags when exactly `remaining` hidden neighbors are left.
  if (remaining > 0 && remaining === hiddenCoords.length) {
    for (const [nx, ny] of hiddenCoords) {
      const n = board.cells[idx(board, nx, ny)];
      if (n.state !== 'hidden') continue;
      n.state = 'flagged';
      board.flagCount++;
    }
    return board;
  }

  // Step 2: open chord when flags already match the number.
  if (flagged !== cell.adjacent || hiddenCoords.length === 0) return board;

  for (const [nx, ny] of hiddenCoords) {
    const n = board.cells[idx(board, nx, ny)];
    if (n.state !== 'hidden') continue;
    if (n.mine) {
      n.state = 'revealed';
      board.revealedCount++;
      board.status = 'lost';
      revealAllMines(board);
      return board;
    }
    revealFlood(board, nx, ny);
  }

  if (board.status === 'playing') checkWin(board);
  return board;
}

/**
 * Returns true when a logical player can clear the board from `startIndex`
 * without guessing (first click + deductions only).
 */
export function isSolvableWithoutGuessing(board: MinesweeperBoard, startIndex: number): boolean {
  const progress = solveUntilStuck(board, startIndex);
  return progress.won;
}

interface SolveProgress {
  won: boolean;
  lost: boolean;
  revealedCount: number;
  /** Cell indices the solver proved empty (revealed). */
  knownEmpty: number[];
  /** Cell indices the solver proved are mines (flagged). */
  knownMines: number[];
  /**
   * Remaining frontier constraint sets when stuck (unknown neighbors of a
   * numbered cell). Used as Tatham `mineperturb` targets.
   */
  stuckSets: number[][];
}

/**
 * Runs the logical solver from `startIndex` until it wins, loses, or stalls.
 * Used by no-guess generation to decide where mines may still be reshuffled.
 */
function solveUntilStuck(
  board: MinesweeperBoard,
  startIndex: number,
  maxCspVars: number = MAX_CSP_VARS
): SolveProgress {
  const sim = cloneSolveState(board);
  const sx = startIndex % board.width;
  const sy = Math.floor(startIndex / board.width);

  if (sim.cells[startIndex].mine) {
    return {
      won: false,
      lost: true,
      revealedCount: 0,
      knownEmpty: [],
      knownMines: [],
      stuckSets: [],
    };
  }

  revealFlood(sim, sx, sy);
  runAutoAssists(sim, maxCspVars);

  const knownEmpty: number[] = [];
  const knownMines: number[] = [];
  for (let i = 0; i < sim.cells.length; i++) {
    if (sim.cells[i].state === 'revealed') knownEmpty.push(i);
    else if (sim.cells[i].state === 'flagged') knownMines.push(i);
  }

  const won = sim.status !== 'lost' && isWon(sim);
  const lost = sim.status === 'lost';
  let stuckSets: number[][] = [];
  if (!won && !lost) {
    const { constraints } = collectConstraints(sim);
    // Prefer mixed sets (both mines and clears) — uniform sets yield empty perturbs.
    stuckSets = constraints
      .map((c) => c.vars)
      .filter((vars) => {
        let mines = 0;
        for (const i of vars) if (board.cells[i].mine) mines++;
        return mines > 0 && mines < vars.length;
      });
    if (stuckSets.length === 0) {
      stuckSets = constraints.map((c) => c.vars).filter((v) => v.length > 0);
    }
  }

  return {
    won,
    lost,
    revealedCount: sim.revealedCount,
    knownEmpty,
    knownMines,
    stuckSets,
  };
}

/** First-click cell and its neighborhood must never contain mines. */
function safeZone(board: MinesweeperBoard, safeIndex: number): Set<number> {
  const forbidden = new Set<number>([safeIndex]);
  const sx = safeIndex % board.width;
  const sy = Math.floor(safeIndex / board.width);
  forEachNeighbor(board, sx, sy, (_nx, _ny, _c, i) => {
    forbidden.add(i);
  });
  return forbidden;
}

function shuffleInPlace<T>(arr: T[], rng: Rng = Math.random): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Simon Tatham `mineperturb` (MIT, SGT Puzzles mines.c): make `targetSet`
 * entirely mines or entirely clear by swapping with outside squares.
 *
 * Outside candidates are preference-ordered: unknown frontier, then deep sea,
 * then already-known cells (last resort). The first-click 3×3 is never touched.
 * Returns false when no effective swap is possible.
 *
 * @param targetSet - Frontier constraint vars to fill/empty, or `null` for a
 *   big perturb over every cell the solver still treats as unknown.
 */
function tathamPerturb(
  board: MinesweeperBoard,
  safeIndex: number,
  knownEmpty: number[],
  knownMines: number[],
  targetSet: number[] | null
): boolean {
  const forbidden = safeZone(board, safeIndex);
  const revealed = new Set(knownEmpty);
  const knownMineSet = new Set(knownMines);
  const knownAny = new Set<number>([...knownEmpty, ...knownMines]);

  let setCells: number[];
  if (targetSet && targetSet.length > 0) {
    setCells = targetSet.filter((i) => !forbidden.has(i));
  } else {
    setCells = [];
    for (let i = 0; i < board.cells.length; i++) {
      if (forbidden.has(i) || knownAny.has(i)) continue;
      setCells.push(i);
    }
  }

  if (setCells.length === 0) return false;

  const inSet = new Set(setCells);
  let nfull = 0;
  let nempty = 0;
  for (const i of setCells) {
    if (board.cells[i].mine) nfull++;
    else nempty++;
  }
  if (nfull === 0 && nempty === 0) return false;

  type Cand = { index: number; type: number; rand: number };
  const candidates: Cand[] = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (forbidden.has(i) || inSet.has(i)) continue;

    let type: number;
    if (knownAny.has(i)) {
      type = 3; // already deduced — last resort swap partner
    } else {
      const x = i % board.width;
      const y = Math.floor(i / board.width);
      let touches = false;
      forEachNeighbor(board, x, y, (_nx, _ny, _n, ni) => {
        if (revealed.has(ni) || knownMineSet.has(ni)) touches = true;
      });
      type = touches ? 1 : 2;
    }
    candidates.push({ index: i, type, rand: rngOf(board)() });
  }

  candidates.sort((a, b) => a.type - b.type || a.rand - b.rand);

  const tofill: number[] = [];
  const toempty: number[] = [];
  for (const c of candidates) {
    if (board.cells[c.index].mine) toempty.push(c.index);
    else tofill.push(c.index);
    if (tofill.length === nfull || toempty.length === nempty) break;
  }

  /** Deltas applied to the mine bitmap: +1 add mine, -1 remove mine. */
  const changes: Array<{ index: number; delta: number }> = [];

  if (tofill.length === nfull && nfull > 0) {
    // Empty the set: move its mines onto `tofill` empties outside.
    for (const i of tofill) changes.push({ index: i, delta: +1 });
    for (const i of setCells) {
      if (board.cells[i].mine) changes.push({ index: i, delta: -1 });
    }
  } else if (toempty.length === nempty && nempty > 0) {
    // Fill the set: pull mines from `toempty` outside into empty set cells.
    for (const i of toempty) changes.push({ index: i, delta: -1 });
    for (const i of setCells) {
      if (!board.cells[i].mine) changes.push({ index: i, delta: +1 });
    }
  } else if (toempty.length > 0 && nempty > toempty.length) {
    // Partial fill (dense boards): fill a random subset of empty set cells.
    const emptiesInSet = setCells.filter((i) => !board.cells[i].mine);
    shuffleInPlace(emptiesInSet, rngOf(board));
    const n = toempty.length;
    for (let k = 0; k < n; k++) {
      changes.push({ index: toempty[k], delta: -1 });
      changes.push({ index: emptiesInSet[k], delta: +1 });
    }
  } else {
    return false;
  }

  if (changes.length === 0) return false;

  // Validate the whole plan before mutating (avoid partial applies).
  for (const { index, delta } of changes) {
    const wantMine = delta > 0;
    if (board.cells[index].mine === wantMine) return false;
  }

  for (const { index, delta } of changes) {
    board.cells[index].mine = delta > 0;
  }

  computeAdjacents(board);
  return true;
}

/**
 * Reshuffles mines among cells the solver has not yet proven, keeping known
 * empties empty and known mines fixed. Used as Tatham "big perturb" fallback.
 */
function perturbUnknownMines(
  board: MinesweeperBoard,
  safeIndex: number,
  knownEmpty: number[],
  knownMines: number[]
): boolean {
  const lockedEmpty = safeZone(board, safeIndex);
  for (const i of knownEmpty) lockedEmpty.add(i);

  const lockedMine = new Set<number>(knownMines);

  const flexible: number[] = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (lockedEmpty.has(i) || lockedMine.has(i)) continue;
    flexible.push(i);
  }

  const minesNeeded = board.mineCount - lockedMine.size;
  if (minesNeeded < 0 || minesNeeded > flexible.length) return false;

  for (const i of flexible) board.cells[i].mine = false;
  for (const i of lockedMine) board.cells[i].mine = true;
  for (const i of lockedEmpty) board.cells[i].mine = false;

  shuffleInPlace(flexible, rngOf(board));
  for (let m = 0; m < minesNeeded; m++) {
    board.cells[flexible[m]].mine = true;
  }

  computeAdjacents(board);
  return true;
}

/** Random layout with a cleared first-click 3×3 (always a zero opening). */
function placeMinesWithZeroOpening(board: MinesweeperBoard, safeIndex: number): void {
  placeMinesRandom(board, safeIndex);
}

/**
 * No-guess generation (Simon Tatham / SGT Puzzles mines.c, MIT):
 * 1. Place mines with a cleared first-click neighbourhood (zero opening).
 * 2. Solve with local deductions (+ capped CSP).
 * 3. When stuck, fill or empty a random frontier set via `tathamPerturb`.
 * 4. After many local failures, allow a whole-unknown reshuffle; else restart.
 */
function placeMines(board: MinesweeperBoard, safeIndex: number): void {
  for (let restart = 0; restart < MAX_GENERATION_RESTARTS; restart++) {
    placeMinesWithZeroOpening(board, safeIndex);

    let localFails = 0;
    let bestRevealed = 0;
    let stagnant = 0;

    for (let step = 0; step < MAX_PERTURBATIONS; step++) {
      const progress = solveUntilStuck(board, safeIndex, GENERATION_CSP_VARS);
      if (progress.won) {
        if (solveUntilStuck(board, safeIndex, MAX_CSP_VARS).won) {
          board.minesPlaced = true;
          return;
        }
      }
      if (progress.lost) break;

      if (progress.revealedCount > bestRevealed) {
        bestRevealed = progress.revealedCount;
        stagnant = 0;
      } else {
        stagnant++;
      }
      if (stagnant >= 24) break;

      const allowBig = restart >= 2 || localFails >= BIG_PERTURB_AFTER || step >= BIG_PERTURB_AFTER;

      let didPerturb = false;
      if (progress.stuckSets.length > 0) {
        const set = progress.stuckSets[Math.floor(rngOf(board)() * progress.stuckSets.length)];
        didPerturb = tathamPerturb(board, safeIndex, progress.knownEmpty, progress.knownMines, set);
      }

      if (!didPerturb && allowBig) {
        didPerturb = tathamPerturb(
          board,
          safeIndex,
          progress.knownEmpty,
          progress.knownMines,
          null
        );
        if (!didPerturb) {
          didPerturb = perturbUnknownMines(
            board,
            safeIndex,
            progress.knownEmpty,
            progress.knownMines
          );
        }
      }

      if (!didPerturb) {
        localFails++;
        if (localFails > 8) break;
        continue;
      }

      localFails = 0;
    }
  }

  // Last resort: accept a zero-opening random layout (may require a guess).
  placeMinesWithZeroOpening(board, safeIndex);
  board.minesPlaced = true;
}

function revealAllMines(board: MinesweeperBoard): void {
  for (const cell of board.cells) {
    if (cell.mine && cell.state !== 'flagged') {
      if (cell.state === 'hidden') board.revealedCount++;
      cell.state = 'revealed';
    }
  }
}

/** Left-click / short press: dig a hidden cell, or flag-then-open chord on a number. */
export function revealCell(board: MinesweeperBoard, x: number, y: number): MinesweeperBoard {
  if (board.status !== 'playing' || !inBounds(board, x, y)) return board;

  const i = idx(board, x, y);
  const cell = board.cells[i];

  if (cell.state === 'flagged') return board;

  if (cell.state === 'revealed') {
    return chordCell(board, x, y);
  }

  if (!board.minesPlaced) placeMines(board, i);

  if (cell.mine) {
    cell.state = 'revealed';
    board.revealedCount++;
    board.status = 'lost';
    revealAllMines(board);
    return board;
  }

  revealFlood(board, x, y);
  checkWin(board);
  return board;
}

/**
 * Right-click / long press: toggle flag on a hidden cell.
 * Does not auto-open neighbors or cascade flags.
 */
export function toggleFlag(board: MinesweeperBoard, x: number, y: number): MinesweeperBoard {
  if (board.status !== 'playing' || !inBounds(board, x, y)) return board;

  const cell = board.cells[idx(board, x, y)];
  if (cell.state === 'revealed') return board;

  if (cell.state === 'flagged') {
    cell.state = 'hidden';
    board.flagCount--;
  } else {
    cell.state = 'flagged';
    board.flagCount++;
  }

  return board;
}

export function remainingMines(board: MinesweeperBoard): number {
  return Math.max(0, board.mineCount - board.flagCount);
}

/**
 * Replays `moves` on a fresh board generated from `seed`.
 * Server anti-cheat uses this: a score is accepted only when replay ends in `won`.
 */
export function verifySolve(
  seed: string,
  moves: ReadonlyArray<MinesweeperMove>,
  config: MinesweeperConfig = CHALLENGE
): { ok: boolean; status: GameStatus; reason?: string } {
  if (moves.length === 0) {
    return { ok: false, status: 'playing', reason: 'no_moves' };
  }
  if (moves[0].type !== 'reveal') {
    return { ok: false, status: 'playing', reason: 'first_must_reveal' };
  }

  const board = createBoard(config, seed);
  for (const move of moves) {
    if (board.status !== 'playing') break;
    if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) {
      return { ok: false, status: board.status, reason: 'invalid_coord' };
    }
    if (move.type === 'reveal') revealCell(board, move.x, move.y);
    else if (move.type === 'flag') toggleFlag(board, move.x, move.y);
    else return { ok: false, status: board.status, reason: 'invalid_move' };
  }

  if (board.status === 'won') return { ok: true, status: 'won' };
  if (board.status === 'lost') return { ok: false, status: 'lost', reason: 'hit_mine' };
  return { ok: false, status: board.status, reason: 'not_cleared' };
}
