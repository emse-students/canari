#!/usr/bin/env node
/**
 * THE ONE WAY TO RUN THE CAMPAIGN.
 *
 *   node run.mjs                      what exists, what is covered, what is not
 *   node run.mjs MSG                  every script of one phase
 *   node run.mjs MSG TYPE READ        several phases, in order
 *   node run.mjs --file msg3.mjs      one script, still with the preflight
 *   node run.mjs --all                every phase that has a script
 *   node run.mjs --preflight [W1 A1]  the rig check ALONE, no script, no verdict (default: all three)
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { PHASES, PHONE_SCRIPTS } from './checks.mjs';
import { awaitQuiet } from './deploy.mjs';
import { srvReport, srvSummary } from './srvlog.mjs';
import { OVERLAYS, clearOverlays, client, evaluate } from './chat.mjs';
import * as phone from './phone.mjs';
import { closeExtraAppTabs } from './tabs.mjs';
import { ORIGIN, PORTS } from './names.mjs';
import { all } from './results.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);

/**
 * Flags that CONSUME the argument after them, which a bare "not a `--`" filter cannot know about.
 *
 * `node run.mjs MSG --repeat 3` read `3` as a phase name and refused the whole run - the parser
 * treating a flag's value as a positional. Anything added here must be listed, or it repeats.
 */
const VALUED = ['repeat', 'file'];
const named = argv.filter(
  (a, i) => !a.startsWith('--') && !VALUED.includes(String(argv[i - 1]).replace(/^--/, ''))
);

/**
 * Where this run's full per-check output goes. ONE DIRECTORY PER RUN, stamped - so re-running a
 * phase to reproduce something never overwrites the capture of the run that raised it, which is the
 * exact loss the whole-output write below exists to prevent.
 *
 * Not the scratchpad: that is scoped to one session, so the next session would find it gone. This
 * lives beside the harness, which is also why it must never be committed - the captures carry real
 * display names.
 */
