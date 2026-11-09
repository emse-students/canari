// @vitest-environment happy-dom
/**
 * THE PICKER OF A SHARE FROM ANOTHER APP IS DRAWN ABOVE A FULL-SCREEN VIEWER (owner, 2026-11-07,
 * Android): sharing a live's link "via Canari" from the live viewer opened "Envoyer a..." on
 * `--z-modal` (280), under the viewer (`--z-viewer`, 300) - present, focused, invisible until the
 * live was closed. The host sits at the app root, outside every viewer's subtree, so the viewer's own
 * mark (`markViewerLayer`) never reaches it: the host marks itself, and its `Modal` takes
 * `--z-viewer-dialog`. happy-dom does not resolve `app.css`, so the order is read from the ladder.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushSync, mount, unmount } from 'svelte';

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
  incomingShare.offer({ text: 'https://canari.emse.fr/lives/abc', files: [] });
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(IncomingShareHost, { target }));
  flushSync();

  const picker = document.querySelector('[data-keyboard-aware-overlay]') as HTMLElement;
  expect(picker).not.toBeNull();
  expect(picker.className).toContain('z-(--z-viewer-dialog)');
  expect(picker.className).not.toContain('z-(--z-modal)');

  const css = readFileSync(join(process.cwd(), 'src/app.css'), 'utf8');
  const rung = (name: string) => Number(new RegExp(String.raw`--z-${name}:\s*(\d+)`).exec(css)![1]);
  expect(rung('viewer-dialog')).toBeGreaterThan(rung('viewer'));
});
