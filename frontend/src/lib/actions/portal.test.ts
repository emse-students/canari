import { describe, expect, it } from 'vitest';
import { portalOrigin, portalWhile } from './portal';

describe('portalWhile - a layer that covers the window only while asked to', () => {
  const setup = () => {
    const parent = document.createElement('div');
    const before = document.createElement('p');
    const node = document.createElement('section');
    const after = document.createElement('p');
    parent.append(before, node, after);
    document.body.appendChild(parent);
    return { parent, before, node, after };
  };

  it('stays where it was written while inactive', () => {
    const { parent, node } = setup();
    portalWhile(node, false);
    expect(node.parentElement).toBe(parent);
  });

  it('moves to the body when active, remembering where it came from', () => {
    const { parent, node } = setup();
    const action = portalWhile(node, false);
    action.update(true);
    expect(node.parentElement).toBe(document.body);
    expect(portalOrigin(node)).toBe(parent);
  });

  it('returns to its exact slot, between the same siblings', () => {
    const { parent, before, node, after } = setup();
    const action = portalWhile(node, true);
    action.update(false);
    expect(node.parentElement).toBe(parent);
    expect(before.nextSibling?.nextSibling).toBe(node);
    expect(node.nextSibling).toBe(after);
    expect(portalOrigin(node)).toBeNull();
  });

  it('leaves nothing behind when destroyed while portalled', () => {
    const { parent, node } = setup();
    const action = portalWhile(node, true);
    action.destroy();
    expect(node.isConnected).toBe(false);
    expect([...parent.childNodes].some((n) => n.nodeType === Node.COMMENT_NODE)).toBe(false);
  });
});
