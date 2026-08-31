import { normaliseCondition, visibleItemIds, type ConditionalItem } from './visibility';
import type { PricingFacts } from '../pricing/audience';

/**
 * Server-side question visibility, which did not exist before the pricing grid needed it.
 *
 * Two live defects were riding on its absence, both fixed by this module existing: `submit`
 * enforced `required` on hidden questions while the client sent only visible answers, so a required
 * conditional question was unsubmittable for everyone its condition did not select; and an answer
 * to a hidden question was accepted and its price modifier charged.
 */
describe('question visibility', () => {
  const facts = (over: Partial<PricingFacts> = {}): PricingFacts => ({
    promo: null,
    formation: null,
    cotisationTiers: [],
    answers: {},
    ...over,
  });

  const ids = (items: ConditionalItem[], f: PricingFacts) => [...visibleItemIds(items, f)];

  it('shows a question with no condition', () => {
    expect(ids([{ id: 'q1' }], facts())).toEqual(['q1']);
  });

  it('shows a question whose profile condition matches', () => {
    const items: ConditionalItem[] = [{ id: 'q1', showIf: { formation: { values: ['ICM'] } } }];
    expect(ids(items, facts({ formation: 'ICM' }))).toEqual(['q1']);
    expect(ids(items, facts({ formation: 'ISMIN' }))).toEqual([]);
  });

  it('honours the legacy dependsOn pair exactly as showIf.answer', () => {
    const legacy: ConditionalItem[] = [
      { id: 'q1' },
      { id: 'q2', dependsOn: 'q1', dependsValue: 'opt_yes' },
    ];
    expect(ids(legacy, facts({ answers: { q1: ['opt_yes'] } }))).toEqual(['q1', 'q2']);
    expect(ids(legacy, facts({ answers: { q1: ['opt_no'] } }))).toEqual(['q1']);
  });

  it('translates the legacy pair rather than evaluating it separately', () => {
    expect(normaliseCondition({ id: 'q2', dependsOn: 'q1', dependsValue: 'opt' })).toEqual({
      answer: { questionId: 'q1', optionIds: ['opt'] },
    });
    expect(normaliseCondition({ id: 'q1' })).toBeNull();
  });

  // The builder offers both controls on one question, so both are requirements OF that question.
  // This asserted the opposite - that showIf won outright - and it made the answer half vanish the
  // moment a profile criterion was added beside it.
  it('ANDs a profile showIf with the legacy pair', () => {
    const item: ConditionalItem = {
      id: 'q2',
      showIf: { formation: { values: ['ICM'] } },
      dependsOn: 'q1',
      dependsValue: 'opt_yes',
    };
    const both = [{ id: 'q1' }, item];
    expect(ids(both, facts({ formation: 'ICM', answers: { q1: ['opt_yes'] } }))).toEqual([
      'q1',
      'q2',
    ]);
    // Right formation, wrong answer.
    expect(ids(both, facts({ formation: 'ICM', answers: { q1: ['opt_no'] } }))).toEqual(['q1']);
    // Right answer, wrong formation.
    expect(ids(both, facts({ formation: 'ISMIN', answers: { q1: ['opt_yes'] } }))).toEqual(['q1']);
    expect(normaliseCondition(item)).toEqual({
      formation: { values: ['ICM'] },
      answer: { questionId: 'q1', optionIds: ['opt_yes'] },
    });
  });

  // One question has one answer condition: `showIf.answer` is the shape a current client writes, so
  // it is the one that counts when a stale `dependsOn` is still sitting beside it.
  it('lets showIf.answer win over a stale legacy pair', () => {
    expect(
      normaliseCondition({
        id: 'q3',
        showIf: { answer: { questionId: 'q1', optionIds: ['new'] } },
        dependsOn: 'q2',
        dependsValue: 'old',
      })
    ).toEqual({ answer: { questionId: 'q1', optionIds: ['new'] } });
  });

  // The chain is the case a single pass gets wrong: C depends on B, B depends on A, A unanswered.
  it('hides a question whose parent is itself hidden', () => {
    const chain: ConditionalItem[] = [
      { id: 'a' },
      { id: 'b', showIf: { answer: { questionId: 'a', optionIds: ['yes'] } } },
      { id: 'c', showIf: { answer: { questionId: 'b', optionIds: ['yes'] } } },
    ];
    // 'b' is hidden, so its answer cannot count for 'c' even if a client sent one.
    expect(ids(chain, facts({ answers: { a: ['no'], b: ['yes'] } }))).toEqual(['a']);
    expect(ids(chain, facts({ answers: { a: ['yes'], b: ['yes'] } }))).toEqual(['a', 'b', 'c']);
  });

  // Declaration order must not decide visibility: a child written before its parent resolves the
  // same way, because the resolver follows references rather than the list.
  it('does not depend on the order items are declared in', () => {
    const reversed: ConditionalItem[] = [
      { id: 'c', showIf: { answer: { questionId: 'b', optionIds: ['yes'] } } },
      { id: 'b', showIf: { answer: { questionId: 'a', optionIds: ['yes'] } } },
      { id: 'a' },
    ];
    expect(ids(reversed, facts({ answers: { a: ['yes'], b: ['yes'] } })).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  // A cycle has no defensible answer, and hidden is the reading that charges nobody for it.
  it('hides a cycle instead of hanging', () => {
    const cycle: ConditionalItem[] = [
      { id: 'x', showIf: { answer: { questionId: 'y', optionIds: ['yes'] } } },
      { id: 'y', showIf: { answer: { questionId: 'x', optionIds: ['yes'] } } },
    ];
    expect(ids(cycle, facts({ answers: { x: ['yes'], y: ['yes'] } }))).toEqual([]);
  });

  it('hides a question depending on one that does not exist', () => {
    expect(ids([{ id: 'q', dependsOn: 'gone', dependsValue: 'v' }], facts())).toEqual([]);
  });
});