const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOG_DIR = `${HERE}logs/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
mkdirSync(LOG_DIR, { recursive: true });

/**
 * THE SERVER WINDOW IS A CURSOR OVER THE WHOLE RUN, NOT A WINDOW PER PASS.
 *
 * Each pass used to ask the server about its OWN interval, which leaves the time BETWEEN two passes
 * observed by nobody - and the classifier's one rule for "the fleet was redeployed under this run"
 * (`Listening on http` / `Nest application successfully started`) can only fire on a line that falls
 * inside a window it is given.
 *
 * That gap cost a whole verification on 2026-08-14. A push landed at 16:21, its CD restarted the
 * frontend, the SSR, social, media and chat-delivery at ~16:44 - between pass 2 and pass 3 - and pass
 * 3 opened at 16:45:12 and reported `server clean`. The phone was still recovering from the socket
 * cut, flushed the four sends the outage had queued, and MSG-5/MSG-6 came back dirty against a fleet
 * that had just been replaced under them. Every part of that was visible in the logs; none of it was
 * in any window.
 *
 * So the cursor starts at process start - before the first preflight, which is also work whose noise
 * belongs to somebody - and each pass advances it to where its own report ended. The windows are
 * contiguous by construction, and nothing that happens during the run can fall between two of them.
 */
let serverWindowFrom = new Date().toISOString();

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
      // THE PROOF BELOW ONLY DESCRIBES /chat, SO ONLY /chat MAY BE JUDGED BY IT. This test used to
      // admit /communities as well, on the reasoning that the PIN gate mounts there too - which is
      // true and is already settled one line above, before this ever runs. What it actually did was
      // hand a /communities client to a rendered-proof that page cannot satisfy: its sidebar is
      // links, not buttons, so a fully booted client counts ZERO and was declared 'booting' for
      // ever. Measured 2026-08-15: W1 rendering 7098 characters on the deployed bundle, waiting out
      // four repair passes that had nothing to repair, and taking the whole phase down with it.
      // Answering 'unknown' instead routes it to the repair that already exists and works - send it
      // to /chat - which is where every check puts it anyway.
      if (!/^\\/chat/.test(location.pathname)) return 'unknown';
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
    //
    // ONE DEFINITION, shared with the preconditions in chat.mjs. The private copy this replaces
    // asked only for [role=dialog] / [aria-modal], which is the half of the problem the DESKTOP has:
    // the mobile action sheet carries neither attribute, so a phone left holding one passed this
    // preflight as ready and then ate the next click - the exact failure the field exists to catch,
    // surviving on the one client whose layout renders it.
    overlay: JSON.parse(${OVERLAYS}).length
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
 * Dismisses whatever covers the screen, and NAMES it - the postcondition of the previous check, run
 * where a postcondition can actually run.
 *
 * IT CANNOT LIVE IN THE SCRIPTS. A check that ends normally could tidy up after itself, but the ones
 * that need tidying are the ones that DIED, and a script that throws never reaches its own last line
 * - `finish` compounds it by exiting the process on the verdict, so anything written after it is
 * unreachable by construction. So the only place a cleanup runs on the path that needs it is here,
 * between two scripts, in a process neither of them can crash.
 *
 * The repair itself is `clearOverlays`, imported rather than reimplemented. The private version this
 * replaces pressed Escape, slept 600 ms, clicked `[aria-label="Fermer"]` and slept again: three
 * separate faults in nine lines - the French caption is a Paraglide string that reads "Close" on an
 * `en` client, the sleeps are wall clocks in an instrument whose whole purpose is determinism, and
 * the predicate disagreed with the one the checks themselves use, which is how two definitions of
 * "the screen is clear" end up answering differently about the same screen.
 *
 * What it cleared is PRINTED. A check that leaves a modal behind is a fault in that check even when
 * its own verdict was PASS, and this line is the only place that is ever visible.
 */
async function dismissOverlay(d) {
  const cx = await client(PORTS[d], null, { focus: false });
  try {
    const cleared = await clearOverlays(cx);
    for (const o of cleared)
      console.log(`       ${d} ${o.stuck ? 'STUCK' : 'cleared'} ${o.kind}${o.label ? ` (${o.label})` : ''}`);
  } finally {
    cx.close();
  }
}

/**
 * Re-reads a client until it is ready, or until the deadline - whichever comes first.
 *
 * Returns the LAST state it managed to read, including an unready one, because the caller's repair
 * loop needs to know what it is still looking at in order to choose the next repair. `null` only
 * when the client never answered at all inside the window.
 */
async function settle(d, deadlineMs) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    const s = await readiness(d).catch(() => null);
    if (s) {
      last = s;
      if (isReady(s)) return s;
    }
    if (Date.now() - t0 >= deadlineMs) return last;
    await sleep(300);
  }
}

/**
 * The campaign's own user ids, filled by the preflight and read by the server observer.
 *
 * Empty until a preflight has run, and `srvReport` treats an empty set as "do not partition" - so a
 * run started with `--no-preflight` judges every line exactly as it did before, rather than
 * forgiving a stranger's traffic on the strength of a list nobody filled.
 */
const SUBJECTS = new Set();

/**
 * Wakes the phone, foregrounds the app and re-derives the devtools forward - and says what it did.
 *
 * IT NEVER THROWS. A phone that is genuinely absent must be reported by the readiness check that
 * follows, with its own hint, and not by this dying first: "adb has no device" and "the app is
 * backgrounded" want completely different fixes and only the second is repairable from here.
 *
 * @returns a sentence for the preflight to print, or '' when there was nothing to do
 */
async function reviveThePhone() {
  const notes = [];
  try {
    phone.sh('svc power stayon usb');
    phone.wake();
    if (!phone.pid()) {
      phone.launch();
      notes.push('the app was not running - launched');
    } else if (!phone.foregrounded()) {
      // A BACKGROUNDED WEBVIEW IS THE FAILURE THIS EXISTS FOR, and `am start` on a running app is a
      // no-op that brings it forward rather than a restart - so nothing is lost by it.
      phone.launch();
      notes.push('the app was in the background - foregrounded');
    }
    const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 20_000 });
    if (!up.ok) notes.push(`devtools still not answering: ${JSON.stringify(up)}`);
    else if (up.reason && notes.length) notes.push(up.reason);
  } catch (e) {
    notes.push(`could not be revived: ${e instanceof Error ? e.message : String(e)}`);
  }
  return notes.join('; ');
}

async function preflight(devices, { quiet = false } = {}) {
  const problems = [];

  // PRODUCTION MUST BE STILL BEFORE A CHECK TOUCHES IT. Prod IS the test server, and a push to
  // `main` restarts every container under whatever is running: on 2026-08-21 a commit touching only
  // `tools/` took out COMM-22's last two cycles, which reported `the salon never appeared in the
  // sidebar` - a sentence about the product, caused by us. `gate()` catches an overlap AFTERWARDS
  // and makes the run VACUOUS, but a run that was never going to count is cheapest not to start.
  //
  // IT WAITS RATHER THAN REFUSING, because the ladder runs unattended: aborting a phase because a
  // deploy was ninety seconds from finishing would cost the whole run for nothing. An answer it
  // cannot get is printed and not treated as quiet - see `deploy.mjs`.
  const quietProd = await awaitQuiet({ log: (l) => console.log(l) }).catch((e) => ({ unknown: e.message }));
  if (quietProd.unknown) console.log(`  ??   production deploy state unknown - ${quietProd.unknown}`);
  else if (quietProd.waitedFor.length)
    console.log(`  ok   production is quiet again after ${Math.round(quietProd.waitedMs / 1000)} s`);

  for (const d of devices) {
    // ONE APP TAB, AND BEFORE ANY PROBE. Every read below resolves a client by its position among
    // the browser's tabs, so an extra tab is not noise - it is a second device wearing this one's
    // name, and the preflight would report on whichever one happened to be in front. A1 has one page
    // by construction. Rule 5 of `docs/wiki/testing-methodology.md` carries the run this cost.
    if (d !== 'A1') {
      const extra = await closeExtraAppTabs(PORTS[d]).catch(() => 0);
      if (extra) console.log(`  fix  ${d.padEnd(3)} ${extra} extra tab(s) closed - a second app tab is a second MLS client`);
    }

    // THE PHONE IS BROUGHT BACK BEFORE IT IS ASKED ANYTHING, because the state it is usually found
    // in is not a failure - it is asleep. A screen that has gone off is enough to lose A1: Android
    // throttles a WebView whose window is not visible, the abstract devtools socket stays LISTED so
    // `/json/list` answers, and CDP never does - which is precisely the hint below, printed as
    // "unreachable" three times in one session on 2026-08-21 and repaired by hand each time.
    //
    // `svc power stayon usb` IS A DEVICE SETTING, NOT A TIMER. While the cable is in, the screen
    // does not sleep, so the class cannot come back in the middle of a phase - which a `wake()` at
    // the start of each job could not promise. Everything here is idempotent, so a healthy phone
    // pays a few hundred milliseconds and prints nothing.
    if (d === 'A1') {
      const revived = await reviveThePhone();
      if (revived) console.log(`  fix  A1  ${revived}`);
    }

    let s;
    try {
      s = await readiness(d);
    } catch (e) {
      // NOT EVERY FAILURE HERE IS AN ABSENCE. `client()` also refuses a browser holding more than one
      // page, and that wants the opposite fix from "the browser is closed" - so the refusal is passed
      // through verbatim rather than translated into a hint about a cable (rule 6).
      if (/so no tab can be chosen/.test(String(e.message))) {
        problems.push(`${d}: ${e.message}`);
        continue;
      }
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
      // How long this pass will keep asking. It is a DEADLINE, not a delay: `settle` returns the
      // moment the client is ready, so a repair that works instantly costs nothing. The numbers
      // below used to be `sleep`s, which charged their full value to every repair including the
      // ones that had already succeeded - and this loop runs before EVERY job in a phase.
      let deadlineMs = 8000;
      if (s.locked === 'unlocked' && s.overlay) {
        console.log(`  fix  ${d.padEnd(3)} ${s.overlay} overlay(s) still up on ${s.path} - dismissing`);
        await dismissOverlay(d);
        deadlineMs = 3000;
      } else if (s.locked === 'unknown') {
        console.log(`  fix  ${d.padEnd(3)} on ${s.path}, where the PIN gate does not mount - sending it to /chat`);
        const cx = await client(PORTS[d], null, { focus: false });
        // ORIGIN[d], never SITE: the phone's app is served from `tauri.localhost`, and sending its
        // WebView to the public site leaves the app rather than reloading it - the Tauri plugin
        // allowlist is scoped to that origin, so every request then fails silently and the client
        // reads as stuck. This preflight would have done it on EVERY run touching A1.
        await evaluate(cx, `location.href = ${JSON.stringify(`${ORIGIN[d]}/chat`)}`);
        cx.close();
        deadlineMs = 20000;
      } else if (s.locked === 'booting') {
        // Nothing to repair - the app is coming up. Acting here would type a PIN into a page that
        // has not raised the prompt yet, and then read the failure as the client's.
        console.log(`  wait ${d.padEnd(3)} on ${s.path}, no gate and nothing rendered yet - still booting`);
        deadlineMs = 20000;
      } else {
        console.log(`  fix  ${d.padEnd(3)} PIN gate is up - unlocking`);
        await runScript(['pin.mjs', '--device', d]);
        deadlineMs = 10000;
      }
      s = (await settle(d, deadlineMs)) ?? s;
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
    // AND IT IS ASKED TO A DEADLINE, because the repairs above are what disconnected the client.
    //
    // Every repair in the loop above ends in a full document navigation, which tears the socket down
    // with the document; a presence read taken immediately after therefore measures OUR OWN repair
    // and not the client. It is a DEADLINE and not a delay, exactly like `settle`: a client that is
    // already connected answers on the first sample and pays nothing.
    //
    // 25 s from the measurement, not from taste: A1 parked on `/communities` (where the PIN gate does
    // not mount, so the repair always fires) was still OFFLINE at 4.9 s and 7.8 s, and back at
    // 10.8 s WITHOUT leaving the page - the route was never the problem, the reconnect cost was. One
    // sample at ~5 s blocked MSG-6/7 on five passes out of five, on a phone that was working.
    const cwd = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const deadline = Date.now() + 25000;
    let r;
    for (;;) {
      r = spawnSync(process.execPath, ['presence.mjs', '--ports', ports.join(',')], {
        cwd,
        encoding: 'utf8',
      });
      if (r.status === 0 || Date.now() >= deadline) break;
      await sleep(2000);
    }
    // The LAST attempt only: printing every sample would report a client as absent and present in
    // the same preflight, and the reader has no way to tell which line the verdict rests on.
    for (const line of String(r.stdout || '').trim().split('\n').filter(Boolean)) {
      const online = /ONLINE/.test(line);
      if (!online || !quiet) console.log(`  ${online ? 'ok  ' : 'STOP'} ${line}`);
      // WHO THIS RUN IS ABOUT, taken from the one place that already knows. The gateway answers with
      // the real user id behind each client, and the server observer needs it to tell our traffic
      // from a stranger's on a SHARED PRODUCTION server. Derived here rather than configured
      // anywhere: a subject list that can go stale is worse than no list, because a stale one
      // forgives the wrong lines.
      const who = /user=([0-9a-f]{6,})/.exec(line);
      if (who) SUBJECTS.add(who[1]);
    }
    if (r.status !== 0) problems.push('at least one client is not connected to the gateway - see the lines above');
  }

  return problems;
}

