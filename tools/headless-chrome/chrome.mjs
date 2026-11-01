/**
 * A headless Chrome driven over the DevTools protocol, with nothing installed: the browser already
 * on the machine (the Windows install on a bench PC, `google-chrome` on a GitHub runner), a fake
 * camera and microphone, and one page session.
 *
 * Two drivers use it and must not each carry a copy: the call audio rig
 * (`tools/call-audio-fidelity/rig.mjs`) and the SFU's end-to-end call
 * (`apps/call-service/e2e/run.mjs`). It moved here from the rig on 2026-11-01, unchanged in
 * behaviour, when the second one was written.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Serves the files of one directory on a free loopback port (`index.html` for `/`): the page a
 * driver built, on an origin of its own so its worker and its module scripts load as the app's do.
 */
export function serveDirectory(www) {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      const file = join(www, path === '/' ? 'index.html' : path.slice(1));
      if (!existsSync(file)) return new Response('not found', { status: 404 });
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.wasm')
          ? 'application/wasm'
          : 'text/html';
      return new Response(readFileSync(file), { headers: { 'content-type': type } });
    },
  });
}

/** The Chrome this machine has, when the caller names none. */
export function defaultChrome() {
  if (process.platform === 'win32') return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (process.platform === 'darwin')
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

/** A minimal CDP session over one target. */
export class Cdp {
  /**
   * @param {WebSocket} ws
   * @param {number} answerMs How long one `eval` may wait for the page. `Infinity` leaves the bound
   *   to the caller's own termination (a CI job's timeout): a page that never answers then hangs the
   *   run instead of failing it, which only a caller that proves its own end may choose.
   */
  constructor(ws, answerMs) {
    this.ws = ws;
    this.answerMs = answerMs;
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

  static async open(url, answerMs = 60_000) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws, answerMs);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /**
   * Evaluates `expr` in the page, awaiting a promise; throws the page's exception text. A page that
   * does not answer within `answerMs` throws, named, rather than hanging the run.
   */
  async eval(expr) {
    let timer = 0;
    const call = this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    const r = Number.isFinite(this.answerMs)
      ? await Promise.race([
          call,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `the page did not answer ${expr.slice(0, 40)} in ${this.answerMs / 1000} s`
                  )
                ),
              this.answerMs
            );
          }),
        ]).finally(() => clearTimeout(timer))
      : await call;
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

/**
 * Polls `fn` until it returns a truthy value, which it returns. `ms` bounds it (`Infinity`: no
 * bound, for a caller whose wait ends on a proof either way).
 */
export async function until(fn, what, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

/**
 * Launches one headless Chrome with a fake camera and microphone (`wav` plays on the microphone
 * when given), opens `url` and waits for the page to set `document.title` to `readyTitle`.
 *
 * `live` is the caller's set of running Chromes - what its interrupt handler must take down; the
 * side is added before anything can throw. Returns `{ name, proc, exited, port, cdp, profile }`.
 */
export async function launchChrome({
  chrome = defaultChrome(),
  name,
  profile,
  url,
  readyTitle,
  wav = null,
  live,
  keep = false,
  log = console.log,
  answerMs = 60_000,
  readyMs = 20_000,
}) {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      // 30 fps: the app's camera constraint (the fake device's default is 20).
      '--use-fake-device-for-media-stream=fps=30',
      '--use-fake-ui-for-media-stream',
      ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : []),
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-default-browser-check',
      // A GitHub runner's Ubuntu restricts the unprivileged user namespaces Chrome's sandbox
      // needs; the page is our own build on loopback, so the sandbox protects nothing here.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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
      () => {
        if (!existsSync(portFile)) return false;
        try {
          return readFileSync(portFile, 'utf8').split('\n')[0];
        } catch (e) {
          // Windows: Chrome still holds the file it is writing (EBUSY) - not written yet, read again.
          if (e.code === 'EBUSY') return false;
          throw e;
        }
      },
      `${name} DevTools port`,
      readyMs
    );
    const targets = await until(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${side.port}/json/list`)).json();
        return list.find((t) => t.type === 'page');
      },
      `${name} page target`,
      readyMs
    );
    side.cdp = await Cdp.open(targets.webSocketDebuggerUrl, answerMs);
    await side.cdp.send('Page.navigate', { url });
    await until(
      async () => (await side.cdp.eval('document.title').catch(() => '')) === readyTitle,
      `${name} page`,
      readyMs
    );
    return side;
  } catch (e) {
    // A Chrome that never became usable is still a running Chrome: take it down before the throw.
    log(`WARN ${name}: launch failed (${String(e)}), killing the tree`);
    await closeChrome(side, { live, keep, log });
    throw e;
  }
}

/** Kills the whole process tree: on Windows, killing the browser process leaves its children. */
export function killTree(side, { sync = false } = {}) {
  if (process.platform === 'win32') {
    const kill = sync ? spawnSync : spawn;
    kill('taskkill', ['/PID', String(side.proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    side.proc.kill('SIGKILL');
  }
}

/** Closes one Chrome (`Browser.close`, then the kill), and removes its profile unless `keep`. */
export async function closeChrome(side, { live, keep = false, log = console.log }) {
  live.delete(side);
  try {
    if (!side.port) throw new Error('no DevTools port yet');
    const v = await (await fetch(`http://127.0.0.1:${side.port}/json/version`)).json();
    const b = await Cdp.open(v.webSocketDebuggerUrl);
    void b.send('Browser.close').catch(() => {});
  } catch (e) {
    log(`WARN ${side.name}: Browser.close failed (${String(e)}), killing the tree`);
    killTree(side);
  }
  const done = await Promise.race([
    side.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!done) {
    log(`WARN ${side.name}: still running 10 s after Browser.close, killing the tree`);
    killTree(side);
    await side.exited;
  }
  if (keep) return;
  // Windows releases a dead process's file handles a little after it exits; a profile that is
  // still locked is named here, and the caller sweeps its profiles again at the end of its run.
  try {
    rmSync(side.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    log(`WARN ${side.name}: profile not removed yet (${e.code}), retried at the end of the run`);
  }
}
