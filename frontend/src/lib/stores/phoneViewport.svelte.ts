import { createSubscriber } from 'svelte/reactivity';
import { isPhoneViewport, onViewportChange, PHONE_VIEWPORT_QUERY } from '$lib/utils/viewport';

/**
 * ONE `matchMedia` LISTENER FOR EVERY READER of "is this a phone-sized screen", however many rows
 * ask (a conversation holds hundreds of message bubbles). The subscription starts with the first
 * reading effect and ends with the last, so a screen that never asks pays nothing.
 */
const subscribe = createSubscriber((update) => onViewportChange(PHONE_VIEWPORT_QUERY, update));

/**
 * Reactive: true below Tailwind `md`, re-evaluated on a rotation or a resized window. Reading it in
 * a template or an effect re-runs that reader when the answer changes. Same `false` answer as
 * `isPhoneViewport` where it cannot be asked (a server render, a bare test environment).
 */
export function phoneViewport(): boolean {
  subscribe();
  return isPhoneViewport();
}
