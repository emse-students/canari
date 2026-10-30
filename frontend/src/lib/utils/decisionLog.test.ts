import { DecisionLog } from './decisionLog';

/**
 * A decision is said once, and a repeat of the same decision is COUNTED and said at its 1st, 10th
 * and 100th occurrence - a repeat is evidence, never silence (review of #2718, 2026-10-30).
 */
describe('DecisionLog', () => {
  it('says the decision, then its repeats at 1, 10 and 100', () => {
    const log = new DecisionLog(10);
    const said: string[] = [];
    for (let i = 0; i <= 100; i++) {
      const noted = log.note('slot', 'same');
      if (noted?.say === 'decision') said.push('decision');
      if (noted?.say === 'repeat') said.push(`repeat ${noted.nth}`);
    }
    expect(said).toEqual(['decision', 'repeat 1', 'repeat 10', 'repeat 100']);
  });

  it('says a changed decision in full and restarts its count', () => {
    const log = new DecisionLog(10);
    log.note('slot', 'a');
    log.note('slot', 'a');
    expect(log.note('slot', 'b')).toEqual({ say: 'decision' });
    expect(log.note('slot', 'b')).toEqual({ say: 'repeat', nth: 1 });
  });

  it('a forgotten slot is decided again', () => {
    const log = new DecisionLog(10);
    log.note('slot', 'a');
    log.forget('slot');
    expect(log.note('slot', 'a')).toEqual({ say: 'decision' });
  });

  it('is bounded: the oldest slot goes, at the cost of one repeated full line', () => {
    const log = new DecisionLog(2);
    log.note('one', 'a');
    log.note('two', 'a');
    log.note('three', 'a');
    expect(log.size).toBe(2);
    expect(log.note('one', 'a')).toEqual({ say: 'decision' });
  });

  it('reset forgets everything', () => {
    const log = new DecisionLog(10);
    log.note('slot', 'a');
    log.reset();
    expect(log.size).toBe(0);
  });
});
