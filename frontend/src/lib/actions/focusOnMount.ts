/** What `focusOnMount` is asked: `true`/`false`, or `{ select: true }` to also select a text field. */
export type FocusOnMount = boolean | { select?: boolean };

/**
 * Focus an element the moment it exists, when asked to.
 *
 * It replaces `$effect`s that looked their target up by ref or selector: an effect and the `{#if}`
 * the SAME state change renders are not ordered by any contract (Svelte 5.59 runs the effect FIRST),
 * so the lookup found nothing and focus stayed where it was. An action runs only once its element is
 * in the DOM, so there is no order to depend on.
 *
 * **The argument is read ONCE, when the element mounts** - there is no `update`: a later change does
 * not move focus, because focus moves on arrival and not on a state flip.
 */
export function focusOnMount(node: HTMLElement, opts: FocusOnMount) {
  const enabled = typeof opts === 'boolean' ? opts : true;
  if (!enabled) return;
  node.focus({ preventScroll: true });
  if (typeof opts === 'object' && opts.select && node instanceof HTMLInputElement) node.select();
}
