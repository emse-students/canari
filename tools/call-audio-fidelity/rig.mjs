#!/usr/bin/env bun
/**
 * Call audio fidelity rig: two headless Chrome processes, each with a fake microphone playing a
 * KNOWN file, call each other through the app's own audio path (`page/page.ts`), and the receiver
 * records the decoded audio sample for sample while both sample `getStats()` once a second. The
 * recording is then scored against the reference (`analyze.mjs`).
 *
 * No account, no estate, no phone: the media path is the whole subject, and a local SDP exchange
 * through this driver replaces the relay socket. See README.md for the matrix and the thresholds.
 *
 *   bun tools/call-audio-fidelity/rig.mjs                  # the whole matrix
 *   bun tools/call-audio-fidelity/rig.mjs --only app,raw   # some rows
 *   bun tools/call-audio-fidelity/rig.mjs --seconds 40 --out <dir> --keep
 *   bun tools/call-audio-fidelity/rig.mjs --reanalyze <dir>  # re-score a run's recordings, no browser
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyze } from './analyze.mjs';
import { RATE, buildReference, encodeWav, quantised } from './signal.mjs';
import { MATRIX, THRESHOLDS, verdict } from './matrix.mjs';

const HERE = import.meta.dir;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const CHROME = opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const SECONDS = Number(opt('seconds', '32'));
const OUT = resolve(opt('out', join(tmpdir(), `canari-call-audio-${process.pid}`)));
const ONLY = opt('only', '').split(',').filter(Boolean);
const KEEP = args.includes('--keep');
const REANALYZE = opt('reanalyze', '');

function say(msg) {
  console.log(`[rig] ${msg}`);
}

/** Every Chrome this run started and has not closed yet: what an interrupt must take down. */
const live = new Set();

/**
 * Ctrl-C or a kill must not leave two headless Chromes holding a fake microphone and a profile:
 * each live tree is killed SYNCHRONOUSLY (the process is about to exit) and its profile removed.
 */
function onSignal(signal) {
  say(`${signal}: killing ${live.size} Chrome(s) and removing their profiles`);
  for (const side of live) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(side.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      side.proc.kill('SIGKILL');
    }
    if (KEEP) continue;
    try {
      rmSync(side.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
      say(`WARN profile ${side.profile} not removed (${e.code}) - delete it by hand`);
    }
  }
  process.exit(130);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/** Builds the page and the worker from the app's sources into `www/`. */
async function buildPage(www) {
  mkdirSync(www, { recursive: true });
  for (const [entry, name] of [
    ['page/page.ts', 'page.js'],
    ['page/impair.worker.ts', 'impair.worker.js'],
  ]) {
    const res = await Bun.build({
      entrypoints: [join(HERE, entry)],
      target: 'browser',
      format: 'esm',
    });
    if (!res.success) throw new Error(`build ${entry}: ${res.logs.map(String).join('\n')}`);
    writeFileSync(join(www, name), await res.outputs[0].text());
  }
  writeFileSync(
    join(www, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>rig</title><script type="module" src="/page.js"></script>'
  );
}

function serve(www) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      const file = join(www, path === '/' ? 'index.html' : path.slice(1));
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      const type = file.endsWith('.js') ? 'text/javascript' : 'text/html';
      return new Response(readFileSync(file), { headers: { 'content-type': type } });
    },
  });
}

/** How long one page call may take: the longest (`finish`) reads the stats and asks the worker twice. */
const EVAL_ANSWER_MS = 60_000;

