/**
 * THE CLIENT OF THE REPLAY A BACKUP RESTORE OWES, run inside the core-service container by
 * `infrastructure/backup/restore.sh` (docs/wiki/account-erasure.md#a-restore-replays-the-erasures):
 *
 *   bun dist/account-erasure/restore-replay.js export  > journal.json   # BEFORE the restore
 *   bun dist/account-erasure/restore-replay.js replay  < journal.json   # once it is live
 *
 * It only carries bytes between the shell and `AccountErasureRestoreController` on this container's
 * own port, with this container's INTERNAL_SECRET - every decision is in the service. Any answer
 * other than 2xx exits 1 with the status and body on stderr, so the restore stops and says why.
 */

/** What the client needs from its process, injectable so a test drives it without one. */
export interface RestoreReplayIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readStdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Runs one mode and returns the process exit code. */
export async function runRestoreReplay(
  mode: string | undefined,
  io: RestoreReplayIo
): Promise<number> {
  if (mode !== 'export' && mode !== 'replay') {
    io.err('usage: restore-replay.js export|replay\n');
    return 2;
  }
  const secret = io.env.INTERNAL_SECRET ?? '';
  if (secret === '') {
    io.err('[restore-replay] INTERNAL_SECRET is empty in this container: the route would refuse\n');
    return 1;
  }
  const base = `http://127.0.0.1:${io.env.PORT ?? '3012'}/api/internal/account-erasure`;
  const res =
    mode === 'export'
      ? await io.fetch(`${base}/journal`, { headers: { 'x-internal-secret': secret } })
      : await io.fetch(`${base}/replay`, {
          method: 'POST',
          headers: { 'x-internal-secret': secret, 'content-type': 'application/json' },
          body: await io.readStdin(),
        });
  const text = await res.text();
  if (!res.ok) {
    io.err(`[restore-replay] ${mode} answered HTTP ${res.status}: ${text.slice(0, 500)}\n`);
    return 1;
  }
  io.out(`${text}\n`);
  return 0;
}

if (require.main === module) {
  void runRestoreReplay(process.argv[2], {
    env: process.env,
    fetch,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Connection refused, mostly: core-service is not answering on its own port.
      process.stderr.write(`[restore-replay] ${process.argv[2]} failed: ${String(err)}\n`);
      process.exitCode = 1;
    }
  );
}
