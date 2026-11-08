import { getPublicForm, PublicFormUnavailableError, type Form } from '$lib/forms/api';
import { Log } from '$lib/utils/Log';
import type { AppPath } from '$lib/utils/internalPath';

/**
 * The app path a form is SHARED by. A form that accepts guest answers (`isPublic`, the server's own
 * field) is shared by its guest address `/f/<id>`, the only one that opens without an account; any
 * other form by its member page `/forms/<id>`. Decided from the form's field, never from a request
 * that failed: a visitor holding the member address of a public form is sent to the guest one by
 * {@link guestPathForMemberLink}, which exists for links already in circulation, not for new ones.
 * The ONE producer of a share link, so the list, the detail page and the QR code cannot drift.
 */
export function formSharePath(form: Pick<Form, 'id' | 'isPublic'>): AppPath {
  return form.isPublic ? `/f/${form.id}` : `/forms/${form.id}`;
}

/** A form id is a uuid (`forms.id`); `/forms/create`, `/forms/success`... are never one. */
const MEMBER_FORM_PATH_RE =
  /^\/forms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The form id of a base-less member page path (`/forms/<uuid>`), else null. */
export function memberFormIdOfPath(path: string): string | null {
  return MEMBER_FORM_PATH_RE.exec(path)?.[1] ?? null;
}

/**
 * Where a SIGNED-OUT visitor on `path` should land instead of the login screen: the guest page
 * `/f/<id>` when `path` is a form's member page and the server answers that form as public (the
 * endpoint the guest page itself reads; it 404s anything not public), else null (login, as before).
 * Asked only for the `/forms/<uuid>` shape and only once the session question is answered "no
 * session", so a signed-in member never pays the request. A failed request is logged and answers
 * null: the visitor reaches the login screen, which is today's behaviour, never a guess.
 */
export async function guestPathForMemberLink(path: string): Promise<AppPath | null> {
  const id = memberFormIdOfPath(path);
  if (!id) return null;
  try {
    await getPublicForm(id);
    Log.d('FormLink', `signed-out visitor on member link, form=${id} is public -> guest page`);
    return `/f/${id}`;
  } catch (e) {
    if (e instanceof PublicFormUnavailableError && e.notFound) {
      // An ANSWER: the server does not serve this form as public, so the member link is right.
      Log.d('FormLink', `signed-out visitor on member link, form=${id} not public -> login`);
    } else {
      // NOT an answer (transport failure, 5xx): the visitor may hold a public form's link and is
      // still sent to login, so it is said at a level that accuses.
      console.warn(`[FormLink] public read of form=${id} failed, sent to login unanswered:`, e);
    }
    return null;
  }
}
