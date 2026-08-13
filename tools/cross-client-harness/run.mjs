#!/usr/bin/env node
/**
 * THE ONE WAY TO RUN THE CAMPAIGN.
 *
 *   node run.mjs                      what exists, what is covered, what is not
 *   node run.mjs MSG                  every script of one phase
 *   node run.mjs MSG TYPE READ        several phases, in order
 *   node run.mjs --file msg3.mjs      one script, still with the preflight
 *   node run.mjs --all                every phase that has a script
 *   node run.mjs MSG --no-preflight   only when you have just checked the clients yourself
 *
 * WHY THIS EXISTS. Three things were rediscovered by hand every session, and each of them produced
 * a wrong answer at least once:
 *
 * 1. WHICH SCRIPT COVERS WHAT. The mapping lived in nobody's head twice the same way. It is now in
 *    `checks.mjs`, next to the prerequisites the dashboard states but the scripts never checked.
 *
 * 2. WHETHER THE CLIENTS WERE READY. Almost every "the check does not work" turned out to be a
 *    locked PIN, a client that had dropped off adb, or a phone whose app was in the background - and
 *    none of those FAIL honestly. A locked client answers, renders, and reports on an empty store;
 *    a backgrounded WebView keeps its devtools socket listed and its forward succeeds, while CDP
 *    never answers. So the preflight runs FIRST and refuses to start rather than producing a
 *    verdict nobody should believe.
 *
 * 3. WHAT THE RUN ACTUALLY SAID. Verdicts were read off stdout, which is wrong: several scripts
 *    print a raw observation dump after their verdict, so "the last lines" is not the answer, and a
 *    run of twelve scripts scrolled past. `results.ndjson` is the record; this reads back only the
 *    rows appended after the run started and prints them as one table.
 *
 * Exit code is 1 if anything FAILed or was INVALID, so it can gate something later.
 */
import { spawn, spawnSync } from 'node:child_process';
import { PHASES } from './checks.mjs';
import { client, evaluate } from './chat.mjs';
import { ORIGIN, PORTS } from './names.mjs';
import { all } from './results.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const named = argv.filter((a) => !a.startsWith('--'));

// ---------------------------------------------------------------------------- preflight

/**
 * Is a client reachable, unlocked, and on a route that can answer that question?
 *
 * `unknown` is a real answer and the honest one: the PIN gate only mounts where the encryption
 * state is needed, so on `/posts` a fully locked client shows no gate at all. Reporting that as
 * "unlocked" is how a drain investigation was once run entirely against a locked phone.
 */
const READY = `(function () {
  var sidebar = document.querySelectorAll('aside button, nav button').length;
  return JSON.stringify({
    path: location.pathname,
    ready: document.readyState,
    locked: (function () {
      var gate = !!document.querySelector('#encryption-pin') ||
        document.body.innerText.indexOf('PIN de chiffrement') !== -1;
      if (gate) return 'LOCKED';
      if (!/^\\/(chat|communities)/.test(location.pathname)) return 'unknown';
      // NOT SEEING THE GATE IS NOT BEING PAST IT. A booting client shows no gate either -
      // 'readyState' reaches 'complete' while the app is still deciding whether the encryption key
      // is available - so the absence alone reported "unlocked" about a client one second away from
      // raising the prompt. Measured 2026-08-13 on all three clients at once, straight after
      // reload.mjs. Something RENDERED is the proof; until then the honest answer is 'booting'.
      return sidebar > 0 ? 'unlocked' : 'booting';
    })(),
    sidebar: sidebar,
    // A MODAL LEFT OPEN BY THE PREVIOUS CHECK, WHICH NO OTHER PROBE CAN SEE. The client is reachable,
    // unlocked, on /chat and rendering a full sidebar - every existing signal says ready - while an
    // overlay sits on top and swallows the first click the next check makes. Measured 2026-08-14:
    // MSG-5 left the "Ajouter un canal" dialog up and the four scripts after it died inside
    // ensureChat, each reporting a navigation the app was perfectly able to perform. (No backticks
    // in this comment: it lives inside a template literal, and one would end the string here.)
    overlay: (function () {
      var n = 0;
      var all = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
      for (var i = 0; i < all.length; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) n++;
      }
      return n;
    })()
  });
})()`;

