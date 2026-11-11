/**
 * AN API READ NEVER WAITS BEHIND MEDIA IN THE APP (weak-network audit, the owner's question of
 * 2026-11-11: "can a slow request hold a slot that a screen's small API read waits behind?").
 *
 * The answer found: no, and this pins WHY so it stays true. `mediaRequestGate` (3 slots) is entered
 * by media bytes only; every API read goes `apiFetch` -> `trackedFetch` -> `fetch` and never touches
 * the gate. A slot is held from the request's start to its RESPONSE HEAD (the task returns the live
 * `Response`; the body is read after the slot is freed), so a slow body holds nothing either.
 * What a slow media request CAN still do is share the wire's bandwidth with the API reads - a link
 * fact no queue in the app decides; the gate's cap of three is what bounds that share.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RequestGate } from './requestGate';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('API reads and the media gate', () => {
  it('the API request path does not enter any request gate', () => {
    for (const file of ['apiFetch.ts', 'trackedFetch.ts', 'requestDeadline.ts', 'renewOn401.ts']) {
      expect(source(file), file).not.toMatch(/requestGate|RequestGate|mediaRequestGate/);
    }
  });

  it('a saturated gate leaves a read on the API path untouched: it queues only its own kind', async () => {
    const media = new RequestGate(3);
    const release: (() => void)[] = [];
    // Three media requests whose heads never arrive hold every slot...
    const held = Array.from({ length: 3 }, () =>
      media.run(() => new Promise<void>((resolve) => release.push(resolve)))
    );
    // ...a fourth media request queues behind them...
    let fourthStarted = false;
    const fourth = media.run(async () => {
      fourthStarted = true;
    });
    await Promise.resolve();
    expect(media.inFlight).toBe(3);
    expect(media.queued).toBe(1);
    expect(fourthStarted).toBe(false);

    // ...while an API read, which does not go through the gate, answers at once.
    const apiRead = await Promise.resolve('answered');
    expect(apiRead).toBe('answered');
    expect(media.queued).toBe(1);

    release.forEach((r) => r());
    await Promise.all([...held, fourth]);
    expect(fourthStarted).toBe(true);
  });

  it('a slot is freed at the response head: the body is read outside the gate', () => {
    // The media fetch returns the Response from the gated task and reads `.arrayBuffer()` after.
    const cache = source('mediaBlobCache.ts');
    const task = cache.slice(
      cache.indexOf('mediaRequestGate.run('),
      cache.indexOf('if (res.ok) return res;')
    );
    expect(task).toContain('return await fetch(url');
    expect(task).not.toMatch(/arrayBuffer|\.blob\(|\.body/);
  });
});
