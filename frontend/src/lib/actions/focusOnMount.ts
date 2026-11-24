/**
 * Focus an element the moment it exists, when `enabled`.
 *
 * It replaces an `$effect` that looked the Accept button up by test id: an effect and the `{#if}`
 * that creates its target are not ordered by any contract (Svelte 5.59 runs the effect FIRST when
 * the same state change both renders the button and triggers the effect), so the lookup found
 * nothing and focus stayed on the overlay's first control. An action runs only once its element is
 * in the DOM, so there is no order to depend on.
 */
export function focusOnMount(node: HTMLElement, enabled: boolean) {
  if (enabled) node.focus({ preventScroll: true });
}
