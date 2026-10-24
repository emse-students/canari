// @vitest-environment happy-dom
/**
 * THE BROADCASTER'S SCREEN, mounted over a fake camera and server: the one-screen rules with the
 * server's numbers, the battery warning, Start, the on-air badge and the quiet reconnecting state,
 * End behind a confirmation, the end screen's cause, and Back on air asking instead of ending - and
 * the chat on air (WP-L6): its own loop, the broadcaster's hide, and its 410 ending the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveBroadcaster from './LiveBroadcaster.svelte';
import LiveOverlay from './LiveOverlay.svelte';
import LiveBroadcasterChat from './LiveBroadcasterChat.svelte';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { LiveBroadcast } from '$lib/live/liveBroadcast.svelte';
import { fakeCamera, fakeDeps } from '$lib/live/liveBroadcast.test-helper';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { m } from '$lib/paraglide/messages';
import {
  clearHistoryOverlayStack,
  historyOverlayStackDepth,
  initHistoryOverlayStack,
} from '$lib/utils/historyOverlayStack';
import { LiveRefusalError } from '$lib/live/api';
import * as liveApi from '$lib/live/api';
import { sealLiveChatMessage } from '$lib/live/liveChatCrypto';
import { KEY, LIMITS, LIVE_ID } from '$lib/live/liveBroadcast.test-helper';
import type { LiveChatBlock, LiveManifest } from '$lib/live/types';
import { flushMacrotask } from '../../../test/flush';

vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(() => Promise.resolve(true)) }));
// The chat panel names each line's author.
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => '',
  resolveUserDisplayName: async () => 'Bob',
}));
// The on-air chat's network: no request leaves a test.
vi.mock('$lib/live/api', async (orig) => ({
  ...(await orig<typeof import('$lib/live/api')>()),
  fetchLiveManifest: vi.fn(),
  fetchLiveLimits: vi.fn(),
  hideLiveMessage: vi.fn(),
}));

const BOB = 'b'.repeat(64);
const CLIENT = '33333333-3333-4333-8333-333333333333';

/** A manifest whose chat block carries `messages` (sealed with the live's key). */
function chatManifest(messages: LiveChatBlock['messages']): LiveManifest {
  return {
    liveId: LIVE_ID,
    nextIndex: 0,
    lastSegmentAt: null,
    serverNow: '2026-10-19T10:00:00.000Z',
    segments: [],
    viewers: 3,
    chat: { messages, messagesCursor: messages.length, reactions: [], reactionsCursor: 0 },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

let teardown: () => void = () => {};
const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.mocked(liveApi.fetchLiveManifest).mockReset().mockResolvedValue(chatManifest([]));
  vi.mocked(liveApi.fetchLiveLimits).mockReset().mockResolvedValue(LIMITS);
  vi.mocked(liveApi.hideLiveMessage)
    .mockReset()
    .mockImplementation(async (liveId, messageId) => ({
      liveId,
      messageId,
      hidden: true as const,
    }));
  for (const level of ['debug', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  teardown = initHistoryOverlayStack();
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  teardown();
  clearHistoryOverlayStack();
  document.body.innerHTML = '';
  // The visibility test overrides it on the document itself.
  delete (document as unknown as Record<string, unknown>).visibilityState;
  vi.restoreAllMocks();
  vi.mocked(showConfirm).mockReset().mockResolvedValue(true);
});

function screen(battery: number | null = null, associationId: string | null = null) {
  const f = fakeDeps();
  const cam = fakeCamera();
  const broadcast = new LiveBroadcast(cam.session, associationId, f.deps);
  const onclose = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(LiveBroadcaster, {
    target,
    props: {
      broadcast,
      associationId,
      associationName: associationId ? 'BDE' : null,
      onclose,
      readBattery: () => Promise.resolve(battery),
    },
  });
  mounted.push(app);
  return { ...f, cam, broadcast, onclose };
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

describe('LiveBroadcaster', () => {
  it("the preview states the rules with the server's numbers, and Start opens the live", async () => {
    const { deps, broadcast } = screen();
    await settle();
    const text = document.body.textContent!;
    expect(text).toContain(m.live_rule_audience_member());
    expect(text).toContain(m.live_rule_moderation());
    expect(text).toContain(m.live_rule_duration({ minutes: 60 }));
    expect(text).toContain(m.live_rule_background({ seconds: 60 }));
    expect(q('[data-live-battery]')).toBeNull();
    const start = q<HTMLButtonElement>('[data-live-start]')!;
    expect(start.disabled).toBe(false);
    start.click();
    await settle();
    expect(deps.startLive).toHaveBeenCalledTimes(1);
    expect(broadcast.phase).toBe('live');
    expect(q('[data-live-phase]')!.dataset.livePhase).toBe('live');
    expect(q('[data-live-end]')).not.toBeNull();
    expect(q('[data-live-close]')).toBeNull();
  });

  it('as an association: its name and the association audience rule', async () => {
    screen(null, 'asso-1');
    await settle();
    const text = document.body.textContent!;
    expect(text).toContain(m.live_prelive_as_association({ name: 'BDE' }));
    expect(text).toContain(m.live_rule_audience_association());
  });

  it('warns under 60 % battery before the live, and not above', async () => {
    screen(0.42);
    await settle();
    expect(q('[data-live-battery]')!.textContent).toContain(
      m.live_battery_warning({ percent: 42 })
    );
  });

  it('a refused start says why, on the preview', async () => {
    const { deps } = screen();
    deps.startLive.mockRejectedValueOnce(
      new LiveRefusalError(409, 'LIVE_ALREADY_OPEN', '', 'refused', null, null, null)
    );
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-start-problem]')!.textContent).toContain(m.live_start_already_open());
  });

  it('first live: the rules sheet replaces Start until "I accept", then Start sends the version', async () => {
    const f = fakeDeps();
    f.deps.fetchLiveRules.mockResolvedValue({
      version: 1,
      acceptedVersion: null,
      acceptedAt: null,
    });
    const cam = fakeCamera();
    const broadcast = new LiveBroadcast(cam.session, null, f.deps);
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(LiveBroadcaster, {
        target,
        props: {
          broadcast,
          associationId: null,
          associationName: null,
          onclose: vi.fn(),
          readBattery: () => Promise.resolve(null),
        },
      })
    );
    await settle();
    const sheet = q('[data-live-rules]')!;
    for (const line of [
      m.live_rules_no_illegal(),
      m.live_rules_no_sexual(),
      m.live_rules_no_harassment(),
      m.live_rules_no_malware(),
      m.live_rules_sanction(),
    ]) {
      expect(sheet.textContent).toContain(line);
    }
    expect(q('[data-live-start]')).toBeNull();
    q<HTMLButtonElement>('[data-live-rules-accept]')!.click();
    await settle();
    expect(q('[data-live-rules]')).toBeNull();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(f.deps.startLive).toHaveBeenCalledWith(expect.any(String), undefined, 1);
  });

  it('a rules refusal at the start shows the sheet again with its sentence', async () => {
    const { deps } = screen();
    deps.startLive.mockRejectedValueOnce(
      new LiveRefusalError(403, 'LIVE_RULES_NOT_ACCEPTED', '', 'refused', null, null, null)
    );
    await settle();
    // After the mount read the (accepted) standing: only the re-read after the refusal sees v2.
    deps.fetchLiveRules.mockResolvedValue({ version: 2, acceptedVersion: 1, acceptedAt: 'x' });
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-rules]')).not.toBeNull();
    expect(q('[data-live-start-problem]')!.textContent).toContain(
      m.live_start_rules_not_accepted()
    );
  });

  it('on air: a retried segment shows the quiet reconnecting badge with the backlog', async () => {
    const { uploaders } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-reconnecting]')).toBeNull();
    uploaders[0].backlog = 4;
    uploaders[0].options.onRetry!(0, 1, new Error('x'));
    await settle();
    expect(q('[data-live-reconnecting]')!.textContent).toContain(m.live_backlog({ count: 4 }));
    // A plural, in both languages: one segment is not "1 segments".
    expect(m.live_backlog({ count: 1 }, { locale: 'en' })).toBe('1 segment waiting');
    expect(m.live_backlog({ count: 4 }, { locale: 'en' })).toBe('4 segments waiting');
    expect(m.live_backlog({ count: 1 }, { locale: 'fr' })).toBe('1 segment en attente');
  });

  it('ending offline: the screen says the wait is the network and offers to leave, which ends the live once', async () => {
    const { deps, uploaders, onclose } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    uploaders[0].idle.mockImplementation(() => new Promise(() => {}));
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await vi.waitFor(() => expect(q('[data-live-ending]')).not.toBeNull());
    expect(q('[data-live-ending]')!.textContent).toContain(m.live_ending_waiting());
    q<HTMLButtonElement>('[data-live-ending-leave]')!.click();
    await settle();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(uploaders[0].stop).toHaveBeenCalled();
    expect(deps.endLive).toHaveBeenCalledTimes(1);
  });

  it('nothing stored past the reconnect window ends the screen with the lost-connection sentence', async () => {
    const { uploaders, clock } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    uploaders[0].backlog = 40;
    clock.t += 61_000;
    uploaders[0].options.onRetry!(0, 50, new Error('x'));
    await settle();
    expect(q('[data-live-ended]')!.dataset.liveEnded).toBe('connection-lost');
    expect(document.body.textContent).toContain(m.live_ended_connection_lost());
  });

  it('a backlog past the cap while the server still stores ends the screen with the too-slow sentence', async () => {
    const { uploaders } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    uploaders[0].backlog = 1_000;
    uploaders[0].options.onRetry!(0, 50, new Error('x'));
    await settle();
    expect(q('[data-live-ended]')!.dataset.liveEnded).toBe('upload-too-slow');
    expect(document.body.textContent).toContain(m.live_ended_upload_too_slow());
  });

  it('End asks first; "keep going" keeps the live, yes ends it and shows why', async () => {
    const { deps } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await settle();
    expect(deps.endLive).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await settle();
    expect(deps.endLive).toHaveBeenCalledTimes(1);
    expect(q('[data-live-ended]')!.dataset.liveEnded).toBe('broadcaster');
    expect(document.body.textContent).toContain(m.live_ended_broadcaster());
  });

  it("a 410 on air ends the screen with the server's sentence", async () => {
    const { uploaders } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    uploaders[0].options.onStopped!(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null)
    );
    await settle();
    expect(document.body.textContent).toContain(m.live_ended_server());
  });

  it('a 410 whose endReason is cut gives the cut its own title, and not the generic server sentence', async () => {
    const { uploaders } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    uploaders[0].options.onStopped!(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut')
    );
    await settle();
    expect(q('[data-live-ended]')!.dataset.liveEnded).toBe('cut');
    expect(document.body.textContent).toContain(m.live_broadcast_cut_title());
    expect(document.body.textContent).not.toContain(m.live_ended_server());
    expect(document.body.textContent).not.toContain(m.live_ended_title());
  });

  it('the app hidden on air shows the camera paused, and coming back resumes on the same live', async () => {
    const { broadcast, recorders, setHidden } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    setHidden(true);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(q('[data-live-away]')).not.toBeNull();
    setHidden(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(broadcast.phase).toBe('live'));
    expect(recorders).toHaveLength(2);
  });

  it('unmounted on air, it ends the live (nothing stays on air behind a closed screen)', async () => {
    const { deps } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    unmount(mounted.pop()!);
    expect(deps.endLive).toHaveBeenCalledTimes(1);
  });
});

