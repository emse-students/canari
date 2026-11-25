import type { MinesweeperBoard } from './game';

/**
 * The bulb of an UNRANKED game (owner, 2026-11-25): points at what justifies the next certain move,
 * never at the move itself. "Sans donner la reponse, cela oriente le regard."
 *
 * A pure, read-only function over what the PLAYER sees - the revealed numbers, the flags, the mine
 * total - so the deduction it points at is one a player could make. The hidden layout is read for
 * ONE thing only: telling a wrong flag apart (decision 2), which no visible state can prove.
 *
 * It does not reuse the engine's solver (`game.ts`): every helper there is private, the tiers MUTATE
 * the board they solve, and `game.ts` is held identical to the server's copy and frozen per
 * generator. So the reasoning is re-expressed here over the visible state, with its own budget, and
 * nothing here can change a board, a replay or a fingerprint.
 *
 * The answer is the CHEAPEST explanation, tried in a fixed order so that one visible state always
 * gives one hint:
 * 1. a wrong flag (the first in reading order);
 * 2. ONE number that settles some of its hidden neighbours alone (a chord);
 * 3. TWO overlapping numbers that settle a cell together (the 1-2 and 1-2-1 patterns, and their kin);
 * 4. a small group of numbers - the fewest found by growing rings around the settled cell, then
 *    dropping every number the deduction does not need;
 * 5. the mines-left counter, when only the total settles a cell.
 * Within a tier a deduction that opens a cell is preferred to one that flags a mine.
 *
 * Bounded by COUNTED search nodes, never a clock: every device stops at the same place.
 */

/** Search nodes one enumeration may spend before it is given up (relaxed: it then deduces nothing). */
const HINT_ENUM_NODE_BUDGET = 200_000;
/** Search nodes one hint may spend over all its enumerations. */
const HINT_NODE_BUDGET = 2_000_000;

/** Which kind of reasoning the highlighted numbers stand for. */
export type HintTier = 'single' | 'pair' | 'group';

/** What the bulb shows. Cell indices are row-major, as on the board. */
export type MinesweeperHint =
  /** These numbers, read together, settle at least one hidden cell. */
  | { kind: 'numbers'; tier: HintTier; cells: number[] }
  /** Only the mines left overall settle a cell: the HUD counter is what to look at. */
  | { kind: 'counter' }
  /** A flag stands on a cell that holds no mine. */
  | { kind: 'wrong-flag'; cell: number }
  /**
   * Nothing is certain. `complete` is false when a search gave up on its budget, so "nothing" is
   * not proven - the two are told apart because only the second can happen on a no-guess board.
   */
  | { kind: 'none'; complete: boolean };

/** One revealed number: the cell it is on, its still-hidden neighbours, and the mines they still hold. */
interface Constraint {
  cell: number;
  vars: number[];
  count: number;
}

/** Every way a set of hidden cells can hold mines under some constraints, summarised per mine count. */
interface Enumeration {
  vars: number[];
  /** False when the search gave up: nothing below is then known, and every count is allowed. */
  complete: boolean;
  achievable: boolean[];
  /** `mineAt[c][k]` / `safeAt[c][k]`: cell `vars[k]` is a mine / safe in some assignment of `c` mines. */
  mineAt: boolean[][];
  safeAt: boolean[][];
}

interface Budget {
  nodesLeft: number;
  /** Set once any enumeration was given up, so a "nothing" is not claimed as proven. */
  relaxed: boolean;
}

/** In-bounds neighbour indices of `i`, in reading order. */
function neighbours(board: Pick<MinesweeperBoard, 'width' | 'height'>, i: number): number[] {
  const x = i % board.width;
  const y = Math.floor(i / board.width);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < board.width && ny < board.height) {
        out.push(ny * board.width + nx);
      }
    }
  }
  return out;
}

/** The constraints a player reads off the screen, in reading order of the numbers. */
function visibleConstraints(board: MinesweeperBoard): Constraint[] {
  const out: Constraint[] = [];
  board.cells.forEach((cell, i) => {
    if (cell.state !== 'revealed' || cell.mine || cell.adjacent === 0) return;
    let flagged = 0;
    const vars: number[] = [];
    for (const n of neighbours(board, i)) {
      const state = board.cells[n].state;
      if (state === 'flagged') flagged++;
      else if (state === 'hidden') vars.push(n);
    }
    if (vars.length > 0) out.push({ cell: i, vars, count: cell.adjacent - flagged });
  });
  return out;
}

