#!/usr/bin/env bun
/**
 * ONE MACHINE-WIDE SLOT FOR THE CHECKS THAT USE EVERY CORE.
 *
 * Every git hook on this machine runs its checks in its own worktree, and several sessions push at
 * once. Each `vitest` sizes its pool from the cores (`availableParallelism() - 1`, 15 here) and
 * knows nothing of the others, so five concurrent pushes put five suites, a cargo build and a
 * `svelte-check` on 16 cores: measured 2026-11-22, a run queue of 69 to 92 threads, paging at
 * 4,000 to 27,000 pages a second, and tests that take 16 ms of CPU failing vitest's 5 s wall-clock
 * deadline. The deadline was measuring the machine. This slot is what bounds the machine: a check
 * that uses every core waits for the one already running, in arrival order, and starts on a
 * machine it has to itself (docs/wiki/test-suite-reform.md, the sixth load reading).
 *
 * THE SLOT IS A LISTENING SOCKET, NOT A FILE. The kernel gives one address to one listener and
 * takes it back when that process dies, however it dies, so there is no stale lock to detect and no
 * clock deciding that one is stale. A waiter connects to the holder and waits for the connection
 * to CLOSE - an event, not a poll - then tries again. Windows: a named pipe; Linux: an abstract
 * socket; macOS has neither, so a socket file whose only stale case (a holder killed outright) is
 * recognised by a refused connection, the one fact that says nobody listens.
 *
 * Usage, from bash (`local-ci.sh` `run_check` is the caller):
 *   coproc SLOT { exec bun .github/scripts/machine-slot.mjs <label>; }
 *   read -r granted <&"${SLOT[0]}"     # one line, `granted`, once the slot is held
 *   ... the check ...
 *   exec {SLOT[1]}>&-                   # end of stdin releases it; so does the caller dying
 *
 * Status lines (who it waits for, how long it waited) go to stderr, which is the terminal.
 * CANARI_MACHINE_SLOT_NAME names another slot (the self-test uses a private one).
 */
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const label = process.argv[2] || 'unnamed check';

/** The one address every checkout on this machine agrees on (a self-test names its own). */
function slotAddress() {
  const name = process.env.CANARI_MACHINE_SLOT_NAME || 'canari-machine-slot';
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  return join(tmpdir(), `${name}.sock`);
}

const address = slotAddress();
const since = Date.now();
const say = (line) => process.stderr.write(`machine-slot: ${line}\n`);
/** Who holds the slot, said once per holder rather than once per retry. */
let announced = '';

/** Holds the slot until stdin ends, telling each waiter who holds it. */
function hold(server) {
  const waited = Math.round((Date.now() - since) / 1000);
  if (waited > 0) say(`${label} took the slot after waiting ${waited}s`);
  process.stdout.write('granted\n');
  const release = () => {
    server.close();
    process.exit(0);
  };
  process.stdin.on('end', release);
  process.stdin.on('close', release);
  process.stdin.resume();
}

/** Waits for the current holder to go, then tries again. */
function waitForHolder() {
  const conn = net.connect(address);
  let holder = '';
  conn.on('data', (chunk) => {
    holder += String(chunk);
    const line = holder.split('\n')[0];
    if (holder.includes('\n') && line !== announced) {
      announced = line;
      say(`${label} waits for ${line}`);
    }
  });
  conn.on('close', (hadError) => {
    if (!hadError) acquire();
  });
  conn.on('error', (e) => {
    // The holder left between our refused listen and this connect: the address is free again.
    if (e.code === 'ENOENT') return acquire();
    // A socket FILE nobody listens on: its holder was killed before it could remove it. Only the
    // file-backed address (macOS) can leave one; the pipe and the abstract socket vanish with it.
    if (e.code === 'ECONNREFUSED' && !address.startsWith('\0') && process.platform !== 'win32') {
      say(`${label} found a slot file nobody listens on (a holder killed outright) and removes it`);
      try {
        unlinkSync(address);
      } catch (unlinkError) {
        say(`could not remove ${address}: ${unlinkError.message}`);
      }
      return acquire();
    }
    say(`cannot reach the holder of ${address}: ${e.code} ${e.message}`);
    process.exit(2);
  });
}

function acquire() {
  // The connection stays OPEN: its close, when this process exits, is the waiter's signal.
  const server = net.createServer((conn) => {
    conn.write(`${label} (pid ${process.pid}, ${process.cwd()})\n`);
    // A waiter that went away (its push was cancelled): nothing here depends on it.
    conn.on('error', (e) => say(`a waiter left (${e.code})`));
  });
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') return waitForHolder();
    say(`cannot listen on ${address}: ${e.code} ${e.message}`);
    process.exit(2);
  });
  server.listen(address, () => hold(server));
}

acquire();