describe('LiveOverlay', () => {
  it('Back on air asks for the end, and "keep going" keeps the layer and its entry', async () => {
    const f = fakeDeps();
    const cam = fakeCamera();
    const broadcast = new LiveBroadcast(cam.session, null, f.deps);
    const onclose = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(LiveOverlay, {
        target,
        props: { broadcast, onclose, readBattery: () => Promise.resolve(null) },
      })
    );
    await settle();
    expect(q('[role="dialog"]')!.getAttribute('aria-label')).toBe(m.live_overlay_label());
    // Focus moved INTO the dialog on open.
    expect(document.activeElement).toBe(q('[role="dialog"]'));
    expect(historyOverlayStackDepth()).toBe(1);
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();

    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    history.back();
    await flushMacrotask();
    await settle();
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(onclose).not.toHaveBeenCalled();
    expect(broadcast.phase).toBe('live');
    expect(historyOverlayStackDepth()).toBe(1);
  });

  it('on air the chat runs its own loop, and the broadcaster hides a line', async () => {
    const sealed = await sealLiveChatMessage(KEY, LIVE_ID, CLIENT, BOB, 'bonjour');
    vi.mocked(liveApi.fetchLiveManifest).mockResolvedValueOnce(
      chatManifest([
        {
          id: 'm-1',
          seq: 1,
          authorId: BOB,
          clientId: CLIENT,
          sealed,
          createdAt: '2026-10-19T10:00:00.000Z',
        },
      ])
    );
    screen();
    await settle();
    expect(q('[data-live-broadcaster-chat]')).toBeNull();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-broadcaster-chat-box]')).not.toBeNull();
    await vi.waitFor(() =>
      expect(q('[data-live-chat-line="m-1"]')?.textContent).toContain('bonjour')
    );
    expect(liveApi.fetchLiveManifest).toHaveBeenCalledWith(LIVE_ID, undefined, {
      messagesAfter: undefined,
      reactionsAfter: undefined,
    });
    q<HTMLButtonElement>('[data-live-chat-line="m-1"] [data-live-chat-hide]')!.click();
    await settle();
    expect(liveApi.hideLiveMessage).toHaveBeenCalledWith(LIVE_ID, 'm-1');
    expect(q('[data-live-chat-line="m-1"]')).toBeNull();
  });

  it('on air the broadcaster sees HOW MANY watch, from its chat poll - a number and no name', async () => {
    vi.mocked(liveApi.fetchLiveManifest).mockResolvedValue({ ...chatManifest([]), viewers: 4 });
    screen();
    await settle();
    expect(q('[data-live-viewer-count]')).toBeNull();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    await vi.waitFor(() =>
      expect(q('[data-live-viewer-count]')?.getAttribute('data-live-viewer-count')).toBe('4')
    );
    expect(q('[data-live-viewer-count]')?.textContent).toContain(m.live_viewer_count({ count: 4 }));
  });

  it('a failed chat poll takes the count off the screen rather than leaving a stale one', async () => {
    vi.mocked(liveApi.fetchLiveManifest)
      .mockResolvedValueOnce({ ...chatManifest([]), viewers: 4 })
      .mockRejectedValue(new TransportFailureError('offline'));
    screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    await vi.waitFor(() => expect(q('[data-live-viewer-count]')).not.toBeNull());
    // The next tick (one second on) fails: no number until a poll answers again.
    await vi.waitFor(() => expect(q('[data-live-viewer-count]')).toBeNull(), { timeout: 3000 });
  });

  it('off air, the count goes with the live', async () => {
    vi.mocked(liveApi.fetchLiveManifest).mockResolvedValue({ ...chatManifest([]), viewers: 2 });
    screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    await vi.waitFor(() => expect(q('[data-live-viewer-count]')).not.toBeNull());
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await settle();
    expect(q('[data-live-ended]')).not.toBeNull();
    expect(q('[data-live-viewer-count]')).toBeNull();
  });

  it("the chat gives its count back when it goes - a new live never opens on the last one's audience", async () => {
    vi.mocked(liveApi.fetchLiveManifest).mockResolvedValue({ ...chatManifest([]), viewers: 6 });
    const counts: (number | null)[] = [];
    const target = document.createElement('div');
    document.body.appendChild(target);
    const chat = mount(LiveBroadcasterChat, {
      target,
      props: { liveId: LIVE_ID, keyHex: KEY, onViewers: (c: number | null) => counts.push(c) },
    });
    await vi.waitFor(() => expect(counts).toEqual([6]));
    // The screen keys this component on the live id: a new live unmounts it first.
    unmount(chat);
    expect(counts).toEqual([6, null]);
  });

  it("the chat's 410 with endReason 'cut' shows the broadcaster's cut screen", async () => {
    vi.mocked(liveApi.fetchLiveManifest).mockRejectedValue(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null, 'cut')
    );
    const { broadcast, deps } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await vi.waitFor(() => expect(broadcast.phase).toBe('ended'));
    await settle();
    expect(broadcast.endCause).toBe('cut');
    expect(q('[data-live-ended]')!.dataset.liveEnded).toBe('cut');
    expect(document.body.textContent).toContain(m.live_broadcast_cut_title());
    expect(deps.endLive).not.toHaveBeenCalled();
  });

  it("the chat's 410 ends the screen as the uploader's would, with the server's sentence", async () => {
    vi.mocked(liveApi.fetchLiveManifest).mockRejectedValue(
      new LiveRefusalError(410, 'LIVE_ENDED', '', 'ended', null, null, null)
    );
    const { broadcast } = screen();
    await settle();
    q<HTMLButtonElement>('[data-live-start]')!.click();
    await vi.waitFor(() => expect(broadcast.phase).toBe('ended'));
    await settle();
    expect(broadcast.endCause).toBe('server');
    expect(document.body.textContent).toContain(m.live_ended_server());
    expect(q('[data-live-broadcaster-chat-box]')).toBeNull();
  });
});
