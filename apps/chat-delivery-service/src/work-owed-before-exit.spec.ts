/// <reference types="jest" />

import { finishWorkOwedBeforeExit } from './work-owed-before-exit';
import { finishJoinAskWorkInFlight } from './utils/join-ask-announce';
import { PUSH_DELIVERY_RECORDER } from './utils/push-delivery-records';

jest.mock('./utils/join-ask-announce', () => ({ finishJoinAskWorkInFlight: jest.fn() }));

/**
 * THE WORK A RETIRING REPLICA OWES, IN ORDER: the join-ask announcements first - they may push, and
 * so hand the push delivery record more - then the record, which says what is pending before it
 * waits. Reversed, a push made by the last announcement would be handed to a writer already drained.
 */
describe('finishWorkOwedBeforeExit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('finishes the join-ask work, THEN the send batches in flight, THEN drains the push delivery record', async () => {
    const order: string[] = [];
    let finishAsks: () => void = () => {};
    (finishJoinAskWorkInFlight as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('join-asks started');
          finishAsks = () => {
            order.push('join-asks done');
            resolve();
          };
        })
    );
    jest.spyOn(PUSH_DELIVERY_RECORDER, 'finishBatchesInFlight').mockImplementation(async () => {
      order.push('batches handed over');
    });
    const drain = jest
      .spyOn(PUSH_DELIVERY_RECORDER, 'drainForExit')
      .mockImplementation(async () => {
        order.push('record drained');
      });

    const owed = finishWorkOwedBeforeExit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(drain).not.toHaveBeenCalled();
    finishAsks();
    await owed;

    expect(order).toEqual([
      'join-asks started',
      'join-asks done',
      'batches handed over',
      'record drained',
    ]);
  });
});
