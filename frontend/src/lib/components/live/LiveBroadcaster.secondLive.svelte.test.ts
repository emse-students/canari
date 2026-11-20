// @vitest-environment happy-dom
/**
 * THE SECOND LIVE OF A SITTING, through the screen's OWN machine (no injected broadcast, as in
 * production): the machine is made once, so nothing a live's end sets can hand the screen a fresh
 * `preview` machine whose limits were never read ("Reading the live's rules" forever, no request).
 * Starts the first live, ends it, and counts the machines the screen made and the rules it read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveBroadcaster from './LiveBroadcaster.svelte';
import { FakeMediaStream, studioOn } from '$lib/live/liveStudio.test-helper';
import * as liveApi from '$lib/live/api';
import { LiveBroadcast } from '$lib/live/liveBroadcast.svelte';
import { m } from '$lib/paraglide/messages';
import { fakeCamera, fakeDeps, LIMITS } from '$lib/live/liveBroadcast.test-helper';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { clearHistoryOverlayStack, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';

const made = vi.hoisted(() => ({ machines: [] as unknown[], deps: null as unknown }));

// The screen builds its machine with the real constructor; this only RECORDS each one and hands it
// the fake camera and dependencies of every other screen test.
vi.mock('$lib/live/liveBroadcast.svelte', async (orig) => {
  const mod = await orig<typeof import('$lib/live/liveBroadcast.svelte')>();
  const { fakeCamera: camera } = await import('$lib/live/liveBroadcast.test-helper');
  class Recorded extends mod.LiveBroadcast {
    constructor(_camera: unknown, id: string | null) {
      super(camera().session, id, made.deps as never);
      made.machines.push(this);
    }
  }
  return { ...mod, LiveBroadcast: Recorded };
});
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn(() => Promise.resolve(true)) }));
vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));
vi.mock('$lib/live/api', async (orig) => ({
  ...(await orig<typeof import('$lib/live/api')>()),
  hideLiveMessage: vi.fn(),
  fetchLiveLimits: vi.fn(),
  fetchLiveManifest: vi.fn(async () => ({
    liveId: 'x',
    nextIndex: 0,
    lastSegmentAt: null,
    serverNow: '2026-10-19T10:00:00.000Z',
    segments: [],
    viewers: 0,
    chat: { messages: [], messagesCursor: 0, reactions: [], reactionsCursor: 0 },
  })),
}));

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

let teardown: () => void = () => {};
let app: Record<string, unknown> | null = null;

beforeEach(() => {
  made.machines.length = 0;
  vi.mocked(liveApi.fetchLiveLimits).mockReset().mockResolvedValue(LIMITS);
  for (const level of ['debug', 'log', 'warn'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  teardown = initHistoryOverlayStack();
});

afterEach(() => {
  if (app) unmount(app);
  app = null;
  teardown();
  clearHistoryOverlayStack();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LiveBroadcaster - its own machine across a live', () => {
  it('start -> end: ONE machine, its rules read once, the end screen over the same machine', async () => {
    // The desktop's machine: scenes, whose constructor sets state the screen must not track.
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const f = fakeDeps();
    f.deps.createStudio.mockImplementation((camera) => studioOn(camera).studio);
    made.deps = f.deps;
    const deps = f.deps;
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(LiveBroadcaster, { target, props: { onclose: vi.fn() } });
    await settle();
    const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector<T>(sel);
    expect(made.machines).toHaveLength(1);
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(1);

    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-phase]')!.dataset.livePhase).toBe('live');
    // The member moves between scenes on air (pause), as a desktop live does.
    await (
      made.machines[0] as { studio: { selectScene: (s: string) => Promise<void> } }
    ).studio.selectScene('pause');
    await settle();
    expect(made.machines).toHaveLength(1);
    expect(q('[data-live-phase]')!.dataset.livePhase).toBe('live');
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await settle();
    expect(showConfirm).toHaveBeenCalled();
    expect(q('[data-live-ended]')).not.toBeNull();

    // The same machine and the same rules: no machine nothing ever loaded was swapped in.
    expect(made.machines).toHaveLength(1);
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(1);
  });

  it('a machine swapped in under the mounted screen has its rules read, not left on "Reading"', async () => {
    const first = fakeDeps();
    const second = fakeDeps();
    made.deps = first.deps;
    const a = new LiveBroadcast(fakeCamera().session, null);
    made.deps = second.deps;
    const b = new LiveBroadcast(fakeCamera().session, null);
    made.machines.length = 0;
    const props = $state({ broadcast: a, onclose: () => {} });
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(LiveBroadcaster, { target, props });
    await settle();
    expect(first.deps.fetchLiveRules).toHaveBeenCalledTimes(1);
    expect(second.deps.fetchLiveRules).not.toHaveBeenCalled();

    props.broadcast = b;
    await settle();
    expect(second.deps.fetchLiveRules).toHaveBeenCalledTimes(1);
    expect(target.textContent).not.toContain(m.live_limits_loading());
    expect(b.limits).not.toBeNull();
  });
});