/** Reads a client's state, or throws if nothing is listening. */
async function readiness(d) {
  const cx = await client(PORTS[d], null, { focus: false });
  const s = JSON.parse(await evaluate(cx, READY));
  cx.close();
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a harness script to completion and resolves its exit code. */
const runScript = (args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, args, {
      cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: 'ignore',
    });
    c.on('close', resolve);
  });

/**
 * THE PREFLIGHT REPAIRS WHAT IT CAN, AND SAYS SO EVERY TIME.
 *
 * Two states are expected rather than exceptional - a fresh tab starts at the PIN gate, and a client
 * left on `/posts` cannot prove it is unlocked because the gate does not mount there - so refusing
 * to run over either would just move a manual step from one place to another. Both are repaired.
 *
 * They are repaired LOUDLY. A silent repair would hide the thing worth knowing: which check left the
 * instrument in that state. TYPE-3 closes a tab by design and W1 comes back locked; that is fine and
 * it should be visible, because the day it is something else, the line is the only warning.
 *
 * AND EACH REPAIR CAN PRODUCE THE STATE THE OTHER ONE EXISTS TO FIX, so they run in a LOOP rather
 * than once each in a fixed order. Unlocking lands the client wherever it already was - on `/posts`
 * for a freshly launched phone - which is precisely the `unknown` the navigation repairs; running
 * the navigation first and the unlock second therefore refuses a client that was one step from
 * ready. Seen 2026-08-13: A1 launched, gate up, `fix ... unlocking` then `REFUSING TO RUN - still
 * unknown on /posts after repair`, with the phone unlocked and healthy the whole time.
 *
 * The bound is on PASSES, not on time, and exhausting it reports the trail rather than the last
 * state alone: `LOCKED -> unknown -> LOCKED` is a client re-locking on every navigation, which is a
 * different fault from one that never moves, and the last state cannot tell them apart.
 */
const MAX_REPAIR_PASSES = 4;

/**
 * Ready is BOTH conditions, and the second one was added after it cost four checks in one run.
 *
 * Being unlocked says the client can answer; carrying no overlay says the next click will reach what
 * it aims at. Neither implies the other, and the state that broke the 2026-08-14 run satisfied every
 * part of the first while failing the second.
 */
const isReady = (s) => s.locked === 'unlocked' && !s.overlay;

/**
 * Dismisses a modal the way a user would, and returns without asserting anything.
 *
 * Escape first, because every dialog in this app closes on it and it needs no selector - a close
 * control has to be FOUND, and the find is exactly what an overlay makes unreliable. The labelled
 * button is the second attempt, not a fallback for a failure: the two are one repair, and the caller
 * re-reads the state afterwards and reports if the overlay is still there.
 */
async function dismissOverlay(d) {
  const cx = await client(PORTS[d], null, { focus: false });
  for (const type of ['rawKeyDown', 'keyUp'])
    await cx.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(600);
  await evaluate(
    cx,
    `(function () {
      var b = document.querySelector('[role="dialog"] [aria-label="Fermer"], [aria-modal="true"] [aria-label="Fermer"]');
      if (b) b.click();
    })()`
  );
  cx.close();
  await sleep(600);
}

