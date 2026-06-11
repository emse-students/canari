/**
 * Client-side hooks – runs once at app startup before any component renders.
 *
 * On Tauri, wraps `window.fetch` so that **external API calls** go through
 * the native HTTP plugin (bypasses CORS, uses native TLS), while internal
 * SvelteKit requests (route data, HMR, Vite modules) still use the browser's
 * built-in `fetch` so the client-side router keeps working.
 */

import { navigateInAppFromPublicUrl } from '$lib/utils/appLinkNavigation';
import { installAppLinkClickHandler, isTauriRuntime } from '$lib/utils/openExternal';
import { inAppPathFromPublicUrl, isPublicAppUrl } from '$lib/utils/publicAppUrl';
import { installConsoleIdTruncation } from '$lib/utils/logTruncate';

// Condense les identifiants longs (UUIDs, hex ≥ 16) dans tous les logs console,
// avant tout autre logging, pour des logs web aussi lisibles que ceux d'adb.
installConsoleIdTruncation();

/** Called on unhandled client-side errors; logs to console (SvelteKit default behaviour). */
export function handleError({ error }: { error: unknown }): void {
  console.error('[App] Client error:', error);
}

/** Optional init hook - called once before the app starts. No setup needed here. */
export function init(): void {}

// ════════════════════════════════════════════════════════════════════════════
// EXTERNAL LINKS - Open in system browser / default app (not in WebView)
// ════════════════════════════════════════════════════════════════════════════

installAppLinkClickHandler();

// ════════════════════════════════════════════════════════════════════════════
// DEEP LINK HANDLER - OIDC on Mobile Tauri
// ════════════════════════════════════════════════════════════════════════════
//
// Flow on Android Tauri:
// 1. User taps "Login" → Opens Authentik in system browser (Chrome Custom Tabs)
// 2. After login, Authentik redirects to fr.emse.canari://callback?code=ABC&state=XYZ
// 3. Android OS recognizes the custom scheme (via AndroidManifest.xml intent-filter)
// 4. Tauri's plugin-deep-link intercepts the intent and emits onOpenUrl()
// 5. This code listens and redirects to /auth/callback?code=ABC&state=XYZ
// 6. The callback page exchanges the code for a token
//
// IMPORTANT: This MUST NOT use async/await at the module level.
// The event can arrive before async setup completes → we use Promise.resolve().then()

