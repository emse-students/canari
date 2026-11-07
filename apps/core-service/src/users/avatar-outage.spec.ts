/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarService } from './avatar.service';

jest.mock('axios');

/**
 * A GALLERY KNOWN TO BE DOWN IS NOT ASKED BY EVERY FACE (five hours, 2026-11-05). The failure that
 * proves the outage writes the state, one probe at a time asks, the first answer clears it, and the
 * log carries the two transitions instead of one line per avatar.
 */
describe('AvatarService - a known outage is asked by one probe at a time', () => {
  const config = {
    get: (name: string, fallback?: string) =>
      name === 'MIGALLERY_API_KEY' ? 'k' : (fallback ?? ''),
  } as unknown as ConfigService;
  const id = (n: number) => `user-${n}`;
  const failure = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      isAxiosError: true,
      response: { status },
    });

  beforeEach(() => {
    (axios.isAxiosError as unknown as jest.Mock).mockImplementation(
      (e: { isAxiosError?: boolean }) => e?.isAxiosError === true
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function build() {
    const svc = new AvatarService(config);
    const warn = jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation();
    const lines = () => warn.mock.calls.map((c) => String(c[0]));
    return { svc, lines };
  }

  it('asks the probe only, answers the rest from the state, and logs one DOWN line', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc, lines } = build();

    expect(await svc.fetchUserAvatar(id(1))).toEqual({ kind: 'unavailable' }); // flips to down
    await svc.fetchUserAvatar(id(2)); // the probe, fails again
    expect(get).toHaveBeenCalledTimes(2);

    let release!: () => void;
    get.mockImplementationOnce(() => new Promise((_, rej) => (release = () => rej(failure(530)))));
    const probe = svc.fetchUserAvatar(id(3));
    const skipped = await Promise.all([svc.fetchUserAvatar(id(4)), svc.fetchUserAvatar(id(5))]);
    expect(skipped).toEqual([
      { kind: 'unavailable', shortCircuited: true },
      { kind: 'unavailable', shortCircuited: true },
    ]);
    expect(get).toHaveBeenCalledTimes(3);
    release();
    await probe;

    expect(lines().filter((l) => l.includes('is DOWN'))).toHaveLength(1);
    // The request that proved the outage keeps its line; the probes that repeated the news are silent.
    expect(lines().filter((l) => l.startsWith('Avatar unavailable for'))).toHaveLength(1);
  });

  it('clears on the first answer, even an absence, and logs the return', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc, lines } = build();
    await svc.fetchUserAvatar(id(1));

    get.mockRejectedValueOnce(failure(404));
    await svc.fetchUserAvatar(id(2)); // the probe: a 404 is an answer, the gallery is up

    get.mockResolvedValue({ status: 200, data: Buffer.from('p'), headers: {} });
    expect((await svc.fetchUserAvatar(id(3))).kind).toBe('image');
    expect(get).toHaveBeenCalledTimes(3);
    expect(lines().some((l) => l.includes('is back after'))).toBe(true);
  });

  it('does not ask the presence route of a gallery known to be down', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc } = build();
    await svc.fetchUserAvatar(id(1));

    let release!: () => void;
    get.mockImplementationOnce(() => new Promise((_, rej) => (release = () => rej(failure(530)))));
    const probe = svc.fetchUserAvatar(id(2));
    expect(await svc.fetchAvatarPresence([id(3)])).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
    release();
    await probe;
  });
});
