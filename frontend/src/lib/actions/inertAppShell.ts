import { portalOrigin } from '$lib/actions/portal';
import { Log } from '$lib/utils/Log';

/**
 * Makes the app shell inert while a window-covering surface that was portalled out of it is
 * mounted (the carte editor).
 *
 * The surface paints over the shell, but what is painted over is still reachable: Tab walked into
 * the hidden page behind the editor, and a screen reader read it. `inert` removes it from both.
 *
 * It targets `.app-shell` - NOT the body's first child - because the layout's `ConfirmDialog` and
 * toasts are siblings of the shell inside the same root, and they must stay usable above the
 * editor. Put it AFTER `use:portalWhile` on the node: the origin it climbs from is recorded when
 * the node moves. The shell's previous `inert` value is restored on destroy.
 */
export function inertAppShell(node: HTMLElement) {
  const origin = portalOrigin(node) ?? node.parentElement;
  const shell = origin?.closest<HTMLElement>('.app-shell') ?? null;
  if (!shell) {
    Log.d('inertAppShell', 'no .app-shell around the surface; nothing made inert');
    return {};
  }
  const was = shell.inert;
  shell.inert = true;
  return {
    destroy() {
      shell.inert = was;
    },
  };
}
