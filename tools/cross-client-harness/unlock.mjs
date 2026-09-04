/**
 * Unlocks every client that needs it, resolving WHICH ACCOUNT owns each port by itself.
 *
 *   bun unlock.mjs               - W1, W2, A1
 *   bun unlock.mjs --ports 9224  - just one
 *
 * TWO PROBLEMS THIS EXISTS TO REMOVE, both of which have cost measurements.
 *
 * 1. **The PIN is forgotten.** Any launch, kill, reboot, radio cycle, `install -r` or reload
 *    re-locks the encryption key, and a locked client cannot decrypt or ACK a single frame - so
 *    every number taken from it is wrong, and it does not announce itself. Worse, the gate only
 *    MOUNTS on `/chat` and `/communities`: on `/posts` a fully locked client shows no gate at all
 *    and an ad-hoc probe reads "unlocked". This therefore NAVIGATES to `/chat` first, so the
 *    question is asked where it can be answered.
 *
 * 2. **The account key had to be typed.** `pin.mjs --account <key>` takes a first name as spelt in
 *    `test-accounts.json`, so every invocation put a real person's name into a shell line, a log, or
 *    a transcript. The file already records which clients each account owns (`clients`), so the
 *    mapping is DATA and nothing has to be typed: this reads it, matches the label, and spawns
 *    `pin.mjs` with the key it found. Names stay in the file.
 *
 * It is idempotent - an unlocked client is left alone - so running it after any restart costs
 * nothing and skipping it costs the whole measurement.
 */
import { ownerByDevice } from './accounts.mjs';
import { spawnSync } from 'node:child_process';
import { client, evaluate } from './chat.mjs';
import { PORTS } from './names.mjs';
import { resolveDevices } from './device.mjs';

// `--device W1,A1` is the spelling; `--ports 9224,9333` still resolves, through the same one
// implementation in `device.mjs`. Naming neither means every client this rig knows, which is the
// default this command was written for and the reason `fallback` is empty here rather than a list:
// the loop below already walks `PORTS` and `wanted` only ever narrows it.
const named = resolveDevices(process.argv.slice(2));
const wanted = named.length ? named.map((t) => t.port) : null;

/** Label ("W1") -> the account key that owns it, taken from the file's own `clients` list. */
const ownerOf = ownerByDevice();

/**
 * The two things that can be PROVED about a client on `/chat`, read in one pass.
 *
 * `gate` is the encryption prompt; `mounted` is the chat having actually rendered - a sidebar with
 * rows, or a composer. Neither alone is the answer, and that is the point of reading both.
 */
const PROBE = `JSON.stringify({
  gate: !!document.querySelector('#encryption-pin') ||
    document.body.innerText.indexOf('PIN de chiffrement') !== -1 ||
    [].some.call(document.querySelectorAll('button'), function (b) {
      return /D\\u00e9verrouiller|Saisie manuelle/i.test(b.innerText || '');
    }),
  mounted: !!document.querySelector('.chat-composer-footer .chat-composer-editor') ||
    document.querySelectorAll('aside button, nav button').length > 0
})`;

/**
 * UNLOCKED IS A PROOF, NOT AN ABSENCE - and this script asserted the absence for one release.
 *
 * It used to read the gate ONCE and call every client that was not showing it unlocked. A page that
 * is still booting shows no gate either: `document.readyState` reaches `complete` while the app is
 * still deciding whether the encryption key is available, so a sample taken in that window reports
 * "already unlocked" about a client that is about to raise the prompt. Measured 2026-08-13 on all
 * THREE clients at once, straight after `reload.mjs` - which re-mounts the app and therefore
 * re-locks it - and `state.mjs` read `LOCKED` on the same three a minute later.
 *
 * So the verdict now comes from whichever of the two proofs arrives first: the gate (LOCKED) or the
 * chat having mounted (unlocked). Neither within the deadline is `UNDECIDED`, which is a third
 * answer and exits non-zero, because "I could not tell" must never be spelt "fine".
 *
 * @returns `'LOCKED' | 'unlocked' | 'UNDECIDED'`
 */
async function settle(cx, deadlineMs = 30000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const raw = await evaluate(cx, PROBE).catch(() => null);
    const seen = raw ? JSON.parse(raw) : null;
    if (seen?.gate) return 'LOCKED';
    if (seen?.mounted) return 'unlocked';
    if (Date.now() >= until) return 'UNDECIDED';
    await new Promise((r) => setTimeout(r, 500));
  }
}

let undecided = 0;

for (const [label, port] of Object.entries(PORTS)) {
  if (wanted && !wanted.includes(port)) continue;
  const account = ownerOf.get(label);
  if (!account) {
    console.log(`${label} (${port}): no account in test-accounts.json claims this client - skipped`);
    continue;
  }

  let cx;
  try {
    cx = await client(port, null, { focus: false });
  } catch (e) {
    console.log(`${label} (${port}): UNREACHABLE - ${e.message}`);
    continue;
  }

  const path = await evaluate(cx, 'location.pathname');
  if (!/^\/(chat|communities)/.test(path)) {
    // The gate cannot be seen from here, and "cannot see" is not "not locked".
    await evaluate(cx, `(function () { location.href = '/chat'; return true; })()`).catch(() => {});
  }

  const verdict = await settle(cx);
  cx.close();

  if (verdict === 'UNDECIDED') {
    undecided += 1;
    console.log(`${label} (${port}): UNDECIDED - neither the gate nor a mounted chat within 30 s`);
    continue;
  }

  if (verdict === 'unlocked') {
    console.log(`${label} (${port}): already unlocked`);
    continue;
  }

  // The PIN itself never crosses this boundary: pin.mjs reads it from the file by account key.
  const r = spawnSync(
    process.execPath,
    ['pin.mjs', '--port', String(port), '--account', account],
    { cwd: new URL('.', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8' }
  );
  const tail = String(r.stdout || r.stderr || '')
    .trim()
    .split('\n')
    .slice(-2)
    .join(' / ');
  console.log(`${label} (${port}): was LOCKED -> ${tail}`);
}

// A run that could not tell must not be read as a green pre-flight gate.
if (undecided > 0) process.exitCode = 3;