// ---------------------------------------------------------------------------- rig check alone

/**
 * ASKING WHETHER THE RIG IS SANE MUST NOT COST A VERDICT.
 *
 * Until this flag existed, the only way to learn that a client was locked, backgrounded or sitting
 * under a leftover modal was to START a run - which then wrote rows to `results.ndjson` about an
 * instrument that was never in a fit state to measure. That is the wrong order: the answer to "can I
 * measure now" belongs BEFORE the measurement, not inside its record.
 *
 * It repairs what it can, exactly as the in-run preflight does - same function, so the two can never
 * drift into disagreeing about what "ready" means - and exits non-zero on what it cannot.
 */
if (flag('preflight')) {
  const want = named.length ? named : ['W1', 'W2', 'A1'];
  for (const d of want) if (!PORTS[d]) throw new Error(`unknown device ${d} - known: ${Object.keys(PORTS).join(' ')}`);
  console.log(`\nPREFLIGHT (${want.join(' ')})\n`);
  const problems = await preflight(want);
  if (problems.length) {
    console.log('\nNOT FIT TO MEASURE:\n');
    for (const p of problems) console.log(`  ${p}`);
  }
  console.log(`\n  ${problems.length ? 'DO NOT RUN' : 'the rig is ready'}\n`);
  process.exit(problems.length ? 2 : 0);
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
  // THE DEVICES COME FROM THE SCRIPT'S OWN PHASE, NEVER FROM A DEFAULT. `--file` used to preflight
  // W1 and W2 whatever it was about to run, so `--file comm25.mjs` - the one COMM check whose whole
  // subject is a SECOND DEVICE - started against a phone nobody had looked at. `checks.mjs` already
  // says COMM needs A1 and says why; reading it here is what makes that declaration load-bearing
  // rather than documentation. A script belonging to no phase keeps the old pair, which is the only
  // honest answer when nothing has declared what it needs.
  //
  // BUT A PHASE'S `needs` IS THE UNION OVER ITS SCRIPTS, so read alone it refuses runs it has no
  // reason to refuse - and an operator taught to answer that with `--no-preflight` has disarmed the
  // gate entirely. Where a phase declares WHICH of its scripts need the phone (`PHONE_SCRIPTS`), one
  // that does not is preflighted without it.
  const owner = Object.entries(PHASES).find(([, p]) =>
    p.scripts.some((s) => s.split(' ')[0] === f)
  );
  const withPhone = owner ? PHONE_SCRIPTS[owner[0]] : undefined;
  const need =
    withPhone && !withPhone.includes(f)
      ? owner[1].needs.filter((d) => d !== 'A1')
      : (owner?.[1].needs ?? ['W1', 'W2']);
  for (const d of need) devices.add(d);
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

/**
 * REPRODUCIBILITY IS A PROPERTY OF A SEQUENCE OF RUNS, AND NOTHING HERE COULD EXPRESS ONE.
 *
 * One green run says the phase passed once. It cannot distinguish "this is stable" from "this check
 * is dirty one time in four", and that difference is the entire question when a fix is being
 * accepted - MSG-1b was clean on its own and dirty after `msg1 --cold`, which no single run of
 * either could have shown.
 *
 * `--repeat N` runs the whole selection N times and prints one row per CHECK with its outcome per
 * pass, so an intermittent one is a row that changes rather than a difference between two scrollbacks
 * nobody diffs. Each pass re-runs the preflight for every script exactly as a lone run does; nothing
 * is skipped to make the repeat cheaper, because a cheaper repeat would measure a different thing.
 */
const repeat = Math.max(1, Number(argv[argv.indexOf('--repeat') + 1]) || 1);
const passes = [];

/** One character per verdict, and the legend below the table is generated from this same map. */
const CELL = {
  PASS: '.',
  'PASS-DIRTY': 'D',
  SLOW: 'W',
  FAIL: 'F',
  INCONCLUSIVE: 'I',
  CAPTURED: 'C',
  // A DELIBERATE SKIP IS A VERDICT, NOT AN UNKNOWN ONE. READ-5 and READ-10 are skipped by
  // construction - one needs a fourth reader, the other `--destructive` - so they printed `?` on
  // every pass and every READ run ended `NOT REPRODUCIBLE`, exit 1, with 40 of 40 checks passing
  // above it. A red that fires on every run is a red its reader learns to skip, which is the one
  // thing an exit code must never become.
  SKIPPED: 'x',
  // A KNOWN VERDICT MEANING "COULD NOT ARM", which is not the same as `?`. `?` says the legend has
  // no letter for what the check wrote - a fault in this table. `v` says the check ran, found its
  // precondition unmet, and reported that honestly. It is deliberately NOT settled: unlike a skip,
  // nobody decided in advance that it would not run, so a row that is `v` on every pass is a
  // precondition that has silently stopped being satisfiable and must stay visible.
  VACUOUS: 'v',
};

for (let pass = 1; pass <= repeat; pass++) {
  if (repeat > 1) console.log(`\n${'='.repeat(60)}\nPASS ${pass}/${repeat}\n${'='.repeat(60)}`);
  try {
    passes.push(await runOnce(jobs.map((j) => ({ ...j }))));
  } catch (e) {
    // A PASS THAT CANNOT BE SET UP IS A RESULT OF THAT PASS, NOT THE END OF THE RUN. Everything
    // inside `runOnce` is already isolated - a script that exits non-zero is recorded and the next
    // one starts - but the SETUP around it was not, so anything thrown by the preflight escaped to
    // the top level and killed the process. Measured 2026-08-15: one `timeout on Runtime.enable`
    // between two scripts took passes 3, 4 and 5 of FWD with it, and with them the cross-pass table
    // that is the only thing able to answer "is it reproducible" - the question the repeat exists
    // for. Two clean passes were thrown away to report a fault that belonged to one.
    //
    // Recorded as BLOCKED, which is the word this file already uses for it and means precisely
    // this: the instrument could not be brought to a state where the question is askable. It is not
    // a failure of the application and must never be counted as one.
    const reason = `pass setup threw: ${e?.message || e}`;
    console.log(`\n  PASS ${pass} BLOCKED - ${reason}`);
    passes.push({
      rows: [],
      bad: 1,
      crashed: 0,
      blocked: jobs.map((j) => ({ ...j, blocked: reason })),
      server: null,
      aborted: true,
    });
  }
}

if (repeat > 1) {
  // The per-check view, which is the only one that answers "is it reproducible".
  const ids = [...new Set(passes.flatMap((p) => p.rows.map((r) => r.id)))];
  console.log(`\n${'='.repeat(60)}\nACROSS ${repeat} PASSES\n`);
  let allClean = true;
  for (const id of ids) {
    const cells = passes.map((p) => {
      const row = p.rows.find((r) => r.id === id);
      // MAPPED EXPLICITLY, because `verdict[0]` printed `P` for PASS-DIRTY against a legend that
      // announced `D` - a character in the table that appeared nowhere in the key under it. A
      // reader who trusts the legend reads a dirty pass as an unknown state, and one who trusts the
      // first letter reads it as a pass. Anything unrecognised prints `?` rather than a letter that
      // happens to be first.
      return row ? (CELL[row.verdict] ?? '?') : '-';
    });
    // TWO DIFFERENT COMPLAINTS, KEPT APART. A row whose cells DIFFER is the thing `--repeat` exists
    // to find: an intermittent check. A row that is the same verdict every time is perfectly
    // reproducible and may still be bad - and calling that "not reproducible" sent the reader
    // looking for a flake that was never there.
    const varies = cells.some((c) => c !== cells[0]);
    const settled = !varies && (cells[0] === CELL.PASS || cells[0] === CELL.SKIPPED);
    allClean &&= settled;
    console.log(
      `  ${id.padEnd(20)} ${cells.join(' ')}${
        varies ? '   <-- not reproducible' : settled ? '' : '   <-- every pass, not a flake'
      }`
    );
  }
  // THE SERVER GETS ITS OWN ROW, because it is the one observer no per-check verdict can carry: the
  // containers serve every client at once, so its window belongs to the pass rather than to a check.
  // `-` where the pass never ran: it has no server window at all, and printing `S` there would
  // report a dirty platform on the strength of a measurement nobody took.
  const srvCells = passes.map((p) => (p.aborted ? '-' : p.server?.clean ? '.' : 'S'));
  const srvClean = srvCells.every((c) => c === '.');
  allClean &&= srvClean;
  console.log(`  ${'(server window)'.padEnd(20)} ${srvCells.join(' ')}${srvClean ? '' : '   <-- not clean'}`);
  // `-` is a check that recorded NOTHING on that pass, which is not a pass and must not read as one.
  // Generated from CELL, so the key can never drift from what the cells actually print.
  console.log(
    `\n  ${Object.entries(CELL)
      .map(([v, c]) => `${c} = ${v}`)
      .join('   ')}   S = server not clean   ? = unknown verdict   - = no verdict recorded`
  );
  console.log(`\n  ${allClean ? `CLEAN ${repeat}/${repeat}` : 'NOT REPRODUCIBLE - see the rows above'}\n`);
  process.exit(allClean ? 0 : 1);
}

const last = passes[0];
process.exit(last.bad || last.crashed || last.blocked.length ? 1 : 0);

async function runOnce(jobs) {
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
  // A SCRIPT THAT RECORDS NOTHING IS INDISTINGUISHABLE FROM ONE THAT PASSED, and only the runner can
  // tell the two apart: `results.mjs` sees the rows a process wrote, never the rows it owed. Counted
  // per job, because the run-wide total below cannot attribute a missing row to the script that
  // failed to write it. Measured 2026-08-16: NINE of the manifest's scripts - `notif.mjs`,
  // `notif7.mjs`, `fwd5.mjs`, `life.mjs`, `tab236.mjs`, `heal.mjs`, `heal-a1.mjs`, `heal-web.mjs`,
  // `grp-traffic.mjs` - computed a verdict, printed it as JSON, and recorded nothing at all. Every
  // one of them exited 0 and every one of them printed `done` here.
  const rowsBefore = all().length;
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    // Kept, not discarded: a script that dies says why on stderr, and that sentence is the whole
    // difference between "the app is broken" and "this script points at a port nothing listens on".
    //
    // AND WATCHED WHILE IT RUNS, which is the half that was missing. Every phase script announces
    // its stages on stderr precisely so that a stall is distinguishable from slowness - `notif.mjs`
    // says so in its own header - and this runner then buffered the whole stream to disk and showed
    // nothing until the process closed. So a script that never closes shows NOTHING, ever: on
    // 2026-08-16 two `notif.mjs` runs sat here for FOUR HOURS driving the same browsers as
    // everything else, and were found by listing processes, not by the runner that owned them.
    // A buffer that is only flushed on exit cannot report the one failure that never exits.
    let lastOutputAt = Date.now();
    let lastLine = '';
    const note = (b) => {
      tail += b;
      lastOutputAt = Date.now();
      const lines = String(b).split('\n').filter((l) => l.trim());
      if (lines.length) lastLine = lines[lines.length - 1].slice(0, 120);
    };
    child.stdout.on('data', note);
    child.stderr.on('data', note);

    // THE WATCHDOG BOUNDS SILENCE, NOT WORK. It does not decide anything about the app and never
    // shortens a legitimate wait: NOTIF-10's radio outage is 600 s of deliberate quiet, so the
    // window is set well beyond it, and reaching it means no stage line has been printed for a
    // quarter of an hour - which no check in this rig does on purpose. It ACCUSES rather than
    // retrying: the script is killed and the job is marked, because a runner that quietly restarts
    // a hung script would hide exactly what it exists to surface.
    const STALL_MS = 15 * 60 * 1000;
    const HEARTBEAT_MS = 60 * 1000;
    const heartbeat = setInterval(() => {
      const quietMs = Date.now() - lastOutputAt;
      if (quietMs >= STALL_MS) {
        job.stalled = Math.round(quietMs / 1000);
        console.log(`\n      STALLED - no output for ${job.stalled}s, killing. Last line: ${lastLine || '(none)'}`);
        child.kill('SIGKILL');
        return;
      }
      console.log(`\n      ...${Math.round((Date.now() - lastOutputAt) / 1000)}s quiet | ${lastLine || '(no output yet)'}`);
    }, HEARTBEAT_MS);

    child.on('close', (c) => {
      clearInterval(heartbeat);
      /**
       * THE WHOLE OUTPUT IS KEPT ON DISK, and only the console summary is four lines.
       *
       * It used to be `slice(-4)` and nothing else, so everything a check printed above its last
       * four lines was destroyed at the moment it was read. That is not a small loss: every script
       * dumps its full observation - `stateChanges`, `unexplained`, the console of both clients -
       * AFTER its verdict line, and those buckets are where a temporary trace lands. Measured
       * 2026-08-14: a `LOST frame` reproduced inside a phase run and the instrumentation that
       * existed to explain it had been thrown away by the runner, so the phase had to be re-run
       * one script at a time to read what it had already captured once.
       *
       * `results.ndjson` does not cover this - it records the VERDICT and its condensed dirt, which
       * is a different question from what the clients actually said.
       */
      job.log = `${LOG_DIR}/${String(job.phase)}-${file.replace(/\.mjs$/, '')}.log`;
      try {
        writeFileSync(job.log, tail);
      } catch (e) {
        console.log(`\n      (could not write ${job.log}: ${e.message})`);
      }
      job.tail = tail.split('\n').filter((l) => l.trim()).slice(-4).join('\n      ');
      resolve(c);
    });
  });
  job.exit = code;
  job.rows = all().length - rowsBefore;
  // STALLED IS NOT "EXIT null". A killed child reports whatever signal ended it, which reads as an
  // ordinary crash and sends the next reader looking for a bug in the script's last statement. The
  // distinction is the finding: this one never got there.
  //
  // NOR IS "done" THE SAME AS "recorded". A job that exits 0 having written no verdict is reported
  // as what it is, in the column a reader is already looking at, rather than left to be inferred
  // from a verdict table that is short by one line.
  console.log(
    job.stalled
      ? `STALLED after ${job.stalled}s of silence`
      : code !== 0
        ? `EXIT ${code}${job.rows ? '' : ' (and recorded nothing)'}`
        : job.rows
          ? 'done'
          : 'NO VERDICT - exited 0 and recorded nothing'
  );
  if (code !== 0) {
    console.log(`      ${job.tail}`);
    // AND WHERE THE REST OF IT IS. Four lines is a summary, and a crash is exactly the case where
    // the last four are not the informative ones: on 2026-08-20 a libuv abort printed two lines
    // after the real error, so the console showed an assertion in `async.c` and the cause - a 502
    // from the edge - sat in the log file nobody had been told existed.
    console.log(`      full output: ${job.log}`);
  }
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
// A JOB THAT RAN, SUCCEEDED, AND RECORDED NOTHING IS THE ONE FAILURE THIS TABLE CANNOT SHOW, because
// its evidence is an ABSENT row and the table is made of rows. It counts against the pass: the phase
// claimed coverage the record cannot support, which is the same debt as a dirty window.
const silent = jobs.filter((j) => !j.blocked && j.exit === 0 && !j.rows);
if (silent.length) {
  console.log(`\n  ${silent.length} script(s) exited 0 without recording a verdict - the record cannot show they ran:`);
  for (const j of silent) console.log(`      ${j.script}`);
}
if (blocked.length) {
  console.log(`\n  ${blocked.length} script(s) never ran - the clients were not in a known state:`);
  for (const j of blocked) console.log(`      ${j.script} - ${j.blocked}`);
}
/**
 * THE THIRD OBSERVER, INSIDE THE LOOP - over THIS pass's window, not a window somebody chose.
 *
 * The bar is that every line is expected "y compris dans les logs web, mobile, et serveur", and two
 * of those three were enforced by the checks themselves while the server was enforced by remembering
 * to run `srvlog.mjs` afterwards with the right `--since`. A bar enforced by memory is not enforced,
 * and it showed: WP-PREFIX-1 had been 404ing on every channel message for as long as the code
 * existed, and no browser or phone could ever have seen it.
 *
 * Each pass gets its OWN answer rather than one widening window in which pass 1's noise never leaves
 * - but the windows are CONTIGUOUS, not one-per-pass: `serverWindowFrom` ends where the previous
 * pass's report ended, so a redeploy landing between two passes is inside one of them. See the
 * comment on `serverWindowFrom` for the run that was lost to that gap.
 */
let server = null;
const windowFrom = serverWindowFrom;
serverWindowFrom = new Date().toISOString();
try {
  server = srvReport(windowFrom, { subjects: [...SUBJECTS] });
  console.log(`SERVER (since ${windowFrom})\n`);
  for (const line of srvSummary(server)) console.log(line);
  console.log(`\n  ${server.clean ? 'server clean' : 'SERVER NOT CLEAN - run srvlog.mjs --since ' + windowFrom + ' for the lines'}`);
} catch (e) {
  // UNREACHABLE IS NOT QUIET. A pass whose server half could not be read has not met the bar, and
  // saying so is the difference between an unmeasured window and a clean one.
  server = { clean: false, unreachable: String(e.message || e).slice(0, 200) };
  console.log(`SERVER UNREADABLE - ${server.unreachable}`);
}

console.log('');
// A dirty SERVER window is a dirty run. It cannot be attributed to one check - the containers serve
// every client at once - so it counts once, against the pass, which is exactly what it is evidence
// about.
return { rows, bad: bad + (server.clean ? 0 : 1) + silent.length, crashed, blocked, silent, server };
}
