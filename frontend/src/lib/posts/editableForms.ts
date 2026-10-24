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
