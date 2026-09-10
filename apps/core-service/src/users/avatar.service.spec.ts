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
