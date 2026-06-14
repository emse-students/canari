<script lang="ts">
  import '../app.css';
  import { beforeNavigate, goto } from '$app/navigation';
  import { onMount, tick } from 'svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import TabFollowerBanner from '$lib/components/chat/TabFollowerBanner.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import MobileHeader from '$lib/components/navigation/MobileHeader.svelte';
  import AppSidebar from '$lib/components/navigation/AppSidebar.svelte';
  import BottomNav from '$lib/components/navigation/BottomNav.svelte';
  import ToastContainer from '$lib/components/ui/ToastContainer.svelte';
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte';
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
  import AppUpdateModal from '$lib/components/shared/AppUpdateModal.svelte';
  import PlatformGateOverlay from '$lib/components/shared/PlatformGateOverlay.svelte';
  import MaintenanceAdminBanner from '$lib/components/shared/MaintenanceAdminBanner.svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import MlsFatalErrorBanner from '$lib/components/shared/MlsFatalErrorBanner.svelte';
  import { getKeyboardViewport, initKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
  import {
    classifySwipeRelease,
    createSwipeNavGestureState,
    isSwipeNavActive,
    shouldIgnoreSwipeTarget,
    swipeDragResistancePx,
    swipeNavTargetHref,
    swipeNavTransitionMs,
    updateSwipeNavGesture,
    type SwipeNavDirection,
    type SwipeNavGestureState,
  } from '$lib/utils/swipeNavigation';

  import { globalSession, globalConvs } from '$lib/stores/globalChatSingleton.svelte';
  import { startPushService } from '$lib/services/PushNotificationService';
  import SeoHead from '$lib/components/seo/SeoHead.svelte';
  import { isTauriRuntime } from '$lib/utils/openExternal';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isLoginPage = $derived(pathname === '/login' || pathname.startsWith('/legal'));

  const showMaintenanceAdminBanner = $derived.by(() => {
    const info = getAppVersionCheck();
    return (
      !isBelowMinClientVersion() &&
      info?.maintenance.enabled === true &&
      isGlobalAdmin()
    );
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

    // Redirect console.log/warn/error to tauri-plugin-log → adb logcat on Android.
    // Dynamic import prevents @tauri-apps/plugin-log from being bundled in the Web build.
    if (isTauriRuntime()) {
      import('@tauri-apps/plugin-log')
        .then(({ attachConsole }) => attachConsole())
        .catch(() => {});
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

  // ── INIT PUSH NOTIFICATIONS (SÉCURISÉ) ─────────────────────────────────────
  $effect(() => {
    // On attend que la session soit totalement valide (connecté + infos présentes)
    if (globalSession.isLoggedIn && globalSession.userId && globalSession.authToken) {
      // On utilise un timeout pour laisser l'Activity Android se lier parfaitement à l'UI
      // avant de faire popper la demande d'autorisation native.
      const timer = setTimeout(() => {
        startPushService(
          globalSession.historyBaseUrl || 'https://canari-emse.fr',
          globalSession.authToken,
          globalSession.myDeviceId
        ).catch((err) => console.error("[Push] Erreur d'initialisation:", err));
      }, 500);

      return () => clearTimeout(timer);
    }
  });

  // ── Swipe navigation (mobile uniquement) ───────────────────────────────────
  let pageScrollWrap = $state<HTMLDivElement | null>(null);
  let swipeGesture = $state<SwipeNavGestureState | null>(null);
  let swipeEnterClass = $state('');

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

  /** `touchmove` must be non-passive so horizontal lock can call `preventDefault`. */
  function swipeNavTouchMove(node: HTMLElement) {
    const onMove = (e: TouchEvent) => handleTouchMove(e);
    node.addEventListener('touchmove', onMove, { passive: false });
    return {
      destroy() {
        node.removeEventListener('touchmove', onMove);
      },
    };
  }
</script>

<SeoHead />

<a href="#main-content" class="skip-link">Aller au contenu principal</a>

<AppUpdateModal />
<PlatformGateOverlay />
{#if showMaintenanceAdminBanner}
  <MaintenanceAdminBanner />
{/if}
<MlsFatalErrorBanner />

<div
  role="presentation"
  use:swipeNavTouchMove
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchCancel}
  class="flex h-[var(--app-viewport-height,100dvh)] w-screen overflow-hidden pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
>
  <svelte:boundary onerror={(e) => console.error('[ChatBackgroundService] crash récupéré:', e)}>
    <ChatBackgroundService />
  </svelte:boundary>

  <!-- Sidebar (navigation principale) -->
  {#if !isLoginPage}
    <AppSidebar />
  {/if}

  <div class="relative z-10 flex flex-1 flex-col overflow-hidden md:pl-[4.5rem]">
    <!-- Bandeau multi-onglets : pleine largeur, en haut du contenu (jamais dans la rangée sidebar). -->
    <TabFollowerBanner />
    {#if !isLoginPage && !isKeyboardOpen}
      <Navbar />
      {#if !isMobileConvoOpen}
        <MobileHeader />
      {/if}
    {/if}

    <main id="main-content" class="relative flex-1 overflow-hidden">
      <BackgroundBlobs />
      <div
        bind:this={pageScrollWrap}
        class="page-scroll-wrap absolute inset-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0"
      >
        <svelte:boundary>
          {@render children?.()}
          {#snippet failed(_error, reset)}
            <div class="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
              <p class="text-sm text-text-muted">Une erreur est survenue sur cette page.</p>
              <button
                type="button"
                onclick={reset}
                class="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold"
              >
                Réessayer
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

  <ToastContainer />
  <ConfirmDialog />
</div>
