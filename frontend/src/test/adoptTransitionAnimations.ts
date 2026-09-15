/**
 * ADOPT THE PROMISE happy-dom CREATES AND SVELTE NEVER ASKED FOR.
 *
 * A Svelte transition is a Web Animation: `element.animate(...)`, and `abort()` calls `cancel()` on
 * it when the element goes away mid-flight - which is exactly what an outro does when the test
 * tears down. Cancelling an animation rejects its `finished` promise with `AbortError`.
 *
 * In a browser that costs nothing, because `Animation.finished` is created LAZILY and Svelte never
 * reads it: `transitions.js` cancels the animation, nulls its effect and replaces `onfinish`, and
 * touches no promise at all. happy-dom creates `finished` eagerly in its constructor, so the
 * rejection lands with no handler anywhere and vitest reports two unhandled rejections on a suite
 * whose every assertion passed - a red run for something the product does not do.
 *
 * Adopting it is the whole fix. Nothing here changes what runs, what is asserted or when: the
 * animation is still created, still cancelled, still aborted at the same moment. What changes is
 * that the rejection has an owner.
 *
 * Call it from a component test that plays an OUTRO - a `{#if}` with `transition:` going false, or
 * an unmount while one is in flight. A test that only ever plays intros does not need it.
 */

/**
 * Installs the shim and returns its undo, for a test file's `afterEach`/`afterAll`.
 *
 * Idempotent in effect but not in bookkeeping: each call captures the implementation it replaced,
 * so calls must be undone in reverse. One per test file is the intended shape.
 */
export function adoptTransitionAnimations(): () => void {
  const real = Element.prototype.animate;

  Element.prototype.animate = function (
    this: Element,
    ...args: Parameters<Element['animate']>
  ): Animation {
    const animation = real.apply(this, args);
    // Optional-chained because this runs against whatever the test environment provides, and a
    // stub with no `finished` at all is a shape this must not throw on.
    animation.finished?.catch(() => {});
    return animation;
  };

  return () => {
    Element.prototype.animate = real;
  };
}