async function preflight(devices, { quiet = false } = {}) {
  const problems = [];
  for (const d of devices) {
    let s;
    try {
      s = await readiness(d);
    } catch {
      // A1's own message ("fetch failed") sends the reader to the network rather than to the phone,
      // which is where every one of these has actually been.
      const hint =
        d === 'A1'
          ? ' - phone off adb, app not running, or app in the BACKGROUND (a backgrounded WebView keeps its devtools socket listed and its forward succeeds, and still never answers CDP)'
          : ' - browser closed? `node launch.mjs start w1`';
      problems.push(`${d}: unreachable on ${PORTS[d]}${hint}`);
      continue;
    }

    const state = (x) => (x.overlay ? `${x.locked}+overlay` : x.locked);
    const trail = [state(s)];
    for (let pass = 0; pass < MAX_REPAIR_PASSES && !isReady(s); pass++) {
      if (s.locked === 'unlocked' && s.overlay) {
        console.log(`  fix  ${d.padEnd(3)} ${s.overlay} dialog(s) still open on ${s.path} - dismissing`);
        await dismissOverlay(d);
      } else if (s.locked === 'unknown') {
        console.log(`  fix  ${d.padEnd(3)} on ${s.path}, where the PIN gate does not mount - sending it to /chat`);
        const cx = await client(PORTS[d], null, { focus: false });
        // ORIGIN[d], never SITE: the phone's app is served from `tauri.localhost`, and sending its
        // WebView to the public site leaves the app rather than reloading it - the Tauri plugin
        // allowlist is scoped to that origin, so every request then fails silently and the client
        // reads as stuck. This preflight would have done it on EVERY run touching A1.
        await evaluate(cx, `location.href = ${JSON.stringify(`${ORIGIN[d]}/chat`)}`);
        cx.close();
        await sleep(5000);
      } else if (s.locked === 'booting') {
        // Nothing to repair - the app is coming up. Acting here would type a PIN into a page that
        // has not raised the prompt yet, and then read the failure as the client's.
        console.log(`  wait ${d.padEnd(3)} on ${s.path}, no gate and nothing rendered yet - still booting`);
        await sleep(3000);
      } else {
        console.log(`  fix  ${d.padEnd(3)} PIN gate is up - unlocking`);
        await runScript(['pin.mjs', '--device', d]);
        await sleep(1500);
      }
      s = await readiness(d).catch(() => s);
      trail.push(state(s));
    }

    if (!isReady(s))
      problems.push(`${d}: still ${state(s)} on ${s.path} after ${trail.length - 1} repair(s) - ${trail.join(' -> ')}`);
    else if (!s.sidebar) problems.push(`${d}: on ${s.path} with an EMPTY sidebar - nothing has loaded`);
    else if (!quiet) console.log(`  ok   ${d.padEnd(3)} ${s.path} unlocked, ${s.sidebar} sidebar rows`);
  }

  // UNLOCKED IS NOT CONNECTED, and no readiness probe above can tell the difference. MSG-2 spent a
  // run on that gap: a phone that was unlocked, rendering, and holding no socket, whose message
  // arrived on its next reconnect 28 s after the check gave up - a delivery check measuring the
  // transport's absence, and unattributable because nothing had asked. `presence.mjs` asks the
  // GATEWAY, which is the only place that answers for all three clients: a Tauri socket lives in
  // Rust, so the WebView can never be watched for frames.
  const ports = [...devices].map((d) => PORTS[d]).filter(Boolean);
  if (ports.length) {
    const r = spawnSync(process.execPath, ['presence.mjs', '--ports', ports.join(',')], {
      cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      encoding: 'utf8',
    });
    for (const line of String(r.stdout || '').trim().split('\n').filter(Boolean)) {
      const online = /ONLINE/.test(line);
      if (!online || !quiet) console.log(`  ${online ? 'ok  ' : 'STOP'} ${line}`);
    }
    if (r.status !== 0) problems.push('at least one client is not connected to the gateway - see the lines above');
  }

  return problems;
}

// ---------------------------------------------------------------------------- listing

