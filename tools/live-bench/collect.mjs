#!/usr/bin/env bun
/**
 * Drains each bench page's window.__LB into ndjson files every `--every` seconds, and samples the
 * phones' battery and heat beside it. Throwaway instrument for WP-L1 (see README.md).
 *
 *   bun collect.mjs --out <dir> --every 30 \
 *     --page mi9t=9301:tauri.localhost --page iphone=9310:dev.canari-emse.fr \
 *     [--adb fa71073b] [--ios <pymobiledevice3 path>]
 *
 * A page is `<name>=<cdp port>:<url substring>`; its target is re-resolved at every read, since a
 * WebKit bridge renumbers targets. Writes <out>/<name>-{seg,sample,event}.ndjson and phone.ndjson.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const one = (k, d) => all(k)[0] ?? d;
const OUT = one('out', 'live-bench-out');
const EVERY = Number(one('every', 30)) * 1000;
const ADB = one('adb');
const IOS = one('ios');
mkdirSync(OUT, { recursive: true });
const pages = all('page').map((p) => {
  const [name, rest] = p.split('=');
  const [port, match] = [rest.slice(0, rest.indexOf(':')), rest.slice(rest.indexOf(':') + 1)];
  return { name, port, match };
});
const line = (file, o) => appendFileSync(join(OUT, file), JSON.stringify(o) + '\n');

async function evaluate(ws, expression, ms = 20000) {
  const s = new WebSocket(ws);
  await new Promise((r, j) => ((s.onopen = r), (s.onerror = j)));
  try {
    return await Promise.race([
      new Promise((res) => {
        s.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id === 1) res(m.result?.result?.value);
        };
        s.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          })
        );
      }),
      new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms)),
    ]);
  } finally {
    s.close();
  }
}

const DRAIN = `JSON.stringify(window.__LB ? { seg: __LB.segs.splice(0), event: __LB.events.splice(0), sample: __LB.samples.splice(0), errors: __LB.errors.length } : null)`;

function phone() {
  const o = { at: Date.now() };
  if (ADB) {
    const sh = (c) =>
      spawnSync('adb', ['-s', ADB, 'shell', c], {
        encoding: 'utf8',
        env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      }).stdout || '';
    const bat = sh('dumpsys battery');
    o.mi9t = {
      level: +(bat.match(/^\s+level: (\d+)/m) || [])[1],
      tempC: +(bat.match(/^\s+temperature: (\d+)/m) || [])[1] / 10,
      usb: /USB powered: true/.test(bat),
      chargeCounter: +(bat.match(/Charge counter: (\d+)/) || [])[1],
    };
    const th = sh('dumpsys thermalservice');
    o.mi9t.thermalStatus = +(th.match(/Thermal Status: (\d+)/) || [])[1];
    for (const n of ['CPU4', 'GPU']) {
      // The dump lists a CACHED reading first and the HAL's current one after it: take the last.
      const m = [
        ...th.matchAll(new RegExp(`mValue=([0-9.]+), mType=\\d+, mName=${n},`, 'g')),
      ].pop();
      if (m) o.mi9t[n] = +m[1];
    }
  }
  if (IOS) {
    const r = spawnSync(IOS, ['diagnostics', 'battery', 'single'], {
      encoding: 'utf8',
      timeout: 40000,
    });
    const t = r.stdout || '';
    const g = (k) => (t.match(new RegExp(`"${k}": (-?[0-9.]+|true|false)`)) || [])[1];
    o.iphone = {
      level: +g('CurrentCapacity'),
      amperage: +g('InstantAmperage'),
      voltage: +g('Voltage'),
      charging: g('IsCharging'),
      temperature: g('Temperature') ? +g('Temperature') / 100 : null,
    };
  }
  return o;
}

async function tick() {
  for (const p of pages) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${p.port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(p.match));
      if (!t) {
        line(`${p.name}-event.ndjson`, { at: Date.now(), m: 'collector: no target' });
        continue;
      }
      const v = await evaluate(t.webSocketDebuggerUrl, DRAIN);
      if (!v) continue;
      const d = JSON.parse(v);
      if (!d) continue;
      for (const k of ['seg', 'event', 'sample'])
        for (const o of d[k]) line(`${p.name}-${k}.ndjson`, o);
    } catch (e) {
      line(`${p.name}-event.ndjson`, { at: Date.now(), m: `collector: ${e.message}` });
    }
  }
  if (ADB || IOS) line('phone.ndjson', phone());
}
await tick();
setInterval(tick, EVERY);
