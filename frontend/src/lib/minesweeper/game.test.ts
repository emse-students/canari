import {
  createBoard,
  revealCell,
  toggleFlag,
  chordCell,
  runAutoAssists,
  isSolvableWithoutGuessing,
  verifySolve,
  hashSeedToU32,
  solveTiered,
  createSolverContext,
  LATEST_GENERATOR_VERSION,
  DEFAULT_CONFIG,
  CHALLENGE,
  type MinesweeperBoard,
  type Cell,
} from './game';

function makeBoard(
  width: number,
  height: number,
  minePositions: Array<[number, number]>
): MinesweeperBoard {
  const board = createBoard({ width, height, mineCount: minePositions.length });
  board.minesPlaced = true;
  for (const [x, y] of minePositions) {
    board.cells[y * width + x].mine = true;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (board.cells[i].mine) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (board.cells[ny * width + nx].mine) count++;
        }
      }
      board.cells[i].adjacent = count;
    }
  }
  return board;
}

function cellAt(board: MinesweeperBoard, x: number, y: number): Cell {
  return board.cells[y * board.width + x];
}

describe('minesweeper', () => {
  it('defaults to the 18x32 / 150-mine challenge board', () => {
    const board = createBoard();
    expect(board.width).toBe(18);
    expect(board.height).toBe(32);
    expect(board.mineCount).toBe(150);
    expect(DEFAULT_CONFIG).toEqual(CHALLENGE);
  });

  it('first reveal places mines and never detonates the clicked cell', () => {
    const board = createBoard({ width: 5, height: 5, mineCount: 5 });
    revealCell(board, 2, 2);
    expect(board.minesPlaced).toBe(true);
    expect(cellAt(board, 2, 2).mine).toBe(false);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).not.toBe('lost');
  });

  it('toggles flags and does not auto-open after flagging', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    for (const [x, y] of [
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    // Only the mine at (0,0) is still hidden; flagging it must NOT auto-open/win.
    toggleFlag(board, 0, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(board.status).toBe('playing');
  });

  it('does not auto-flag after digging; flags only when clicking the number', () => {
    // Mines at top corners. Digging (1,0) must leave mines hidden until the number is clicked.
    const board = makeBoard(3, 3, [
      [0, 0],
      [2, 0],
    ]);
    for (const c of board.cells) c.state = 'hidden';
    for (const [x, y] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [0, 2],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    revealCell(board, 1, 0);
    expect(cellAt(board, 1, 0).state).toBe('revealed');
    expect(cellAt(board, 0, 0).state).toBe('hidden');
    expect(cellAt(board, 2, 0).state).toBe('hidden');

    // Click the number → places both flags.
    revealCell(board, 1, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(cellAt(board, 2, 0).state).toBe('flagged');
    expect(cellAt(board, 1, 2).state).toBe('hidden');
    expect(board.status).toBe('playing');
  });

  it('clicking a number flags when hidden count matches, else opens when flags match', () => {
    const board = makeBoard(3, 3, [
      [0, 0],
      [2, 0],
    ]);
    for (const c of board.cells) c.state = 'hidden';
    for (const [x, y] of [
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    // (1,0) shows 2 with exactly two hidden neighbors → click places flags only.
    revealCell(board, 1, 0);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(cellAt(board, 2, 0).state).toBe('flagged');
    expect(board.status).toBe('playing');

    // Fresh board: flags already match → click opens the rest.
    const board2 = makeBoard(3, 3, [[0, 0]]);
    for (const c of board2.cells) c.state = 'hidden';
    cellAt(board2, 1, 1).state = 'revealed';
    board2.revealedCount = 1;
    cellAt(board2, 0, 0).state = 'flagged';
    board2.flagCount = 1;
    revealCell(board2, 1, 1);
    expect(cellAt(board2, 2, 2).state).toBe('revealed');
    expect(board2.status).toBe('won');
  });

  it('manual chord opens neighbors when flags match the number', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    cellAt(board, 0, 0).state = 'flagged';
    board.flagCount = 1;
    chordCell(board, 1, 1);
    expect(cellAt(board, 2, 2).state).toBe('revealed');
    expect(board.status).toBe('won');
  });

  it('manual chord does nothing when flags do not match', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    chordCell(board, 1, 1);
    expect(cellAt(board, 0, 0).state).toBe('hidden');
    expect(board.status).toBe('playing');
  });

  it('solver auto-assists still clear a trivial endgame (generation path)', () => {
    const board = makeBoard(3, 3, [[0, 0]]);
    for (const c of board.cells) c.state = 'hidden';
    cellAt(board, 1, 1).state = 'revealed';
    board.revealedCount = 1;
    for (const [x, y] of [
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ] as const) {
      cellAt(board, x, y).state = 'revealed';
      board.revealedCount++;
    }
    runAutoAssists(board);
    expect(cellAt(board, 0, 0).state).toBe('flagged');
    expect(board.status).toBe('won');
  });

  it('loses when revealing a mine', () => {
    const board = makeBoard(2, 2, [[0, 0]]);
    board.minesPlaced = true;
    revealCell(board, 0, 0);
    expect(board.status).toBe('lost');
    expect(cellAt(board, 0, 0).state).toBe('revealed');
  });

  it('generates challenge boards that are solvable without guessing', () => {
    // Seeded on purpose. No-guess generation at 26% density is rejection sampling with full
    // board restarts, so its cost is a heavy-tailed random variable: unseeded, the same
    // assertion took 31s on a CI runner and failed a wall-clock budget of 15s. Fixing the seed
    // makes the amount of work reproducible; the `it` timeout below is the guard against a
    // generator that stops terminating. Timing belongs in a benchmark, not in this assertion.
    const board = createBoard(CHALLENGE, 'challenge-no-guess-fixture-001');
    const startX = 9;
    const startY = 16;
    revealCell(board, startX, startY);
    expect(board.minesPlaced).toBe(true);
    expect(board.status).not.toBe('lost');
    const startIndex = startY * board.width + startX;
    expect(isSolvableWithoutGuessing(board, startIndex)).toBe(true);
    runAutoAssists(board);
    expect(board.status).toBe('won');
  }, 30_000);

  it('detects a layout that still requires a guess after the opening', () => {
    const board = makeBoard(2, 2, [[0, 0]]);
    expect(isSolvableWithoutGuessing(board, 3)).toBe(false);
  });

  it('seeded generation is deterministic for the same first click', () => {
    const seed = 'ranked-fixture-seed-001';
    const a = createBoard({ width: 9, height: 9, mineCount: 10 }, seed);
    const b = createBoard({ width: 9, height: 9, mineCount: 10 }, seed);
    revealCell(a, 4, 4);
    revealCell(b, 4, 4);
    expect(a.cells.map((c) => (c.mine ? 1 : 0)).join('')).toBe(
      b.cells.map((c) => (c.mine ? 1 : 0)).join('')
    );
  });

  it('seeded challenge boards match their recorded fingerprints', () => {
    // The server replays a ranked game on the board regenerated from its seed, so ANY change
    // to generation - solver deductions, neighbor order, RNG draws - silently rejects every
    // challenge still open when it deploys. These fingerprints were recorded before the
    // solver's 2026-09-24 speed-up; a failure here means the change altered the boards, not
    // just their cost. Update them only when that is the intent.
    const fixtures: Array<[string, number, number, number]> = [
      ['8601e326fcef5ef936a1c69d6ab6ac41', 0, 31, 3410185195],
      ['8601e326fcef5ef936a1c69d6ab6ac41', 9, 16, 2788063149],
      ['ranked-golden-fixture-002', 17, 0, 420646431],
    ];
    for (const [seed, x, y, fingerprint] of fixtures) {
      const board = createBoard(CHALLENGE, seed);
      revealCell(board, x, y);
      const layout = board.cells.map((c) => (c.mine ? '1' : '0')).join('');
      expect(hashSeedToU32(layout)).toBe(fingerprint);
    }
  }, 30_000);

  it('verifySolve rejects empty or incomplete move lists', () => {
    expect(verifySolve('seed', []).ok).toBe(false);
    expect(verifySolve('seed', [{ type: 'flag', x: 0, y: 0 }]).ok).toBe(false);
  });
});

describe('generator v2 (2026-11-13)', () => {
  const fixtures: Array<[string, number, number, number]> = [
    ['8601e326fcef5ef936a1c69d6ab6ac41', 0, 31, 3181686381],
    ['8601e326fcef5ef936a1c69d6ab6ac41', 9, 16, 434082617],
    ['ranked-golden-fixture-002', 17, 0, 3207965141],
  ];
  const layoutOf = (board: MinesweeperBoard) =>
    board.cells.map((c) => (c.mine ? '1' : '0')).join('');

  it('is opt-in: a board made without a version uses generator 1, and v2 is the latest', () => {
    expect(createBoard(CHALLENGE, 'seed').generator).toBe(1);
    expect(LATEST_GENERATOR_VERSION).toBe(2);
  });

  it('seeded v2 boards match their recorded fingerprints', () => {
    // Same rule as v1: the server replays on what ITS generator makes from (seed, first click, version),
    // so ANY change to v2 - a tier, a weight, the swap order, a draw from the RNG - rejects every v2
    // challenge open at deploy time. A change of that kind is a NEW version, never an edit of this one.
    for (const [seed, x, y, fingerprint] of fixtures) {
      const board = createBoard(CHALLENGE, seed, 2);
      revealCell(board, x, y);
      expect(hashSeedToU32(layoutOf(board))).toBe(fingerprint);
    }
  }, 60_000);

  it('the same seed gives different boards under v1 and v2', () => {
    const [seed, x, y] = fixtures[1];
    const v1 = createBoard(CHALLENGE, seed, 1);
    const v2 = createBoard(CHALLENGE, seed, 2);
    revealCell(v1, x, y);
    revealCell(v2, x, y);
    expect(layoutOf(v1)).not.toBe(layoutOf(v2));
  }, 30_000);

  it('a v2 board is clearable without guessing and reaches the target score', () => {
    for (const [seed, x, y] of fixtures) {
      const board = createBoard(CHALLENGE, seed, 2);
      revealCell(board, x, y);
      const report = board.generationReport!;
      expect(report.fellBack).toBe(false);
      expect(report.reachedTarget).toBe(true);
      // Solved again from the finished layout, so the claim is about the board and not the climb.
      const solve = solveTiered(board, y * board.width + x, createSolverContext());
      expect(solve.won).toBe(true);
      expect(solve.score).toBe(report.score);
      expect(solve.score).toBeGreaterThanOrEqual(report.targetScore);
    }
  }, 60_000);

  it('keeps the first click and its neighbours free of mines', () => {
    const board = createBoard(CHALLENGE, 'v2-safe-zone', 2);
    revealCell(board, 0, 0);
    for (const i of [0, 1, CHALLENGE.width, CHALLENGE.width + 1])
      expect(board.cells[i].mine).toBe(false);
    expect(board.cells.filter((c) => c.mine)).toHaveLength(CHALLENGE.mineCount);
  }, 30_000);

  it('verifySolve replays on the version named: the board of one is a loss on the other', () => {
    const [seed, x, y] = fixtures[0];
    const made = createBoard(CHALLENGE, seed, 2);
    revealCell(made, x, y);
    // A winning log for the v2 board: the first click, then every other safe cell.
    const moves: Array<{ type: 'reveal'; x: number; y: number }> = [{ type: 'reveal', x, y }];
    made.cells.forEach((c, i) => {
      if (!c.mine) moves.push({ type: 'reveal', x: i % made.width, y: Math.floor(i / made.width) });
    });
    expect(verifySolve(seed, moves, CHALLENGE, 2).ok).toBe(true);
    expect(verifySolve(seed, moves, CHALLENGE, 1).ok).toBe(false);
  }, 60_000);

  it('fails loudly on a generator version it does not know, never playing it as another', () => {
    const board = createBoard(CHALLENGE, 'seed', 3 as never);
    expect(() => revealCell(board, 0, 0)).toThrow(/unknown minesweeper generator version 3/);
  });

  it('a spent search budget only makes the solver deduce less, never wrongly', () => {
    const [seed, x, y] = fixtures[1];
    const board = createBoard(CHALLENGE, seed, 2);
    revealCell(board, x, y);
    const full = solveTiered(board, y * board.width + x, createSolverContext());
    const spent = createSolverContext();
    spent.nodesLeft = 0;
    const starved = solveTiered(board, y * board.width + x, spent);
    expect(full.won).toBe(true);
    // Refusing every enumeration cannot clear MORE than enumerating can.
    expect(starved.won && starved.score > full.score).toBe(false);
  }, 30_000);

  it('verifySolve hands back what generation did, so the server can log a fall-back', () => {
    const [seed, x, y] = fixtures[0];
    const made = createBoard(CHALLENGE, seed, 2);
    revealCell(made, x, y);
    const moves: Array<{ type: 'reveal'; x: number; y: number }> = [{ type: 'reveal', x, y }];
    made.cells.forEach((c, i) => {
      if (!c.mine) moves.push({ type: 'reveal', x: i % made.width, y: Math.floor(i / made.width) });
    });
    const verdict = verifySolve(seed, moves, CHALLENGE, 2);
    expect(verdict.generation).toMatchObject({ fellBack: false, reachedTarget: true });
    expect(verdict.generation!.searchNodes).toBeGreaterThan(0);
    expect(verifySolve('seed', []).generation).toBeUndefined();
  }, 60_000);
});
