#!/usr/bin/env node
/**
 * NO TRACKED SOURCE FILE CARRIES A RAW NUL BYTE.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. A NUL makes ripgrep classify the file as BINARY, and a
 * binary file does not produce matching lines - it produces `binary file matches` and nothing else.
 * The file is still perfectly valid TypeScript, still compiles, still passes every suite, and is
 * simply INVISIBLE to every search this repository depends on.
 *
 * It happened, and it cost a wrong conclusion rather than a wrong build.
 * `apps/chat-delivery-service/src/app.controller.ts` used a NUL as the separator in a composite
 * `deviceId + groupId` map key - deliberate and correct, but typed as the raw character instead of
 * the `\0` escape, which is byte-identical at runtime. On 2026-09-01 a search for
 * `reportStrandedDeviceMemberships` returned the SPEC file and not the implementation, and the first
 * thing concluded from that was that the implementation did not exist. CLAUDE.md tells every session
 * to search the repository before reading source; anything that greps this tree - a session, a hook,
 * a CI step - is lied to the same way, and nothing else here would ever notice.
 *
 * THE OBVIOUS CHECK IS INVERTED, WHICH IS WHY IT IS SPELLED OUT HERE. `git grep -Il ''` was written
 * down as the way to list the offenders; `-I` means "do not match in binary files", so that command
 * lists every file git considers TEXT - the complement of the answer, and a long, reassuring,
 * entirely wrong list. This reads the bytes instead, which cannot be misread in either direction.
 *
 * The scope is the source a person or an agent greps for meaning. Fixtures are excluded BY NAME and
 * not by shape: a frozen cross-version artefact is binary on purpose, and a test that fails on the
 * evidence it was written to protect gets deleted rather than obeyed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

/** The extensions worth grepping for meaning. A NUL in any of them hides a whole file. */
const SOURCE = /\.(ts|tsx|js|mjs|cjs|svelte|rs|py|sh|md|json|ya?ml|toml|css|html)$/;

/** Trees whose contents are deliberately opaque, so a NUL there accuses nobody. */
const EXCLUDED = /(^|\/)(tests\/fixtures|fixtures)\//;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

const scanned = tracked.filter((f) => SOURCE.test(f) && !EXCLUDED.test(f));

for (const f of scanned) {
  let bytes;
  try {
    bytes = readFileSync(join(ROOT, f));
  } catch {
    continue; // a path listed by git but absent from the work tree is not this test's business
  }
  const at = bytes.indexOf(0);
  if (at !== -1) {
    const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
    fail(
      `${f}:${line} carries a raw NUL byte, so ripgrep reads the whole file as binary and reports ` +
        `no matching lines. If the NUL is intentional, write it as a backslash-zero escape - byte-identical ` +
        `at runtime, and visible to every reader.`
    );
  }
}

// THE TEST MUST BE ABLE TO FAIL, and the cheapest proof is the check applied to a byte we make.
const canary = Buffer.from('a\0b', 'utf8');
if (canary.indexOf(0) !== 1) fail('the NUL probe itself cannot find a NUL - the check proves nothing');

console.log(
  failures === 0
    ? `ok   ${scanned.length} tracked source file(s), not one carries a raw NUL`
    : `\n${failures} file(s) invisible to ripgrep.`
);
process.exit(failures === 0 ? 0 : 1);