if (isTauriRuntime()) {
  // Initialize deep-link listener immediately (no async race condition).
  Promise.resolve()
    .then(() => import('@tauri-apps/plugin-deep-link'))
    .then(({ onOpenUrl, getCurrent }) => {
      console.log('[hooks] Deep-link listener registered');

      const processUrls = (urls: string[]) => {
        console.log('[hooks] onOpenUrl called with', urls.length, 'URL(s)');

        for (const url of urls) {
          console.log('[hooks] Processing URL:', url);

          try {
            // Parse the URL
            const u = new URL(url);
            console.log('[hooks] Parsed URL protocol:', u.protocol, 'host:', u.host);

            // Public web link (App Link / universal link): https://canari-emse.fr/posts/…
            if (u.protocol === 'https:' || u.protocol === 'http:') {
              if (isPublicAppUrl(u.href)) {
                const inApp = inAppPathFromPublicUrl(u.href);
                if (inApp) {
                  void navigateInAppFromPublicUrl(u.href);
                  continue;
                }
              }
            }

            // Chat conversation deep link: fr.emse.canari://chat/{groupId}
            if (u.protocol === 'fr.emse.canari:' && u.host === 'chat') {
              const groupId = u.pathname.replace(/^\//, '');
              if (groupId) {
                import('$lib/stores/notifNav.svelte')
                  .then(({ notifNav }) => {
                    notifNav.navigate(groupId);
                    if (window.location.pathname !== '/chat') {
                      import('$app/navigation')
                        .then(({ goto }) => goto('/chat'))
                        .catch(() => {
                          window.location.href = '/chat';
                        });
                    }
                  })
                  .catch(() => {});
              }
              continue;
            }

            // Post deep link: fr.emse.canari://post/{postId}
            if (u.protocol === 'fr.emse.canari:' && u.host === 'post') {
              const postId = u.pathname.replace(/^\//, '');
              if (postId) {
                import('$app/navigation')
                  .then(({ goto }) => goto(`/posts/${postId}`))
                  .catch(() => {
                    window.location.href = `/posts/${postId}`;
                  });
              }
              continue;
            }

            // Form deep link: fr.emse.canari://form/{formId}
            if (u.protocol === 'fr.emse.canari:' && u.host === 'form') {
              const formId = u.pathname.replace(/^\//, '');
              if (formId) {
                import('$app/navigation')
                  .then(({ goto }) => goto(`/forms/${formId}`))
                  .catch(() => {
                    window.location.href = `/forms/${formId}`;
                  });
              }
              continue;
            }

            // Stripe Checkout return: fr.emse.canari://stripe/success|cancel?…
            if (u.protocol === 'fr.emse.canari:' && u.host === 'stripe') {
              const path = u.pathname.replace(/\/$/, '') || '/';
              const sessionId = u.searchParams.get('session_id');
              const registered = u.searchParams.get('registered');
              const postId = u.searchParams.get('post_id');
              const paymentSetup = u.searchParams.get('payment_setup');

              const navigate = (target: string) => {
                import('$app/navigation')
                  .then(({ goto }) => goto(target))
                  .catch(() => {
                    window.location.href = target;
                  });
              };

              if (path === '/success') {
                const purchaseSuccess = u.searchParams.get('purchase_success');
                const productId =
                  u.searchParams.get('product_id') ?? u.searchParams.get('productId');
                if (purchaseSuccess && productId) {
                  navigate(
                    `/shop?purchase_success=${encodeURIComponent(purchaseSuccess)}&productId=${encodeURIComponent(productId)}`
                  );
                } else if (sessionId) {
                  navigate(`/forms/success?session_id=${encodeURIComponent(sessionId)}`);
                } else if (paymentSetup) {
                  navigate(`/profile?payment_setup=${encodeURIComponent(paymentSetup)}`);
                } else if (registered) {
                  const q = new URLSearchParams({ registered });
                  if (postId) q.set('post_id', postId);
                  navigate(`/posts?${q}`);
                } else {
                  navigate('/posts');
                }
              } else if (path === '/cancel') {
                if (u.searchParams.get('purchase_cancel')) {
                  navigate('/shop?purchase_cancel=1');
                } else if (sessionId) {
                  navigate(`/forms/cancel?session_id=${encodeURIComponent(sessionId)}`);
                } else if (paymentSetup) {
                  navigate(`/profile?payment_setup=${encodeURIComponent(paymentSetup)}`);
                } else {
                  navigate('/forms');
                }
              }
              continue;
            }

            // Only handle OIDC callback scheme
            if (u.protocol !== 'fr.emse.canari:' || u.host !== 'callback') {
              console.log('[hooks] URL is not our deep link, ignoring');
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
              console.log('[hooks] Auth error:', msg);
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
          } catch (err) {
            console.error('[hooks] Error processing deep link URL:', url, err);
          }
        }
      };

      // Handles deep links when the app is already running
      onOpenUrl(processUrls);

      // URL traitée lors du dernier appel getCurrent() - évite de rejouer la même URL
      // au retour au premier plan si Android n'a pas mis à jour l'intent courant.
      let lastGetCurrentUrl: string | null = null;

      const checkCurrentUrl = () =>
        getCurrent()
          .then((urls) => {
            if (!urls) return;
            const first = Array.isArray(urls) ? urls[0] : String(urls);
            if (first === lastGetCurrentUrl) return; // déjà traité
            lastGetCurrentUrl = first;
            processUrls(Array.isArray(urls) ? urls : [urls]);
          })
          .catch(() => {});

      // Handles deep link that cold-started the app (fired before listener could register)
      void checkCurrentUrl();

      // Re-vérifie au retour au premier plan : couvre le cas où onOpenUrl ne tire pas
      // quand l'app était en arrière-plan et que l'utilisateur tape une notification.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkCurrentUrl();
      });
    })
    .catch((err) => {
      // Plugin might not be available (desktop, or in dev without Tauri).
      // This is not an error - just log it.
      console.log('[hooks] Deep-link plugin not available:', err.message);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// HTTP PLUGIN WRAPPER - Use Tauri native HTTP for external API calls
// ════════════════════════════════════════════════════════════════════════════

if (isTauriRuntime()) {
  import('@tauri-apps/plugin-http')
    .then(({ fetch: tauriFetch }) => {
      const originalFetch = window.fetch;
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        // Determine the URL string
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        // Keep browser fetch for relative URLs (SvelteKit internal),
        // Vite dev server, HMR, and data requests.
        if (
          !url ||
          url.startsWith('/') ||
          url.startsWith('http://127.0.0.1:1420') ||
          url.startsWith('http://localhost:1420') ||
          url.includes('__data.json') ||
          url.includes('@vite') ||
          url.includes('node_modules')
        ) {
          return originalFetch.call(window, input, init);
        }

        // Cookie-bearing requests (credentials: 'include') MUST use the
        // browser's native fetch. The Tauri HTTP plugin runs in a separate
        // Rust thread whose cookie jar is isolated from the WebView's - it
        // can't write Set-Cookie responses back to the WebView, which breaks
        // HttpOnly session cookies (refresh token). Using native fetch here
        // also prevents a deadlock where the plugin stalls waiting for a
        // cookie-jar sync that never completes.
        if ((init as RequestInit | undefined)?.credentials === 'include') {
          return originalFetch.call(window, input, init);
        }

        return tauriFetch(input, init) as ReturnType<typeof window.fetch>;
      } as typeof window.fetch;
    })
    .catch(() => {
      // May fail during an in-flight page reload; the next load will retry.
    });
}
