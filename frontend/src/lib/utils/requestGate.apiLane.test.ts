/**
 * AN API READ NEVER WAITS BEHIND MEDIA IN THE APP (weak-network audit, the owner's question of
 * 2026-11-11: "can a slow request hold a slot that a screen's small API read waits behind?").
 *
 * Behaviour, through the real gate: three media requests whose heads never arrive saturate
 * `mediaRequestGate` and a fourth queues - while an API read on the same path `apiFetch` uses
 * (`trackedFetch`) leaves at once on its own fetch. A media slot is held to the response HEAD only
 * (the gated task returns the live `Response`), so a slow body holds none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mediaRequestGate } from './requestGate';
import { trackedFetch } from './trackedFetch';

const release: (() => void)[] = [];
afterEach(() => release.splice(0).forEach((r) => r()));

describe('API reads and the media gate', () => {
  it('a saturated media gate does not delay an API read', async () => {
    // Three media "fetches" whose heads never arrive hold every slot...
    const held = Array.from({ length: 3 }, () =>
      mediaRequestGate.run(() => new Promise<void>((resolve) => release.push(resolve)))
    );
    // ...a fourth media request queues behind them...
    let fourthStarted = false;
    const fourth = mediaRequestGate.run(async () => {
      fourthStarted = true;
    });
    await Promise.resolve();
    expect(mediaRequestGate.inFlight).toBe(3);
    expect(mediaRequestGate.queued).toBe(1);
    expect(fourthStarted).toBe(false);

    // ...and an API read on the real request path is on the wire immediately, answered at once.
    const sent: string[] = [];
    const fakeFetch = (async (url: string) => {
      sent.push(url);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const answer = await trackedFetch(fakeFetch, 'https://api.test/api/posts', {});
    expect(sent).toEqual(['https://api.test/api/posts']);
    expect(answer.ok).toBe(true);
    // The media queue is exactly as it was: the read neither joined nor displaced it.
    expect(mediaRequestGate.queued).toBe(1);
    expect(fourthStarted).toBe(false);

    release.splice(0).forEach((r) => r());
    await Promise.all([...held, fourth]);
    expect(fourthStarted).toBe(true);
  });

  it('a media slot is freed at the response head, whatever the body does', async () => {
    let bodyDone!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyDone = () => controller.close();
      },
    });
    // The task returns the live Response, as `fetchMediaObject` does; its body is still open.
    const res = await mediaRequestGate.run(async () => new Response(body));
    expect(mediaRequestGate.inFlight).toBe(0);
    bodyDone();
    await res.arrayBuffer();
  });
});
