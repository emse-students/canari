/**
 * THE ONE WAY THIS HARNESS REACHES A REMOTE HOST - and its one caller is `estate.mjs`, for DEV.
 *
 * It used to be the way the rig reached production's containers. Since 2026-10-24 no rig path does:
 * `estate-target.mjs` accepts the local estate and dev only, and builds every remote command itself.
 *
 * WHY IT IS NOT JUST `execFileSync('ssh', ...)`. Two `ssh` binaries are on this machine and they do
 * not behave the same. Git ships one at `/usr/bin/ssh`, and it MANGLES the `ProxyCommand` in
 * `~/.ssh/config`: the cloudflared path is a Windows path, its backslashes are eaten, the exec
 * fails, and the connection dies before a single byte leaves. Windows' own OpenSSH at
 * `%SystemRoot%\System32\OpenSSH\ssh.exe` handles it correctly - which is why `CLAUDE.md` says prod
 * access goes through PowerShell and never through Bash.
 *
 * A bare `'ssh'` therefore resolves to whichever one the LAUNCHING SHELL put first on PATH, and a
 * harness script inherits that. Measured 2026-08-13: the same `run.mjs --file msg1b.mjs` refused to
 * start from Bash ("the gateway could not be asked") and ran from PowerShell, with both clients
 * online the whole time. That is the campaign's own failure mode - an instrument answering about
 * itself while reading as an answer about the application - and it would have reappeared in every
 * future check that asks prod anything.
 *
 * So the binary is RESOLVED here, once, preferring the system one, and every call site goes through
 * this module. Nothing else in the harness may spawn `ssh` by name.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Windows' OpenSSH when it is installed, the PATH's `ssh` otherwise (Linux, or a stripped box). */
export const SSH = (() => {
  const system = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\OpenSSH\\ssh.exe`;
  return existsSync(system) ? system : 'ssh';
})();

/**
 * Runs one command on a remote host and returns its trimmed stdout.
 *
 * Throws on a non-zero exit rather than returning what came back, so no caller can mistake an
 * unreachable server for an empty answer - the distinction `presence.mjs` exists to preserve.
 *
 * `maxBuffer` IS PART OF THAT SAME DISTINCTION, and it is not a tuning knob. Node's default is 1 MB,
 * and a command that produces more dies with `ENOBUFS` - which `srvReport` then files as
 * `unreachable`. Measured 2026-08-14: `chat-delivery-service` over a 20-minute window is past 1 MB,
 * so the BUSIEST service on the platform was the one whose logs could never be read, and the reason
 * looked like a broken tunnel. The busiest service is exactly the one a run most needs to see.
 *
 * @param host an alias in `~/.ssh/config`, named by machine-local configuration (`DEV_SSH_HOST`).
 */
export function ssh(host, command, { timeoutMs = 30_000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  // A TRANSPORT FAILURE IS NOT AN ANSWER, AND ONLY ONE EXIT CODE SAYS WHICH IT IS. `ssh` reserves
  // 255 for its own failures - the tunnel did not come up, the connection died - and passes the
  // REMOTE command's status through for everything else. So 255 alone is retried, twice, and every
  // other non-zero status is handed straight to the caller: a `redis-cli` that answered "no" must
  // never be retried into a different answer.
  //
  // Bounded, and it SAYS SO. A cloudflared blip cost a whole FWD pass on 2026-08-15 - one failed
  // presence read blocked the two scripts behind it - and a silent retry would replace that with a
  // tunnel degrading unnoticed. The line is the only warning either way.
  //
  // AND A HANG IS A TRANSPORT FAILURE TOO. `timeout` kills an `ssh` that never answered, and the
  // kill carries NO exit status (`ETIMEDOUT`, status null) - so it was never retried, and one stalled
  // connection made TOK-3's whole invariant unreadable on 2026-10-27 (the same 75-minute window read
  // in 2.6 s and 5.8 s minutes later: not volume, a stall).
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(SSH, [host, command], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
      }).trim();
    } catch (e) {
      const why = transportFailure(e);
      if (!why || attempt >= 2) throw e;
      console.log(`  [ssh] ${host}: transport failure (${why}), retry ${attempt + 1}/2`);
    }
  }
}

/**
 * Why a failed `ssh` call is the TRANSPORT's failure rather than the remote command's answer, or
 * null when it is an answer: `255` is ssh's own status, `ETIMEDOUT` is a call killed for never
 * answering. Every other status came from the remote command and must reach the caller unretried.
 *
 * @param {any} e what `execFileSync` threw
 * @returns {'255'|'ETIMEDOUT'|null}
 */
export function transportFailure(e) {
  if (e?.status === 255) return '255';
  if (e?.code === 'ETIMEDOUT') return 'ETIMEDOUT';
  return null;
}
