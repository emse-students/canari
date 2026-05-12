/** Svelte action that moves the attached DOM node into `target` (defaults to `document.body`), enabling CSS-stacking-context escapes for modals and tooltips. */
export function portal(node: HTMLElement, target: HTMLElement = document.body) {
  target.appendChild(node);

  return {
    destroy() {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
}
