/**
 * THE FULL-SCREEN CALL, AS A SCREEN-READER, A KEYBOARD AND THE SYSTEM BACK MEET IT.
 *
 * Each case fails without its fix (review of #2138): the ring is an ALERT with focus on Accept;
 * a state change is announced once, never the timer's every second; the chevron and Escape leave
 * the history stack through the binder (no entry accumulates over minimise/expand cycles); a voice
 * the engine refused says "tap to hear" and the next tap starts it.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { writable } from 'svelte/store';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
const logs = vi.hoisted(() => [] as string[]);
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import CallOverlay from './CallOverlay.svelte';
import type { CallService, CallState } from '$lib/services/CallService';
import { callView } from '$lib/stores/callView.svelte';
import { historyOverlayStackDepth, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The screen fades out when it minimises: its cancelled animation needs an owner.
afterAll(adoptTransitionAnimations());

function fakeService(state: CallState) {
  return {
    callState: writable<CallState>(state),
    remoteStream: writable<MediaStream | null>(null),
    remoteStreams: writable(new Map<string, MediaStream>()),
    localStreamStore: writable<MediaStream | null>(null),
    isMuted: writable(false),
    isVideoOff: writable(true),
    connectedAt: writable<number | null>(state === 'incall' ? 1 : null),
    endedAt: writable<number | null>(null),
    reconnecting: writable(false),
    currentGroupId: 'g',
    currentCallId: 'c',
    acceptCall: vi.fn(async () => {}),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    toggleVideo: vi.fn(),
  };
}

let stopHistory: () => void = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  logs.length = 0;
  callView.reset();
  callView.setLocked(false);
  stopHistory = initHistoryOverlayStack();
  // jsdom has no media pipeline: a play() that resolves unless a test says otherwise.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  stopHistory();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function render(service: ReturnType<typeof fakeService>) {
  const c = mount(CallOverlay, {
    target: document.body,
    props: {
      callService: service as unknown as CallService,
      participants: [{ userId: 'bob', displayName: 'Bob' }],
    },
  });
  mounted.push(c);
  flushSync();
  await tick();
  return c;
}

const screen = () => document.querySelector<HTMLElement>('[data-testid="call-screen"]');

describe('the ring', () => {
  it('is an alertdialog with focus on Accept', async () => {
    await render(fakeService('incoming'));
    expect(screen()?.getAttribute('role')).toBe('alertdialog');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('call-accept');
  });

  it('is a plain dialog once answered', async () => {
    await render(fakeService('incall'));
    expect(screen()?.getAttribute('role')).toBe('dialog');
  });
});

describe('the live region', () => {
  it('announces the state, and "connected" rather than the running timer', async () => {
    const service = fakeService('incoming');
    await render(service);
    const announcer = () => document.querySelector('[data-testid="call-announcer"]');
    expect(announcer()?.getAttribute('role')).toBe('status');
    expect(announcer()?.textContent).toBe(m.call_incoming_label());

    service.callState.set('incall');
    service.connectedAt.set(1);
    flushSync();
    expect(announcer()?.textContent).toBe(m.call_live_announcement());

    service.reconnecting.set(true);
    flushSync();
    expect(announcer()?.textContent).toBe(m.call_reconnecting());
  });
});

describe('leaving the full screen', () => {
  it('minimises on Escape and on the chevron, and the history stack never grows over the cycles', async () => {
    await render(fakeService('incall'));
    expect(historyOverlayStackDepth()).toBe(1);
    const lengthOpen = history.length;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(callView.minimised).toBe(true);
    // The screen fades out (150 ms) before it leaves the DOM.
    await vi.waitFor(() => expect(screen()).toBeNull());
    expect(historyOverlayStackDepth()).toBe(0);

    callView.expand();
    flushSync();
    expect(historyOverlayStackDepth()).toBe(1);

    screen()!
      .querySelector<HTMLButtonElement>(`[aria-label="${m.call_minimize_label()}"]`)!
      .click();
    flushSync();
    expect(callView.minimised).toBe(true);
    expect(historyOverlayStackDepth()).toBe(0);

    callView.expand();
    flushSync();
    // The expand took the ghost the minimise left: no entry was added by the two cycles.
    expect(history.length).toBe(lengthOpen);
  });
});

describe('a voice the engine refused', () => {
  it('says "tap to hear", and the next tap anywhere starts it', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('no gesture', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    const service = fakeService('incall');
    await render(service);

    service.remoteStream.set(new MediaStream());
    flushSync();
    await vi.waitFor(() => expect(callView.audioBlocked).toBe(true));
    flushSync();
    expect(document.querySelector('[data-testid="call-tap-to-hear"]')).not.toBeNull();

    window.dispatchEvent(new PointerEvent('pointerdown'));
    await vi.waitFor(() => expect(callView.audioBlocked).toBe(false));
    expect(play).toHaveBeenCalledTimes(2);
    flushSync();
    expect(document.querySelector('[data-testid="call-tap-to-hear"]')).toBeNull();
  });
});

describe('the PIN lock', () => {
  it('is never painted over: the full screen steps back while it is up', async () => {
    await render(fakeService('incoming'));
    expect(screen()).not.toBeNull();
    callView.setLocked(true);
    flushSync();
    await vi.waitFor(() => expect(screen()).toBeNull());
    callView.setLocked(false);
    flushSync();
    expect(screen()).not.toBeNull();
  });
});

describe('the size of every control', () => {
  // `iconButtonScale.test.ts` reads markup, and the big controls are drawn by a snippet it cannot
  // see through. So the RENDERED screen is held here: every button is either the shared icon button
  // or a 64px (`size-16`) call control - never a third size, in the ring or in the call.
  it.each(['incoming', 'incall'] as const)('is the icon button or 64px while %s', async (state) => {
    await render(fakeService(state));
    const buttons = [...screen()!.querySelectorAll('button')].filter(
      (b) => b.dataset.testid !== 'call-tap-to-hear'
    );
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) {
      const ok = b.classList.contains('ui-icon-button') || b.classList.contains('size-16');
      expect(ok, b.getAttribute('aria-label') ?? b.outerHTML).toBe(true);
    }
  });
});
