import { matchesCondition, type AudienceCondition, type PricingFacts } from '../pricing/audience';

/** The subset of a form item this module needs. */
export interface ConditionalItem {
  id: string;
  /** Generalised condition: profile attributes and/or another question's answer. */
  showIf?: AudienceCondition | null;
  /** Legacy pair, still written by older clients: "option `dependsValue` of question `dependsOn`". */
  dependsOn?: string | null;
  dependsValue?: string | null;
}

/**
 * Which questions a given submitter actually sees.
 *
 * This has to exist on the SERVER, and until now it did not: `dependsOn` was evaluated in the
 * browser alone. Two consequences, both live before this file:
 *
 * 1. `submit` enforced `required` on every item, hidden ones included, while the client sent only
 *    the visible answers - so a required question behind a condition made the form unsubmittable
 *    for anyone the condition did not select.
 * 2. An answer to a hidden question was accepted and its price modifier charged.
 *
 * The second becomes far worse once an answer can select a price cell, which is why this lands with
 * the matrix rather than after it.
 */
export function visibleItemIds(items: ConditionalItem[], facts: PricingFacts): Set<string> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const resolved = new Map<string, boolean>();
  const inProgress = new Set<string>();

  /**
   * Answers count only when the question asking them is itself visible, so visibility and answers
   * are mutually recursive. Memoised, and a cycle resolves to hidden: a question that depends on
   * itself has no defensible answer, and hidden is the reading that charges nobody for it.
   */
  const isVisible = (id: string): boolean => {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return false;
    const item = byId.get(id);
    if (!item) return false;

    const condition = normaliseCondition(item);
    if (!condition) {
      resolved.set(id, true);
      return true;
    }

    inProgress.add(id);
    // A condition on another question is only satisfied if that question is on screen.
    const parentVisible = !condition.answer || isVisible(condition.answer.questionId);
    const visible = parentVisible && matchesCondition(condition, facts);
    inProgress.delete(id);
    resolved.set(id, visible);
    return visible;
  };

  return new Set(items.filter((i) => isVisible(i.id)).map((i) => i.id));
}

/**
 * A submitter's answers as option-id lists keyed by question - what every criterion reads - for a
 * form and a booking space alike, so the two cannot build it differently.
 *
 * THE KEYS ARE THE ITEMS' OWN DECLARED IDS, AND NOTHING ELSE GETS IN. Every key of `answers` comes
 * straight off a request body, so `__proto__`, `constructor` or an id nobody declared is a key the
 * submitter chooses; written onto a `{}` literal, `__proto__` REPLACES that map's prototype. The
 * allowlist settles it, and the map is prototype-less besides, so even a declared id has nothing to
 * walk into. Dropping an undeclared key changes nothing observable: every reader looks answers up
 * BY declared id. A free-text answer becomes a one-element list and contributes nothing to a
 * criterion; it keeps its place in the raw answers.
 */
export function answerSelections(
  items: readonly { id: string }[],
  answers: Record<string, unknown>
): Record<string, string[]> {
  const declared = new Set(items.map((item) => item.id));
  const selections = Object.create(null) as Record<string, string[]>;
  for (const [key, value] of Object.entries(answers)) {
    if (!declared.has(key)) continue;
    selections[key] = Array.isArray(value) ? (value as string[]) : [String(value)];
  }
  return selections;
}

/**
 * The questions a person is NOT shown because of WHO they are - the PROFILE half of each condition
 * (promo, formation, cotisation), decided on the server because a browser cannot be trusted with
 * someone's profile. The ANSWER half stays for the page to evaluate as the person types. One rule
 * for a form and a booking space, so the two never disagree on who sees a question.
 */
export function profileHiddenItemIds(items: ConditionalItem[], facts: PricingFacts): string[] {
  return items
    .filter((item) => {
      const condition = normaliseCondition(item);
      if (!condition) return false;
      const { answer: _answer, ...profileOnly } = condition;
      return Object.keys(profileOnly).length > 0 && !matchesCondition(profileOnly, facts);
    })
    .map((item) => item.id);
}

/**
 * The two condition shapes a stored item may carry, as ONE condition.
 *
 * `dependsOn`/`dependsValue` is the same statement as `showIf.answer`, so it is translated rather
 * than evaluated separately - a second evaluator for a subset of the same rule is how the two come
 * to disagree. `dependsValue` holds an option id, matching what the fill page compares against.
 *
 * They are ANDed, not chosen between: the builder offers both controls on the same question, so
 * "only for cotisants" in `showIf` and "only if Q1 = menu B" in `dependsOn` are two requirements of
 * one question, and returning `showIf` alone would drop the second one silently. `showIf.answer`
 * still wins over the legacy pair when both name an answer - one question, one answer condition.
 */
export function normaliseCondition(item: ConditionalItem): AudienceCondition | null {
  const answer =
    item.showIf?.answer ??
    (item.dependsOn
      ? { questionId: item.dependsOn, optionIds: [item.dependsValue ?? ''] }
      : undefined);
  const merged: AudienceCondition = { ...item.showIf, ...(answer ? { answer } : {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}
