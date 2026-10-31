import type { AppPath } from '$lib/utils/internalPath';

/**
 * The query parameter that opens ONE form's responses on the forms list.
 *
 * The responses are an accordion on `/forms`, not a page of their own, so a link that must land on
 * them - the organiser alert for a payment over capacity, from the bell or from a push tap
 * (`fr.emse.canari://form-responses/<id>`, written by `socialDeepLink` in social-service) - names
 * the form here and the list opens that accordion once it has loaded.
 */
export const FORM_RESPONSES_PARAM = 'responses';

/** The app route that opens `formId`'s responses on the forms list. */
export function formResponsesRoute(formId: string): AppPath {
  return `/forms?${FORM_RESPONSES_PARAM}=${encodeURIComponent(formId)}`;
}
