import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';

/** What an attached-form card draws: the form's title, its opening date and whether this reader answered. */
export interface FormSummary {
  id: string;
  title: string;
  opensAt?: string | null;
  hasSubmitted: boolean;
}

/** Most ids one `GET /api/forms/summaries` may name (the server's `FORM_SUMMARIES_MAX`). */
export const FORM_SUMMARIES_MAX = 50;

/** One batch request: the forms the server served (an unreadable one is left out); a throw for no answer. */
export type SummaryFetcher = (ids: string[]) => Promise<FormSummary[]>;

/** The real fetcher: one request for the whole batch. */
async function fetchFormSummaries(ids: string[]): Promise<FormSummary[]> {
  const url = `${socialUrl()}/api/forms/summaries?ids=${ids.map(encodeURIComponent).join(',')}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`form summaries: HTTP ${res.status}`);
  return ((await res.json()) as { forms: FormSummary[] }).forms;
}

/**
 * Coalesces the per-form reads of every card drawn in the same turn into batched requests.
 *
 * A feed page drew one `GET /api/forms/:id` and one `/check` per attached form, 12 to 28 at a time
 * with no reuse; a stalled `/check` then made the card claim "not answered". Cards asking in the same
 * synchronous turn (one render flush) are collected and flushed on the next microtask - an ORDER,
 * not a timer - as ONE request per {@link FORM_SUMMARIES_MAX} ids. A form asked while its answer is
 * in flight shares that answer; a settled answer is NOT kept, since "has this reader answered" is
 * fresh each time a card mounts.
 *
 * Resolves `null` when the server answered but left the form out (deleted, draft, archived), and
 * REJECTS when no answer came - the two are different facts and the card draws them differently.
 */
export function createFormSummaryBatcher(fetcher: SummaryFetcher = fetchFormSummaries) {
  const inFlight = new Map<
    string,
    { promise: Promise<FormSummary | null>; settle: (r: FormSummary | null, e?: unknown) => void }
  >();
  let queue: string[] = [];
  let scheduled = false;

  async function flush(): Promise<void> {
    scheduled = false;
    const ids = queue;
    queue = [];
    for (let i = 0; i < ids.length; i += FORM_SUMMARIES_MAX) {
      const chunk = ids.slice(i, i + FORM_SUMMARIES_MAX);
      Log.d('FORMS', `summaries batch of ${chunk.length}`);
      try {
        const rows = await fetcher(chunk);
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of chunk) inFlight.get(id)?.settle(byId.get(id) ?? null);
      } catch (e) {
        console.warn(`[FORMS] summaries of ${chunk.length} form(s) got no answer: ${String(e)}`);
        for (const id of chunk) inFlight.get(id)?.settle(null, e ?? new Error('no answer'));
      }
    }
  }

  return function summaryOf(id: string): Promise<FormSummary | null> {
    const held = inFlight.get(id);
    if (held) return held.promise;
    let settle!: (r: FormSummary | null, e?: unknown) => void;
    const promise = new Promise<FormSummary | null>((resolve, reject) => {
      settle = (r, e) => {
        inFlight.delete(id);
        if (e !== undefined) reject(e);
        else resolve(r);
      };
    });
    inFlight.set(id, { promise, settle });
    queue.push(id);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => void flush());
    }
    return promise;
  };
}

/** The app's shared batcher: every card on the page asks through it. */
export const formSummaryOf = createFormSummaryBatcher();
