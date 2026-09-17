import { focusTrap } from './focusTrap.svelte';

/**
 * WHAT THIS FILE IS FOR: opening an overlay must not scroll the page underneath it.
 *
 * `focusTrap` moves focus into a panel the instant it mounts, and a portalled overlay is still
 * inside `.page-scroll-wrap` for one effect at that moment - the child's action runs before the
 * parent's `use:portal`. That wrapper carries `will-change: transform`, so the `fixed` backdrop is
 * laid out at the SCROLLER's origin rather than the viewport's, and a plain `focus()` asks the
 * browser to reveal something sitting at scroll offset zero. The page jumped to the top, on every
 * modal in the app, from any scrolled position (user, 2026-09-17, about the planning list:
 * *"Cliquer sur evenement sur mobile (type liste) renvoie vers le haut de la page"*).
 *
 * happy-dom has no layout and cannot scroll, so the SCROLL cannot be asserted here - the scroll
 * itself was measured in Chrome and the numbers are in the action's header. What a test CAN pin,
 * and what actually decides the behaviour, is the option: every focus call made at MOUNT passes
 * `preventScroll`, and the two Tab wrap-arounds deliberately do not.
 */

/** A panel with `count` focusable controls, in the document, plus the trigger that opened it. */
function panel(count: number) {
  const trigger = document.createElement('button');
  const node = document.createElement('div');
  node.tabIndex = -1;
  const controls: HTMLButtonElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const button = document.createElement('button');
    button.textContent = `control ${i}`;
    node.appendChild(button);
    controls.push(button);
  }
  document.body.append(trigger, node);
  return { trigger, node, controls };
}

describe('focusTrap', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('focuses the first control without scrolling the page the overlay covers', () => {
    const t = panel(2);
    const focus = vi.spyOn(t.controls[0], 'focus');

    focusTrap(t.node);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('focuses the container itself, still without scrolling, when the panel has no control', () => {
    const t = panel(0);
    const focus = vi.spyOn(t.node, 'focus');

    focusTrap(t.node);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('lets the browser scroll when Tab wraps around inside the panel', () => {
    const t = panel(2);
    const first = vi.spyOn(t.controls[0], 'focus');
    focusTrap(t.node);
    t.controls[1].focus();
    first.mockClear();

    t.node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    // A wrap-around reveals a control the person may have scrolled away from, and `preventDefault`
    // has just cancelled the scroll the browser's own sequential navigation would have done.
    expect(first).toHaveBeenCalledWith();
  });

  it('returns focus to whatever opened the overlay', () => {
    const t = panel(1);
    t.trigger.focus();
    const back = vi.spyOn(t.trigger, 'focus');

    focusTrap(t.node).destroy();

    expect(back).toHaveBeenCalled();
  });
});
