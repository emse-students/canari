import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * NO CONSOLE LINE CARRIES A MEMBER'S MESSAGE TEXT (WP-CONSOLE-PLAINTEXT).
 *
 * The console sink redacts prose FIELDS at print time (`redactConsoleProse`), but a field it does
 * not recognise, or an interpolation with no field name, would still print the text. So the source
 * is read: a log line that interpolates `text=`, `plaintext=`, `caption=`, `draft=`, `snippet=` or
 * `preview=` is a finding - log `chars=${text.length}` instead. `contact=` is NOT in the list: it is
 * a display name the console and the stored log both redact as a prose field. An HTTP response
 * `body=` is a server answer, not a member's words, and is deliberately absent too.
 */
const OFFENDER_RE = /\b(?:text|plaintext|caption|draft|snippet|preview)=\$\{/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'paraglide' || entry.name === 'wasm' || entry.name === 'proto') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The files whose text interpolates message text into a template literal as a named field. */
export function consolePlaintextOffenders(files: ReadonlyArray<{ file: string; text: string }>) {
  return files.filter((f) => OFFENDER_RE.test(f.text)).map((f) => f.file);
}

describe('no log line carries message text', () => {
  it('finds no offender in the source', () => {
    const files = sourceFiles('src').map((path) => ({
      file: relative('src', path).replaceAll(String.fromCharCode(92), '/'),
      text: readFileSync(path, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(100);
    expect(consolePlaintextOffenders(files)).toEqual([]);
  });

  it('names the file of a planted offender', () => {
    const planted = [
      { file: 'lib/planted/Offender.ts', text: 'console.log(`[SEND] text=${JSON.stringify(t)}`);' },
      { file: 'lib/planted/Clean.ts', text: 'console.log(`[SEND] chars=${t.length}`);' },
    ];
    expect(consolePlaintextOffenders(planted)).toEqual(['lib/planted/Offender.ts']);
  });
});
