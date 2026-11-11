/**
 * A FULL-SCREEN PLACE DRAWS NO CHROME, AT ANY WIDTH (owner, Android 1.6.10, 2026-11-11).
 *
 * Turned to landscape, a phone is 800+ px wide and crosses Tailwind `md`: the sidebar and the top
 * bar - `md:` pieces - came back around the camera, which shrank into what was left. Chrome is
 * decided by the PLACE (`isFullScreenPlace`), never by a width. The root layout is not renderable
 * in a unit test (the whole app boots in it), so this pins its source: every chrome piece is behind
 * `!isFullScreen`, and so is the gutter that makes room for the sidebar.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';
import { isFullScreenPlace } from '$lib/navigation/places';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../routes/+layout.svelte'),
  'utf8'
).replaceAll('\r\n', '\n');
const ast = parse(source, { modern: true });

type Node = { type: string; name?: string; [key: string]: unknown };

/**
 * The `{#if}` conditions (as source text) of every block whose CONSEQUENT holds a `<name />`
 * component, found by walking the parsed template - not by looking at the text near it.
 */
function guardsOf(name: string): string[] | null {
  let found: string[] | null = null;
  const walk = (node: unknown, guards: string[]): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((child) => walk(child, guards));
    const n = node as Node;
    if (n.type === 'Component' && n.name === name) found = guards;
    for (const [key, value] of Object.entries(n)) {
      if (key === 'parent') continue;
      if (n.type === 'IfBlock' && key === 'consequent') {
        const test = n.test as { start: number; end: number };
        walk(value, [...guards, source.slice(test.start, test.end)]);
      } else walk(value, guards);
    }
  };
  walk(ast.fragment, []);
  return found;
}

describe('the root layout on a full-screen place', () => {
  it('knows the camera as one, with its sub-routes', () => {
    expect(isFullScreenPlace('/camera')).toBe(true);
    expect(isFullScreenPlace('/camera/review')).toBe(true);
    expect(isFullScreenPlace('/chat')).toBe(false);
  });

  it.each(['AppSidebar', 'Navbar', 'MobileHeader', 'BottomNav'])(
    '%s is not rendered there, whatever the width',
    (piece) => {
      const guards = guardsOf(piece);
      expect(guards, `${piece} is in the layout`).not.toBeNull();
      expect(guards!.some((test) => test.includes('!isFullScreen'))).toBe(true);
    }
  );

  it('does not reserve the sidebar gutter there', () => {
    expect(source).toMatch(/isLoginPage \|\| isFullScreen\s*\? ''\s*: 'md:pl-24'/);
  });
});
