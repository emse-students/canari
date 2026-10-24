#!/usr/bin/env bun
/**
 * Summarises one run's ndjson files (collect.mjs) into the numbers live.md quotes.
 *
 *   bun analyze.mjs <run dir> [--from <epoch ms>] [--to <epoch ms>]
 *
 * For every `<name>-seg.ndjson` written by a BROADCASTER: segment size, bitrate, seal and upload
 * time, refusals, keyframe alignment. For a VIEWER: glass-to-glass, distance behind the buffer
 * edge, stalls, segment ready-to-playable time and fetch time. And the phones' battery and heat.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const opt = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : null;
};
const FROM = opt('from') ?? -Infinity;
const TO = opt('to') ?? Infinity;
const read = (f) =>
  existsSync(join(dir, f))
    ? readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const pct = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const stat = (xs, unit = '', d = 0) => {
  const f = (v) => (v === null ? '-' : (+v).toFixed(d));
  return `p50 ${f(pct(xs, 50))} / p90 ${f(pct(xs, 90))} / max ${f(pct(xs, 100))}${unit} (n=${xs.length})`;
};
const inWin = (t) => t >= FROM && t <= TO;

const names = [
  ...new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('-seg.ndjson'))
      .map((f) => f.replace(/-seg\.ndjson$/, ''))
  ),
];
for (const n of names) {
  const segs = read(`${n}-seg.ndjson`);
  const seen = new Set();
  const samples = read(`${n}-sample.ndjson`)
    .filter((s) => inWin(s.at) && !seen.has(s.at) && seen.add(s.at))
    .sort((a, b) => a.at - b.at);
  const events = read(`${n}-event.ndjson`);
  console.log(`\n== ${n}`);
  if (segs.length && 'upMs' in segs[0]) {
    const s = segs.filter((x) => inWin(x.readyAt) && x.i > 0);
    const span = (s[s.length - 1].readyAt - s[0].readyAt) / 1000;
    const bytes = s.reduce((a, x) => a + x.bytes, 0);
    const gaps = s.slice(1).map((x, k) => x.readyAt - s[k].readyAt);
    console.log(
      `segments ${s.length} over ${(span / 60).toFixed(1)} min, mean ${((bytes * 8) / span / 1e6).toFixed(2)} Mb/s`
    );
    console.log(
      `segment bytes: ${stat(
        s.map((x) => x.bytes / 1000),
        ' kB'
      )}`
    );
    console.log(`interval between segments: ${stat(gaps, ' ms')}`);
    console.log(
      `seal: ${stat(
        s.map((x) => x.sealMs),
        ' ms',
        1
      )}`
    );
    console.log(
      `upload (PUT, incl. retries): ${stat(
        s.map((x) => x.upMs),
        ' ms'
      )}`
    );
    console.log(
      `upload throughput: ${stat(
        s.map((x) => (x.bytes * 8) / x.upMs / 1000),
        ' Mb/s',
        1
      )}`
    );
    console.log(
      `ready -> stored: ${stat(
        s.map((x) => x.upEnd - x.readyAt),
        ' ms'
      )}`
    );
    console.log(`queue at upload start > 0: ${s.filter((x) => x.queueAtStart > 0).length}`);
    const bad = s.filter((x) => x.status !== 200);
    console.log(
      `non-200: ${bad.length} ${JSON.stringify(bad.slice(0, 3).map((x) => [x.i, x.status, x.refusal]))}; retried: ${s.filter((x) => x.retries).length}`
    );
    console.log(
      `video starts on a sync sample: ${s.filter((x) => x.videoSync === true).length}/${s.length}; box-aligned ${s.filter((x) => x.aligned).length}/${s.length}; moofs per segment ${stat(s.map((x) => x.moofs))}`
    );
  } else if (segs.length) {
    const s = segs.filter((x) => inWin(x.appendedAt));
    console.log(`segments taken ${s.length}`);
    console.log(
      `recorder handover -> playable on this viewer: ${stat(
        s.map((x) => x.readyToPlayableMs),
        ' ms'
      )}`
    );
    console.log(
      `segment fetch (GET): ${stat(
        s.map((x) => x.fetchMs),
        ' ms'
      )}`
    );
    const ok = samples.filter((x) => x.vis === 'visible');
    console.log(
      `glass-to-glass: ${stat(
        ok.map((x) => x.g2gMs / 1000),
        ' s',
        1
      )}`
    );
    console.log(
      `behind buffer edge: ${stat(
        ok.map((x) => x.behindS),
        ' s',
        1
      )}`
    );
    if (samples.length) {
      const a = samples[0],
        b = samples[samples.length - 1];
      const dur = (b.at - a.at) / 1000;
      console.log(
        `over ${(dur / 60).toFixed(1)} min: stalls ${b.stalls - a.stalls}, stalled ${((b.stallMs - a.stallMs) / 1000).toFixed(1)} s (${((b.stallMs - a.stallMs) / 10 / dur || 0).toFixed(2)} %), seeks to edge ${b.seeks - a.seeks}, append errors ${b.appendErr}, dropped ${b.dropped - a.dropped} of ${b.frames - a.frames} frames`
      );
    }
  }
  const errs = events.filter((e) => e.m === 'error' && inWin(e.at));
  if (errs.length)
    console.log(`errors: ${errs.length} ${JSON.stringify(errs.slice(0, 4).map((e) => e.error))}`);
  const other = events.filter(
    (e) => inWin(e.at) && !['error'].includes(e.m) && !String(e.m).startsWith('collector')
  );
  if (other.length)
    console.log(
      `events: ${other
        .map(
          (e) =>
            `${new Date(e.at).toISOString().slice(11, 19)} ${e.m}${e.why ? ' (' + e.why + ')' : ''}`
        )
        .slice(0, 25)
        .join('; ')}`
    );
}
const ph = read('phone.ndjson').filter((p) => inWin(p.at));
if (ph.length > 1) {
  const a = ph[0],
    b = ph[ph.length - 1];
  const h = (b.at - a.at) / 3.6e6;
  console.log(`\n== phones over ${(h * 60).toFixed(1)} min`);
  if (a.mi9t) {
    const mx = (k) => Math.max(...ph.map((p) => p.mi9t[k] || 0));
    console.log(
      `Mi 9T: level ${a.mi9t.level} -> ${b.mi9t.level} (${((a.mi9t.level - b.mi9t.level) / h).toFixed(1)} %/h, usb ${b.mi9t.usb}); charge counter ${a.mi9t.chargeCounter} -> ${b.mi9t.chargeCounter} uAh; battery ${a.mi9t.tempC} -> ${b.mi9t.tempC} C (max ${mx('tempC')}); CPU4 max ${mx('CPU4')} C; GPU max ${mx('GPU')} C; thermal status max ${mx('thermalStatus')}`
    );
  }
  if (a.iphone)
    console.log(
      `iPhone: level ${a.iphone.level} -> ${b.iphone.level}; charging ${b.iphone.charging}`
    );
}
