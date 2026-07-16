/**
 * No-guess Minesweeper: mine layouts are accepted only when a logical solver
 * (basic chords + frontier CSP / "tank" enumeration) can clear the board from
 * the first click without guessing.
 *
 * During play, the same deductions power auto-flag / auto-reveal assists.
 */

export type CellState = 'hidden' | 'revealed' | 'flagged';

export interface Cell {
  mine: boolean;
  adjacent: number;
  state: CellState;
}

export type GameStatus = 'playing' | 'won' | 'lost';

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
}

export interface MinesweeperConfig {
  width: number;
  height: number;
  mineCount: number;
}

/** Beginner board that fits a settings modal. */
export const BEGINNER: MinesweeperConfig = { width: 9, height: 9, mineCount: 10 };

/** Max random layouts tried before accepting a fallback (should almost never hit). */
const MAX_GENERATION_ATTEMPTS = 400;

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

/** Creates an empty board; mines are placed on the first reveal. */
export function createBoard(config: MinesweeperConfig = BEGINNER): MinesweeperBoard {
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

  for (let m = 0; m < board.mineCount && candidates.length > 0; m++) {
    const pick = Math.floor(Math.random() * candidates.length);
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

/** Basic single-cell deductions (trivial chords). Returns whether anything changed. */
function applyBasicAssists(board: SolveState | MinesweeperBoard): boolean {
  let changed = false;

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
      if (remaining > 0 && remaining === hiddenCoords.length) {
        for (const [nx, ny] of hiddenCoords) {
          const n = board.cells[idx(board, nx, ny)];
          if (n.state !== 'hidden') continue;
          n.state = 'flagged';
          board.flagCount++;
          changed = true;
        }
      }
    }
  }

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
function applyCspAssists(board: SolveState | MinesweeperBoard): boolean {
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

  // Prefer one joint enumeration when the frontier is small enough (accurate global bounds).
  if (frontier.length <= MAX_CSP_VARS) {
    const { forcedMines, forcedSafe } = deduceForced(
      frontier,
      constraints,
      remaining,
      sea.length,
      true
    );
    if (applyForced(forcedMines, forcedSafe)) changed = true;
    if (board.status === 'lost') return true;
  } else {
    for (const component of frontierComponents(constraints, frontier)) {
      if (component.length > MAX_CSP_VARS) continue;
      const { forcedMines, forcedSafe } = deduceForced(
        component,
        constraints,
        remaining,
        sea.length,
        false
      );
      if (applyForced(forcedMines, forcedSafe)) changed = true;
      if (board.status === 'lost') return true;
    }
  }

  return changed;
}

/**
 * Runs logical assists until the board stabilizes (basic chords + CSP).
 * Used both during play and when verifying no-guess generation.
 */
export function runAutoAssists(board: MinesweeperBoard | SolveState): void {
  if (board.status !== 'playing') return;
  if ('minesPlaced' in board && !board.minesPlaced) return;

  let changed = true;
  let guard = 0;
  while (changed && board.status === 'playing' && guard < 400) {
    guard++;
    changed = applyBasicAssists(board);
    if (board.status !== 'playing') return;
    if (applyCspAssists(board)) changed = true;
  }

  if ('minesPlaced' in board && board.status === 'playing') {
    checkWin(board as MinesweeperBoard);
  }
}

/**
 * Returns true when a logical player can clear the board from `startIndex`
 * without guessing (first click + deductions only).
 */
export function isSolvableWithoutGuessing(board: MinesweeperBoard, startIndex: number): boolean {
  const sim = cloneSolveState(board);
  const sx = startIndex % board.width;
  const sy = Math.floor(startIndex / board.width);
  if (sim.cells[startIndex].mine) return false;

  revealFlood(sim, sx, sy);
  runAutoAssists(sim);

  return sim.status !== 'lost' && isWon(sim);
}

/**
 * Places a no-guess mine layout for the given first-click cell.
 * Retries random layouts until the logical solver can finish the board.
 */
function placeMines(board: MinesweeperBoard, safeIndex: number): void {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    placeMinesRandom(board, safeIndex);
    if (isSolvableWithoutGuessing(board, safeIndex)) {
      board.minesPlaced = true;
      return;
    }
  }

  // Extremely unlikely on beginner density; keep the last layout rather than hang.
  placeMinesRandom(board, safeIndex);
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

/** Left-click / short press: reveal a cell (or chord if already revealed). */
export function revealCell(board: MinesweeperBoard, x: number, y: number): MinesweeperBoard {
  if (board.status !== 'playing' || !inBounds(board, x, y)) return board;

  const i = idx(board, x, y);
  const cell = board.cells[i];

  if (cell.state === 'flagged') return board;

  if (cell.state === 'revealed') {
    runAutoAssists(board);
    return board;
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
  runAutoAssists(board);
  return board;
}

/** Right-click / long press: toggle flag on a hidden cell. */
export function toggleFlag(board: MinesweeperBoard, x: number, y: number): MinesweeperBoard {
  if (board.status !== 'playing' || !inBounds(board, x, y)) return board;

  const cell = board.cells[idx(board, x, y)];
  if (cell.state === 'revealed') {
    runAutoAssists(board);
    return board;
  }

  if (cell.state === 'flagged') {
    cell.state = 'hidden';
    board.flagCount--;
  } else {
    cell.state = 'flagged';
    board.flagCount++;
  }

  runAutoAssists(board);
  return board;
}

export function remainingMines(board: MinesweeperBoard): number {
  return Math.max(0, board.mineCount - board.flagCount);
}
