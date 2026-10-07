/**
 * Centres a message inside the message list by scrolling THAT list and nothing else.
 *
 * `Element.scrollIntoView` scrolls every scrollable ancestor up to the viewport, so a jump
 * to a pinned message also moved the page wrapper and pushed the salon header off screen
 * (reported 2026-10-05). The list is the only container a jump may move, so the offset is
 * computed against it and applied with `scrollTo` on it alone.
 *
 * @param container The message list's own scroll container.
 * @param target The message element to bring to the middle of that container.
 * @param behavior Scroll behaviour passed through to `scrollTo`.
 */
export function scrollMessageIntoList(
  container: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior = 'smooth'
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTopInContent = container.scrollTop + (targetRect.top - containerRect.top);
  const top = targetTopInContent - (container.clientHeight - targetRect.height) / 2;
  container.scrollTo({ top: Math.max(0, top), behavior });
}