/**
 * Depth-first enumeration of every assignment of the constraints' cells that meets all of them. A
 * branch dies as soon as one equation cannot be met; past its node allowance the result is relaxed.
 */
function enumerate(constraints: readonly Constraint[], budget: Budget): Enumeration {
  const vars = [...new Set(constraints.flatMap((c) => c.vars))].sort((a, b) => a - b);
  const n = vars.length;
  const relaxed = (): Enumeration => {
    budget.relaxed = true;
    const all = () => Array.from({ length: n + 1 }, () => Array<boolean>(n).fill(true));
    return {
      vars,
      complete: false,
      achievable: Array<boolean>(n + 1).fill(true),
      mineAt: all(),
      safeAt: all(),
    };
  };
  const allowance = Math.min(HINT_ENUM_NODE_BUDGET, budget.nodesLeft);
  if (allowance <= 0) return relaxed();

  const indexOf = new Map(vars.map((v, k) => [v, k]));
  const equations = constraints.map((c) => ({ count: c.count, placed: 0, open: c.vars.length }));
  const equationsOf: number[][] = vars.map(() => []);
  constraints.forEach((c, ci) => {
    for (const v of c.vars) equationsOf[indexOf.get(v)!].push(ci);
  });
  const achievable = Array<boolean>(n + 1).fill(false);
  const mineAt = Array.from({ length: n + 1 }, () => Array<boolean>(n).fill(false));
  const safeAt = Array.from({ length: n + 1 }, () => Array<boolean>(n).fill(false));
  const assignment = Array<boolean>(n).fill(false);
  let nodes = 0;
  let exhausted = false;

  const search = (k: number, mines: number): void => {
    if (exhausted) return;
    if (++nodes > allowance) {
      exhausted = true;
      return;
    }
    if (k === n) {
      achievable[mines] = true;
      for (let j = 0; j < n; j++) (assignment[j] ? mineAt : safeAt)[mines][j] = true;
      return;
    }
    for (const mine of [false, true]) {
      let feasible = true;
      for (const ci of equationsOf[k]) {
        const eq = equations[ci];
        eq.open--;
        if (mine) eq.placed++;
        if (eq.placed > eq.count || eq.placed + eq.open < eq.count) feasible = false;
      }
      if (feasible) {
        assignment[k] = mine;
        search(k + 1, mine ? mines + 1 : mines);
      }
      for (const ci of equationsOf[k]) {
        const eq = equations[ci];
        eq.open++;
        if (mine) eq.placed--;
      }
    }
  };
  search(0, 0);
  budget.nodesLeft -= Math.min(nodes, allowance);
  if (exhausted) return relaxed();
  return { vars, complete: true, achievable, mineAt, safeAt };
}

/** Cells settled whatever the mine count: a mine in every assignment, or safe in every one. */
function forcedOf(e: Enumeration, allowedCount: (c: number) => boolean = () => true) {
  const safe: number[] = [];
  const mine: number[] = [];
  if (!e.complete) return { safe, mine };
  e.vars.forEach((cell, k) => {
    let canMine = false;
    let canSafe = false;
    for (let c = 0; c < e.achievable.length; c++) {
      if (!e.achievable[c] || !allowedCount(c)) continue;
      canMine ||= e.mineAt[c][k];
      canSafe ||= e.safeAt[c][k];
    }
    if (canMine && !canSafe) mine.push(cell);
    else if (canSafe && !canMine) safe.push(cell);
  });
  return { safe, mine };
}

/** True when `constraints` alone settle `target` (a mine or safe in every assignment). */
function settles(constraints: readonly Constraint[], target: number, budget: Budget): boolean {
  const { safe, mine } = forcedOf(enumerate(constraints, budget));
  return safe.includes(target) || mine.includes(target);
}

/** The first candidate that opens a cell, else the first that flags one: opening is preferred. */
function preferSafe<T>(candidates: { item: T; safe: boolean }[]): T | null {
  return (candidates.find((c) => c.safe) ?? candidates[0])?.item ?? null;
}

