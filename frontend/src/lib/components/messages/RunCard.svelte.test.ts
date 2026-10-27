// @vitest-environment happy-dom
/**
 * The CanaRun card as a bubble draws it: the stats in the sport's units, the trace as ONE bare
 * polyline with no request of any kind, none for a pool swim - and the "cannot draw" row for a
 * message this build does not know.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

import RunCard from './RunCard.svelte';
import MessageBubble from './MessageBubble.svelte';
import { mkRunEnvelope, mkUnsupportedEnvelope, serializeEnvelope } from '$lib/envelope';
import { setLocale } from '$lib/paraglide/runtime';
import { sampleRun } from '../../../test/canarunFixture';

const mounted: (() => void)[] = [];

function mountInto<P extends Record<string, unknown>>(component: never, props: P): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(component, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

function bubble(content: string): HTMLElement {
  return mountInto(MessageBubble as never, {
    messageId: 'm-1',
    senderId: 'u-runner',
    currentUserId: 'u-me',
    content,
    timestamp: new Date('2026-10-27T10:00:00Z'),
    isOwn: false,
  });
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  setLocale('fr', { reload: false });
});

describe('RunCard', () => {
  it('draws the title, the stats in the sport units and one polyline', () => {
    setLocale('en', { reload: false });
    const el = mountInto(RunCard as never, { run: sampleRun() });
    const text = el.textContent ?? '';
    expect(text).toContain('Footing du matin');
    expect(text).toContain('5.23 km');
    expect(text).toContain('30:00');
    expect(text).toContain('5:33 /km');
    expect(text).toContain('42 m');
    expect(text).toContain('Trace shortened by 200 m at each end');
    expect(el.querySelectorAll('polyline')).toHaveLength(1);
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 320 160');
  });

  it('asks nothing of the network: no image, no tile, no link', () => {
    const el = mountInto(RunCard as never, { run: sampleRun() });
    expect(el.querySelectorAll('img, image, iframe, a, use')).toHaveLength(0);
    expect(el.innerHTML).not.toMatch(/\b(href|src)=|url\(/);
  });

  it('draws no trace for a pool swim or a stats-only send', () => {
    for (const run of [
      sampleRun({ sport: 'pool-swim', trackE5: [] }),
      sampleRun({ trackE5: [] }),
    ]) {
      const el = mountInto(RunCard as never, { run });
      expect(el.querySelector('[data-testid="run-trace"]')).toBeNull();
      expect(el.textContent).not.toContain('Tracé raccourci');
    }
  });

  it('reads cycling as a speed', () => {
    setLocale('en', { reload: false });
    const el = mountInto(RunCard as never, {
      run: sampleRun({ sport: 'cycling', distanceM: 36_000, movingS: 3_600, durationS: 3_700 }),
    });
    expect(el.textContent).toContain('36.0 km/h');
  });
});

describe('MessageBubble with a CanaRun message', () => {
  it('draws the activity card for a run envelope', () => {
    const el = bubble(serializeEnvelope(mkRunEnvelope(sampleRun())));
    expect(el.querySelector('[data-testid="run-card"]')).not.toBeNull();
  });

  it('draws the "needs a newer version" row for a kind this build does not know', () => {
    setLocale('en', { reload: false });
    const el = bubble(serializeEnvelope(mkUnsupportedEnvelope('unknown-kind', 99)));
    expect(el.textContent).toContain('This message needs a newer version of Canari');
    expect(el.querySelector('[data-testid="run-card"]')).toBeNull();
  });

  it('draws the unreadable row for a run that broke a bound', () => {
    setLocale('en', { reload: false });
    const el = bubble(serializeEnvelope(mkUnsupportedEnvelope('malformed-run')));
    expect(el.textContent).toContain('This activity could not be displayed');
  });
});
