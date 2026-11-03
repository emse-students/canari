// @vitest-environment happy-dom
/**
 * A DIALOG OPENED FROM INSIDE A FULL-SCREEN VIEWER IS DRAWN ABOVE IT (`utils/viewerLayer.ts`): the
 * report dialog of a comment in the CanaReels sheet sat on `--z-modal` (280), under the viewer
 * (`--z-viewer`, 300). Marked by the viewer, `Modal` and `ModalOverlay` take `--z-viewer-dialog`;
 * anywhere else they keep their own rung.
 */
import { afterEach, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Host from './ViewerLayerHost.test-helper.svelte';
import NestedHost from './NestedDialogHost.test-helper.svelte';

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

function render(inViewer: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(Host, { target, props: { inViewer } }));
  flushSync();
  const modal = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;
  const overlay = document.querySelector('[data-overlay-body]')!.closest('.fixed') as HTMLElement;
  return { modal, overlay };
}

it('inside a viewer, both dialogs take the rung above it', () => {
  const { modal, overlay } = render(true);
  expect(modal.className).toContain('z-(--z-viewer-dialog)');
  expect(overlay.className).toContain('z-(--z-viewer-dialog)');
});

it('anywhere else, they keep their own rung', () => {
  const { modal, overlay } = render(false);
  expect(modal.className).toContain('z-(--z-modal)');
  expect(modal.className).not.toContain('z-(--z-viewer-dialog)');
  expect(overlay.className).not.toContain('z-(--z-viewer-dialog)');
});

/**
 * THE COMMENT GIF PICKER OPENED UNDER ITS OWN COMMENTS SHEET (iPhone, 2026-11-03): the picker is a
 * `ModalOverlay` on `--z-sheet` (160), the sheet a `CommentsDrawer` (phone) or `Modal` (desktop) on
 * `--z-modal` (280). What a dialog opens must clear the dialog.
 */
it.each(['modal', 'drawer'] as const)('a picker opened from a %s clears it', (host) => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(NestedHost, { target, props: { host } }));
  flushSync();
  const overlay = document.querySelector('[data-overlay-body]')!.closest('.fixed') as HTMLElement;
  expect(overlay.className).toContain('z-(--z-viewer-dialog)');
  expect(overlay.className).not.toContain('z-(--z-sheet)');
});
