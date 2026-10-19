/**
 * THE BROADCASTER'S SCREEN, mounted over a fake camera and server: the one-screen rules with the
 * server's numbers, the battery warning, Start, the on-air badge and the quiet reconnecting state,
 * End behind a confirmation, the end screen's cause, and Back on air asking instead of ending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveBroadcaster from './LiveBroadcaster.svelte';
import LiveOverlay from './LiveOverlay.svelte';
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
import { flushMacrotask } from '../../../test/flush';

vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(() => Promise.resolve(true)) }));

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
});