if (!named.length && !flag('all') && !flag('file')) {
  console.log('\nPHASES\n');
  let covered = 0;
  let bare = 0;
  for (const [name, p] of Object.entries(PHASES)) {
    const n = p.scripts.length;
    if (n) covered++;
    else bare++;
    console.log(
      `  ${name.padEnd(8)} ${String(n).padStart(2)} script(s)  needs ${p.needs.join(' ')}  - ${p.title}` +
        (n ? '' : '   << NO COVERAGE')
    );
  }
  console.log(`\n  ${covered} phase(s) with a script, ${bare} with none.`);
  console.log('\n  node run.mjs MSG          run a phase');
  console.log('  node run.mjs --all        run every phase that has a script');
  console.log('  node run.mjs --file x.mjs run one script\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------- selection

let jobs = [];
let devices = new Set();

if (flag('file')) {
  const f = argv[argv.indexOf('--file') + 1];
  if (!f) throw new Error('--file needs a script name');
  jobs.push({ phase: '(file)', script: f });
  for (const d of ['W1', 'W2']) devices.add(d);
} else {
  const wanted = flag('all') ? Object.keys(PHASES).filter((p) => PHASES[p].scripts.length) : named;
  for (const name of wanted) {
    const p = PHASES[name];
    if (!p) throw new Error(`unknown phase ${name} - known: ${Object.keys(PHASES).join(' ')}`);
    if (!p.scripts.length) {
      console.log(`  skip ${name}: no script exists for this phase yet`);
      continue;
    }
    for (const d of p.needs) devices.add(d);
    for (const s of p.scripts) jobs.push({ phase: name, script: s });
  }
}
if (!jobs.length) {
  console.log('nothing to run');
  process.exit(0);
}

// ---------------------------------------------------------------------------- go

if (!flag('no-preflight')) {
  console.log(`\nPREFLIGHT (${[...devices].join(' ')})\n`);
  const problems = await preflight([...devices]);
  if (problems.length) {
    console.log('\nREFUSING TO RUN - a check against a client in this state does not fail, it lies:\n');
    for (const p of problems) console.log(`  ${p}`);
    console.log('');
    process.exit(2);
  }
}

const startedAt = new Date().toISOString();
console.log(`\nRUNNING ${jobs.length} script(s)\n`);

/**
 * THE PREFLIGHT IS A PRECONDITION OF EVERY SCRIPT, NOT AN OPENING CEREMONY.
 *
 * It used to run once, before the first job, and the eleven scripts after that one started from
 * whatever the previous script happened to leave behind. That is not a phase that can be re-run to
 * show a system is healthy - its result depends on the ORDER and on the leftovers, so a green run
 * proves nothing about the next one, which is the whole property being asked for here.
 *
 * It cost a real diagnosis on 2026-08-14: MSG-5 left a dialog open, and MSG-1b, MSG-6/7, MSG-9 and
 * MSG-10 all died inside `ensureChat` pointing at an application that was working perfectly. Four
 * checks accusing the wrong component is worse than four checks not running.
 *
 * So a job whose clients cannot be brought to a known state is BLOCKED and says so, rather than
 * running and producing a verdict about the previous script's mess.
 */
for (const job of jobs) {
  const [file, ...args] = job.script.split(' ');
  if (!flag('no-preflight')) {
    const problems = await preflight([...devices], { quiet: true });
    if (problems.length) {
      job.exit = null;
      job.blocked = problems.join('; ');
      console.log(`  ${job.phase.padEnd(8)} ${job.script.padEnd(22)} BLOCKED - ${job.blocked}`);
      continue;
    }
  }
  process.stdout.write(`  ${job.phase.padEnd(8)} ${job.script.padEnd(22)} `);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    // Kept, not discarded: a script that dies says why on stderr, and that sentence is the whole
    // difference between "the app is broken" and "this script points at a port nothing listens on".
    child.stdout.on('data', (b) => (tail += b));
    child.stderr.on('data', (b) => (tail += b));
    child.on('close', (c) => {
      job.tail = tail.split('\n').filter((l) => l.trim()).slice(-4).join('\n      ');
      resolve(c);
    });
  });
  job.exit = code;
  console.log(code === 0 ? 'done' : `EXIT ${code}`);
  if (code !== 0) console.log(`      ${job.tail}`);
}

// ---------------------------------------------------------------------------- report

const rows = all().filter((r) => r.at >= startedAt);
console.log(`\nVERDICTS (${rows.length} recorded this run)\n`);

const tally = {};
for (const r of rows) {
  tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const detail =
    r.latencyMs != null ? `${r.latencyMs} ms` : r.elapsedMs != null ? `${r.elapsedMs} ms` : '';
  console.log(`  ${String(r.verdict).padEnd(16)} ${String(r.id).padEnd(20)} ${detail}`);
}
console.log('');
for (const [v, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${v}`);

// ANYTHING THAT IS NOT A CLEAN `PASS` IS WORK STILL OWED. This used to match `FAIL|INVALID` only,
// so a phase whose every row was `PASS-DIRTY` or `INCONCLUSIVE` exited 0 and read as finished - and
// the campaign's own rule is that a check counts as passed when the assertions hold AND the run is
// clean. A dirty pass is a defect nobody has looked at yet; an inconclusive one is a check that did
// not run. Neither may let the ladder move up a rung.
const bad = rows.filter((r) => r.verdict !== 'PASS').length;
// A BLOCKED JOB IS NOT A CRASHED ONE AND MUST NOT BE COUNTED AS EITHER PASSING OR FAILING. It never
// ran, so it has no verdict at all, and reporting it separately is the difference between "the app
// misbehaved" and "the instrument could not be brought to a state where the question is askable".
const blocked = jobs.filter((j) => j.blocked);
const crashed = jobs.filter((j) => !j.blocked && j.exit !== 0).length;
if (crashed) console.log(`\n  ${crashed} script(s) exited non-zero - see the tails above.`);
if (blocked.length) {
  console.log(`\n  ${blocked.length} script(s) never ran - the clients were not in a known state:`);
  for (const j of blocked) console.log(`      ${j.script} - ${j.blocked}`);
}
console.log('');
process.exit(bad || crashed || blocked.length ? 1 : 0);
