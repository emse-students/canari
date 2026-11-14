import {
  requestAgendaSubscription,
  revokeAgendaSubscriptions,
  SocialApiError,
  type AgendaFeedSelection,
} from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/**
 * Where a link stands: asked, answered, REFUSED (`error`: the server answered 4xx, the campus text
 * applies) or UNAVAILABLE (a 5xx or a transport failure: nothing was decided about the reader, so the
 * campus text would lie).
 */
export type SubscriptionLinkStatus = 'idle' | 'signing' | 'ready' | 'error' | 'unavailable';

/**
 * Where a revocation stands: none asked, under way, done, or failed (`failed` keeps the link shown
 * before: nothing tells the reader it stopped working).
 */
export type SubscriptionRevokeStatus = 'idle' | 'revoking' | 'revoked' | 'failed';

/**
 * Classifies a failed request BY TYPE AND STATUS, never by message: a status code below 500 is an
 * answer (a refusal), a 5xx or a transport failure is not one.
 */
function isRefusal(err: unknown): boolean {
  return err instanceof SocialApiError && err.status < 500;
}

/**
 * THE READER'S SUBSCRIPTION LINK (owner, 2026-11-14, "Respecter les publics"): the token the server
 * binds to the reader's account for a selection, which the URL handed to a calendar app carries
 * ALONE. It serves what the reader sees, re-read at every poll, and is revocable. This asks for it,
 * reactively, and keeps it apart from the selection it was made for - so a URL is never built from
 * the token of the PREVIOUS choice.
 *
 * Call it during component initialisation (it owns an `$effect`). `request` returns the selection,
 * or `null` when nothing should be asked yet - the modal being closed, a selection not chosen - so no
 * request leaves for a link nobody has asked to see.
 *
 * `revoke()` ends EVERY link of the reader, then asks again for the current selection's: the new
 * token is a new link.
 *
 * @returns `token` is `''` until the CURRENT request is answered; `status` says why it is empty.
 */
export function createSubscriptionLink(request: () => AgendaFeedSelection | null) {
  let token = $state('');
  let status = $state<SubscriptionLinkStatus>('idle');
  let revokeStatus = $state<SubscriptionRevokeStatus>('idle');
  /** Bumped by a revocation: the effect reads it, so the current selection is asked again. */
  let generation = $state(0);

  $effect(() => {
    const selection = request();
    void generation;
    token = '';
    if (!selection) {
      status = 'idle';
      return;
    }
    status = 'signing';
    let stale = false;
    Log.d(
      'subscriptionLink',
      `asking campus=${selection.campus || '-'} formation=${selection.formation || '-'} association=${selection.associationId || '-'}`
    );
    requestAgendaSubscription(selection)
      .then((answer) => {
        if (stale) return;
        token = answer;
        status = 'ready';
      })
      .catch((err) => {
        if (stale) return;
        if (isRefusal(err)) {
          Log.d(
            'subscriptionLink',
            `the server refused the link: ${(err as SocialApiError).status} ${(err as SocialApiError).code ?? '-'}`
          );
          status = 'error';
        } else {
          // 503 = the server's signing key is unset or too short; a transport failure decides nothing.
          Log.d(
            'subscriptionLink',
            `the link is unavailable, no refusal was issued: ${String(err)}`
          );
          status = 'unavailable';
        }
      });
    return () => {
      stale = true;
    };
  });

  async function revoke(): Promise<void> {
    Log.d('subscriptionLink', 'revoking every subscription link of the reader');
    revokeStatus = 'revoking';
    try {
      const revoked = await revokeAgendaSubscriptions();
      Log.d('subscriptionLink', `revoked ${revoked} link(s); asking for a new one`);
      revokeStatus = 'revoked';
      generation += 1;
    } catch (err) {
      Log.d(
        'subscriptionLink',
        `revocation failed (${isRefusal(err) ? 'refused' : 'unavailable'}): ${String(err)}`
      );
      revokeStatus = 'failed';
    }
  }

  return {
    get token() {
      return token;
    },
    get status() {
      return status;
    },
    get revokeStatus() {
      return revokeStatus;
    },
    revoke,
  };
}
