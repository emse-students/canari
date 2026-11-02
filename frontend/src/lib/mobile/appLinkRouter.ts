import { resolve } from '$app/paths';
import { MOBILE_APP_PROTOCOL, OIDC_SIGNED_OUT_HOST } from '$lib/mobile/appSiteAssociation';
import { chatTargetOfLink } from '$lib/mobile/chatLinkTarget';
import { appRouteForDeepLink, proposalQueueAssociationId } from '$lib/mobile/deepLinkRoutes';
import { shopReturnPath } from '$lib/shop/checkoutReturn';
import { openClaimedAppLink } from '$lib/utils/appLinkNavigation';
import { noteOpenRoutedNowhere } from '$lib/utils/chat/resumeOpening.svelte';
import { CHECKOUT_RETURN_HOST } from '$lib/utils/checkoutCallbacks';
import type { AppPath } from '$lib/utils/internalPath';
import { describeDeepLink } from '$lib/utils/logSanitize';

/**
 * ROUTES APP LINKS, from whichever source delivered them: the deep-link plugin (`onOpenUrl`, the
 * launch URL) or the iOS notification tap (`notificationTapDrain.ts`). Out of `hooks.client.ts` so
 * its outcomes are driven by a test: every branch starts a landing or a navigation, or says the open
 * routes NOWHERE (`noteOpenRoutedNowhere`) - a resume that opened the link holds the conversation
 * it found on screen until one of the three is known (`resumeOpening.svelte.ts`).
 */
