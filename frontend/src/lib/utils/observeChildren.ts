/**
 * Keep a `ResizeObserver` on every child of `node` - the ones there now AND the ones rendered later.
 *
 * Reading `node.children` once, when an action or an effect starts, is a bet that Svelte rendered the
 * children first. Since 5.59 it does not promise that (an action can start before its sibling
 * `{#each}`), so the children are re-enrolled whenever the child list changes, driven by the DOM
 * itself (`childList`), never by a clock. `observe` is idempotent and a removed child is released.
 *
 * @param selector when given, only the matching children are observed.
 * @returns the stop function: it disconnects the child watcher (the caller owns the `observer`).
 */
export function observeChildren(
  node: Element,
  observer: ResizeObserver | null,
  selector?: string
): () => void {
  if (!observer) return () => {};
  const wanted = (el: Element) => !selector || el.matches(selector);
  const enrol = () => {
    for (const child of Array.from(node.children)) if (wanted(child)) observer.observe(child);
  };
  enrol();
  if (typeof MutationObserver === 'undefined') return () => {};
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed instanceof Element) observer.unobserve(removed);
      }
    }
    enrol();
  });
  mutations.observe(node, { childList: true });
  return () => mutations.disconnect();
}
