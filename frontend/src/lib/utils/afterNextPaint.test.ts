// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterNextPaint } from './afterNextPaint';

const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => vi.unstubAllGlobals());

describe('afterNextPaint', () => {
  it('runs nothing inside the frame callback, and the work once after it', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    const work = vi.fn();
    afterNextPaint(work);
    expect(work).not.toHaveBeenCalled();
    frames.shift()!(0);
    // Still inside the frame: the paint has not happened yet.
    expect(work).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
  });

  it('runs at once in a hidden document, which paints no frame', () => {
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const work = vi.fn();
    afterNextPaint(work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('a pressed salon row', () => {
  it('lights up before the salon mounts, and a later press wins (2026-10-13)', () => {
    // WHY A SOURCE TEST (WP-T5: keep). The helper is driven above; the ORDER of three statements in
    // `MainChatPage`'s salon handler is the property, and mounting the whole chat page to press one
    // row would assert the mocks it needs, not the order.
    const page = readFileSync(join(here, '../components/MainChatPage.svelte'), 'utf8');
    const handler = page.slice(page.indexOf('onSelectChannelConversation:'));
    const highlight = handler.indexOf('channels.selectedChannelConversationId = channelId;');
    const deferred = handler.indexOf('afterNextPaint(() => {');
    const select = handler.indexOf('convs.selectConversation(channelId);');
    expect(highlight).toBeGreaterThan(-1);
    expect(deferred).toBeGreaterThan(highlight);
    expect(select).toBeGreaterThan(deferred);
    expect(handler.slice(deferred, select)).toContain(
      'if (channels.selectedChannelConversationId !== channelId) return;'
    );
  });
});
