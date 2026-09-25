<script lang="ts">
  import '../app.css';
  import { DEFAULT_PUBLIC_APP_ORIGIN } from '$lib/utils/publicAppUrl';
  import { beforeNavigate, goto } from '$app/navigation';
  import { onMount, tick } from 'svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import TabFollowerBanner from '$lib/components/chat/TabFollowerBanner.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import MobileHeader from '$lib/components/navigation/MobileHeader.svelte';
  import AppSidebar from '$lib/components/navigation/AppSidebar.svelte';
  import BottomNav from '$lib/components/navigation/BottomNav.svelte';
  import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
  import AnnouncementModal from '$lib/components/shared/AnnouncementModal.svelte';
  import { page } from '$app/state';
  import {
    initHistoryOverlayStack,
    drainHistoryOverlayStack,
  } from '$lib/utils/historyOverlayStack';
  import {
    refreshAppVersionCheck,
    getAppVersionCheck,
    isBelowMinClientVersion,
  } from '$lib/stores/appVersionCheck.svelte';
  import PlatformGateOverlay from '$lib/components/shared/PlatformGateOverlay.svelte';
  import EnvironmentBanner from '$lib/components/shared/EnvironmentBanner.svelte';
  import MaintenanceAdminBanner from '$lib/components/shared/MaintenanceAdminBanner.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import MlsFatalErrorBanner from '$lib/components/shared/MlsFatalErrorBanner.svelte';
  import OfflineBanner from '$lib/components/shared/OfflineBanner.svelte';
  import { getKeyboardViewport, initKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
  import {
    classifySwipeRelease,
    createSwipeNavGestureState,
    isSwipeNavActive,
    isSwipeNavArmed,
    isSwipeNavViewport,
    shouldIgnoreSwipeTarget,
    swipeDragResistancePx,
    swipeNavTargetHref,
    swipeNavTransitionMs,
    updateSwipeNavGesture,
    type SwipeNavDirection,
    type SwipeNavGestureState,
  } from '$lib/utils/swipeNavigation';
  import { onViewportChange, SWIPE_NAV_QUERY } from '$lib/utils/viewport';

  import { globalSession, globalConvs } from '$lib/stores/globalChatSingleton.svelte';
  import { startPushService } from '$lib/services/PushNotificationService';
  import { setTabUnread, startTabIndicator } from '$lib/stores/tabIndicator';
  import { totalUnreadMessages } from '$lib/utils/unreadTotal';
  import SeoHead from '$lib/components/seo/SeoHead.svelte';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { purgeRetiredAvatarCache } from '$lib/utils/userAvatarCache';
  import { m } from '$lib/paraglide/messages';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isLoginPage = $derived(pathname === '/login' || pathname.startsWith('/legal'));

  const showMaintenanceAdminBanner = $derived.by(() => {
    const info = getAppVersionCheck();
    return !isBelowMinClientVersion() && info?.maintenance.enabled === true && isGlobalAdmin();
  });

  // Hide BottomNav and remove its padding from the composer when a conversation
  // is open on mobile (only relevant on the chat / communities routes).
  const isMobileConvoOpen = $derived(
    (pathname === '/chat' || pathname === '/communities') && globalConvs.mobileView === 'chat'
  );

  $effect(() => {
    document.documentElement.classList.toggle('mobile-convo-open', isMobileConvoOpen);
    return () => document.documentElement.classList.remove('mobile-convo-open');
  });

  const keyboardViewport = $derived(getKeyboardViewport());
  const isKeyboardOpen = $derived(keyboardViewport.isOpen);

  beforeNavigate(({ from, to }) => {
    drainHistoryOverlayStack();
    const fromPath = from?.url.pathname ?? '';
    const toPath = to?.url.pathname ?? '';
    const leavingMessaging = fromPath === '/chat' || fromPath === '/communities';
    const enteringMessaging = toPath === '/chat' || toPath === '/communities';
    if (leavingMessaging && enteringMessaging && fromPath !== toPath) {
      globalConvs.selectedContact = null;
      globalConvs.sendError = '';
    }
  });

  onMount(() => {
    themeStore.init();
    startTabIndicator();

    // Dismiss the inline splash screen (see app.html) once the first frame is rendered.
    // tick() ensures SvelteKit has completed its initial render before we fade out.
    void tick().then(() => {
      const splash = document.getElementById('canari-splash');
      if (splash) {
        splash.classList.add('done');
        setTimeout(() => splash.remove(), 450);
      }
    });

    const teardownHistory = initHistoryOverlayStack();
    const teardownKeyboard = initKeyboardViewport();

    // Reclaim the avatar bucket this client no longer writes. Idempotent, and free once it is gone.
    void purgeRetiredAvatarCache();

    // Redirect console.log/warn/error to tauri-plugin-log → adb logcat on Android.
    // Dynamic import prevents @tauri-apps/plugin-log from being bundled in the Web build.
    if (isTauriRuntime()) {
      import('@tauri-apps/plugin-log').then(({ attachConsole }) => attachConsole()).catch(() => {});
    }

    const onVersionCheckTrigger = () => void refreshAppVersionCheck();
    void refreshAppVersionCheck();
    window.addEventListener('focus', onVersionCheckTrigger);
    window.addEventListener('online', onVersionCheckTrigger);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshAppVersionCheck();
    });

    return () => {
      teardownHistory();
      teardownKeyboard();
      window.removeEventListener('focus', onVersionCheckTrigger);
      window.removeEventListener('online', onVersionCheckTrigger);
    };
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('keyboard-open', isKeyboardOpen);
  });

  // ── The unread signal a backgrounded tab has without a permission ────────────────
  // Unconditional on purpose. The web `Notification` is the only other out-of-page signal and it
  // needs a permission the browser spends the FIRST message asking for, so a user who declines had
  // nothing at all. The title and the icon ask nobody. Logged-out means no conversations to count,
  // never a stale badge left over from the last session.
  $effect(() => {
    setTabUnread(
      globalSession.isLoggedIn ? totalUnreadMessages(globalConvs.conversations.values()) : 0
    );
  });

  // ── Push notification init ───────────────────────────────────────────────────
  $effect(() => {
    // Wait until the session is fully established (logged in + user info + token present).
    if (globalSession.isLoggedIn && globalSession.userId && globalSession.authToken) {
      // Small delay lets the Android Activity bind to the UI before the native permission prompt.
      const timer = setTimeout(() => {
        startPushService(
          globalSession.historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN,
          globalSession.authToken,
          globalSession.myDeviceId
        ).catch((err) => console.error('[Push] Init error:', err));
      }, 500);

      return () => clearTimeout(timer);
    }
  });

  // -- The banner column's height, published so the floating cards can follow it ------------
  let bannerColumn = $state<HTMLDivElement | null>(null);

  /**
   * Publishes the banner column's measured height as `--app-banner-height`, which `app.css` folds
   * into `--app-content-top` - the single expression the nav rail, its hover scrim, the right-hand
   * drawers and the side panels all position against.
   *
   * WHY IT IS MEASURED AND NOT COUNTED. Every one of those cards is `position: fixed` against the
   * window, so none of them can see that a banner has pushed the brand bar down; and the height to
   * push them by is not derivable - it depends on how many banners are up, on how the text wrapped,
   * and on the viewport width. A constant per banner would be a fourth copy of a number that has
   * already drifted five ways. The observer answers with the height that is actually on screen.
   */
  $effect(() => {
    const column = bannerColumn;
    if (!column) return;
    const publish = () => {
      document.documentElement.style.setProperty(
        '--app-banner-height',
        `${Math.ceil(column.offsetHeight)}px`
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(column);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--app-banner-height');
    };
  });

  // ── Swipe navigation (mobile only) ────────────────────────────────────────
  let appShell = $state<HTMLDivElement | null>(null);
  let pageScrollWrap = $state<HTMLDivElement | null>(null);
  let swipeGesture = $state<SwipeNavGestureState | null>(null);
  let swipeEnterClass = $state('');

  /**
   * The viewport half of arming, held as STATE because a `matchMedia` read answers once and never
   * again. The same shape `ChatArea` and `ChatComposer` already use for their own question.
   */
  let swipeNavViewport = $state(false);
  $effect(() => {
    swipeNavViewport = isSwipeNavViewport();
    return onViewportChange(SWIPE_NAV_QUERY, (matches) => {
      swipeNavViewport = matches;
    });
  });

  /** Whether this screen can swipe at all - `isSwipeNavArmed` owns the reasoning. */
  const swipeNavArmed = $derived(isSwipeNavArmed(pathname, swipeNavViewport));

  function swipeNavContext() {
    return {
      pathname,
      mobileConvoOpen: isMobileConvoOpen,
      keyboardOpen: isKeyboardOpen,
    };
  }

  function clearSwipeTransform(el: HTMLDivElement | null) {
    if (!el) return;
    el.style.removeProperty('transform');
    el.style.removeProperty('transition');
    el.classList.remove(
      'swipe-nav-dragging',
      'swipe-nav-exit-left',
      'swipe-nav-exit-right',
      'swipe-nav-enter-left',
      'swipe-nav-enter-right'
    );
  }

  function handleTouchStart(e: TouchEvent) {
    if (!isSwipeNavActive(swipeNavContext())) return;
    if (shouldIgnoreSwipeTarget(e.target)) {
      swipeGesture = { startX: 0, startY: 0, phase: 'ignored', dragPx: 0 };
      return;
    }
    swipeGesture = createSwipeNavGestureState(e.touches[0].clientX, e.touches[0].clientY);
  }

  function handleTouchMove(e: TouchEvent) {
    if (!swipeGesture || swipeGesture.phase === 'ignored' || !pageScrollWrap) return;
    if (!isSwipeNavActive(swipeNavContext())) return;

    const updated = updateSwipeNavGesture(swipeGesture, e.touches[0].clientX, e.touches[0].clientY);
    swipeGesture = updated;

    if (updated.phase !== 'horizontal') return;

    e.preventDefault();
    const canNext = swipeNavTargetHref(pathname, 'next') !== null;
    const canPrev = swipeNavTargetHref(pathname, 'prev') !== null;
    const offset = swipeDragResistancePx(updated.dragPx, null, canNext, canPrev);
    pageScrollWrap.classList.add('swipe-nav-dragging');
    pageScrollWrap.style.transform = `translate3d(${offset}px, 0, 0)`;
  }

  function snapSwipeBack() {
    if (!pageScrollWrap) return;
    pageScrollWrap.style.transition = `transform ${swipeNavTransitionMs}ms ease-out`;
    pageScrollWrap.style.transform = 'translate3d(0, 0, 0)';
    window.setTimeout(() => clearSwipeTransform(pageScrollWrap), swipeNavTransitionMs);
  }

  async function commitSwipeNav(direction: SwipeNavDirection) {
    const href = swipeNavTargetHref(pathname, direction);
    if (!href || !pageScrollWrap) {
      snapSwipeBack();
      return;
    }

    const width = pageScrollWrap.offsetWidth || window.innerWidth;
    const exitX = direction === 'next' ? -width : width;

    pageScrollWrap.classList.remove('swipe-nav-dragging');
    pageScrollWrap.style.transition = `transform ${swipeNavTransitionMs}ms ease-out`;
    pageScrollWrap.style.transform = `translate3d(${exitX}px, 0, 0)`;

    await new Promise((r) => setTimeout(r, swipeNavTransitionMs));

    await goto(href);

    if (!pageScrollWrap) return;
    clearSwipeTransform(pageScrollWrap);
    swipeEnterClass = direction === 'next' ? 'swipe-nav-enter-right' : 'swipe-nav-enter-left';
  }

  function handleTouchEnd(e: TouchEvent) {
    if (!swipeGesture || swipeGesture.phase === 'ignored') {
      swipeGesture = null;
      return;
    }

    const dx = e.changedTouches[0].clientX - swipeGesture.startX;
    const dy = e.changedTouches[0].clientY - swipeGesture.startY;
    const direction = classifySwipeRelease(dx, dy, swipeGesture.phase);
    swipeGesture = null;

    if (!pageScrollWrap) return;
    pageScrollWrap.classList.remove('swipe-nav-dragging');

    if (!isSwipeNavActive(swipeNavContext()) || !direction) {
      snapSwipeBack();
      return;
    }

    void commitSwipeNav(direction);
  }

  function handleTouchCancel() {
    swipeGesture = null;
    snapSwipeBack();
  }

  $effect(() => {
    void pathname;
    if (!swipeEnterClass || !pageScrollWrap) return;
    const cls = swipeEnterClass;
    pageScrollWrap.classList.add(cls);
    const timer = window.setTimeout(() => {
      pageScrollWrap?.classList.remove(cls);
      swipeEnterClass = '';
    }, swipeNavTransitionMs);
    return () => window.clearTimeout(timer);
  });

  /**
   * THE GESTURE'S LISTENERS EXIST ONLY WHERE THE GESTURE DOES.
   *
   * `touchmove` must be non-passive so the horizontal lock can `preventDefault`. `touchstart`
   * decides nothing the engine has to wait for, so it is passive - which it was not: an element
   * handler (`ontouchstart={...}`) is non-passive like any other, and a non-passive `touchstart` on
   * the shell stops a scroll from STARTING as surely as a `touchmove` stops it from continuing.
   * Both were bound on every route and every platform; see `isSwipeNavArmed`.
   *
   * The effect tracks `appShell` and `swipeNavArmed` and nothing else. The handlers re-ask
   * `isSwipeNavActive` themselves - that is the fine half of the question and it cannot be
   * answered from a render.
   */
  $effect(() => {
    const node = appShell;
    if (!node || !swipeNavArmed) return;

    node.addEventListener('touchstart', handleTouchStart, { passive: true });
    node.addEventListener('touchmove', handleTouchMove, { passive: false });
    node.addEventListener('touchend', handleTouchEnd, { passive: true });
    node.addEventListener('touchcancel', handleTouchCancel, { passive: true });

    return () => {
      node.removeEventListener('touchstart', handleTouchStart);
      node.removeEventListener('touchmove', handleTouchMove);
      node.removeEventListener('touchend', handleTouchEnd);
      node.removeEventListener('touchcancel', handleTouchCancel);
      // DISARMING MID-GESTURE NEVER SEES ITS `touchend`, so the state that handler would have
      // cleared is cleared here instead - otherwise a rotation, or a keyboard opening under the
      // finger, leaves the wrapper parked at whatever `translate3d` the last move wrote with no
      // gesture left to snap it back.
      swipeGesture = null;
      clearSwipeTransform(pageScrollWrap);
    };
  });
</script>

<SeoHead />

<a href="#main-content" class="skip-link">{m.layout_skip_to_content()}</a>

<PlatformGateOverlay />

<!-- The swipe gesture's touch listeners are bound to this node in script, and only on a screen that
     can swipe - see the effect above. They are deliberately NOT `ontouch*` attributes: those bind
     unconditionally and non-passively, which is what cost every scroll in the app its compositor. -->
<div
  bind:this={appShell}
  class="flex h-(--app-viewport-height,100dvh) w-screen flex-col overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
>
  <!-- ONE COLUMN FOR THE WINDOW-SCALE BANNERS. Both of these used to place themselves - `fixed top-0`
       at 120 and `fixed top-safe-area` at 50 - so when both were up the maintenance notice simply
       painted over the fatal MLS error, hiding the only message that says the messaging stack is
       dead. Stacked in one flex column they queue instead, which is the lesson `ChatArea` had already
       learnt for the conversation-scale pair. The column takes the `--z-banner` rung of the layer
       ladder in `app.css`; a sheet the reader opened sits above it, deliberately.

       AND IT IS IN FLOW, WHICH IS THE HALF THAT WAS MISSING. The column was `fixed`, so it reserved
       nothing and simply painted over whatever the top of the page happened to be - exactly the
       defect `.mobile-nav-inset` in `app.css` records for the BottomNav at the other edge ("it
       reserves nothing for itself, so whatever it covers is covered for good"). The thing it covered
       is the app header, which is `sticky top-0` and therefore lands in the same band: measured on
       dev 2026-09-14 at 1440px the banner was 44px tall and hid the header's top 44px, logo
       included; at 390px it was 84px tall and hid the whole 56px mobile header, so the phone showed
       no top bar at all. A row in the shell's own column cannot overlap it, at any width and for any
       number of banners, with nothing measured and no variable to keep in step. -->
  <div bind:this={bannerColumn} class="z-(--z-banner) flex shrink-0 flex-col">
    <!-- FIRST, and it decides for itself whether to render. The others come and go; this one is a
         property of the whole deployment, so a transient notice must not push it off screen. -->
    <EnvironmentBanner />
    {#if showMaintenanceAdminBanner}
      <MaintenanceAdminBanner />
    {/if}
    <MlsFatalErrorBanner />
    <!-- THE LAST TWO JOINED THE COLUMN ON 2026-09-22, and they are the reason it publishes its
         height. Both were rendered inside the CONTENT column instead, under a comment claiming
         "pleine largeur, jamais dans la rangee sidebar" - which is the one thing that placement
         cannot give them, because that column reserves the rail's 6rem gutter. Measured locally in
         a second tab of one account: the follower banner sat 108px from the left edge and 12px
         from the right, and it displaced the brand bar 50px down INTO the rail, which is fixed to
         the window and does not move - so the bar's subtitle was clipped by the rail's card.
         Strong first, then the two subtle ones: an interrupting fact is never pushed off by a
         transient. -->
    <TabFollowerBanner />
    <OfflineBanner />
  </div>

  <!-- THE ROW THAT WAS THE SHELL. It takes what the banners leave, so the height chain
       `app.css` documents above `.app-layout` still subtracts the status-bar inset exactly once -
       the wrapper above owns `h-(--app-viewport-height,100dvh)` and its padding, and this only ever
       divides what is left. `min-h-0` because a flex child's default `min-height:auto` refuses to
       shrink below its content, which is what turns an overflowing chat list into a page scroll. -->
  <div class="flex min-h-0 w-full flex-1">
    <svelte:boundary onerror={(e) => console.error('[ChatBackgroundService] crash recovered:', e)}>
      <ChatBackgroundService />
    </svelte:boundary>

    <!-- Sidebar (navigation principale) -->
    {#if !isLoginPage}
      <AppSidebar />
    {/if}

    <!--
      THE GUTTER IS DECIDED BY THE SAME PREDICATE AS THE SIDEBAR IT MAKES ROOM FOR. It was a constant
      `md:pl-[6rem]` while `AppSidebar` above was already conditional, so `/login` and `/legal/*`
      reserved 96px for a bar they do not render: the card centred 48px right of the viewport, while
      the confirm dialog - portalled to the body and `fixed inset-0` - centred on the real middle, and
      the two disagreed on screen. Measured on production 2026-09-12 at 1280px: card centre 685,
      dialog centre 640. Two independent statements about one fact, with nothing comparing them.
    -->
    <div
      class="relative z-10 flex flex-1 flex-col overflow-hidden {isLoginPage ? '' : 'md:pl-[6rem]'}"
    >
      {#if !isLoginPage && !isKeyboardOpen}
        <Navbar />
        {#if !isMobileConvoOpen}
          <MobileHeader />
        {/if}
      {/if}

      <main id="main-content" class="relative flex-1 overflow-hidden">
        <div
          bind:this={pageScrollWrap}
          class="page-scroll-wrap absolute inset-0 overflow-y-auto pb-[calc(4rem+var(--safe-area-inset-bottom,0px))] md:pb-0"
        >
          <svelte:boundary onerror={(e) => console.error('[Layout] page crash:', e)}>
            {@render children?.()}
            {#snippet failed(_error, reset)}
              <div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
                <p class="text-text-muted text-sm">{m.layout_error_boundary_message()}</p>
                <button
                  type="button"
                  onclick={reset}
                  class="text-cn-ink rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold"
                >
                  {m.common_retry_button()}
                </button>
              </div>
            {/snippet}
          </svelte:boundary>
        </div>
      </main>

      {#if !isKeyboardOpen && !isLoginPage && !isMobileConvoOpen}
        <BottomNav />
      {/if}
    </div>
  </div>

  <ToastContainer />
  <ConfirmDialog />
  <AnnouncementModal />
</div>
