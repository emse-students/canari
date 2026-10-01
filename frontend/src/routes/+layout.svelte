<script lang="ts">
  import '../app.css';
  import { DEFAULT_PUBLIC_APP_ORIGIN } from '$lib/utils/publicAppUrl';
  import {
    afterNavigate,
    beforeNavigate,
    goto,
    onNavigate,
    preloadCode,
    preloadData,
  } from '$app/navigation';
  import { onMount, tick } from 'svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import TabFollowerBanner from '$lib/components/chat/TabFollowerBanner.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import MobileHeader from '$lib/components/navigation/MobileHeader.svelte';
  import AppSidebar from '$lib/components/navigation/AppSidebar.svelte';
  import BottomNav from '$lib/components/navigation/BottomNav.svelte';
  import NativeTabBar, { nativeTabBar } from '$lib/components/navigation/NativeTabBar.svelte';
  import { screenCover } from '$lib/actions/coversScreen.svelte';
  import { isIosTauriRuntime } from '$lib/utils/appVersion';
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
  import OpenInAppBanner from '$lib/components/shared/OpenInAppBanner.svelte';
  import { getKeyboardViewport, initKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
  import {
    classifySwipeRelease,
    createSwipeNavGestureState,
    isSwipeNavActive,
    isSwipeNavArmed,
    isSwipeNavViewport,
    shouldIgnoreSwipeTarget,
    swipeDragResistancePx,
    transformTranslateXPx,
    swipeNavSlideOriginPx,
    swipeNavTargetHref,
    swipeNavTransitionMs,
    updateSwipeNavGesture,
    type SwipeNavDirection,
    type SwipeNavGestureState,
  } from '$lib/utils/swipeNavigation';
  import { hasActiveTextSelection, onTextSelectionActive } from '$lib/utils/textSelection';
  import { onViewportChange, SWIPE_NAV_QUERY } from '$lib/utils/viewport';

  import { globalSession, globalConvs } from '$lib/stores/globalChatSingleton.svelte';
  import { startPushService } from '$lib/services/PushNotificationService';
  import { setTabUnread, startTabIndicator } from '$lib/stores/tabIndicator';
  import { totalUnreadMessages } from '$lib/utils/unreadTotal';
  import SeoHead from '$lib/components/seo/SeoHead.svelte';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import { purgeRetiredAvatarCache } from '$lib/utils/userAvatarCache';
  import { publishTextZoom } from '$lib/utils/textZoom';
  import { m } from '$lib/paraglide/messages';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  /** Read once: the platform does not change under a running app. */
  const isIosApp = isIosTauriRuntime();
  // No app chrome on a page a visitor without an account reads: login, the legal pages, and a
  // public form's guest page (`/f/`), whose sidebar and tabs would all lead to a login screen.
  const isLoginPage = $derived(
    pathname === '/login' || pathname.startsWith('/legal') || pathname.startsWith('/f/')
  );

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
    publishTextZoom();

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
      const height = Math.ceil(column.offsetHeight);
      document.documentElement.style.setProperty('--app-banner-height', `${height}px`);
      // The phone header paints the status strip above it only while nothing sits between them.
      document.documentElement.toggleAttribute('data-banner-up', height > 0);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(column);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--app-banner-height');
      document.documentElement.removeAttribute('data-banner-up');
    };
  });

  // ── Swipe navigation (mobile only) ────────────────────────────────────────
  let appShell = $state<HTMLDivElement | null>(null);
  let pageScrollWrap = $state<HTMLDivElement | null>(null);
  let swipeGesture = $state<SwipeNavGestureState | null>(null);
  let swipeEnterClass = '';

  /**
   * THE RELEASE HANDS THIS TO `onNavigate`, AND IT IS THE ONLY THING THAT TELLS A SWIPE FROM A TAP
   * ON THE BOTTOM BAR. Both reach the router through `goto`, and only the swipe may take over the
   * navigation's rendering; a tab tapped in the nav must still swap instantly. Plain `let`, not
   * `$state`: nothing renders from it, it is read once by the hook it was written for and cleared
   * there, and a reactive read would tie the hook to a render it does not run inside.
   */
  let swipeNavSlide: { direction: SwipeNavDirection } | null = null;

  /**
   * The neighbour asked for as soon as the gesture locks horizontal, so the page has its data by
   * the time the finger lets go - one `preloadData` per destination per gesture, which is what
   * makes the `goto` below resolve inside the same animation instead of after it.
   */
  let swipeNavPreloadedHref: string | null = null;

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

  // BOTH NEIGHBOURS' CODE IS FETCHED ON ARRIVAL, not at the horizontal lock. A fast swipe locks and
  // releases inside ~100ms, and the route's JS imported in that window was part of what the finger
  // waited on at the middle of the screen (user, 2026-09-30: "the sudden stop at the middle when
  // swiping fast"). Code only: data is a network call on some tabs (`/posts` lists the feed) and
  // SvelteKit caches one preload, so two neighbours would evict each other - data stays on the lock.
  $effect(() => {
    if (!swipeNavArmed) return;
    for (const direction of ['next', 'prev'] as const) {
      const href = swipeNavTargetHref(pathname, direction);
      if (href) {
        void preloadCode(href).catch((err) =>
          console.warn('[SwipeNav] code preload failed:', href, err)
        );
      }
    }
  });

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
      'swipe-nav-capture-out',
      'swipe-nav-capture-in',
      'swipe-nav-enter-left',
      'swipe-nav-enter-right'
    );
  }

  /**
   * A SELECTION IN PROGRESS ABANDONS AN ENGAGED SWIPE - IT DOES NOT PAUSE IT. The finger now belongs
   * to the selection (`textSelection.ts` says why), so the page snaps back and the gesture is
   * `ignored` for the rest of the touch: its release can no longer navigate.
   */
  function abandonSwipeForSelection() {
    if (!swipeGesture || swipeGesture.phase === 'ignored') return;
    console.debug('[SwipeNav] abandoned: a text selection took the touch');
    swipeGesture = { startX: 0, startY: 0, startedAt: 0, phase: 'ignored', dragPx: 0 };
    pageScrollWrap?.classList.remove('swipe-nav-dragging');
    snapSwipeBack();
  }

  function handleTouchStart(e: TouchEvent) {
    if (!isSwipeNavActive(swipeNavContext())) return;
    if (shouldIgnoreSwipeTarget(e.target) || hasActiveTextSelection()) {
      swipeGesture = { startX: 0, startY: 0, startedAt: 0, phase: 'ignored', dragPx: 0 };
      return;
    }
    swipeNavPreloadedHref = null;
    swipeGesture = createSwipeNavGestureState(
      e.touches[0].clientX,
      e.touches[0].clientY,
      performance.now()
    );
  }

  function handleTouchMove(e: TouchEvent) {
    if (!swipeGesture || swipeGesture.phase === 'ignored' || !pageScrollWrap) return;
    if (!isSwipeNavActive(swipeNavContext())) return;
    if (hasActiveTextSelection()) {
      abandonSwipeForSelection();
      return;
    }

    const updated = updateSwipeNavGesture(swipeGesture, e.touches[0].clientX, e.touches[0].clientY);
    swipeGesture = updated;

    if (updated.phase !== 'horizontal') return;

    e.preventDefault();
    const canNext = swipeNavTargetHref(pathname, 'next') !== null;
    const canPrev = swipeNavTargetHref(pathname, 'prev') !== null;
    const offset = swipeDragResistancePx(updated.dragPx, null, canNext, canPrev);
    pageScrollWrap.classList.add('swipe-nav-dragging');
    pageScrollWrap.style.transform = `translate3d(${offset}px, 0, 0)`;

    // THE DESTINATION IS FETCHED WHILE THE FINGER IS STILL DOWN. Without this the release waited on
    // a cold `goto`, and the only way to hide that wait was to spend it animating the OLD page off
    // screen first - which is why the two pages were never on screen together. The direction can
    // still flip under the finger, so the preload follows the current sign rather than the release.
    const previewHref = swipeNavTargetHref(pathname, updated.dragPx < 0 ? 'next' : 'prev');
    if (previewHref && previewHref !== swipeNavPreloadedHref) {
      swipeNavPreloadedHref = previewHref;
      void preloadData(previewHref).catch((err) =>
        // Best-effort only: a failed preload costs the release its head start and nothing else, so
        // it is logged rather than surfaced - but it IS logged, because silence here reads exactly
        // like a slow network.
        console.warn('[SwipeNav] preload failed:', previewHref, err)
      );
    }
  }

  function snapSwipeBack() {
    if (!pageScrollWrap) return;
    pageScrollWrap.style.transition = `transform ${swipeNavTransitionMs}ms ease-out`;
    pageScrollWrap.style.transform = 'translate3d(0, 0, 0)';
    window.setTimeout(() => clearSwipeTransform(pageScrollWrap), swipeNavTransitionMs);
  }

  /**
   * THE RELEASE NAVIGATES IMMEDIATELY, AND THE PAGE IT LEAVES IS NO LONGER WAITED FOR.
   *
   * It used to slide the outgoing page fully off screen, sleep the full 220ms, THEN `goto`, THEN
   * animate the new page in from 28% - two animations back to back over an empty background, 440ms
   * in which the destination was never once visible. That is the whole of what a reader feels as
   * "the next page does not come" (user, 2026-09-29): nothing was wrong with the gesture, the two
   * pages simply never existed at the same time.
   *
   * `onNavigate` below is what puts them there. All this function does is keep the page moving
   * the way it was going, record which way, and hand the router the destination it already
   * preloaded - `onNavigate` reads how far the page has got when it takes over.
   */
  function commitSwipeNav(direction: SwipeNavDirection) {
    const href = swipeNavTargetHref(pathname, direction);
    if (!href || !pageScrollWrap) {
      snapSwipeBack();
      return;
    }

    // THE PAGE KEEPS MOVING WHILE THE ROUTER GETS READY. It used to hold the release position until
    // `onNavigate` - a still frame in the middle of a fast throw, for as long as the destination's
    // load took (user, 2026-09-30). It now carries on towards the edge at the transition's own pace;
    // `onNavigate` reads where it has got to and the view transition takes over from THERE, so the
    // strip never stops. The inline transform is what the snapshot captures, so it is not cleared.
    const width = window.innerWidth;
    pageScrollWrap.style.transition = `transform ${swipeNavTransitionMs}ms ease-out`;
    pageScrollWrap.style.transform = `translate3d(${direction === 'next' ? -width : width}px, 0, 0)`;
    swipeNavSlide = { direction };
    void goto(href).catch((err) => {
      console.error('[SwipeNav] navigation failed:', href, err);
      swipeNavSlide = null;
      snapSwipeBack();
    });
  }

  /**
   * THE TWO PAGES ON SCREEN AT ONCE, which is the one thing a single-page-at-a-time router cannot
   * give by itself: SvelteKit mounts exactly one route, so the outgoing page has to be a PICTURE of
   * itself while the incoming one takes its place. That is what a view transition is.
   *
   * The name is swapped between the two captures - `swipe-nav-capture-out` before, `-in` inside the
   * update callback - so the old and new snapshots land in SEPARATE groups. Sharing one name is the
   * obvious thing to write and it is wrong: the browser then treats them as the same box moving,
   * morphs the group and cross-fades inside it, and no amount of keyframes on the old and new
   * pseudo-elements makes them slide PAST each other.
   *
   * `::view-transition-old(root)` is hidden rather than animated (see `app.css`), so the header and
   * the bottom bar adopt the new tab on the first frame while the pages are still sliding - a nav
   * indicator that lagged the page by 220ms would be the same defect in a smaller place.
   *
   * WITHOUT THE API (WebKit before 18) THIS RETURNS AND THE NAVIGATION IS ORDINARY. That is a
   * capability branch, not a fallback: there is no second implementation of the transition to keep
   * correct, the destination is reached by exactly the same `goto` either way, and what the reader
   * loses is the slide - `afterNavigate` still plays the entrance the app had before.
   */
  onNavigate((navigation) => {
    const slide = swipeNavSlide;
    swipeNavSlide = null;
    if (!slide) return;

    const wrap = pageScrollWrap;
    const startViewTransition = document.startViewTransition?.bind(document);
    if (!wrap || !startViewTransition) {
      // The drag transform is cleared here: nothing captures it on this path, and left in place it
      // would shift the NEW page by the drag distance once the entrance animation ended.
      clearSwipeTransform(wrap);
      swipeEnterClass =
        slide.direction === 'next' ? 'swipe-nav-enter-right' : 'swipe-nav-enter-left';
      return;
    }

    // Where the page has got to since the release - it has been moving (`commitSwipeNav`) - frozen
    // there so the snapshot and `--swipe-nav-from` agree, and the slide continues from that point.
    const travelled = transformTranslateXPx(getComputedStyle(wrap).transform);
    wrap.style.transition = 'none';
    wrap.style.transform = `translate3d(${slide.direction === 'next' ? -travelled : travelled}px, 0, 0)`;
    const root = document.documentElement;
    root.style.setProperty('--swipe-nav-from', `${swipeNavSlideOriginPx(travelled)}px`);
    root.dataset.swipeNav = slide.direction;
    wrap.classList.add('swipe-nav-capture-out');

    return new Promise<void>((resolve) => {
      const transition = startViewTransition(async () => {
        // The old snapshot is taken before this callback runs, so the drag transform has served its
        // purpose and the incoming page must be captured square.
        clearSwipeTransform(wrap);
        wrap.classList.add('swipe-nav-capture-in');
        resolve();
        await navigation.complete;
      });

      void transition.finished
        .catch((err) => console.warn('[SwipeNav] view transition interrupted:', err))
        .finally(() => {
          root.style.removeProperty('--swipe-nav-from');
          delete root.dataset.swipeNav;
          wrap.classList.remove('swipe-nav-capture-out', 'swipe-nav-capture-in');
        });
    });
  });

  function handleTouchEnd(e: TouchEvent) {
    if (!swipeGesture || swipeGesture.phase === 'ignored') {
      swipeGesture = null;
      return;
    }

    const dx = e.changedTouches[0].clientX - swipeGesture.startX;
    const dy = e.changedTouches[0].clientY - swipeGesture.startY;
    const direction = classifySwipeRelease(
      dx,
      dy,
      swipeGesture.phase,
      performance.now() - swipeGesture.startedAt
    );
    swipeGesture = null;

    if (!pageScrollWrap) return;
    pageScrollWrap.classList.remove('swipe-nav-dragging');

    if (!isSwipeNavActive(swipeNavContext()) || !direction) {
      snapSwipeBack();
      return;
    }

    commitSwipeNav(direction);
  }

  function handleTouchCancel() {
    swipeGesture = null;
    snapSwipeBack();
  }

  /**
   * The entrance the app keeps where view transitions do not exist, played from `afterNavigate`
   * rather than from an effect keyed on the pathname. The effect it replaces fired the moment
   * `swipeEnterClass` was written - which `onNavigate` does BEFORE the route changes, so the class
   * landed on the page being left and had to be re-added when the path caught up.
   */
  afterNavigate(() => {
    if (!swipeEnterClass || !pageScrollWrap) return;
    const cls = swipeEnterClass;
    const wrap = pageScrollWrap;
    swipeEnterClass = '';
    wrap.classList.add(cls);
    window.setTimeout(() => wrap.classList.remove(cls), swipeNavTransitionMs);
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
    const stopSelectionWatch = onTextSelectionActive(abandonSwipeForSelection);

    return () => {
      stopSelectionWatch();
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
  class="app-shell flex h-(--app-viewport-height,100dvh) w-screen flex-col overflow-hidden pt-(--safe-area-inset-top) pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
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
    <!-- Only inside the browser built into Messenger, Facebook or Instagram; it decides itself. -->
    <OpenInAppBanner />
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
          class="page-scroll-wrap absolute inset-0 overflow-y-auto pb-(--bottom-nav-reserve) md:pb-0"
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

      <!-- THE iOS APP DRAWS THE BAR NATIVELY (Liquid Glass on iOS 26) and hands the bottom back to
           the web bar only if the native one could not be configured - which it says at error
           level. Both obey the same rule, passed to the native bar as `visible`. -->
      {#if isIosApp && nativeTabBar.status !== 'failed'}
        <!-- Mounted outside the login page only: configuring it there would draw it for a frame
             before `visible` hid it. The keyboard and an open conversation hide it without
             unmounting, because a reconfiguration per keystroke would be a native round trip each.
             So does anything that covers the screen (`coversScreen`): a native bar is drawn ABOVE
             the WebView, so no modal can paint over it the way it paints over the web bar. -->
        {#if !isLoginPage}
          <NativeTabBar visible={!isKeyboardOpen && !isMobileConvoOpen && !screenCover.covered} />
        {/if}
      {:else if !isKeyboardOpen && !isLoginPage && !isMobileConvoOpen}
        <BottomNav />
      {/if}
    </div>
  </div>

  <ToastContainer />
  <ConfirmDialog />
  <AnnouncementModal />
</div>
