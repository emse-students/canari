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
 * Refused by the server (`form-ownership.ts`): the form is not the post's own entity's - another
 * association's under an association's post, or one its author does not manage under a personal one.
 */
export const FORM_NOT_OF_ENTITY = 'FORM_NOT_OF_ENTITY';

/** Refused by the server: an anonymous post carries no form (the form would name its manager). */
export const FORM_NOT_ON_ANONYMOUS_POST = 'FORM_NOT_ON_ANONYMOUS_POST';

/**
 * The forms a post may attach for the identity it is published under - the server's rule
 * (`form-ownership.ts`, 2026-11-14), so the picker never offers what the publish would refuse:
 * an association's, institution's or list's post only that association's forms (as an agenda
 * event); a personal post every form the reader manages (`forms` is `GET /forms`, exactly those);
 * an anonymous post none ({@link FORM_NOT_ON_ANONYMOUS_POST}).
 *
 * @param forms The reader's own list (`getForms`), already reduced to published ones.
 * @param identity The association the post speaks for (null for a personal post), and whether it
 *   is published anonymously.
 */
export function attachableForms(
  forms: Form[],
  identity: { associationId: string | null; anonymous: boolean }
): Form[] {
  if (identity.anonymous) {
    if (forms.length) Log.d('POSTS', 'form picker: an anonymous post attaches no form');
    return [];
  }
  const { associationId } = identity;
  if (!associationId) return forms;
  const own = forms.filter((f) => f.associationId === associationId);
  if (own.length < forms.length) {
    Log.d('POSTS', `form picker: ${forms.length - own.length} form(s) of another entity left out`);
  }
  return own;
}
