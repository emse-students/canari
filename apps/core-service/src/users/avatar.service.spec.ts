/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarService } from './avatar.service';

// NOTHING HERE MAY LEAVE THE MACHINE. The first draft of the last test below called the real
// `https://gallery.mitv.fr` - another repository's PRODUCTION estate - and took a 403 from it.
// A unit test that dials a live third party is slow, flaky, and not ours to poke.
jest.mock('axios');

/**
 * AN ESTATE WITH NO AVATAR PROVIDER SPENT TWO HOURS ANSWERING 502 TO EVERY FACE ON EVERY RENDER.
 *
 * `dev.canari-emse.fr` deliberately has no MiGallery: `docker-compose.dev.yml` CUTS the URL rather
 * than inheriting production's gallery, which lives in another repository's estate, and says so in
 * a comment. So `MIGALLERY_API_KEY` is empty there and the constructor warns at startup, exactly as
 * designed.
 *
 * What was not designed is what happened next. The unconfigured case returned `unavailable`, which
 * the controller answers as a **502 marked `no-store`** - correct for a timeout, whose whole point
 * is that the next request should try again. A missing key is not a timeout: it is read once at
 * startup and cannot change while the process lives. Measured on dev, 2026-09-09: **560 uncached
 * 502s since 06:00Z and still climbing**, one per avatar per render, none of which could ever have
 * succeeded.
 *
 * That is the amplification the cache beside this file exists to prevent, arriving through the one
 * door it left open - its own docblock records the same shape turning one outbound failure into 479
 * recorded 502s on the portal. *A predicate that named the last incident is not the predicate that
 * names the next one.*
 */
