// @vitest-environment happy-dom
/**
 * WHAT AN OVERLAY OPENS IS DRAWN ABOVE IT, BY OPEN ORDER AND NOT BY RUNG (`utils/overlayStack.ts`).
 *
 * The report dialog of a comment in the CanaReels sheet sat under the viewer, the comment GIF picker
 * under its own comments sheet, a dropdown under the nested dialog it belonged to: each nesting
 * needed another rung. These tests mount the real components and read the z-index each takes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import NestedHost from './NestedDialogHost.test-helper.svelte';
import Modal from './Modal.svelte';
import GateHost from './GateHost.test-helper.svelte';
import Probe from './LayerProbe.test-helper.svelte';
import { openOverlayDepth, registerGate, registerOverlay } from '$lib/utils/overlayLayer.svelte';

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

function render(host: 'modal' | 'drawer' | 'popover') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(NestedHost, { target, props: { host } }));
  flushSync();
}

const zOf = (el: Element | null) => Number((el as HTMLElement).style.zIndex);

describe('overlays by open order', () => {
  it('a Modal and a ModalOverlay opened later than a viewer are above it', () => {
    const viewer = registerOverlay('viewer');
    render('modal');

    const modal = document.querySelector('[data-keyboard-aware-overlay]');
    const sheet = document.querySelector('[data-overlay-body]')!.closest('.fixed');
    expect(zOf(modal)).toBeGreaterThan(viewer.z!);
    expect(zOf(sheet)).toBeGreaterThan(zOf(modal));
    viewer.release();
  });

  it.each(['modal', 'drawer'] as const)('a picker opened from a %s clears it', (host) => {
    render(host);

    const overlay = document.querySelector('[data-overlay-body]')!.closest('.fixed');
    const parent =
      host === 'modal'
        ? document.querySelector('[data-keyboard-aware-overlay]')
        : document.querySelector('[data-comments-drawer]');
    expect(zOf(overlay)).toBeGreaterThan(zOf(parent));
  });

  it('a popover inside a nested Modal clears both dialogs', () => {
    render('popover');

    const panel = document.querySelector('[data-popover-body]')!.closest('[role="group"]');
    const modals = [...document.querySelectorAll('[data-keyboard-aware-overlay]')].map(zOf);
    expect(modals).toHaveLength(2);
    expect(zOf(panel)).toBeGreaterThan(Math.max(...modals));
  });

  it('releases on destroy while open, so the depth returns to what it was', () => {
    const before = openOverlayDepth();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const modal = mount(Modal, { target, props: { open: true, title: 'T', onClose: () => {} } });
    flushSync();
    expect(openOverlayDepth()).toBe(before + 1);

    unmount(modal);
    flushSync();
    expect(openOverlayDepth()).toBe(before);
  });

  it('closes ranks when the lower of two overlays closes', () => {
    const lower = registerOverlay('lower');
    const upper = registerOverlay('upper');
    const upperZ = upper.z!;

    lower.release();
    expect(upper.z).toBeLessThan(upperZ);
    upper.release();
    expect(lower.z).toBeUndefined();
  });
});

describe('the pinned gate tier', () => {
  it('keeps a viewer opened AFTER the PIN under it, and the PIN under the boot gate', () => {
    const pin = registerGate('PinModal', 'test');
    const viewer = registerOverlay('viewer');
    const boot = registerGate('BootGate', 'test');

    expect(viewer.z!).toBeLessThan(pin.z!);
    expect(pin.z!).toBeLessThan(boot.z!);
    expect(boot.zAbove!).toBeLessThan(310);
    for (const layer of [pin, viewer, boot]) layer.release();
  });

  it('opens the real PIN Modal over a viewer registered after it', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(mount(GateHost, { target, props: {} }));
    flushSync();
    const viewer = registerOverlay('viewer-after-pin');

    const pin = document.querySelector('[data-keyboard-aware-overlay]');
    expect(zOf(pin)).toBeGreaterThan(viewer.z!);
    viewer.release();
  });
});

describe('what useOverlayLayer registers on', () => {
  it('keeps its rank when a dependency changes but the overlay stays open', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ open: true, dep: 1 });
    mounted.push(mount(Probe, { target, props }));
    flushSync();
    const later = registerOverlay('later');
    const before = zOf(document.querySelector('[data-probe]'));

    props.dep = 2;
    flushSync();

    expect(zOf(document.querySelector('[data-probe]'))).toBe(before);
    expect(later.z!).toBeGreaterThan(before);
    later.release();
  });

  it('holds its z-index while it plays an outro, once released', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const props = $state({ open: true, outro: true });
    mounted.push(mount(Probe, { target, props }));
    flushSync();
    const during = zOf(document.querySelector('[data-probe]'));
    expect(during).toBeGreaterThan(0);

    props.open = false;
    flushSync();

    expect(openOverlayDepth()).toBe(0);
    expect(zOf(document.querySelector('[data-probe]'))).toBe(during);
  });
});
