/**
 * WHETHER THE SERVER TOOK ONE DEVICE'S SEND, read off chat-delivery's own trace - for a client whose
 * requests the WebView cannot see.
 *
 * WHY. `send.mjs` proves a send by the WIRE: `Network.requestWillBeSent` for `POST /api/mls/send`,
 * then its status. On `tauri://localhost` (the iOS app) every API call goes through the Rust
 * `tauri-plugin-http` (no cookie jar there, so `fetchRouting.ts` routes nothing to the WebView's
 * fetch), and the WebKit Network domain never sees it. Measured 2026-10-01: the bubble rendered, the
 * server logged `[SEND] START ... sender=<user>:tauri-...` and `DONE queued=6`, nginx logged
 * `POST /api/mls/send 201 ... tauri-plugin-http/2.6.0` - and the atom reported "NO POST
 * /api/mls/send was made". The server's trace names the DEVICE, which nginx's line does not.
 *
 * The trace: `[SEND][<id>] START group=<g> sender=<user>:<device> ...`, then for that id either
 * `[SEND][<id>] DONE queued=N realtime=M` (taken) or nothing (refused - the controller answers the
 * error and the trace stops). Pure, so `archive/sendtrace-selftest.mjs` pins it in the CI gate.
 */

const START = /\[SEND\]\[([^\]]+)\] START group=(\S+) sender=([^:\s]+):(\S+)/;
const DONE = /\[SEND\]\[([^\]]+)\] DONE queued=(\d+) realtime=(\d+)/;

/**
 * Every send `deviceId` started in `lines`, in order, each with its outcome.
 *
 * @param {string[]} lines chat-delivery-service log lines (ANSI already stripped)
 * @param {string} deviceId the sending device
 * @returns {Array<{ trace: string, group: string, sender: string, done: boolean, queued: number|null }>}
 */
export function sendsByDevice(lines, deviceId) {
  const sends = new Map();
  for (const line of lines) {
    const s = START.exec(line);
    if (s && s[4] === deviceId) {
      sends.set(s[1], { trace: s[1], group: s[2], sender: s[3], done: false, queued: null });
      continue;
    }
    const d = DONE.exec(line);
    if (d && sends.has(d[1])) {
      const e = sends.get(d[1]);
      e.done = true;
      e.queued = Number(d[2]);
    }
  }
  return [...sends.values()];
}
