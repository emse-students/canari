import {
  RECEIVE_CHECKPOINT_SKIP_BUDGET,
  receiveCheckpointSkipBudget,
} from './receiveCheckpointSkip';

describe('receiveCheckpointSkipBudget', () => {
  it("is 0 while the server's switch is off - every drain checkpoints, as before", () => {
    expect(receiveCheckpointSkipBudget('off', true)).toBe(0);
    expect(receiveCheckpointSkipBudget('off', false)).toBe(0);
  });

  it('is the measured K = 100 when the switch is on, on a native phone', () => {
    expect(receiveCheckpointSkipBudget('on', true)).toBe(100);
    expect(RECEIVE_CHECKPOINT_SKIP_BUDGET).toBe(100);
  });

  it('is 0 on web and desktop whatever the server says - only the phones were measured', () => {
    expect(receiveCheckpointSkipBudget('on', false)).toBe(0);
  });

  it('stays far under the sender ratchet window (maximum_forward_distance = 2000)', () => {
    expect(RECEIVE_CHECKPOINT_SKIP_BUDGET).toBeLessThan(2000 / 4);
  });
});
