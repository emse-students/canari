import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drainOnSigterm } from '../drain-on-sigterm';
import { finishJoinAskWorkInFlight, trackJoinAskWork } from './join-ask-announce';

/** A promise the test settles by hand: every wait below is on an event, never on a clock. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Whether `promise` has settled, asked after every microtask already queued has run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((r) => setImmediate(r));
  return settled;
}

/**
 * A RETIRED REPLICA FINISHES THE JOIN-ASK WORK IT HAS STARTED - the announcements an answer started,
 * and the expiry cron's expiry and announcements as one unit - and waits for nothing started after.
 */
describe('the join-ask work a retiring replica still owes', () => {
  it('is awaited by the SIGTERM drain before the process exits', async () => {
    const held = deferred();
    const tracked = trackJoinAskWork(() => held.promise);
    const signals = new EventEmitter();
    const exits: number[] = [];
    const exited = deferred();
    const server = { close: (cb: (err?: Error) => void) => cb() };
    drainOnSigterm(
      server as never,
      (code) => {
        exits.push(code);
        exited.resolve();
      },
      signals,
      finishJoinAskWorkInFlight
    );

    signals.emit('SIGTERM');
    expect(await hasSettled(exited.promise)).toBe(false);
    held.resolve();
    await tracked;
    await exited.promise;
    expect(exits).toEqual([0]);
  });

  it('waits for the work in flight when it is asked, never for work started after', async () => {
    const first = deferred();
    const later = deferred();
    void trackJoinAskWork(() => first.promise);
    const finished = finishJoinAskWorkInFlight();
    void trackJoinAskWork(() => later.promise);

    expect(await hasSettled(finished)).toBe(false);
    first.resolve();
    await finished;
    later.resolve();
  });

  it("returns the work's own result, and a failure is the caller's while the drain still ends", async () => {
    await expect(trackJoinAskWork(async () => 7)).resolves.toBe(7);
    const failing = trackJoinAskWork(() => Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');
    await expect(finishJoinAskWorkInFlight()).resolves.toBeUndefined();
  });

  it('is what main.ts hands the drain as the work owed before exit', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).toMatch(
      /drainOnSigterm\(\s*app\.getHttpServer\(\),\s*undefined,\s*undefined,\s*finishJoinAskWorkInFlight\s*\)/
    );
  });
});
