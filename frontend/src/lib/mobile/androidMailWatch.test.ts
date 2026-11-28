// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_MAIL_EVENT,
  announceAndroidPageReplaced,
  armAndroidMailWatch,
  claimAndroidMailWatch,
  forgetAndroidMailWatch,
  releaseAndroidMailWatch,
} from './androidMailWatch';

/**
 * The page's side of lot 4b's native watcher: a new document says so, the page's run waits for the
 * native run to be JOINED before it starts (one watcher over one cursor), and arming sends the
 * remembered password as one op of the top-frame bridge.
 */

const sent: Record<string, unknown>[] = [];
function bridge() {
  (window as unknown as { canariMail: unknown }).canariMail = {
    postMessage: (m: string) => sent.push(JSON.parse(m)),
  };
}
const answer = (kind: string, code?: string) =>
  window.dispatchEvent(new CustomEvent(NATIVE_MAIL_EVENT, { detail: { kind, code } }));

afterEach(() => {
  delete (window as unknown as { canariMail?: unknown }).canariMail;
  sent.length = 0;
});

describe('the native watcher bridge (lot 4b)', () => {
  it('a claim resolves only on "handed", never on another event', async () => {
    bridge();
    let done = false;
    const claimed = claimAndroidMailWatch().then(() => (done = true));
    expect(sent).toHaveLength(1);
    const { op, id } = sent[0] as { op: string; id: string };
    expect(op).toBe('claim');
    answer('started');
    answer('armed');
    await Promise.resolve();
    expect(done).toBe(false);
    answer('handed', id);
    await claimed;
    expect(done).toBe(true);
  });

  it("a claim resolves only on ITS OWN handed - an earlier claim's answer resolves nothing", async () => {
    bridge();
    let done = false;
    const claimed = claimAndroidMailWatch().then(() => (done = true));
    const { id } = sent[0] as { id: string };
    answer('handed', 'claim-0');
    answer('handed');
    await Promise.resolve();
    expect(done).toBe(false);
    answer('handed', id);
    await claimed;
  });

  it('a claim that could not be sent rejects - the page must not start a second writer', async () => {
    (window as unknown as { canariMail: unknown }).canariMail = {
      postMessage: () => {
        throw new Error('the port is closed');
      },
    };
    await expect(claimAndroidMailWatch()).rejects.toThrow('the port is closed');
  });

  it('with no bridge, nothing native can run: the claim resolves at once', async () => {
    await expect(claimAndroidMailWatch()).resolves.toBeUndefined();
  });

  it('a new document and an arm are one op each', () => {
    bridge();
    announceAndroidPageReplaced();
    expect(armAndroidMailWatch('u1', 'ada@etu.emse.fr', 'pw')).toBe(true);
    expect(sent).toEqual([
      { op: 'page' },
      { op: 'arm', userId: 'u1', account: 'ada@etu.emse.fr', password: 'pw', persistent: true },
    ]);
  });

  it('an arm carries the persistent-watch choice', () => {
    bridge();
    armAndroidMailWatch('u1', 'ada@etu.emse.fr', 'pw', false);
    expect(sent).toEqual([
      { op: 'arm', userId: 'u1', account: 'ada@etu.emse.fr', password: 'pw', persistent: false },
    ]);
  });

  it('a forget and a release are one op each (review B1, minor 3)', () => {
    bridge();
    forgetAndroidMailWatch('u1');
    releaseAndroidMailWatch();
    expect(sent).toEqual([{ op: 'forget', userId: 'u1' }, { op: 'release' }]);
  });

  it('a forget with no bridge sends nothing and does not throw', () => {
    expect(() => forgetAndroidMailWatch('u1')).not.toThrow();
    expect(sent).toEqual([]);
  });

  it('an arm with no bridge says so at error level and sends nothing', async () => {
    const { Log } = await import('$lib/utils/Log');
    const warn = vi.spyOn(Log, 'w');
    expect(armAndroidMailWatch('u1', 'a@etu.emse.fr', 'pw')).toBe(false);
    expect(warn).toHaveBeenCalledWith('MAIL-WATCH', expect.stringContaining('ERROR'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('pw');
  });
});
