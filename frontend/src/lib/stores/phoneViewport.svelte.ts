import { createSubscriber } from 'svelte/reactivity';
import {
  isOverlayLayout,
  isPhoneViewport,
  onViewportChange,
  OVERLAY_LAYOUT_QUERY,
  PHONE_VIEWPORT_QUERY,
} from '$lib/utils/viewport';

/**
 * A viewport question a template or an effect can READ and be re-run by.
 *
 * ONE `matchMedia` LISTENER PER QUESTION FOR EVERY READER, however many rows ask (a conversation
 * holds hundreds of message bubbles). The subscription starts with the first reading effect and
 * ends with the last, so a screen that never asks pays nothing. The answer itself comes from
 * `$lib/utils/viewport`, the one place a breakpoint is decided, and keeps its `false` where it
 * cannot be asked (a server render, a bare test environment).
 */
function reactiveViewport(query: string, answer: () => boolean): () => boolean {
  const subscribe = createSubscriber((update) => onViewportChange(query, update));
  return () => {
    subscribe();
    return answer();
  };
}

/** Reactive: true below Tailwind `md`, re-evaluated on a rotation or a resized window. */
export const phoneViewport = reactiveViewport(PHONE_VIEWPORT_QUERY, isPhoneViewport);

/**
 * Reactive: true below Tailwind `xl`, where the layout has no room for a side column and panels
 * become full-screen overlays. A component drawn ONLY at `xl` is not worth mounting under it.
 */
export const overlayLayout = reactiveViewport(OVERLAY_LAYOUT_QUERY, isOverlayLayout);
