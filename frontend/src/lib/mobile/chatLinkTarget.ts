import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';

/**
 * The conversation an app link opens (`fr.emse.canari://chat/{groupId}`), or `null` when it opens
 * anything else. The ONE parse of a chat link: the deep-link router publishes this id to `notifNav`,
 * and a resume that opens a link compares it with the conversation on screen
 * (`resumeOpening.svelte.ts`) - two parses could disagree about what "the same conversation" is.
 */
export function chatTargetOfLink(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== MOBILE_APP_PROTOCOL || u.host !== 'chat') return null;
  const id = u.pathname.replace(/^\//, '');
  return id || null;
}
