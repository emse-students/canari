/**
 * Launching and killing the two test browsers.
 *
 * The flags are not decoration. Without
 * `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows`
 * a window Chrome considers covered is marked HIDDEN while `windowState` still says `normal`, and
 * a hidden page discards every input event - so every synthetic click is silently dropped and the
 * run reads as a layout bug. `--user-data-dir` is what makes the login survive a relaunch: the
 * profile is persistent, so a relaunched browser is still logged in (only the PIN is re-asked).
 *
 * Usage:  bun launch.mjs kill w1     bun launch.mjs close w1     bun launch.mjs start w1
 *
 * `kill` is a CRASH and `close` is a QUIT - they are not interchangeable, and `killBrowser`
 * says what the difference costs.
 */
import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { connect } from "./cdp.mjs";
import { SITE, STATE_DIR } from "./names.mjs";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * The profiles live in `STATE_DIR`, NOT next to this file: they are the devices, not instruments.
 * A profile under the repository would be deleted by `git clean -xdf` like any other untracked
 * directory, and re-enrolling costs the one step no tool here can answer.
 *
 * W3 IS THE ONE PROFILE MEANT TO BE WIPED. W1, W2 and A1 are long-lived identities whose whole value
 * is that they survive; the HEAL-NEW rows need the opposite - a client that has never seen this
 * account, on demand, repeatedly. So W3 exists to be reset, holds the OWNER account like W1, and is
 * the only device `newdevice.mjs` will accept. Its profile still lives OUTSIDE the work tree, because
 * what is expensive about it is not the MLS state - wiping that IS the measurement - but the CAS
 * session: a browser CAS has already challenged is not challenged again, so the 2FA is paid once for
 * the profile and never again for a device reset.
 */
export const BROWSERS = {
  w1: { port: 9224, profile: join(STATE_DIR, "chrome-w1") },
  w2: { port: 9223, profile: join(STATE_DIR, "chrome-w2") },
  w3: { port: 9225, profile: join(STATE_DIR, "chrome-w3") },
};

