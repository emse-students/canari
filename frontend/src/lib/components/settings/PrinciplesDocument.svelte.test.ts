// @vitest-environment happy-dom
/**
 * "NOS PRINCIPES": the page renders the ONE text of `docs/principes.md`, in French, with its eight
 * principles in order, and carries no second copy of it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import charter from '../../../../../docs/principes.md?raw';
import PrinciplesDocument from './PrinciplesDocument.svelte';

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

async function render() {
  component = mount(PrinciplesDocument, { target: document.body });
  await tick();
  flushSync();
}

describe('PrinciplesDocument', () => {
  it('renders every principle heading of the source, in order', async () => {
    await render();
    const expected = [...charter.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    const drawn = [...document.querySelectorAll('[data-principles-document] h2')].map((h) =>
      h.textContent?.trim()
    );
    expect(expected).toHaveLength(8);
    expect(drawn).toEqual(expected);
  });

  it('is French whatever the interface language, and drops its own title line', async () => {
    await render();
    const root = document.querySelector('[data-principles-document]');
    expect(root?.getAttribute('lang')).toBe('fr');
    expect(root?.querySelector('h1')).toBeNull();
    expect(root?.textContent).toContain('Vos messages sont à vous');
  });

  it('keeps the hard-wrapped source as one paragraph, not one line per newline', async () => {
    await render();
    const first = document.querySelector('[data-principles-document] p');
    expect(first?.querySelector('br')).toBeNull();
  });
});
