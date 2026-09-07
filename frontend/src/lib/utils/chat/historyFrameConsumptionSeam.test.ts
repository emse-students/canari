import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * EVERY PATH THAT SPENDS A RATCHET GENERATION MUST RECORD THAT IT DID.
 *
 * `setupMessageHandler` has always recorded it, in a private `noteConsumed`, under a docblock saying
 * "both call sites below reach here" - both call sites of ITSELF. Four other places in this tree hand
 * bytes to `processIncomingMessage`, and two of them spent generations silently: the buffered-message
 * replay that runs when a Welcome lands, and `attemptCommitReplay`, whose own comment says a commit
 * consumes its generation exactly like a message does.
 *
 * WHAT IT COSTS IS THE LOUDEST FALSE ALARM THE APP HAS. The archive replay walks the same row later,
 * MLS refuses it because the generation is spent, and the client prints
 * `frame never read here and unreadable for good`, counts a permanent loss and asks a peer to
 * reconcile history it already holds. Measured on TAB-3b (2026-09-07): the seen-ciphertext set for
 * that group held 1 691 frame fingerprints and 1 800 row keys - a ledger plainly working - and not
 * one of the accused frames' fingerprints was in it.
 *
 * SO THE OBLIGATION IS ASSERTED RATHER THAN REMEMBERED, which is the only remedy for its own class:
 * a precondition applied to a helper's callers is one every caller must remember, and one of them
 * will not. A new decrypt site fails this test until it either records the consumption or is listed
 * below with the reason it must not.
 */
// FROM THE PROJECT ROOT, not from `import.meta.url`: this file runs in the happy-dom environment,
// where `import.meta.url` is not a `file:` URL and `fileURLToPath` throws. `process.cwd()` is the
// frontend package under vitest, which is what the config's `root` fixes.
const LIB = join(process.cwd(), 'src', 'lib');

/**
 * Files that call `processIncomingMessage` and deliberately do NOT record, each with the reason.
 *
 * Adding a name here is a decision about the ratchet, not a way to make a test pass: the entry has to
 * say why recording would be WRONG, not why it is inconvenient.
 */
const EXEMPT: Record<string, string> = {
  'mls-client/mlsDecryptSession.ts':
    'the archive replay page-decrypt. `history.ts` records the whole page in one pass right after ' +
    '`decryptPage` returns, and defers the durable write to the commit thunk on purpose, so the ' +
    'ledger never runs ahead of the persisted ratchet. Recording here would be a second, earlier ' +
    'writer of the same fact.',
};

/** Every `.ts` under `src/lib`, excluding tests and the generated trees. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['paraglide', 'wasm', 'proto'].includes(entry.name)) continue;
      sources(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A CALL, never a declaration. `abstract processIncomingMessage(` in `BaseMlsService`, the signature
 * in `IMlsService` and the two concrete implementations all spell the name without a receiver; a
 * call always has one. Matching the bare name would put every one of those in the failing list and
 * teach the next reader to widen the exemptions.
 */
const CALLS = /\.processIncomingMessage\s*\(/;
/** Either the shared seam or the private one `setupMessageHandler` still uses for its own frames. */
const RECORDS = /noteFrameConsumed\s*\(|markHistoryFrameConsumed\s*\(/;

describe('the frame-consumption seam', () => {
  const callers = sources(LIB)
    .filter((f) => CALLS.test(readFileSync(f, 'utf8')))
    .map((f) => relative(LIB, f).replace(/\\/g, '/'));

  it('finds the decrypt sites at all - a test that matches nothing proves nothing', () => {
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it('every caller of processIncomingMessage records the consumption, or says why it must not', () => {
    const silent = callers.filter(
      (rel) => !EXEMPT[rel] && !RECORDS.test(readFileSync(join(LIB, rel), 'utf8'))
    );
    expect(silent).toEqual([]);
  });

  it('an exemption names a file that still calls it, so the list cannot rot', () => {
    expect(Object.keys(EXEMPT).filter((rel) => !callers.includes(rel))).toEqual([]);
  });

  it('the two paths that were silent are the ones the entry names', () => {
    // Not a restatement of the test above: these two are pinned BY NAME because they are the ones
    // that shipped the defect, and a refactor that moved the recording out of them would otherwise
    // pass on the strength of some other file in the same list.
    const commitReplay = readFileSync(join(LIB, 'utils/chat/commitReplay.ts'), 'utf8');
    const handler = readFileSync(
      join(LIB, 'mls-client/messagePipeline/setupMessageHandler.ts'),
      'utf8'
    );
    expect(commitReplay).toMatch(/noteFrameConsumed\(userId, groupId, bytes\)/);
    expect(handler).toMatch(/noteFrameConsumed\(userId, joinedGroupId, msg\.content\)/);
  });
});
