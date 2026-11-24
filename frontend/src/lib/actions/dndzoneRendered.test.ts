// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const library = vi.hoisted(() => ({
  update: vi.fn(),
  destroy: vi.fn(),
  start: vi.fn(),
}));
vi.mock('svelte-dnd-action', () => ({
  dndzone: (_node: HTMLElement, options: unknown) => {
    library.start(options);
    return { update: library.update, destroy: library.destroy };
  },
}));

import { dndzoneRendered } from './dndzoneRendered';

const flush = () => Promise.resolve();
const zone = (n: number) => {
  const node = document.createElement('div');
  for (let i = 0; i < n; i++) node.append(document.createElement('p'));
  return node;
};
const opts = { items: [] } as never;

afterEach(() => vi.clearAllMocks());

describe('dndzoneRendered', () => {
  it('starts the library once and configures again when the rows render after it', async () => {
    const node = zone(0);
    dndzoneRendered(node, opts);
    expect(library.start).toHaveBeenCalledTimes(1);
    node.append(document.createElement('p'), document.createElement('p'));
    await flush();
    expect(library.update).toHaveBeenCalledTimes(1);
  });

  it('configures again on a keyed swap that keeps the child COUNT', async () => {
    const node = zone(2);
    dndzoneRendered(node, opts);
    node.firstElementChild!.replaceWith(document.createElement('p'));
    await flush();
    expect(library.update).toHaveBeenCalledTimes(1);
  });

  it('does not loop: a mutation that leaves the same children configures nothing', async () => {
    const node = zone(2);
    dndzoneRendered(node, opts);
    const [a, b] = Array.from(node.children);
    node.append(a!);
    node.insertBefore(a!, b!);
    await flush();
    expect(library.update).not.toHaveBeenCalled();
  });

  it('leaves a drag in progress to the library', async () => {
    const node = zone(2);
    dndzoneRendered(node, opts);
    const shadow = document.createElement('p');
    shadow.setAttribute('data-is-dnd-shadow-item-internal', 'true');
    node.append(shadow);
    await flush();
    expect(library.update).not.toHaveBeenCalled();
  });

  it("passes the page's own option updates through, and disconnects on destroy", async () => {
    const node = zone(1);
    const action = dndzoneRendered(node, opts) as { update(o: unknown): void; destroy(): void };
    const next = { items: [1] };
    action.update(next);
    expect(library.update).toHaveBeenCalledWith(next);
    action.destroy();
    expect(library.destroy).toHaveBeenCalledTimes(1);
    node.append(document.createElement('p'));
    await flush();
    expect(library.update).toHaveBeenCalledTimes(1);
  });
});
