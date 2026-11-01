<script lang="ts">
  import { appPathFromPathname, safeInternalPath } from '$lib/utils/internalPath';
  import { gotoAppPath } from '$lib/navigation/gotoAppPath';
  import { onMount } from 'svelte';
  import {
    startOidcLogin,
    hasStoredSession,
    getToken,
    PASSWORD_LOGIN_FLOW_SLUG,
  } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';
  import { loginOpenInAppOffer } from '$lib/mobile/openInApp';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { PHONE_VIEWPORT_QUERY, isPhoneViewport, onViewportChange } from '$lib/utils/viewport';
  import { onAppForegroundChange } from '$lib/utils/appForeground';
  import {
    getAppVersionCheck,
    isBelowMinClientVersion,
    refreshAppVersionCheck,
  } from '$lib/stores/appVersionCheck.svelte';
  import { m } from '$lib/paraglide/messages';
  import { attemptRestore } from '$lib/services/restoreCredential';

  // ─── Auth state ─────────────────────────────────────────────────────────────
  let isLoggingIn = $state(false);
  /** Set while a restore key is being tried (WP-RESTORE-1): the busy button says so. */
  let busyLabel = $state<string | null>(null);
  let loginError = $state('');
  let biometricAvailable = $state(false);
  let requestedReturnTo = '';
  /** Store badges: a phone-sized WEB visitor, never the native app itself. */
  let showStoreBadges = $state(false);
  let openInAppHref = $state<string | null>(null);

  const platformInfo = $derived(getAppVersionCheck());
  const loginDisabled = $derived(isBelowMinClientVersion());
  const maintenanceNotice = $derived.by(() => {
    if (!platformInfo?.maintenance.enabled) return null;
    return platformInfo.maintenance.message || m.auth_maintenance_default();
  });

  /** Key holding the last auto-redirect target and its timestamp, for the loop breaker. */
  const LAST_AUTO_REDIRECT_KEY = 'canari_login_auto_redirect';
  /** A second bounce to the same target within this window is treated as a loop. */
  const AUTO_REDIRECT_LOOP_WINDOW_MS = 5000;

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function getSafeReturnTarget(): string {
    const target = safeInternalPath(requestedReturnTo, '/posts');
    // Prevent redirect loops back to the login page.
    if (target === '/login' || target.startsWith('/login?')) return '/posts';
    return target;
  }

  /**
   * Loop breaker for the silent post-session redirect.
   *
   * A page can send the user here because ITS notion of "signed in" is unmet while the OIDC
   * session this page checks is perfectly valid - the two never converge, and the pair spins
   * at roughly one full round trip per second, each one burning a token refresh. Refusing the
   * second identical bounce inside a short window leaves the user on /login, where the sign-in
   * button is reachable.
   *
   * Only the automatic redirect is throttled; an explicit sign-in still honours returnTo.
   */
  function shouldAutoRedirectTo(target: string): boolean {
    try {
      const raw = sessionStorage.getItem(LAST_AUTO_REDIRECT_KEY);
      const now = Date.now();
      if (raw) {
        const { target: last, at } = JSON.parse(raw) as { target: string; at: number };
        if (last === target && now - at < AUTO_REDIRECT_LOOP_WINDOW_MS) {
          sessionStorage.removeItem(LAST_AUTO_REDIRECT_KEY);
          console.warn(`[auth] redirect loop to ${target} broken - staying on /login`);
          loginError = m.auth_redirect_loop_blocked();
          return false;
        }
      }
      sessionStorage.setItem(LAST_AUTO_REDIRECT_KEY, JSON.stringify({ target, at: now }));
    } catch {
      // sessionStorage unavailable (private mode): fall through and redirect as before.
    }
    return true;
  }

  // ─── Initialization ──────────────────────────────────────────────────────────
  onMount(() => {
    void refreshAppVersionCheck();

    // Reset isLoggingIn when the user returns to the page (e.g. after a failed
    // navigation to Authentik or after a biometric prompt).
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        isLoggingIn = false;
        void refreshAppVersionCheck();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    // A phone's WebView stays `visible` in the background, so coming back from the identity
    // provider's browser is seen only through the native foreground edge.
    const unsubscribeForeground = onAppForegroundChange((foreground) => {
      if (foreground) onVisible();
    });

    // 1. Safely extract the return URL from query params.
    try {
      const url = new URL(window.location.href);
      requestedReturnTo = url.searchParams.get('returnTo') ?? '';
    } catch {
      requestedReturnTo = '';
    }

    // 2. Unified session + biometric check.
    const initAuth = async () => {
      await refreshAppVersionCheck();
      if (isBelowMinClientVersion()) return;

      const isTauri = isTauriRuntime();

      // Biometric check is Tauri-only.
      if (isTauri) {
        try {
          biometricAvailable = await BiometricService.isAvailable();
        } catch {
          biometricAvailable = false;
        }
      }

      // Session check (Tauri + Web).
      if (await hasStoredSession()) {
        try {
          await getToken();
        } catch {
          // Token expired or invalid: stay on login so the user can re-authenticate.
          console.debug('Session expired or invalid, re-login required.');
          return;
        }
        const target = getSafeReturnTarget();
        const current = appPathFromPathname(window.location.pathname) + window.location.search;

        // Only redirect when not already on the target page, and never twice in a row to a
        // target that just bounced back here. A navigation that fails is a navigation failure,
        // logged as one - never read as an expired session.
        if (target !== current && shouldAutoRedirectTo(target)) {
          await gotoAppPath(target, { replace: true }).catch((err: unknown) =>
            console.error(
              '[LOGIN] signed in, but leaving /login for the return target failed:',
              err
            )
          );
        }
        return;
      }

      // No session here. On the first start of a fresh Android install, a restore key carried by
      // the phone's Google backup may move the old phone's session here (docs/wiki/account-restore.md).
      // `attemptRestore` decides whether it applies and never throws.
      await tryRestore();
    };

    void initAuth();

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      unsubscribeForeground();
    };
  });

  /**
   * Tries a restore key while the sign-in button is held busy, then either goes where a sign-in goes
   * or hands the form back - with the sentence of a refusal that has one (erasure, maintenance).
   */
  async function tryRestore() {
    isLoggingIn = true;
    busyLabel = m.auth_restore_in_progress();
    try {
      const attempt = await attemptRestore();
      if (attempt.outcome === 'restored') {
        console.debug('[LOGIN] session restored, leaving /login');
        await gotoAppPath(getSafeReturnTarget(), { replace: true }).catch((err: unknown) =>
          console.error('[LOGIN] session restored, but leaving /login failed:', err)
        );
        return;
      }
      if (attempt.outcome === 'refused' && attempt.shown) loginError = attempt.shown;
      isLoggingIn = false;
    } finally {
      busyLabel = null;
    }
  }

  // ─── Event handlers ────────────────────────────────────────────────────────
  /**
   * Runs the pre-flight both login buttons owe: clear the last error, hold the form busy, and
   * refuse a login the server would reject for an outdated client.
   *
   * The busy flag is raised BEFORE the version check on purpose. `refreshAppVersionCheck()` carries
   * its own retry ladder (3 x 8 s timeouts plus backoff), and raising the flag after it left that
   * whole window with the button enabled and no spinner: a press looked ignored, and pressing again
   * was the only visible move. The disabled state and the spinner already exist in `LoginForm` -
   * they were simply switched on too late.
   *
   * @returns `true` when the caller may start the OIDC flow, `false` when it must not.
   */
  async function beginLoginAttempt(): Promise<boolean> {
    console.debug('[LOGIN] Attempt starting, checking client version.');
    loginError = '';
    isLoggingIn = true;
    await refreshAppVersionCheck();
    if (isBelowMinClientVersion()) {
      console.debug('[LOGIN] Refused: client below minClientVersion.');
      loginError = m.auth_update_required({ version: platformInfo?.minClientVersion ?? '?' });
      isLoggingIn = false;
      return false;
    }
    return true;
  }

  /**
   * Reports a login that never reached Authentik, and hands the form back to the user.
   *
   * The card carries a GENERIC line and the console carries the exception. `startOidcLogin` fails
   * before any response exists - a discovery document that would not parse, a redirect the engine
   * refused - so there is no status to describe and nothing localized to show: its message is dev
   * prose in English, and this is the most exposed card in the application, read by someone who is
   * not signed in and has no way past it.
   */
  function failLoginAttempt(e: unknown) {
    console.warn(`[LOGIN] OIDC start failed: ${String(e)}`);
    loginError = m.auth_login_start_failed();
    isLoggingIn = false;
  }

  async function handleLogin() {
    if (!(await beginLoginAttempt())) return;
    try {
      // Awaited: `startOidcLogin` is async, and an unawaited rejection would escape this `catch`
      // and leave the form busy for ever.
      await startOidcLogin(getSafeReturnTarget());
      // The browser navigates to Authentik - no need to reset isLoggingIn.
    } catch (e: unknown) {
      failLoginAttempt(e);
    }
  }

  async function handlePasswordLogin() {
    if (!(await beginLoginAttempt())) return;
    try {
      await startOidcLogin(getSafeReturnTarget(), { flowSlug: PASSWORD_LOGIN_FLOW_SLUG });
    } catch (e: unknown) {
      failLoginAttempt(e);
    }
  }

  // A native install already IS the app; only a phone-sized web visitor is offered a store.
  $effect(() => {
    if (isTauriRuntime()) {
      showStoreBadges = false;
      openInAppHref = null;
      return;
    }
    openInAppHref =
      loginOpenInAppOffer(window.location.href, navigator.userAgent)?.openHref ?? null;
    showStoreBadges = isPhoneViewport();
    return onViewportChange(PHONE_VIEWPORT_QUERY, (narrow) => {
      showStoreBadges = narrow;
    });
  });
</script>

<LoginForm
  {isLoggingIn}
  {busyLabel}
  {loginError}
  {biometricAvailable}
  {maintenanceNotice}
  {loginDisabled}
  {showStoreBadges}
  {openInAppHref}
  onLogin={handleLogin}
  onPasswordLogin={handlePasswordLogin}
/>