/** True when something still answers on that debugging port. */
export async function isUp(which) {
  try {
    const r = await fetch(`http://127.0.0.1:${BROWSERS[which].port}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Kills every Chrome process of that profile, and does not return until the port is dead.
 *
 * THIS IS A CRASH, NOT A QUIT, AND THE DIFFERENCE IS NOT COSMETIC. `Stop-Process -Force` gives
 * Chrome no shutdown at all, and Chrome commits `localStorage` and IndexedDB to their LevelDB
 * stores ASYNCHRONOUSLY - so everything the page wrote in the seconds before the kill is rolled
 * back, and the relaunched browser comes up on the last state that happened to reach disk.
 *
 * Measured 2026-09-05 by PIN-9, which is the row that pays for it: the client was brought through
 * the gate with "stay signed in" ticked, the vault was READ BACK from `localStorage` a moment
 * later - `persist: "true"`, blob and wrap key both present - and the browser was killed 1 ms after
 * that. It came back with the flag rolled back to a value from a previous run and no vault at all,
 * so the gate returned and the row recorded FAIL twice against a product doing exactly the right
 * thing. `closeBrowser` on the identical sequence: everything present, no gate, four conversations.
 *
 * So the two are not interchangeable, and a row picks by what it MEANS. A crash - the process
 * disappearing under the user - is TAB-3's subject and this is the right gesture for it. A user
 * closing their browser is `closeBrowser`, and anything asking what SURVIVES a restart must use
 * that one or it is measuring Chrome's flush interval.
 *
 * Matched on the profile DIRECTORY NAME, not the full path: PowerShell `-like` treats a backslash
 * as an ordinary character, so escaping the path made the pattern match nothing - the first run of
 * TAB-3 killed no process, reported the browser as down, and measured a browser that was up the
 * whole time. Hence the verification loop: a kill that cannot prove it happened is worthless.
 */
export async function killBrowser(which, timeoutMs = 20_000) {
  const dirName = BROWSERS[which].profile.split(/[\\/]/).pop();
  // Single quotes throughout, and no `-Filter`: the filter string needs DOUBLE quotes, which do not
  // survive being nested inside the `-Command "..."` that execSync passes. That mis-quoting is why
  // the first version killed nothing while reporting success.
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  // Absolute path: this shell's PATH has no System32, so a bare `powershell` is ENOENT - and an
  // ENOENT swallowed by a catch reads exactly like "nothing to kill".
  let spawnError = null;
  try {
    execSync(`${POWERSHELL} -NoProfile -Command "${ps}"`, { stdio: "pipe" });
  } catch (e) {
    spawnError = String(e.stderr || e.message).slice(0, 200);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await isUp(which))) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `${which} still answering on ${BROWSERS[which].port} after the kill${spawnError ? ` (powershell said: ${spawnError})` : ""}`,
  );
}

/**
 * Closes the browser the way a USER closes it, and does not return until the port is dead.
 *
 * `Browser.close` is Chrome's own shutdown path: it ends the session, flushes the storage LevelDBs
 * and exits. That is the whole difference from {@link killBrowser}, and it is the difference
 * between measuring a feature and measuring a flush interval - see that function's own note for
 * what it cost to find out.
 *
 * THE COMMAND IS NOT AWAITED, DELIBERATELY, AND THAT IS NOT A SWALLOWED ERROR. `Browser.close`
 * closes the socket it was sent on before it can reply, so awaiting it waits for an answer that
 * cannot arrive. The post-condition is the port, polled below and thrown on - which is a stronger
 * proof than the reply would have been, and the same one `killBrowser` already uses.
 *
 * IT REFUSES A BROWSER THAT IS NOT THERE rather than reporting a close it never performed. A caller
 * asking for a graceful shutdown is asking for the flush, and "nothing to close" is a precondition
 * failure for that question, not a success.
 *
 * @param {'w1'|'w2'|'w3'} which
 * @returns milliseconds between the command and the port going quiet
 */
export async function closeBrowser(which, timeoutMs = 20_000) {
  const { port } = BROWSERS[which];
  if (!(await isUp(which)))
    throw new Error(`${which} is not up on ${port}, so there is nothing to close gracefully`);
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  const { webSocketDebuggerUrl } = await res.json();
  const browser = connect(webSocketDebuggerUrl);
  await browser.ready;
  browser.send("Browser.close").catch(() => null);

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await isUp(which))) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `${which} still answering on ${port} ${timeoutMs} ms after Browser.close - it did not shut down, ` +
      "and killBrowser would lose whatever it has not flushed",
  );
}

/**
 * Starts the browser detached on its debugging port and resolves once /json/version answers.
 *
 * Refuses to run against a live instance: a second `chrome.exe` on the same `--user-data-dir` does
 * not start a browser, it hands the URL to the running one and exits - so the "relaunch" would
 * silently be an extra TAB in the browser that was never killed.
 *
 * THE LANDING URL IS `SITE`, NOT A SPELT HOST. It used to be `https://canari-emse.fr/chat`, which
 * survived the 2026-09-03 move to the local estate because nothing reads a default argument back:
 * every browser this rig started opened PRODUCTION while `names.mjs` said `http://localhost:1420`,
 * and the first gesture of every row then acted on whichever estate the previous navigation had
 * left behind. A default is a navigation literal like any other and belongs to the one constant
 * that decides where the campaign runs.
 */
export async function startBrowser(which, url = `${SITE}/chat`) {
  const { port, profile } = BROWSERS[which];
  if (await isUp(which)) throw new Error(`${which} is already up on ${port} - kill it first`);
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI",
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return Date.now() - t0;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${which} never answered on port ${port}`);
}

if (process.argv[1] && process.argv[1].endsWith("launch.mjs")) {
  const [, , action, which] = process.argv;
  if (action === "kill") {
    killBrowser(which);
    console.log(`${which} killed`);
  } else if (action === "close") {
    console.log(`${which} closed in ${await closeBrowser(which)}ms`);
  } else if (action === "start") {
    console.log(`${which} up in ${await startBrowser(which)}ms`);
  } else {
    console.log("usage: bun launch.mjs kill|close|start w1|w2");
  }
  process.exit(0);
}