/** Tier "single": one number whose hidden neighbours are all safe, or all mines. */
function singleTier(constraints: readonly Constraint[]): Constraint | null {
  return preferSafe(
    constraints
      .filter((c) => c.count === 0 || c.count === c.vars.length)
      .map((c) => ({ item: c, safe: c.count === 0 }))
  );
}

/** Tier "pair": two numbers sharing a hidden neighbour that settle a cell together. */
function pairTier(constraints: readonly Constraint[], budget: Budget): Constraint[] | null {
  const candidates: { item: Constraint[]; safe: boolean }[] = [];
  for (let a = 0; a < constraints.length; a++) {
    for (let b = a + 1; b < constraints.length; b++) {
      if (!constraints[a].vars.some((v) => constraints[b].vars.includes(v))) continue;
      const { safe, mine } = forcedOf(enumerate([constraints[a], constraints[b]], budget));
      if (safe.length > 0 || mine.length > 0) {
        candidates.push({ item: [constraints[a], constraints[b]], safe: safe.length > 0 });
        // The first that opens a cell wins; nothing after it can be preferred.
        if (safe.length > 0) return preferSafe(candidates);
      }
    }
  }
  return preferSafe(candidates);
}

/** Splits the constraints into groups linked by shared hidden cells, smallest group first. */
function components(constraints: readonly Constraint[]): Constraint[][] {
  // Union-find over the constraints' positions: two constraints sharing a hidden cell are one group.
  const parent = constraints.map((_, k) => k);
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  const ownerOfCell = new Map<number, number>();
  constraints.forEach((c, k) => {
    for (const v of c.vars) {
      const other = ownerOfCell.get(v);
      if (other === undefined) ownerOfCell.set(v, k);
      else parent[root(other)] = root(k);
    }
  });
  const byRoot = new Map<number, Constraint[]>();
  constraints.forEach((c, k) => {
    const r = root(k);
    const list = byRoot.get(r);
    if (list) list.push(c);
    else byRoot.set(r, [c]);
  });
  return [...byRoot.values()].sort(
    (a, b) =>
      new Set(a.flatMap((c) => c.vars)).size - new Set(b.flatMap((c) => c.vars)).size ||
      a[0].cell - b[0].cell
  );
}

/**
 * The fewest numbers, found without searching every subset: grow rings of numbers around `target`
 * until they settle it (adding a number never unsettles a cell), then drop, in reading order, every
 * number the deduction still holds without. Every set kept settles `target`, so a budget spent
 * midway still leaves a true hint, only a larger one.
 */
function minimalSet(group: readonly Constraint[], target: number, budget: Budget): Constraint[] {
  let chosen = group.filter((c) => c.vars.includes(target));
  while (!settles(chosen, target, budget) && chosen.length < group.length) {
    const cells = new Set(chosen.flatMap((c) => c.vars));
    const ring = group.filter((c) => !chosen.includes(c) && c.vars.some((v) => cells.has(v)));
    if (ring.length === 0) break;
    chosen = [...chosen, ...ring];
  }
  if (!settles(chosen, target, budget)) chosen = [...group];
  chosen.sort((a, b) => a.cell - b.cell);
  for (const c of chosen) {
    const without = chosen.filter((other) => other !== c);
    if (without.length > 0 && settles(without, target, budget)) chosen = without;
  }
  return chosen;
}

/**
 * The hint for the player's current board. Pure and read-only: the same visible state (and, for a
 * wrong flag, the same layout) always gives the same answer.
 */
