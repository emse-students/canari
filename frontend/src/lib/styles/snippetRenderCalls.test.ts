/**
 * A SNIPPET IS DRAWN WITH `{@render ...}`, NEVER CALLED AS AN EXPRESSION.
 *
 * Production, 2026-11-17 (1.6.12): the scheduled-posts strip of `/posts` wrote
 * `{guardedCard(sp, ...)}`. A snippet is a function whose FIRST argument is the DOM anchor, so the
 * bare call handed it the post as the anchor and Svelte ran `post.before(...)`: "e.before is not a
 * function", and the whole feed crashed for every editor of a scheduled post until it was due. The
 * compiler accepts the bare call, and svelte-check types it, so nothing but a scan refuses it.
 *
 * The rule read here: in a `.svelte` file, a name declared by `{#snippet name(` appears in a mustache
 * as `{name(` only after `@render`. Passing the snippet as a value (`children={name}`) is untouched.
 */
import { describe, expect, it } from 'vitest';
import { svelteSources } from './markupTree';
import { withoutComments } from './markupSources';

/** Every `{name(` of a snippet declared in `text` that is not preceded by `@render`. */
export function bareSnippetCalls(text: string): string[] {
  const names = [...text.matchAll(/\{#snippet\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const found: string[] = [];
  for (const name of new Set(names)) {
    // Every regex metacharacter escaped, not only `$`: the name is data, never pattern.
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bare = new RegExp(`\\{\\s*${literal}\\s*\\(`, 'g');
    for (const m of text.matchAll(bare)) found.push(`${name} @${m.index}`);
  }
  return found;
}

describe('snippet render calls', () => {
  it('a bare call of a snippet is caught, a rendered one is not', () => {
    const src = '{#snippet card(p)}<b>{p}</b>{/snippet}\n{card(x)}\n{@render card(y)}';
    expect(bareSnippetCalls(src)).toEqual([`card @${src.indexOf('{card(')}`]);
  });

  it('no .svelte file calls a snippet without @render', () => {
    const offenders = svelteSources('src').flatMap((f) =>
      bareSnippetCalls(withoutComments(f.text)).map((c) => `${f.path}: ${c}`)
    );
    expect(offenders).toEqual([]);
  });
});
