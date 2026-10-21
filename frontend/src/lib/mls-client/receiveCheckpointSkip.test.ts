import { receiveCheckpointSkipBudget } from './receiveCheckpointSkip';

describe('receiveCheckpointSkipBudget', () => {
  it('is 0 on a production build whatever the key says', () => {
    expect(receiveCheckpointSkipBudget(() => '50', false)).toBe(0);
  });

  it('is 0 on a non-production build without the key, or with a malformed one', () => {
    for (const raw of [null, '', 'abc', '-3', '1.5', '0x10']) {
      expect(receiveCheckpointSkipBudget(() => raw, true)).toBe(0);
    }
  });

  it('reads a positive integer on a non-production build, capped far under the ratchet window', () => {
    expect(receiveCheckpointSkipBudget(() => '200', true)).toBe(200);
    expect(receiveCheckpointSkipBudget(() => '99999', true)).toBe(500);
  });
});
