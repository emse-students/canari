/**
 * The A/V sync rig: a source with a KNOWN sync (a white frame and a beep on every whole second),
 * made in a headless Chrome, run through the app's own `prepareVideoForUpload`, read back and judged
 * - at the start AND at the end of the file, where a drift shows.
 *
 *   bun tools/video-av-sync/rig.mjs                 # every row
 *   bun tools/video-av-sync/rig.mjs --only vfr-aac  # one row
 *
 * The exit code fails when a row's verdict fails or a row does not complete. Results and their
 * reading: docs/wiki/frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChrome, serveDirectory } from '../headless-chrome/chrome.mjs';

const here = import.meta.dir;
const frontend = join(here, '..', '..', 'frontend');

/**
 * The rows. `vfr-*` are a phone that dropped frames (holes of a quarter second); `aac-192` is dearer
 * than 128 kb/s so an engine with an AAC encoder RE-ENCODES it, `aac-96` is copied; `webm-opus` is
 * the Android recorder's shape; `cfr-60` and `cfr-24` are a gallery clip off the output's rate.
 */
const CASES = [
  {
    name: 'vfr-aac-192',
    container: 'mp4',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 192_000,
  },
  { name: 'vfr-aac-96', container: 'mp4', mode: 'vfr', fps: 30, seconds: 14, audioBitrate: 96_000 },
  {
    name: 'vfr-webm-opus',
    container: 'webm',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 96_000,
  },
  {
    name: 'holes-aac-96',
    container: 'mp4',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 96_000,
    audioHoles: true,
  },
  {
    name: 'holes-aac-192',
    container: 'mp4',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 192_000,
    audioHoles: true,
  },
  {
    name: 'holes-reel-trim',
    container: 'mp4',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 192_000,
    audioHoles: true,
    trimToVideo: true,
  },
  {
    name: 'drift-aac-192',
    container: 'mp4',
    mode: 'vfr',
    fps: 30,
    seconds: 14,
    audioBitrate: 192_000,
    audioDrift: true,
  },
  { name: 'cfr-60', container: 'mp4', mode: 'cfr', fps: 60, seconds: 14, audioBitrate: 96_000 },
  { name: 'cfr-24', container: 'mp4', mode: 'cfr', fps: 24, seconds: 14, audioBitrate: 96_000 },
];

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set(args[onlyAt + 1].split(',')) : null;
const chromeAt = args.indexOf('--chrome');
const chrome = chromeAt >= 0 ? args[chromeAt + 1] : undefined;

const www = mkdtempSync(join(tmpdir(), 'video-av-sync-'));
// The page imports `mediabunny` bare; it resolves to the frontend's own install - the version the
// app ships - at the ES module its `exports` map gives a browser, the file `prepareVideoForUpload`'s
// own import reaches, so the two share one copy.
const mbDir = join(frontend, 'node_modules', 'mediabunny');
const mbEntry = join(
  mbDir,
  JSON.parse(readFileSync(join(mbDir, 'package.json'), 'utf8')).exports['.'].browser.import
);
const built = await Bun.build({
  entrypoints: [join(here, 'page', 'entry.ts')],
  outdir: www,
  target: 'browser',
  splitting: true,
  plugins: [
    {
      name: 'frontend-mediabunny',
      setup(b) {
        b.onResolve({ filter: /^mediabunny$/ }, () => ({ path: mbEntry }));
      },
    },
  ],
});
if (!built.success) {
  console.error(built.logs.join('\n'));
  process.exit(1);
}
await Bun.write(
  join(www, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script type="module" src="/entry.js"></script>'
);

const server = serveDirectory(www);
const live = new Set();
let failed = 0;
try {
  const side = await launchChrome({
    chrome,
    name: 'av-sync',
    profile: join(www, 'profile'),
    url: `http://127.0.0.1:${server.port}/`,
    readyTitle: 'ready',
    live,
    answerMs: 300_000,
  });
  for (const c of CASES) {
    if (only && !only.has(c.name)) continue;
    try {
      const r = await side.cdp.eval(`runCase(${JSON.stringify(c)})`);
      const v = r.verdict;
      const first = v.pairs[0];
      const last = v.pairs[v.pairs.length - 1];
      console.log(
        `${v.ok ? 'PASS' : 'FAIL'} ${c.name}: source ${r.source.frames} frames, max gap ${r.source.maxFrameGapMs} ms` +
          ` (${r.source.gapsOver60ms} over 60 ms) -> output ${r.output.frames} frames, max gap ${v.maxFrameGapMs} ms;` +
          ` video-audio at ${first?.flash.toFixed(3)} s: ${first?.skewMs} ms, at ${last?.flash.toFixed(3)} s: ${last?.skewMs} ms;` +
          ` ends video ${v.videoEnd.toFixed(3)} s, audio ${v.audioEnd.toFixed(3)} s;` +
          ` source audio holes ${r.source.audioHoles}, output ${v.audioHoles}`
      );
      for (const l of r.logs) console.log(`    ${l}`);
      for (const f of v.failures) console.log(`    - ${f}`);
      if (!v.ok) failed++;
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.name}: did not complete - ${e.message}`);
    }
  }
} finally {
  for (const s of live) s.proc.kill();
  // The profile is in use until Chrome has EXITED (Windows refuses to remove an open file).
  await Promise.all([...live].map((s) => s.exited));
  server.stop(true);
  try {
    rmSync(www, { recursive: true, force: true });
  } catch (e) {
    console.warn(`could not remove ${www}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
