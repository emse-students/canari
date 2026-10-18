import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// FROM `process.cwd()`, NOT FROM `import.meta.url`, for the reason `cardGrid.test.ts` records:
// Vite hands a module under `src/` a non-`file:` `import.meta.url`.
const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

type Messages = Record<string, string>;
const fr = JSON.parse(readFileSync(join(ROOT, 'messages/fr.json'), 'utf8')) as Messages;
const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8')) as Messages;

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return name.endsWith('.svelte') ? [full] : [];
  });
}

/**
 * Every opening tag of a Svelte source, with the line it starts on. The `{}` depth is tracked so
 * the `>` of an arrow function inside an attribute (`onclick={() => a > b}`) does not end the tag.
 */
function openingTags(src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) continue;
    let depth = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    found.push({ line: src.slice(0, i).split('\n').length, text: src.slice(i, j + 1) });
  }
  return found;
}

/** Every element whose `title` and `aria-label` are two DIFFERENT Paraglide keys. */
function twoKeyElements(): { at: string; title: string; aria: string }[] {
  const pairs: { at: string; title: string; aria: string }[] = [];
  for (const file of svelteFiles(SRC)) {
    for (const tag of openingTags(readFileSync(file, 'utf8'))) {
      const title = tag.text.match(/\stitle=\{m\.(\w+)\(/)?.[1];
      const aria = tag.text.match(/\saria-label=\{m\.(\w+)\(/)?.[1];
      if (!title || !aria || title === aria) continue;
      const rel = file
        .slice(SRC.length + 1)
        .split('\\')
        .join('/');
      pairs.push({ at: `${rel}:${tag.line}`, title, aria });
    }
  }
  return pairs;
}

describe('an icon-only control names itself with ONE key when the hint and the name are one text', () => {
  /**
   * The convention of design-reference "Tooltips: one convention": a `title` and an `aria-label`
   * from two keys are fine when they differ on purpose (a short hint, a longer accessible name);
   * two keys holding the SAME text in every locale are one string kept twice, and a later edit to
   * one of them silently makes the tooltip and the screen reader say different things. The audit of
   * 2026-10-08 merged four; three more were still there on 2026-10-18.
   */
  it('has no element whose two keys carry the same text in every locale', () => {
    const duplicates = twoKeyElements().filter(
      (p) => fr[p.title] === fr[p.aria] && en[p.title] === en[p.aria]
    );
    expect(duplicates).toEqual([]);
  });

  /**
   * The check above passes vacuously if the scan stops finding pairs. 29 elements carry two keys
   * with different texts on purpose (measured 2026-10-18); a floor well under that keeps the guard
   * honest without breaking when one of them is reworded.
   */
  it('actually finds the two-key elements it claims to check', () => {
    expect(twoKeyElements().length).toBeGreaterThan(20);
  });
});
