// @vitest-environment happy-dom
/**
 * THE PICKER OF A SHARE FROM ANOTHER APP IS DRAWN ABOVE A FULL-SCREEN VIEWER (owner, 2026-11-07,
 * Android): sharing a live's link "via Canari" from the live viewer opened "Envoyer a..." under the
 * viewer - present, focused, invisible until the live was closed. The host sits at the app root,
 * outside every viewer's subtree; with the overlay stack nothing has to mark it, because the picker
 * opens AFTER the viewer and the last opened is on top (`utils/overlayStack.ts`).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { registerOverlay } from '$lib/utils/overlayLayer.svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: true, userId: 'me' },
  globalConvs: { conversations: new Map(), conversationSourcesSettled: true },
  globalChannels: { channelWorkspaces: new Map() },
  appendLog: () => {},
}));

import IncomingShareHost from './IncomingShareHost.svelte';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  incomingShare.cancel();
  document.body.innerHTML = '';
});

it('the share picker clears the full-screen viewers', () => {
  const viewer = registerOverlay('viewer');
  incomingShare.offer({ text: 'https://canari.emse.fr/lives/abc', files: [] });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(IncomingShareHost, { target }));
  flushSync();

  const picker = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;
  expect(picker).not.toBeNull();
  expect(Number(picker.style.zIndex)).toBeGreaterThan(viewer.z!);
  viewer.release();
});