export function processAppLinks(urls: string[]): void {
  console.log('[hooks] onOpenUrl called with', urls.length, 'URL(s)');

  for (const url of urls) {
    console.log('[hooks] Processing URL:', describeDeepLink(url));

    try {
      // Parse the URL
      const u = new URL(url);
      console.log('[hooks] Parsed URL protocol:', u.protocol, 'host:', u.host);

      // Public web link (App Link / universal link): https://canari-emse.fr/posts/…
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        if (openClaimedAppLink(u.href)) continue;
      }

      // A page leaving an in-app browser (Messenger, Instagram) on iOS:
      // fr.emse.canari://open?url=<public Canari URL> (`$lib/mobile/openInApp`). Opened only
      // if it is a CLAIMED Canari page, exactly as the Universal Link would have been - anyone
      // can write this URL, so it must not reach anything a Universal Link cannot.
      if (u.protocol === MOBILE_APP_PROTOCOL && u.host === 'open') {
        const target = u.searchParams.get('url') ?? '';
        if (!openClaimedAppLink(target)) {
          console.warn(
            '[hooks] open link names no claimed Canari page, ignoring:',
            describeDeepLink(target)
          );
          noteOpenRoutedNowhere('an open link to no claimed page');
        }
        continue;
      }

      // Chat conversation deep link: fr.emse.canari://chat/{groupId}
      // A community channel target (`channel_<uuid>`) opens under /communities, not /chat.
      if (u.protocol === MOBILE_APP_PROTOCOL && u.host === 'chat') {
        const groupId = chatTargetOfLink(u.href);
        if (!groupId) noteOpenRoutedNowhere('a chat link naming no conversation');
        // A LINK NAVIGATES, IT NEVER ANSWERS A CALL. The native answer is carried by a
        // private intent (`pending_call_accept.json`, `$lib/stores/pendingCallAccept`); a
        // parameter of this URL is never read as one, whoever opened it.
        if (u.searchParams.has('acceptCall')) {
          console.warn('[hooks] a chat link carried acceptCall - ignored, links never answer');
        }
        if (groupId) {
          Promise.all([
            import('$lib/stores/notifNav.svelte'),
            import('$lib/stores/globalChatSingleton.svelte'),
          ])
            .then(([{ notifNav }, { appendLog }]) => {
              // The one line that says the native half of a notification tap worked. Without
              // it the chain - PendingIntent, onNewIntent, the deep-link plugin, this handler -
              // fails silently and indistinguishably at four different hops.
              appendLog(`[notifNav] deep link received: ${describeDeepLink(url)} -> chat target`);
              // PUBLISHING THE TARGET IS ALL THIS DOES, AND ROUTING IS SOMEBODY ELSE'S JOB.
              // It used to route here as well, so one landing drove TWO navigations to the
              // same route: this one, and the landing effect in `ChatBackgroundService`,
              // which is the one that can also SELECT the conversation once it arrives. Two
              // pushes of `/chat` is one extra Back press for the reader, and the `catch` here
              // assigned `window.location.href` - a full document load that discards the back
              // stack entirely, on a path whose whole purpose is to leave one behind.
              //
              // The effect is the survivor because it is the one that works on a COLD start:
              // a `goto` from here can fire before the SvelteKit router exists and no-op in
              // silence, which is what the effect's own comment has said all along.
              notifNav.navigate(groupId);
            })
            .catch((err) => {
              // The target never reached the landing: nothing will open. Said - to the log, and
              // to a resume holding the conversation it found on screen.
              console.error('[hooks] chat link could not be published:', err);
              noteOpenRoutedNowhere('a chat link whose landing could not be published');
            });
        }
        continue;
      }

      // Page deep links a notification tap lands on: post/{id}, form/{id}, posts, calendar,
      // admin-agenda. The table is `appRouteForDeepLink`; a host it does not own falls through
      // to the handlers below.
      // A proposal push (repost, co-organisation): its page is reached by SLUG, so the
      // association is looked up first - the path the notifications page takes for the same
      // row. A lookup that fails is logged, never replaced by another destination.
      const queueAssociationId = proposalQueueAssociationId(u);
      if (queueAssociationId) {
        Promise.all([
          import('$app/navigation'),
          import('$lib/stores/globalChatSingleton.svelte'),
          import('$lib/posts/notificationTarget'),
          import('$lib/associations/api'),
        ])
          .then(async ([{ goto }, { appendLog }, { resolveNotificationHref }, assos]) => {
            appendLog(`[notifNav] deep link received: ${describeDeepLink(url)} -> proposals queue`);
            const route = await resolveNotificationHref(
              { type: 'repost_proposed', postId: queueAssociationId },
              async (id) => (await assos.getAssociation(id)).slug
            );
            // Unreachable for `repost_proposed` (it always has a slug route); kept because the
            // signature is `string | null` and a null must never reach `goto`.
            if (!route) {
              noteOpenRoutedNowhere('a proposals link with no destination');
              console.warn('[hooks] proposals queue has no destination');
              return;
            }
            return goto(route);
          })
          .catch((err) => {
            console.error('[hooks] Proposal queue navigation failed', err);
            noteOpenRoutedNowhere('a proposals link whose navigation failed');
          });
        continue;
      }

      const pageRoute = appRouteForDeepLink(u);
      if (pageRoute) {
        Promise.all([import('$app/navigation'), import('$lib/stores/globalChatSingleton.svelte')])
          .then(([{ goto }, { appendLog }]) => {
            // The same line the chat branch prints: the first absent one names the broken hop.
            appendLog(
              `[notifNav] deep link received: ${describeDeepLink(url)} -> ${`/${pageRoute.split('/')[1] ?? ''}`}`
            );
            return goto(pageRoute);
          })
          .catch((err) => {
            console.error(
              '[hooks] Navigation to',
              `/${pageRoute.split('/')[1] ?? ''}`,
              'failed',
              err
            );
            noteOpenRoutedNowhere('a page link whose navigation failed');
          });
        continue;
      }

      // Checkout return: fr.emse.canari://payment/success|cancel?…
      if (u.protocol === MOBILE_APP_PROTOCOL && u.host === CHECKOUT_RETURN_HOST) {
        const path = u.pathname.replace(/\/$/, '') || '/';
        // A form return names its submission: the server puts `submission_id` in place of
        // the `session_id` placeholder, which Lydia never fills (return-url-key.ts).
        const submissionId = u.searchParams.get('submission_id');
        const registered = u.searchParams.get('registered');
        const postId = u.searchParams.get('post_id');

        const navigate = (target: AppPath) => {
          import('$app/navigation')
            .then(({ goto }) => goto(target))
            .catch(() => {
              window.location.href = target;
            });
        };

        if (path === '/success') {
          const purchaseSuccess = u.searchParams.get('purchase_success');
          const productId = u.searchParams.get('product_id') ?? u.searchParams.get('productId');
          if (purchaseSuccess && productId) {
            // The attempt the server named (`checkout_id`) is carried, so the shop asks
            // about THAT one.
            navigate(shopReturnPath('purchase_success', u.searchParams));
          } else if (submissionId) {
            navigate(`/forms/success?submission_id=${encodeURIComponent(submissionId)}`);
          } else if (registered) {
            const q = new URLSearchParams({ registered });
            if (postId) q.set('post_id', postId);
            navigate(`/posts?${q}`);
          } else {
            navigate('/posts');
          }
        } else if (path === '/cancel') {
          if (u.searchParams.get('purchase_cancel')) {
            navigate(shopReturnPath('purchase_cancel', u.searchParams));
          } else if (submissionId) {
            navigate(`/forms/cancel?submission_id=${encodeURIComponent(submissionId)}`);
          } else {
            navigate('/forms');
          }
        }
        continue;
      }

      // MiConnect's answer to a sign-out (`leaveSignedOut`): its session is ended, and arriving
      // here is what closed the in-app browser. The app went to `/login` when it opened that
      // browser, so there is nothing to route - only the proof to record, since nothing else
      // tells a sign-out that reached MiConnect from one whose browser was closed by hand.
      if (u.protocol === MOBILE_APP_PROTOCOL && u.host === OIDC_SIGNED_OUT_HOST) {
        // Nothing to route: the app already stands on `/login`.
        noteOpenRoutedNowhere('the sign-out browser coming back');
        import('$lib/stores/globalChatSingleton.svelte')
          .then(({ appendLog }) =>
            appendLog('[AUTH] MiConnect session ended - the sign-out browser came back')
          )
          .catch((err) => console.error('[hooks] Could not log the MiConnect sign-out', err));
        continue;
      }

      // A host of our own scheme that no table above owns: a push from a newer server. The
      // tap must land somewhere a reader can see the notification, never nowhere.
      if (u.protocol === MOBILE_APP_PROTOCOL && u.host !== 'callback') {
        console.warn(
          `[hooks] unknown deep-link host, opening notifications: ${describeDeepLink(url)}`
        );
        import('$app/navigation')
          .then(({ goto }) => goto(resolve('/notifications')))
          .catch((err) => {
            console.error('[hooks] Notifications navigation failed', err);
            noteOpenRoutedNowhere('an unknown-host link whose navigation failed');
          });
        continue;
      }

      // Only handle OIDC callback scheme
      if (u.protocol !== MOBILE_APP_PROTOCOL || u.host !== 'callback') {
        console.log('[hooks] URL is not our deep link, ignoring');
        noteOpenRoutedNowhere('a link that is not ours');
        continue;
      }

      // Extract OIDC parameters
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error');
      const error_description = u.searchParams.get('error_description');

      console.log('[hooks] Deep-link parameters:', {
        has_code: !!code,
        has_state: !!state,
        has_error: !!error,
      });

      // Handle error response from Authentik
      if (error) {
        const msg = error_description || error;
        console.log('[hooks] Auth error on the OIDC callback, code:', error);
        import('$app/navigation')
          .then(({ goto }) => goto(`/auth/callback?error=${encodeURIComponent(msg)}`))
          .catch(() => {
            window.location.href = `/auth/callback?error=${encodeURIComponent(msg)}`;
          });
        return;
      }

      // Handle successful OIDC response
      if (code && state) {
        console.log('[hooks] Valid OIDC response, redirecting to /auth/callback');
        import('$app/navigation')
          .then(({ goto }) =>
            goto(
              `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
            )
          )
          .catch(() => {
            window.location.href = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
          });
        return;
      }

      console.warn('[hooks] Missing code or state in callback URL');
      noteOpenRoutedNowhere('a callback with no code or state');
    } catch (err) {
      console.error('[hooks] Error processing deep link URL:', describeDeepLink(url), err);
      noteOpenRoutedNowhere('a link that could not be processed');
    }
  }
}
