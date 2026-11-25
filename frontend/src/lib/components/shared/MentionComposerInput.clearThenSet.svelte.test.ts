// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import Harness from './MentionComposerInput.clearThenSet.harness.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

describe('MentionComposerInput - text loaded after a send cleared the field', () => {
  it.each(['parent-first', 'editor-first', 'flush-between', 'editor-only'])(
    'renders a text the parent sets after a send cleared the field (%s)',
    async (order) => {
      const target = document.createElement('div');
      document.body.appendChild(target);
      let api!: { type: (t: string) => void; send: (o: string) => void; load: (t: string) => void };
      const app = mount(Harness, { target, props: { expose: (a: typeof api) => (api = a) } });
      mounted.push(() => void unmount(app));
      flushSync();
      const ed = () => target.querySelector<HTMLElement>('[role="textbox"]')!;
      api.type("J'ai tout télécharger");
      await tick();
      api.send(order);
      await tick();
      api.load("J'ai tout télécharger");
      flushSync();
      await tick();
      expect(ed().textContent).toBe("J'ai tout télécharger");
    }
  );
});
