import { signAgendaFeed, type AgendaFeedSelection } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/** Where a signature stands: asked, answered, or refused. */
export type FeedSigningStatus = 'idle' | 'signing' | 'ready' | 'error';

/**
 * THE SIGNATURE A SUBSCRIPTION URL CARRIES (D40 amended 2026-10-06): a selection feed is refused by
 * the server unless its URL holds the `sig` the server made for that exact selection, and it makes
 * one only for the reader's own spaces. This asks for it, reactively, and keeps it apart from the
 * selection it was made for - so a URL is never built from the signature of the PREVIOUS choice.
 *
 * Call it during component initialisation (it owns an `$effect`). `request` returns the selection to
 * sign, or `null` when nothing should be signed yet - the modal being closed, a selection not
 * chosen - so no request leaves for a link nobody has asked to see.
 *
 * @returns `sig` is `''` until the CURRENT request is answered; `status` says why it is empty.
 */
export function createFeedSigner(request: () => AgendaFeedSelection | null) {
  let sig = $state('');
  let status = $state<FeedSigningStatus>('idle');

  $effect(() => {
    const selection = request();
    sig = '';
    if (!selection) {
      status = 'idle';
      return;
    }
    status = 'signing';
    let stale = false;
    Log.d(
      'feedSigner',
      `signing campus=${selection.campus || '-'} formation=${selection.formation || '-'} association=${selection.associationId || '-'}`
    );
    signAgendaFeed(selection)
      .then((signature) => {
        if (stale) return;
        sig = signature;
        status = 'ready';
      })
      .catch((err) => {
        if (stale) return;
        Log.d('feedSigner', `the server refused to sign: ${String(err)}`);
        status = 'error';
      });
    return () => {
      stale = true;
    };
  });

  return {
    get sig() {
      return sig;
    },
    get status() {
      return status;
    },
  };
}
