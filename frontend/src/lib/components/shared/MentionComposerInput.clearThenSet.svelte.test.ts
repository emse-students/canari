// @vitest-environment happy-dom
/**
 * A TEXT LOADED AFTER A SEND CLEARED THE FIELD MUST REACH IT (owner, 2026-11-25: "Modifier" right
 * after a send showed the banner over an empty field). Needs the parent's text to be a `$derived`
 * over a SvelteMap and the field's own clear to land after the parent's (Svelte 5.59.1).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './MentionComposerInput.clearThenSet.harness.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

describe('MentionComposerInput - text loaded after a send cleared the field', () => {
  it.each(["J'ai tout télécharger", 'another text'])('shows %s', async (loaded) => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    let api!: { type: (t: string) => void; send: () => void; load: (t: string) => void };
    const app = mount(Harness, { target, props: { expose: (a: typeof api) => (api = a) } });
    mounted.push(() => void unmount(app));
    flushSync();
    const ed = () => target.querySelector<HTMLElement>('[role="textbox"]')!;
    api.type("J'ai tout télécharger");
    await tick();
    api.send();
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    api.load(loaded);
    flushSync();
    await tick();
    expect(ed().textContent).toBe(loaded);
  });
});
