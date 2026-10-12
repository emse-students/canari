/**
 * Centres a message inside the message list by scrolling THAT list and nothing else.
 *
 * `Element.scrollIntoView` scrolls every scrollable ancestor up to the viewport, so a jump
 * to a pinned message also moved the page wrapper and pushed the salon header off screen
 * (reported 2026-10-05). The list is the only container a jump may move, so the offset is
 * computed against it and applied with `scrollTo` on it alone.
 *
 * **THE JUMP IS INSTANT BY DEFAULT, NOT SMOOTH (2026-10-12).** A smooth scroll is an animation
 * spread over many frames, and ANY plain `scrollTop` write during it cancels it where it stands.
 * The thread's anchor observer (`threadGrowthObserver`) makes exactly such writes whenever a row
 * above the reader moves - and the tap that asks for a jump moves every row itself: closing the
 * pinned or poll dropdown shrinks the floating glass chrome of the phone apps, which is the list's
 * `padding-top`. So the jump was cancelled a frame after it started and the anchor correction put
 * the reader back at the bottom ("1 sondage actif" did nothing, Android, user 2026-10-12). An
 * instant jump has nothing in flight to cancel: the corrections that follow only compensate the
 * padding, which keeps the target where it landed.
 *
 * @param container The message list's own scroll container.
 * @param target The message element to bring to the middle of that container.
 * @param behavior Scroll behaviour passed through to `scrollTo`.
 */
export function scrollMessageIntoList(
  container: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior = 'auto'
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTopInContent = container.scrollTop + (targetRect.top - containerRect.top);
  const top = targetTopInContent - (container.clientHeight - targetRect.height) / 2;
  container.scrollTo({ top: Math.max(0, top), behavior });
}
