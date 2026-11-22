/**
 * For the unit specs whose manager is a mock: the row an anonymous submit HOLDS for its batch
 * (`holdAnonymousAnswer`, `anonymous-answer-batches.ts`), read back from the SQL the mock received,
 * in the shape of the submission it becomes - so a spec asserts on what is stored, as it did when the
 * answer went to `submissions` directly.
 */
export function heldRowOf(sql: unknown, params: unknown): Record<string, unknown> | null {
  if (typeof sql !== 'string' || !sql.includes('INSERT INTO form_answers_held')) return null;
  const [formId, answers, lines, priceLockedItemIds, respondentIdentity] = params as [
    string,
    string,
    string | null,
    string | null,
    string | null,
  ];
  const parse = (value: string | null) => (value === null ? null : JSON.parse(value));
  return {
    formId,
    userId: null,
    answers: parse(answers),
    lines: parse(lines),
    priceLockedItemIds: parse(priceLockedItemIds),
    respondentIdentity: parse(respondentIdentity),
  };
}
