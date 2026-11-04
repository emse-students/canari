import { registerPerReaderCache } from '$lib/utils/sharedCache';
import { Log } from '$lib/utils/Log';
import { listPostAsAssociations } from './postIdentity';

/**
 * WHETHER THE SIGNED-IN ACCOUNT MAY PUBLISH AS SOME ASSOCIATION - the one fact the "publish as an
 * association" first-time hint is conditional on.
 *
 * It is NOT a second definition of the right: it asks {@link listPostAsAssociations}, the very list
 * the composer's "Publier en tant que" picker offers (`POST_AS_ASSO` held, or a global admin), so the
 * hint and the picker cannot disagree. The list is async, so the answer is reactive: `null` until it
 * arrives, and a reader of it inside an effect (the guide scheduler) is re-run by the answer. The
 * request starts on the FIRST read, never at boot - only an account that is on the feed and has an
 * unseen help asks.
 */
let answer = $state<boolean | null>(null);
let started = false;
/** Bumped when the reader changes, so an answer in flight for the previous account is dropped. */
let generation = 0;

registerPerReaderCache(() => {
  generation += 1;
  started = false;
  answer = null;
});

/** `true` once the account is known to be able to post as an association; `false` while unknown. */
export function canPostAsAssociation(): boolean {
  if (!started) {
    started = true;
    const mine = generation;
    Log.d('POST_AS', 'probing the associations the account may publish as');
    void listPostAsAssociations()
      .then((list) => {
        if (mine !== generation) return;
        Log.d('POST_AS', `account may publish as ${list.length} association(s)`);
        answer = list.length > 0;
      })
      .catch((err) => {
        if (mine !== generation) return;
        // Not "no": the account may well have the right. Offer nothing now, ask again on a later read.
        console.error('[post-as] probe failed, the publish-as hint is not offered yet', err);
        started = false;
      });
  }
  return answer === true;
}
