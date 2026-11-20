// @vitest-environment happy-dom
/**
 * A PARENT RE-TARGETING A MOUNTED SCREEN, through the screen's OWN machine (no injected broadcast, as
 * in production). The feed passes `associationId={liveTarget.associationId}`, a getter over its
 * `$state`, and "En direct" assigns `liveTarget` a new object. Reached on dev (2026-11-20) by
 * "Publier" then "En direct" past an ended screen: the screen's machine, then a prop fallback and so
 * a `derived` of that getter, was made again - phase `preview`, its limits never read, "Reading the
 * live's rules" with no request. The screen must hold ONE machine for its life, whatever its props do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LiveBroadcaster from './LiveBroadcaster.svelte';
import { FakeMediaStream, studioOn } from '$lib/live/liveStudio.test-helper';
import * as liveApi from '$lib/live/api';
import { m } from '$lib/paraglide/messages';
import { fakeDeps, LIMITS } from '$lib/live/liveBroadcast.test-helper';
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
  it('start -> end -> the parent re-targets it: ONE machine, the end screen stays, rules read once', async () => {
    // The desktop's machine: scenes, whose constructor sets state the screen must not track.
    vi.stubGlobal('MediaStream', FakeMediaStream);
    const f = fakeDeps();
    f.deps.createStudio.mockImplementation((camera) => studioOn(camera).studio);
    made.deps = f.deps;
    const deps = f.deps;
    // The feed's own shape (`routes/posts/+page.svelte`): a `$state` target read through getters.
    let liveTarget = $state<{ associationId: string | null; associationName: string | null }>({
      associationId: null,
      associationName: null,
    });
    const props = {
      get associationId() {
        return liveTarget.associationId;
      },
      get associationName() {
        return liveTarget.associationName;
      },
      onclose: vi.fn(),
    };
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(LiveBroadcaster, { target, props });
    await settle();
    const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector<T>(sel);
    expect(made.machines).toHaveLength(1);
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(1);

    q<HTMLButtonElement>('[data-live-start]')!.click();
    await settle();
    expect(q('[data-live-phase]')!.dataset.livePhase).toBe('live');
    q<HTMLButtonElement>('[data-live-end]')!.click();
    await settle();
    expect(showConfirm).toHaveBeenCalled();
    expect(q('[data-live-ended]')).not.toBeNull();

    // "En direct" again with this screen mounted: the same target, as a NEW object.
    liveTarget = { associationId: null, associationName: null };
    await settle();

    expect(made.machines).toHaveLength(1);
    expect(q('[data-live-phase]')!.dataset.livePhase).toBe('ended');
    expect(q('[data-live-ended]')).not.toBeNull();
    expect(target.textContent).not.toContain(m.live_limits_loading());
    expect(deps.fetchLiveRules).toHaveBeenCalledTimes(1);
  });
});
