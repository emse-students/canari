import { SvelteMap } from 'svelte/reactivity';
import type { PostEntity } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';

/** One form a post names: its id, and its title when the post carries it (the `forms` list). */
export interface AttachedFormSource {
  id: string;
  title?: string;
}

/** One attached form as its card draws it: the title, and whether this reader has answered. */
export interface AttachedFormInfo {
  id: string;
  title: string;
  submitted: boolean;
  opensAt?: string | null;
}

/** The two reads a card makes per form - injected so the loader is testable without a server. */
export interface AttachedFormReads {
  getForm(id: string): Promise<{ id: string; title: string; opensAt?: string | null }>;
  checkSubmission(id: string): Promise<{ hasSubmitted: boolean }>;
}

/**
 * The forms `post` names, each ONCE, in the order the post names them.
 *
 * `forms` is the list a post carries since several forms could be attached; a post written before it
 * names its one form in `attachedFormId`, read only when there is no list. A list naming one form
 * twice is a server-side defect - nothing in the composer writes it - so it is said, at the level that
 * accuses, and drawn once: two cards for one form would be the same `each_key_duplicate` that took the
 * followed feed down (production, 2026-10-18).
 */
export function attachedFormSources(
  post: Pick<PostEntity, 'id' | 'forms' | 'attachedFormId'>
): AttachedFormSource[] {
  if (!post.forms?.length) return post.attachedFormId ? [{ id: post.attachedFormId }] : [];
  const out: AttachedFormSource[] = [];
  for (const f of post.forms) {
    if (out.some((s) => s.id === f.id)) continue;
    out.push({ id: f.id, title: f.title });
  }
  if (out.length < post.forms.length) {
    console.warn(
      `[POSTS] post ${post.id} names ${post.forms.length - out.length} attached form(s) more than once - each drawn once`
    );
  }
  return out;
}

/**
 * Reads each attached form of a card ONCE and holds the answers KEYED BY FORM, so the list a card
 * draws cannot name a form twice.
 *
 * **THE DEFECT THIS REPLACES (production, client 1.2.9, 2026-10-18).** The card's effect skipped a
 * form only once its answer was in the drawn list, and appended each answer to that list. Any re-run
 * while an answer was in flight - the card's OTHER form answering (the effect read the list it wrote),
 * or the card being handed the server's copy of its post - asked again and appended again: two cards
 * for one form, `each_key_duplicate`, and the whole feed behind the page error boundary. Whether a form
 * has been ASKED is a different question from whether it has ANSWERED, so it has its own record, which
 * nothing reactive reads; and what is drawn is derived from the post's own list, so its order is the
 * post's and its length can only be the post's.
 *
 * A form whose read fails stays a placeholder for this card's life and is not asked again - the
 * card's previous behaviour, now logged.
 *
 * @param sources The forms the card's post names now ({@link attachedFormSources}).
 * @param reads The form reads (`$lib/forms/api` in the app).
 */
export function attachedFormsLoader(
  sources: () => AttachedFormSource[],
  reads: AttachedFormReads
): { readonly infos: AttachedFormInfo[]; readonly pending: string[] } {
  const answered = new SvelteMap<string, AttachedFormInfo>();
  // NOT REACTIVE ON PURPOSE: the effect below must not re-run because it recorded an ask.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a record of asks nothing draws
  const asked = new Set<string>();

  async function load(src: AttachedFormSource): Promise<void> {
    let title = src.title;
    let opensAt: string | null | undefined;
    if (!title) {
      try {
        const form = await reads.getForm(src.id);
        title = form.title;
        opensAt = form.opensAt;
      } catch (e) {
        console.error(
          `[POSTS] attached form ${src.id} could not be read - left as a placeholder`,
          e
        );
        return;
      }
    }
    let submitted = false;
    try {
      submitted = (await reads.checkSubmission(src.id)).hasSubmitted;
    } catch (e) {
      console.warn(
        `[POSTS] attached form ${src.id}: whether this reader answered could not be read - drawn as not answered`,
        e
      );
    }
    answered.set(src.id, { id: src.id, title, submitted, opensAt });
  }

  $effect(() => {
    for (const src of sources()) {
      if (asked.has(src.id)) continue;
      asked.add(src.id);
      Log.d('POSTS', `attached form ${src.id} asked`);
      void load(src);
    }
  });

  const infos = $derived(
    sources().flatMap((s) => {
      const info = answered.get(s.id);
      return info ? [info] : [];
    })
  );
  const pending = $derived(
    sources()
      .map((s) => s.id)
      .filter((id) => !answered.has(id))
  );

  return {
    get infos() {
      return infos;
    },
    get pending() {
      return pending;
    },
  };
}
