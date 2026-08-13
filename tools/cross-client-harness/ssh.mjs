/**
 * THE ONE WAY THIS HARNESS REACHES PRODUCTION.
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
 * Runs one command on a prod host and returns its trimmed stdout.
 *
 * Throws on a non-zero exit rather than returning what came back, so no caller can mistake an
 * unreachable server for an empty answer - the distinction `presence.mjs` exists to preserve.
 *
 * @param host one of the aliases in `~/.ssh/config`: `canari`, `mitv`, `cercle`.
 */
export function ssh(host, command, { timeoutMs = 30_000 } = {}) {
  return execFileSync(SSH, [host, command], { encoding: 'utf8', timeout: timeoutMs }).trim();
}

/** `redis-cli <args...>` inside the gateway's Redis container. Arguments are already quoted by the caller. */
export const redis = (args, opts) =>
  ssh('canari', `docker exec infrastructure-redis-1 redis-cli ${args}`, opts);

/** Runs `sql` on the production database, tuples-only and unaligned. Read-only by convention. */
export const psql = (sql, opts) =>
  ssh(
    'canari',
    `docker exec infrastructure-postgres-1 psql -U canari -d auth_db -tAc "${sql.replace(/"/g, '\\"')}"`,
    { timeoutMs: 60_000, ...opts }
  );