describe('AvatarService - an estate with no provider is not an outage', () => {
  function service(key: string): AvatarService {
    const config = {
      get: (name: string, fallback?: string) =>
        name === 'MIGALLERY_API_KEY' ? key : (fallback ?? ''),
    } as unknown as ConfigService;
    return new AvatarService(config);
  }

  afterEach(() => {
    // `restoreAllMocks` removes the spy but leaves the automocked `axios.get` holding the calls it
    // recorded, so without the clear the next test counts this one's. Caught by that exact failure.
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('answers `disabled`, never `unavailable`, when no key is configured', async () => {
    const outcome = await service('').fetchUserAvatar('a'.repeat(64));

    // The distinction IS the fix: `unavailable` is `no-store` by contract, so every render asks
    // again, for ever, for an answer that cannot change without a restart.
    expect(outcome.kind).toBe('disabled');
  });

  it('never reaches the network to find that out, because the key is read at startup', async () => {
    // A request would be the same defect one layer down: an outbound connection per face, all of
    // them refused, on an estate that declared it has no gallery.
    const before = Date.now();
    const outcome = await service('').fetchUserAvatar('b'.repeat(64));
    expect(outcome.kind).toBe('disabled');
    // Well under the 4 000 ms upstream timeout: nothing was dialled.
    expect(Date.now() - before).toBeLessThan(500);
  });

  it('still refuses a malformed user id before anything else', async () => {
    // The estate having no gallery must not become a way past the input check - the id reaches a
    // URL, and this is the guard that keeps it from being anything but an id.
    await expect(service('').fetchUserAvatar('../../etc/passwd')).rejects.toThrow(
      'Invalid user ID'
    );
  });

  it('does not claim `disabled` when a key IS configured', async () => {
    // With a key present the outcome must come from the upstream attempt - here a refusal, which
    // stays `unavailable` because THAT one really can succeed on the next request.
    // Reached through `spyOn` rather than as `axios.get`: naming the method as a string keeps the
    // reference bound, which is what `typescript(unbound-method)` is asking for.
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('upstream down'));

    const outcome = await service('a-real-key').fetchUserAvatar('c'.repeat(64));

    expect(outcome.kind).toBe('unavailable');
  });

  it('still calls nothing at all when the key is missing', async () => {
    const get = jest.spyOn(axios, 'get');

    await service('').fetchUserAvatar('d'.repeat(64));

    // The cheapest proof that the storm is gone at the source rather than only at the status code.
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * A PHOTO THAT CHANGED USED TO BE INVISIBLE FOR ABOUT A DAY, AND THE UPSTREAM HAD ALREADY SOLVED IT.
 *
 * MiGallery keys its ETag on the ASSET ID - the thing that changes when a user changes their photo -
 * and this service read `content-type` off the response and threw the rest away. So the only
 * question anything in the chain could ask was "has an hour elapsed", which is a question about a
 * clock and not about the photo, and the answer to it was always "download the whole thing again".
 *
 * These assert the two halves of the repair: the version is KEPT, and the lapsed TTL spends a
 * conditional request rather than a download.
 */
describe('AvatarService - a photo that changed, and one that did not', () => {
  const USER = 'e'.repeat(64);
  const TTL_MS = 60 * 60 * 1000;

  const service = () =>
    new AvatarService({
      get: (name: string, fallback?: string) =>
        name === 'MIGALLERY_API_KEY' ? 'a-real-key' : (fallback ?? ''),
    } as unknown as ConfigService);

  const imageResponse = (body: string, etag?: string) => ({
    status: 200,
    data: Buffer.from(body),
    headers: { 'content-type': 'image/png', ...(etag ? { etag } : {}) },
  });

  // THE CLOCK IS DRIVEN, NEVER WAITED FOR - the TTL is an hour, and a suite may not spend one.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('keeps the upstream version instead of discarding it with the rest of the headers', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('photo', '"asset-7"'));

    const outcome = await service().fetchUserAvatar(USER);

    expect(outcome).toMatchObject({ kind: 'image', contentType: 'image/png', etag: '"asset-7"' });
  });

  it('asks the gallery to confirm that version once the hour lapses, and sends no such header before', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('photo', '"asset-7"'));
    const svc = service();

    await svc.fetchUserAvatar(USER);
    jest.advanceTimersByTime(TTL_MS + 1);
    await svc.fetchUserAvatar(USER);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][1]?.headers).not.toHaveProperty('If-None-Match');
    expect(get.mock.calls[1][1]?.headers).toMatchObject({ 'If-None-Match': '"asset-7"' });
  });

  it('accepts a 304 ONLY while it has a version to revive - an unsolicited one is not an answer', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('photo', '"asset-7"'));
    const svc = service();

    await svc.fetchUserAvatar(USER);
    jest.advanceTimersByTime(TTL_MS + 1);
    await svc.fetchUserAvatar(USER);

    // axios is mocked, so `validateStatus` is never applied here - it is read back and exercised
    // directly, which is the only way to prove the rule it encodes rather than assume it.
    expect(get.mock.calls[0][1]?.validateStatus?.(304)).toBe(false);
    expect(get.mock.calls[1][1]?.validateStatus?.(304)).toBe(true);
    expect(get.mock.calls[1][1]?.validateStatus?.(500)).toBe(false);
  });

  it('revives the held bytes on a 304 and re-arms the hour, so nothing is downloaded twice', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('photo', '"asset-7"'));
    const svc = service();
    await svc.fetchUserAvatar(USER);

    jest.advanceTimersByTime(TTL_MS + 1);
    get.mockResolvedValue({ status: 304, data: Buffer.alloc(0), headers: {} });
    const revalidated = await svc.fetchUserAvatar(USER);

    // The body came from the entry we already had; the 304 carried none.
    expect(revalidated).toMatchObject({ kind: 'image', etag: '"asset-7"' });
    expect((revalidated as { body: Buffer }).body).toEqual(Buffer.from('photo'));

    // And the hour started again: a request inside it must not reach the gallery at all.
    await svc.fetchUserAvatar(USER);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('takes the new photo when the gallery answers 200 with a different version', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('old', '"asset-7"'));
    const svc = service();
    await svc.fetchUserAvatar(USER);

    jest.advanceTimersByTime(TTL_MS + 1);
    get.mockResolvedValue(imageResponse('new', '"asset-8"'));
    const outcome = await svc.fetchUserAvatar(USER);

    expect(outcome).toMatchObject({ kind: 'image', etag: '"asset-8"' });
    expect((outcome as { body: Buffer }).body).toEqual(Buffer.from('new'));
  });

  it('asks nothing conditional of an upstream that sent no version, and re-downloads as before', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue(imageResponse('photo'));
    const svc = service();

    await svc.fetchUserAvatar(USER);
    jest.advanceTimersByTime(TTL_MS + 1);
    await svc.fetchUserAvatar(USER);

    // No version means nothing could confirm it, so the entry is dropped rather than held: a
    // conditional request with no validator is a full download wearing a second header.
    expect(get.mock.calls[1][1]?.headers).not.toHaveProperty('If-None-Match');
    expect(get.mock.calls[1][1]?.validateStatus?.(304)).toBe(false);
  });
});
