import {
  RECEIVE_CHECKPOINT_SKIP_BUDGET,
  receiveCheckpointSkipBudget,
} from './receiveCheckpointSkip';

describe('receiveCheckpointSkipBudget', () => {
  it("is 0 while the server's switch is off - every drain checkpoints, as before", () => {
    expect(receiveCheckpointSkipBudget('off')).toBe(0);
  });

  it('is the measured K = 100 when the switch is on', () => {
    expect(receiveCheckpointSkipBudget('on')).toBe(100);
    expect(RECEIVE_CHECKPOINT_SKIP_BUDGET).toBe(100);
  });

  it('stays far under the sender ratchet window (maximum_forward_distance = 2000)', () => {
    expect(RECEIVE_CHECKPOINT_SKIP_BUDGET).toBeLessThan(2000 / 4);
  });
});