/** A minimal CDP session over one page target. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /**
   * Evaluates `expr` in the page, awaiting a promise; throws the page's exception text. A page that
   * does not answer within `EVAL_ANSWER_MS` fails the row, named, rather than hanging the run.
   */
  async eval(expr) {
    let timer = 0;
    const silent = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`the page did not answer ${expr.slice(0, 40)} in ${EVAL_ANSWER_MS / 1000} s`)
          ),
        EVAL_ANSWER_MS
      );
    });
    const r = await Promise.race([
      this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      silent,
    ]).finally(() => clearTimeout(timer));
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function until(fn, what, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/** Launches one headless Chrome whose fake microphone plays `wav`; returns its page session. */
async function launch(name, wav, url, row) {
  const profile = join(OUT, `profile-${row}-${name}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      // 30 fps: the app's camera constraint (the fake device's default is 20).
      '--use-fake-device-for-media-stream=fps=30',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  const exited = new Promise((res) => proc.once('exit', res));
  const side = { name, proc, exited, port: 0, cdp: null, profile };
  live.add(side);
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    side.port = await until(
      () => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0],
      `${name} DevTools port`
    );
    const targets = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${side.port}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    }, `${name} page target`);
    side.cdp = await Cdp.open(targets.webSocketDebuggerUrl);
    await side.cdp.send('Page.navigate', { url });
    await until(
      async () => (await side.cdp.eval('document.title').catch(() => '')) === 'rig-ready',
      `${name} page`
    );
    return side;
  } catch (e) {
    // A Chrome that never became usable is still a running Chrome: take it down before the throw.
    say(`WARN ${name}: launch failed (${String(e)}), killing the tree`);
    await close(side);
    throw e;
  }
}

/** Kills the whole process tree: on Windows, killing the browser process leaves its children. */
function killTree(side) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(side.proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    side.proc.kill('SIGKILL');
  }
}

async function close(side) {
  live.delete(side);
  try {
    if (!side.port) throw new Error('no DevTools port yet');
    const v = await (await fetch(`http://127.0.0.1:${side.port}/json/version`)).json();
    const b = await Cdp.open(v.webSocketDebuggerUrl);
    void b.send('Browser.close').catch(() => {});
  } catch (e) {
    say(`WARN ${side.name}: Browser.close failed (${String(e)}), killing the tree`);
    killTree(side);
  }
  const done = await Promise.race([
    side.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!done) {
    say(`WARN ${side.name}: still running 10 s after Browser.close, killing the tree`);
    killTree(side);
    await side.exited;
  }
  if (KEEP) return;
  // Windows releases a dead process's file handles a little after it exits; a profile that is
  // still locked is named here and swept again at the end of the run.
  try {
    rmSync(side.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    say(`WARN ${side.name}: profile not removed yet (${e.code}), retried at the end of the run`);
  }
}

/**
 * One direction's frame identity check: each frame the receiver decrypted is looked up, by its
 * 32-bit FNV-1a hash and length (`page/impair.worker.ts`), among the frames the sender encoded. A
 * membership test, not a full byte compare: a corrupted frame escapes only on a hash collision.
 */
function bitExact(sent, received) {
  if (!sent || !received) return null;
  const set = new Set(sent);
  const identical = received.filter((h) => set.has(h)).length;
  return {
    encoded: sent.length,
    decoded: received.length,
    identical,
    corrupted: received.length - identical,
  };
}

function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Folds the per-second stats series into the numbers a row reports. */
function summarise(stats) {
  const valid = stats.filter((s) => s.in_totalSamplesReceived !== undefined);
  const first = valid[Math.min(3, valid.length - 1)] ?? {};
  const last = valid.at(-1) ?? {};
  const d = (k) => (last[k] ?? 0) - (first[k] ?? 0);
  const dt = (last.t ?? 0) - (first.t ?? 0) || 1;
  const recv = d('in_totalSamplesReceived') || 1;
  const jit = valid.map((s) => s.in_jitter ?? 0);
  return {
    codec: `${last.in_codec ?? '?'} ch=${last.in_channels ?? '?'}`,
    fmtp: last.in_fmtp ?? '?',
    rxKbps: Math.round((d('in_bytes') * 8) / dt / 100) / 10,
    lostPkts: d('in_packetsLost'),
    impairDropped: (last.impair?.dropped ?? 0) - (first.impair?.dropped ?? 0),
    concealedPct: Math.round((d('in_concealedSamples') / recv) * 1000) / 10,
    insertedPct: Math.round((d('in_inserted') / recv) * 1000) / 10,
    removedPct: Math.round((d('in_removed') / recv) * 1000) / 10,
    jitterMsMax: Math.round(Math.max(0, ...jit) * 1000),
    jbDelayMs: last.in_jbEmitted ? Math.round((last.in_jbDelay / last.in_jbEmitted) * 1000) : null,
    fecPkts: d('in_fecPacketsReceived'),
    pair: last.pair ?? '?',
  };
}

/** One renegotiation started by `from` (its offer), answered by `to`. */
async function renegotiate(from, to, offerExpr) {
  const offer = await from.cdp.eval(offerExpr);
  const answer = await to.cdp.eval(`rig.answer(${JSON.stringify(offer)})`);
  await from.cdp.eval(`rig.accept(${JSON.stringify(answer)})`);
}

/**
 * The VIDEO steps of a row, after the first negotiation and before the measured window: a camera
 * turned on late (`lateCamera`, by the callee), a camera switch, or the camera off then on. Returns
 * what the measurement needs to judge them: the sender's video frames when the last step was taken
 * (frames AFTER it prove the transform stayed fed) and the receiver's track while the camera was off.
 */
/** How long a camera OFF may take to mute the peer's track before the row reads it as never. */
const OFF_MUTE_BOUND_MS = 5_000;

async function runVideoOps(row, caller, callee, down) {
  if (!row.video) return null;
  const vtx = down ? callee : caller;
  const vrx = down ? caller : callee;
  if (row.callee.lateCamera) {
    await renegotiate(callee, caller, 'rig.addLateCamera()');
    await Bun.sleep(1000);
  }
  const ops = row.ops ?? [];
  let offState = null;
  if (ops.includes('switch')) {
    await Bun.sleep(3000);
    await vtx.cdp.eval('rig.switchCamera()');
  }
  if (ops.includes('off-on')) {
    await Bun.sleep(3000);
    await renegotiate(vtx, vrx, 'rig.cameraOff()');
    // Polled, bounded: the mute is read as soon as it lands; a peer that never mutes is read once
    // the bound is spent and fails `video-mute-when-off` with what it showed.
    const deadline = Date.now() + OFF_MUTE_BOUND_MS;
    offState = await vrx.cdp.eval('rig.remoteVideoState()');
    while (!offState?.muted && Date.now() < deadline) {
      await Bun.sleep(100);
      offState = await vrx.cdp.eval('rig.remoteVideoState()');
    }
    await renegotiate(vtx, vrx, 'rig.cameraOn()');
  }
  const atOp = ops.length ? await vtx.cdp.eval('rig.report()') : null;
  await Bun.sleep(1000);
  return { atOp, offState };
}

/**
 * The measured VIDEO direction of a row: the app worker's per-kind frames on the sending side
 * (`tx`) and the receiving side (`rx`), what the receiver decoded over the window (frames per
 * second, freezes, key frames, PLIs, codec, size), and the two pictures.
 */
function summariseVideo(tx, rx, ops) {
  const vin = rx.stats.filter((s) => s.vin_framesDecoded !== undefined);
  const first = vin[Math.min(3, vin.length - 1)] ?? {};
  const last = vin.at(-1) ?? {};
  const d = (k) => (last[k] ?? 0) - (first[k] ?? 0);
  const dt = (last.t ?? 0) - (first.t ?? 0) || 1;
  const vout = tx.stats.filter((s) => s.vout_packetsSent !== undefined).at(-1) ?? {};
  // The SENDER's side over the same window: what it encoded, at what cost, at what rate.
  const vo = tx.stats.filter((s) => s.vout_framesEncoded !== undefined);
  const o0 = vo[Math.min(3, vo.length - 1)] ?? {};
  const o1 = vo.at(-1) ?? {};
  const od = (k) => (o1[k] ?? 0) - (o0[k] ?? 0);
  const odt = (o1.t ?? 0) - (o0.t ?? 0) || 1;
  const encoded = od('vout_framesEncoded');
  const encodeMsPerFrame = encoded > 0 ? (od('vout_totalEncodeTime') * 1000) / encoded : null;
  const encodeFps = encoded / odt;
  const framesIn = (rep, side) => rep?.framesInBy?.[`0|${side}|video`] ?? 0;
  return {
    senderFrames: framesIn(tx.report, 'sender'),
    receiverFrames: framesIn(rx.report, 'receiver'),
    encrypted: tx.report?.encrypted?.video ?? 0,
    decrypted: rx.report?.decrypted?.video ?? 0,
    decryptFailed: rx.report?.decryptFailuresBy?.video ?? 0,
    notVp8: (tx.report?.videoCodecUnexpected ?? 0) + (rx.report?.videoCodecUnexpected ?? 0),
    keyframesIn: rx.report?.videoKeyframesIn ?? 0,
    codec: last.vin_codec ?? null,
    decoder: last.vin_decoder ?? null,
    size: last.vin_w ? `${last.vin_w}x${last.vin_h}` : '-',
    fps: Math.round((d('vin_framesDecoded') / dt) * 10) / 10,
    framesDecoded: d('vin_framesDecoded'),
    keyFramesDecoded: last.vin_keyFramesDecoded ?? 0,
    freezes: d('vin_freezeCount'),
    freezeSec: Math.round(d('vin_totalFreezesDuration') * 10) / 10,
    pli: last.vin_pliCount ?? 0,
    rxKbps: Math.round((d('vin_bytes') * 8) / dt / 1000),
    packetsSent: vout.vout_packetsSent ?? 0,
    packetsReceived: last.vin_packetsReceived ?? 0,
    sendLimit: vout.vout_limit ?? '-',
    sendSize: o1.vout_w ? `${o1.vout_w}x${o1.vout_h}` : '-',
    sendKbps: Math.round((od('vout_bytes') * 8) / odt / 1000),
    encoder: o1.vout_encoder ?? null,
    encodeFps: Math.round(encodeFps * 10) / 10,
    encodeMsPerFrame: encodeMsPerFrame === null ? null : Math.round(encodeMsPerFrame * 100) / 100,
    // Share of one core the encoder's wall time takes (libvpx may thread above 640x480, so the CPU
    // cost can be higher than this reads - the phone reading measures the process instead).
    encodeCorePct:
      encodeMsPerFrame === null ? null : Math.round(encodeMsPerFrame * encodeFps * 10) / 100,
    ladder: tx.ladder ?? null,
    pictures: { local: tx.pictures?.local ?? null, remote: rx.pictures?.remote ?? null },
    afterOp: ops?.atOp
      ? { senderFrames: framesIn(tx.report, 'sender') - framesIn(ops.atOp, 'sender') }
      : undefined,
    offState: ops?.offState ?? undefined,
    remoteEvents: rx.remoteVideo?.events ?? [],
  };
}

async function runRow(row, wavs, url) {
  say(`row ${row.name}: ${row.what}`);
  // `measure: 'down'` measures the CALLEE's audio heard by the caller (the reference plays on the
  // callee's microphone); the default measures the caller heard by the callee.
  const down = row.measure === 'down';
  // Both launches sit inside the try: a callee that fails to start must not strand the caller.
  let caller = null;
  let callee = null;
  try {
    caller = await launch('caller', down ? wavs.silence : wavs.caller, url, row.name);
    callee = await launch(
      'callee',
      down ? wavs.caller : row.farTalk ? wavs.far : wavs.silence,
      url,
      row.name
    );
    const setupCaller = await caller.cdp.eval(`rig.setup(${JSON.stringify(row.caller)})`);
    await callee.cdp.eval(`rig.setup(${JSON.stringify(row.callee)})`);
    const offer = await caller.cdp.eval('rig.offer()');
    const answer = await callee.cdp.eval(`rig.answer(${JSON.stringify(offer)})`);
    await caller.cdp.eval(`rig.accept(${JSON.stringify(answer)})`);
    await Promise.all([caller.cdp.eval('rig.connected()'), callee.cdp.eval('rig.connected()')]);
    if (row.callee.lateTrack) {
      const reoffer = await callee.cdp.eval('rig.addLateTrack()');
      const reanswer = await caller.cdp.eval(`rig.answer(${JSON.stringify(reoffer)})`);
      await callee.cdp.eval(`rig.accept(${JSON.stringify(reanswer)})`);
      await Bun.sleep(1000);
    }
    const videoOps = await runVideoOps(row, caller, callee, down);
    await (down ? caller : callee).cdp.eval('rig.record()');
    await Promise.all([callee.cdp.eval('rig.startStats()'), caller.cdp.eval('rig.startStats()')]);
    await Bun.sleep(SECONDS * 1000);
    // The pictures first, while both sides still send (a finished side stops its camera).
    const [calleePics, callerPics] = row.video
      ? await Promise.all([callee.cdp.eval('rig.pictures()'), caller.cdp.eval('rig.pictures()')])
      : [null, null];
    const calleeOut = { ...(await callee.cdp.eval('rig.finish()')), pictures: calleePics };
    const callerOut = { ...(await caller.cdp.eval('rig.finish()')), pictures: callerPics };
    const rx = down ? callerOut : calleeOut;
    const tx = down ? calleeOut : callerOut;
    if (rx.sampleRate !== RATE) throw new Error(`receiver recorded at ${rx.sampleRate} Hz`);
    const rec = decode(rx.b64);
    writeFileSync(
      join(OUT, `${row.name}.f32`),
      Buffer.from(rec.buffer, rec.byteOffset, rec.byteLength)
    );
    const metrics = analyze(rec, wavs.refSamples, { far: wavs.farSamples });
    const txStats = tx.stats.at(-1) ?? {};
    const result = {
      row: row.name,
      what: row.what,
      gated: !!row.gated,
      fault: !!row.fault,
      micSettings: setupCaller.settings,
      senderEncodings: tx.senderParams,
      sentFmtp: txStats.out_fmtp,
      bitExact: {
        measured: bitExact(tx.tap?.sent, rx.tap?.received),
        reverse: bitExact(rx.tap?.sent, tx.tap?.received),
      },
      // The app worker's own report: frames the engine handed each transform. An E2E row whose
      // sender or receiver transform saw NO frame is media flowing AROUND the worker.
      transformPath: {
        e2e: !!row.caller.e2e && !!row.callee.e2e,
        senderFrames: tx.report?.framesIn?.sender ?? 0,
        receiverFrames: rx.report?.framesIn?.receiver ?? 0,
      },
      engine: rx.engine,
      videoPath: row.video ? summariseVideo(tx, rx, videoOps) : undefined,
      txTargetBitrate: txStats.out_targetBitrate,
      ...summarise(rx.stats),
      metrics,
      log: [...tx.log.map((l) => `caller ${l}`), ...rx.log.map((l) => `callee ${l}`)],
    };
    result.verdict = verdict(result);
    writeFileSync(
      join(OUT, `${row.name}.json`),
      JSON.stringify({ ...result, stats: rx.stats }, null, 2)
    );
    return result;
  } finally {
    if (caller) await close(caller);
    if (callee) await close(callee);
  }
}

function verdictText(v) {
  if (v.fault)
    return v.ok
      ? `fails as it must (${v.failed.join(', ')})`
      : 'PASSES - the rig is blind to this fault';
  return v.pass ? 'PASS' : `FAIL: ${v.failed.join(', ')}`;
}

function table(results) {
  const head =
    '| row | match | frames bit-exact (measured / reverse) | speech SNR dB | speech LSD dB | HF tilt >4k dB | bandwidth Hz | dropouts (ms) | concealed % | stretch +/- % | rx kbps | lost pkts | gain dB | floor dBFS | verdict |';
  const sep = `|${'---|'.repeat(15)}`;
  const lines = results.map((r) => {
    const sp = r.metrics.segments.speech;
    const f = (x, n = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(n));
    const be = (x) => (x ? `${x.identical}/${x.decoded}` : '-');
    return `| ${r.row} | ${f(r.metrics.matchCoef, 2)} | ${be(r.bitExact.measured)} / ${be(r.bitExact.reverse)} | ${f(sp.snrDb)} | ${f(sp.lsdDb, 2)} | ${f(sp.hfLossDb)} | ${r.metrics.bandwidthHz} | ${r.metrics.dropouts.events} (${r.metrics.dropouts.ms}) | ${r.concealedPct} | ${r.insertedPct}/${r.removedPct} | ${r.rxKbps} | ${r.lostPkts}${r.impairDropped ? ` (+${r.impairDropped} injected)` : ''} | ${f(sp.gainDb)} | ${f(r.metrics.silenceFloorDbfs)} | ${verdictText(r.verdict)} |`;
  });
  return [head, sep, ...lines, videoTable(results)].join('\n');
}

/** The video rows' own table (rows without video are left out); empty when there are none. */
function videoTable(results) {
  const rows = results.filter((r) => r.videoPath);
  if (!rows.length) return '';
  const head =
    '| row | codec (decoder) | size | decoded fps | freezes (s) | key frames | PLI | rx kbps | sent (encoder) | encode ms/frame (core %) | ladder | worker frames in tx / rx | encrypted / decrypted / failed | not-VP8 | picture rgb local / remote | after op | muted when off |';
  const sep = `|${'---|'.repeat(17)}`;
  const lines = rows.map((r) => {
    const v = r.videoPath;
    const rgb = (p) => (p ? p.rgb.join(',') : '-');
    const ladder = v.ladder
      ? `${v.ladder.rung}${v.ladder.changes.length ? ` (${v.ladder.changes.map((c) => `${c.from}->${c.to}`).join(', ')})` : ''}`
      : '-';
    return `| ${r.row} | ${v.codec ?? '-'} (${v.decoder ?? '-'}) | ${v.size} | ${v.fps} | ${v.freezes} (${v.freezeSec}) | ${v.keyFramesDecoded} | ${v.pli} | ${v.rxKbps} | ${v.sendSize} ${v.sendKbps} kbps (${v.encoder ?? '-'}) | ${v.encodeMsPerFrame ?? '-'} (${v.encodeCorePct ?? '-'}) | ${ladder} | ${v.senderFrames} / ${v.receiverFrames} | ${v.encrypted} / ${v.decrypted} / ${v.decryptFailed} | ${v.notVp8} | ${rgb(v.pictures.local)} / ${rgb(v.pictures.remote)} | ${v.afterOp ? v.afterOp.senderFrames : '-'} | ${v.offState ? `${v.offState.muted} (${v.remoteEvents.join(',')})` : '-'} |`;
  });
  return `\n\nVideo (the measured direction):\n\n${[head, sep, ...lines].join('\n')}`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  say(`out: ${OUT}`);
  const ref = buildReference({ seed: 1 });
  const far = buildReference({ seed: 2, gain: 0.5, talkOnly: true });
  const wavs = {
    caller: join(OUT, 'ref.wav'),
    far: join(OUT, 'far.wav'),
    silence: join(OUT, 'silence.wav'),
    refSamples: quantised(ref),
    farSamples: quantised(far),
  };
  writeFileSync(wavs.caller, encodeWav(ref));
  writeFileSync(wavs.far, encodeWav(far));
  writeFileSync(wavs.silence, encodeWav(new Float64Array(ref.length)));
  const www = join(OUT, 'www');
  await buildPage(www);
  const server = serve(www);
  const url = `http://127.0.0.1:${server.port}/`;
  const rows = MATRIX.filter((r) => !ONLY.length || ONLY.includes(r.name));
  const results = [];
  const broken = [];
  try {
    for (const row of rows) {
      let r;
      try {
        r = await runRow(row, wavs, url);
      } catch (e) {
        // One broken row is named and the run goes on; the exit code still fails.
        say(`ERROR row ${row.name} did not complete: ${String(e)}
${e?.stack ?? ''}`);
        broken.push(row.name);
        continue;
      }
      results.push(r);
      if (r.videoPath) {
        const v = r.videoPath;
        say(
          `  ${r.row} video: ${v.codec} ${v.size} ${v.fps} fps, ${v.freezes} freeze(s), sent ${v.sendSize} ${v.sendKbps} kbps, encode ${v.encodeMsPerFrame} ms/frame (${v.encodeCorePct} % of a core), ladder ${v.ladder?.rung ?? '-'}, worker video frames tx=${v.senderFrames} rx=${v.receiverFrames}, decrypted ${v.decrypted} (failed ${v.decryptFailed})`
        );
      }
      say(
        `  ${r.row} [${/Chrome\/[\d.]+/.exec(r.engine?.ua ?? '')?.[0] ?? '?'}, transform frames tx=${r.transformPath.senderFrames} rx=${r.transformPath.receiverFrames}]: speech SNR ${r.metrics.segments.speech.snrDb.toFixed(1)} dB, LSD ${r.metrics.segments.speech.lsdDb.toFixed(2)} dB, bw ${r.metrics.bandwidthHz} Hz, ${verdictText(r.verdict)}`
      );
    }
  } finally {
    server.stop(true);
    if (!KEEP) {
      for (const d of readdirSync(OUT).filter((f) => f.startsWith('profile-'))) {
        try {
          rmSync(join(OUT, d), { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        } catch (e) {
          say(`WARN profile ${d} could not be removed (${e.code}) - delete ${OUT} by hand`);
        }
      }
    }
  }
  const md = table(results);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, 'results.md'), md);
  console.log(`\n${md}\n`);
  say(`thresholds: ${JSON.stringify(THRESHOLDS)}`);
  const failed = results.filter((r) => (r.verdict.gated || r.verdict.fault) && !r.verdict.ok);
  if (failed.length || broken.length) {
    say(
      `FAIL: ${[...failed.map((r) => r.row), ...broken.map((b) => `${b} (did not complete)`)].join(', ')}`
    );
    process.exitCode = 1;
  }
}

/** Re-scores the recordings of an earlier run (`<row>.f32` + `<row>.json`) with today's analysis. */
function reanalyze(dir) {
  const ref = quantised(buildReference({ seed: 1 }));
  const far = quantised(buildReference({ seed: 2, gain: 0.5, talkOnly: true }));
  const results = [];
  for (const file of readdirSync(dir).filter((x) => x.endsWith('.f32'))) {
    const name = file.slice(0, -4);
    const saved = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
    const rec = decode(readFileSync(join(dir, file)).toString('base64'));
    const { stats: _stats, ...result } = saved;
    result.metrics = analyze(rec, ref, { far });
    result.verdict = verdict(result);
    results.push(result);
  }
  const order = MATRIX.map((r) => r.name);
  results.sort((a, b) => order.indexOf(a.row) - order.indexOf(b.row));
  const md = table(results);
  writeFileSync(join(dir, 'results.md'), md);
  console.log(`
${md}
`);
  if (results.some((r) => (r.verdict.gated || r.verdict.fault) && !r.verdict.ok))
    process.exitCode = 1;
}

if (REANALYZE) reanalyze(resolve(REANALYZE));
else await main();
