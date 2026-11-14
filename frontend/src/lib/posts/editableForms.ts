import type { Form } from '$lib/forms/api';
import { Log } from '$lib/utils/Log';

/**
 * The forms an edit picker offers: the ones its reader manages, PLUS the one the post already carries.
 *
 * `GET /api/forms` lists only the forms its reader owns or manages (`MANAGE_FORMS`). An editor whose
 * post carries a form they do not manage - a moderator, an officer without that right - therefore
 * saw "no form yet" under a post that visibly carried one, with no sign it was kept. The
 * attached form is read by id (any signed-in reader may) and added, so the picker always shows what
 * the post has. Saving never depended on it: `attachedFormId` is written from the selected id.
 *
 * @param managed The reader's own list (`getForms`).
 * @param attachedFormId The form the post carries now, if any.
 * @param readForm One form by id (`getForm` in the app); injected so the merge is testable.
 */
export async function withAttachedForm(
  managed: Form[],
  attachedFormId: string | null | undefined,
  readForm: (id: string) => Promise<Form>
): Promise<Form[]> {
  if (!attachedFormId || managed.some((f) => f.id === attachedFormId)) return managed;
  try {
    const attached = await readForm(attachedFormId);
    Log.d(
      'POSTS',
      `edit picker: attached form ${attachedFormId} is not this reader's to manage, added`
    );
    return [attached, ...managed];
  } catch (e) {
    console.error(`[POSTS] edit picker: attached form ${attachedFormId} could not be read`, e);
    return managed;
  }
}

/**
 * The forms a post may attach for the identity it is published under - the server's rule
 * (`form-ownership.ts`, 2026-11-14), so the picker never offers what the publish would refuse:
 * an association's, institution's or list's post only that association's forms (as an agenda
 * event); a personal or anonymous post every form the reader manages (`forms` is `GET /forms`,
 * exactly those).
 *
 * @param forms The reader's own list (`getForms`), already reduced to published ones.
 * @param associationId The association the post speaks for, or null for a personal post.
 */
export function attachableForms(forms: Form[], associationId: string | null): Form[] {
  if (!associationId) return forms;
  const own = forms.filter((f) => f.associationId === associationId);
  if (own.length < forms.length) {
    Log.d('POSTS', `form picker: ${forms.length - own.length} form(s) of another entity left out`);
  }
  return own;
}