export function findHint(board: MinesweeperBoard): MinesweeperHint {
  console.debug('[minesweeper] hint requested', {
    revealed: board.revealedCount,
    flags: board.flagCount,
  });
  if (!board.minesPlaced || board.status !== 'playing') {
    console.debug('[minesweeper] hint: no game in progress');
    return { kind: 'none', complete: true };
  }

  const wrong = board.cells.findIndex((c) => c.state === 'flagged' && !c.mine);
  if (wrong >= 0) {
    console.debug('[minesweeper] hint: a misplaced flag', { cell: wrong });
    return { kind: 'wrong-flag', cell: wrong };
  }

  // Every flag is now a true mine, so the counts below are what the numbers really still need.
  const constraints = visibleConstraints(board);
  const budget: Budget = { nodesLeft: HINT_NODE_BUDGET, relaxed: false };
  const answer = (tier: HintTier, cs: readonly Constraint[]): MinesweeperHint => {
    const cells = cs.map((c) => c.cell).sort((a, b) => a - b);
    console.debug('[minesweeper] hint: numbers', {
      tier,
      cells,
      nodesSpent: HINT_NODE_BUDGET - budget.nodesLeft,
    });
    return { kind: 'numbers', tier, cells };
  };

  const single = singleTier(constraints);
  if (single) return answer('single', [single]);

  const pair = pairTier(constraints, budget);
  if (pair) return answer('pair', pair);

  const groups = components(constraints);
  const enumerations = groups.map((g) => enumerate(g, budget));
  const local = preferSafe(
    enumerations.flatMap((e, gi) => {
      const { safe, mine } = forcedOf(e);
      const target = safe[0] ?? mine[0];
      return target === undefined ? [] : [{ item: { gi, target }, safe: safe.length > 0 }];
    })
  );
  if (local) return answer('group', minimalSet(groups[local.gi], local.target, budget));

  if (globalSettlesSomething(board, enumerations)) {
    console.debug('[minesweeper] hint: the mines-left counter', {
      nodesSpent: HINT_NODE_BUDGET - budget.nodesLeft,
    });
    return { kind: 'counter' };
  }

  const complete = !budget.relaxed;
  if (complete) {
    // A no-guess board always has a next certain move: reaching this is the one outcome to look into.
    console.warn('[minesweeper] hint: nothing is certain on this board (search complete)', {
      revealed: board.revealedCount,
      flags: board.flagCount,
      generation: board.generationReport,
    });
  } else {
    console.info('[minesweeper] hint: nothing found within the search budget', {
      nodesSpent: HINT_NODE_BUDGET - budget.nodesLeft,
    });
  }
  return { kind: 'none', complete };
}

/**
 * The mines left overall: every group's possible counts, combined with the hidden cells no number
 * touches ("the sea"). A count no combination reaches is impossible; a cell only such counts allowed
 * either way is settled - by the total, which is what the counter shows.
 */
function globalSettlesSomething(
  board: MinesweeperBoard,
  enumerations: readonly Enumeration[]
): boolean {
  const remaining = board.mineCount - board.flagCount;
  const frontier = new Set(enumerations.flatMap((e) => e.vars));
  let seaSize = 0;
  board.cells.forEach((c, i) => {
    if (c.state === 'hidden' && !frontier.has(i)) seaSize++;
  });
  if (remaining < 0) {
    console.warn('[minesweeper] hint: more flags than mines with every flag on a mine', {
      remaining,
    });
    return false;
  }

  /** Sums reachable by `reach` plus one more group's counts, capped at `remaining`. */
  const add = (reach: boolean[], achievable: boolean[]): boolean[] => {
    const out = Array<boolean>(remaining + 1).fill(false);
    for (let have = 0; have <= remaining; have++) {
      if (!reach[have]) continue;
      for (let c = 0; c < achievable.length && have + c <= remaining; c++) {
        if (achievable[c]) out[have + c] = true;
      }
    }
    return out;
  };
  const start = Array.from({ length: remaining + 1 }, (_, i) => i === 0);
  const before: boolean[][] = [start];
  for (const e of enumerations) before.push(add(before[before.length - 1], e.achievable));
  const after: boolean[][] = Array.from({ length: enumerations.length + 1 }, () => start);
  for (let i = enumerations.length - 1; i >= 0; i--)
    after[i] = add(after[i + 1], enumerations[i].achievable);

  const seaFits = (total: number) => remaining - total >= 0 && remaining - total <= seaSize;
  const settledInGroup = enumerations.some((e, i) => {
    const others = add(before[i], after[i + 1]);
    const { safe, mine } = forcedOf(e, (c) => {
      for (let t = Math.max(0, remaining - seaSize - c); t <= remaining - c; t++) {
        if (others[t]) return true;
      }
      return false;
    });
    return safe.length > 0 || mine.length > 0;
  });
  if (settledInGroup) return true;
  if (seaSize === 0) return false;
  let canMine = false;
  let canSafe = false;
  before[enumerations.length].forEach((reachable, total) => {
    if (!reachable || !seaFits(total)) return;
    const inSea = remaining - total;
    if (inSea >= 1) canMine = true;
    if (inSea <= seaSize - 1) canSafe = true;
  });
  return canMine !== canSafe;
}
