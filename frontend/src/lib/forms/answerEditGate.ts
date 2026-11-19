import { Log } from '$lib/utils/Log';

/**
 * WHETHER THIS ESTATE IS ASKED ABOUT CHANGING AN ANSWER AT ALL (forms.md, "A respondent changes
 * their own answer"; docs/wiki/legacy-compatibility.md, "an answer editor newer than its server").
 *
 * A store build reaches phones days before production deploys. A server older than migration 166
 * answers the answer routes `404` and strips the form's switch from a save, so the client asks its
 * `/api/version` (`formAnswerEdit`) instead of learning it from a refusal: only an estate that says
 * `true` is offered the switch or "Modifier ma reponse". `null` (no server has ever answered) offers
 * nothing - the feature waits for the answer, it is never guessed.
 */

/**
 * Whether the fill page asks for the caller's changeable answers: the form allows it, is not
 * anonymous, the caller is signed in, and the estate serves the routes.
 */
export function offersAnswerEdit(
  form: { allowAnswerEdit?: boolean; anonymous?: boolean },
  signedIn: boolean,
  estateServes: boolean | null
): boolean {
  if (!form.allowAnswerEdit || form.anonymous || !signedIn) return false;
  if (estateServes !== true) {
    Log.d('FormView', `answer edit not offered: the estate says formAnswerEdit=${estateServes}`);
    return false;
  }
  return true;
}

/**
 * The switch's part of a form's save: sent only to an estate that serves it, so an older server is
 * never handed a field it would drop while the editor showed it saved. Absent means "leave it" on an
 * edit - the stored value is kept.
 */
export function answerEditPayload(
  estateServes: boolean,
  allowAnswerEdit: boolean
): { allowAnswerEdit?: boolean } {
  return estateServes ? { allowAnswerEdit } : {};
}
