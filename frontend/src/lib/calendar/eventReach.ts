import { institutionReachOffered } from '$lib/posts/institutionReach';
import { serverEventReach } from '$lib/stores/appVersionCheck.svelte';

/**
 * WHETHER THE EVENT FORM OFFERS AN INSTITUTION'S REACH (owner, 2026-11-13): the owner is an
 * institution AND the estate says it stores the reach (`eventReach` in `/api/version`). A store build
 * reaches phones before production deploys, and an older server answers the options route `404` and
 * cannot store a reach - requiring one there would keep "Déposer" disabled for every institution. So
 * until the estate says so, the form files the event as before, with no picker and no requirement
 * (docs/wiki/legacy-compatibility.md, "an event form newer than its server"). The capability is read,
 * never inferred from a refusal.
 */
export function eventReachOffered(associationType: string | null | undefined): boolean {
  return institutionReachOffered(associationType) && serverEventReach() === true;
}
