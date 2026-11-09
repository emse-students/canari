/// <reference types="jest" />

import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarService } from './avatar.service';

jest.mock('axios');

/**
 * A GALLERY KNOWN TO BE DOWN IS NOT ASKED BY EVERY FACE (five hours, 2026-11-05). The failure that
 * proves the outage writes the state, probes are spaced by a COUNT of skipped requests, the first
 * answer clears it, and the log carries the two transitions instead of one line per avatar.
 */
describe('AvatarService - a known outage is asked by spaced probes', () => {
  const config = {
    get: (name: string, fallback?: string) =>
      name === 'MIGALLERY_API_KEY' ? 'k' : (fallback ?? ''),
  } as unknown as ConfigService;
  const id = (n: number) => `user-${n}`;
  const failure = (status?: number, code?: string) =>
    Object.assign(new Error(`failed ${status ?? code}`), {
      isAxiosError: true,
      code,
      response: status === undefined ? undefined : { status },
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

  it('100 sequential requests against a fast-failing gallery make 7 calls and one DOWN line', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc, lines } = build();

    let known = 0;
    for (let n = 1; n <= 100; n += 1) {
      const out = await svc.fetchUserAvatar(id(n));
      expect(out.kind).toBe('unavailable');
      if ('shortCircuited' in out && out.shortCircuited) known += 1;
    }
    // the flip (1) + probes at requests 3, 6, 11, 20, 37, 70
    expect(get).toHaveBeenCalledTimes(7);
    expect(known).toBe(93);
    expect(lines().filter((l) => l.includes('is DOWN'))).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });

  it('a late failure of a request asked before the flip does not release the real probe', async () => {
    const get = jest.spyOn(axios, 'get');
    const rejecters: Array<(e: unknown) => void> = [];
    get.mockImplementation(() => new Promise((_, rej) => rejecters.push(rej)));
    const { svc } = build();

    const a = svc.fetchUserAvatar(id(1));
    const b = svc.fetchUserAvatar(id(2)); // both admitted as `ask`
    rejecters[0](failure(530)); // flips down
    await a;
    await svc.fetchUserAvatar(id(3)); // skip
    const probe = svc.fetchUserAvatar(id(4)); // the real probe, in flight
    expect(get).toHaveBeenCalledTimes(3);
    rejecters[1](failure(530)); // the late ask fails
    await b;
    for (let n = 5; n < 80; n += 1) {
      expect(await svc.fetchUserAvatar(id(n))).toMatchObject({ shortCircuited: true });
    }
    expect(get).toHaveBeenCalledTimes(3);
    rejecters[2](failure(530));
    await probe;
  });

  it('one bad answer about one id never flips the gallery down', async () => {
    const get = jest.spyOn(axios, 'get');
    const { svc, lines } = build();
    for (const status of [500, 400, 410, 429, 304]) {
      get.mockRejectedValueOnce(failure(status));
      expect(await svc.fetchUserAvatar(id(status))).toEqual({ kind: 'unavailable' });
    }
    get.mockResolvedValue({ status: 200, data: Buffer.from('p'), headers: {} });
    expect((await svc.fetchUserAvatar(id(1))).kind).toBe('image');
    expect(lines().some((l) => l.includes('is DOWN') || l.includes('is back'))).toBe(false);
  });

  it('a local exception after the gallery answered never flips it, and frees the probe', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: 'not-a-buffer-source',
      headers: {},
    });
    const { svc, lines } = build();
    // Buffer.from(<number>) throws a TypeError AFTER the answer
    get.mockResolvedValueOnce({ status: 200, data: 5 as never, headers: {} });
    await svc.fetchUserAvatar(id(1));
    expect(lines().some((l) => l.includes('is DOWN'))).toBe(false);
  });

  it('clears on the first answer, even an absence, and logs the return', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc, lines } = build();
    await svc.fetchUserAvatar(id(1)); // flips
    await svc.fetchUserAvatar(id(2)); // skip
    get.mockRejectedValueOnce(failure(404));
    await svc.fetchUserAvatar(id(3)); // the probe: a 404 is an answer, the gallery is up

    get.mockResolvedValue({ status: 200, data: Buffer.from('p'), headers: {} });
    expect((await svc.fetchUserAvatar(id(4))).kind).toBe('image');
    expect(get).toHaveBeenCalledTimes(3);
    expect(lines().some((l) => l.includes('is back after'))).toBe(true);
  });

  it('a timeout (no response) is an outage like a 530', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(failure(undefined, 'ECONNABORTED'));
    const { svc, lines } = build();
    await svc.fetchUserAvatar(id(1));
    expect(lines().filter((l) => l.includes('is DOWN'))).toHaveLength(1);
  });

  it('does not ask the presence route of a gallery known to be down, and a failed probe is silent', async () => {
    const get = jest.spyOn(axios, 'get').mockRejectedValue(failure(530));
    const { svc, lines } = build();
    await svc.fetchUserAvatar(id(1)); // flips
    expect(await svc.fetchAvatarPresence([id(2)])).toBeNull(); // skip
    expect(get).toHaveBeenCalledTimes(1);
    expect(await svc.fetchAvatarPresence([id(3)])).toBeNull(); // the probe, fails
    expect(get).toHaveBeenCalledTimes(2);
    expect(lines()).toHaveLength(1); // only the DOWN line: no warn per failed presence call
  });
});
