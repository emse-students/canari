import { clickOutside } from './clickOutside';
import { portal } from './portal';

/**
 * A guarded element with a child, both in the document, plus a spy for the dismissal.
 *
 * The child matters: the defect this file exists for is about a node that WAS a child and is not
 * one any more, so a test that only ever clicks the guarded element itself cannot see it.
 */
function guarded() {
  const owner = document.createElement('div');
  const child = document.createElement('div');
  const outside = document.createElement('div');
  owner.appendChild(child);
  document.body.append(owner, outside);

  let closed = 0;
  const action = clickOutside(owner, () => {
    closed += 1;
  });

  return {
    owner,
    child,
    outside,
    action,
    closed: () => closed,
    click: (node: Node) =>
      node.dispatchEvent(new Event('click', { bubbles: true, composed: true })),
  };
}

describe('clickOutside', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('fires for a click outside the element', () => {
    const t = guarded();
    t.click(t.outside);
    expect(t.closed()).toBe(1);
    t.action.destroy();
  });

  it('stays silent for a click on the element itself', () => {
    const t = guarded();
    t.click(t.owner);
    expect(t.closed()).toBe(0);
    t.action.destroy();
  });

  it('stays silent for a click on a child still in place', () => {
    const t = guarded();
    t.click(t.child);
    expect(t.closed()).toBe(0);
    t.action.destroy();
  });

  /**
   * THE REGRESSION. A panel written inside the guarded element and portalled to `document.body` is
   * still the same component's panel; only its parent moved, for painting. It shipped as the
   * message reaction picker dismissing itself on its own search field and category tabs.
   */
  it('stays silent for a click inside a panel portalled out of the element', () => {
    const t = guarded();
    const panel = document.createElement('div');
    const insidePanel = document.createElement('button');
    panel.appendChild(insidePanel);
    t.child.appendChild(panel);

    const moved = portal(panel);
    expect(panel.parentElement).toBe(document.body);
    expect(t.owner.contains(panel)).toBe(false);

    t.click(insidePanel);
    expect(t.closed()).toBe(0);

    moved.destroy();
    t.action.destroy();
  });

  it('follows the chain when a portalled panel portals a panel of its own', () => {
    const t = guarded();
    const panel = document.createElement('div');
    t.child.appendChild(panel);
    const movedPanel = portal(panel);

    const nested = document.createElement('div');
    const leaf = document.createElement('button');
    nested.appendChild(leaf);
    panel.appendChild(nested);
    const movedNested = portal(nested);

    expect(nested.parentElement).toBe(document.body);
    t.click(leaf);
    expect(t.closed()).toBe(0);

    movedNested.destroy();
    movedPanel.destroy();
    t.action.destroy();
  });

  it('still fires for a portalled panel belonging to somebody else', () => {
    const t = guarded();
    const stranger = document.createElement('div');
    const panel = document.createElement('div');
    const leaf = document.createElement('button');
    panel.appendChild(leaf);
    stranger.appendChild(panel);
    document.body.appendChild(stranger);

    const moved = portal(panel);
    t.click(leaf);
    expect(t.closed()).toBe(1);

    moved.destroy();
    t.action.destroy();
  });

  /**
   * A destroyed portal forgets where it came from, so a node re-parented by something else later
   * cannot inherit a containment it never had.
   */
  it('forgets the origin once the portal is destroyed', () => {
    const t = guarded();
    const panel = document.createElement('div');
    t.child.appendChild(panel);
    const moved = portal(panel);
    moved.destroy();

    document.body.appendChild(panel);
    t.click(panel);
    expect(t.closed()).toBe(1);
    t.action.destroy();
  });

  it('does nothing while disabled, and resumes when enabled again', () => {
    const owner = document.createElement('div');
    const outside = document.createElement('div');
    document.body.append(owner, outside);
    let closed = 0;
    const action = clickOutside(owner, { enabled: false, callback: () => (closed += 1) });

    outside.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    expect(closed).toBe(0);

    action.update({ enabled: true, callback: () => (closed += 1) });
    outside.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
    expect(closed).toBe(1);
    action.destroy();
  });
});
