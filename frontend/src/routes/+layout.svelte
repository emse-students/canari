<script lang="ts">
  import '../app.css';
  import { beforeNavigate, goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { attachConsole } from '@tauri-apps/plugin-log';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import AppSidebar from '$lib/components/navigation/AppSidebar.svelte';
  import BottomNav from '$lib/components/navigation/BottomNav.svelte';
  import LogsPanel from '$lib/components/dev/LogsPanel.svelte';
  import { page } from '$app/state';
  import { initHistoryOverlayStack, drainHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
  import { refreshAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import AppUpdateModal from '$lib/components/shared/AppUpdateModal.svelte';
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

  // NOUVEAUX IMPORTS POUR LE PUSH :
  import { getStatusLog, globalSession, globalConvs } from '$lib/stores/globalChatSingleton.svelte';
  import { startPushService } from '$lib/services/PushNotificationService';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isLoginPage = $derived(pathname === '/login' || pathname.startsWith('/legal'));

  // Hide BottomNav and remove its padding from the composer when a conversation
  // is open on mobile (only relevant on the chat / communities routes).
  const isMobileConvoOpen = $derived(
    (pathname === '/chat' || pathname === '/communities') &&
      globalConvs.mobileView === 'chat'
  );

  $effect(() => {
    document.documentElement.classList.toggle('mobile-convo-open', isMobileConvoOpen);
    return () => document.documentElement.classList.remove('mobile-convo-open');
  });

  // ── Logs panel (global — fonctionne sur toutes les routes) ──────────────────
  let showLogs = $state(false);
  const keyboardViewport = $derived(getKeyboardViewport());
  const isKeyboardOpen = $derived(keyboardViewport.isOpen);
  const statusLog = $derived(getStatusLog());

  beforeNavigate(({ from, to }) => {
    drainHistoryOverlayStack();
    const fromPath = from?.url.pathname ?? '';
    const toPath = to?.url.pathname ?? '';
    const leavingMessaging =
      fromPath === '/chat' || fromPath === '/communities';
    const enteringMessaging = toPath === '/chat' || toPath === '/communities';
    if (leavingMessaging && enteringMessaging && fromPath !== toPath) {
      globalConvs.selectedContact = null;
      globalConvs.sendError = '';
    }
  });

  onMount(() => {
    const teardownHistory = initHistoryOverlayStack();
    const teardownKeyboard = initKeyboardViewport();

    // Redirige console.log/warn/error vers tauri-plugin-log → adb logcat sur Android.
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      attachConsole().catch(() => {});
    }

    const onVersionCheckTrigger = () => void refreshAppVersionCheck();
    void refreshAppVersionCheck();
    window.addEventListener('focus', onVersionCheckTrigger);
    window.addEventListener('online', onVersionCheckTrigger);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refreshAppVersionCheck();
    });

    const handler = () => {
      showLogs = !showLogs;
    };

    window.addEventListener('canari:toggle-logs', handler);

    return () => {
      teardownHistory();
      teardownKeyboard();
      window.removeEventListener('focus', onVersionCheckTrigger);
      window.removeEventListener('online', onVersionCheckTrigger);
      window.removeEventListener('canari:toggle-logs', handler);
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
          globalSession.historyBaseUrl || "https://canari-emse.fr",
          globalSession.authToken,
          globalSession.myDeviceId
        ).catch(err => console.error("[Push] Erreur d'initialisation:", err));
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

    const updated = updateSwipeNavGesture(
      swipeGesture,
      e.touches[0].clientX,
      e.touches[0].clientY
    );
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

<a href="#main-content" class="skip-link">Aller au contenu principal</a>

<AppUpdateModal />

<div
  role="presentation"
  use:swipeNavTouchMove
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchCancel}
  class="flex h-[var(--app-viewport-height,100dvh)] w-screen overflow-hidden pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
>
  <ChatBackgroundService />

  <!-- Sidebar (navigation principale) -->
   {#if !isLoginPage}
    <AppSidebar />
  {/if}

  <div class="relative z-10 flex flex-1 flex-col overflow-hidden md:pl-[4.5rem]">

    {#if !isLoginPage && !isKeyboardOpen}
      <Navbar />
    {/if}

    <main id="main-content" class="relative flex-1 overflow-hidden">
      <BackgroundBlobs />
      <div
        bind:this={pageScrollWrap}
        class="page-scroll-wrap absolute inset-0 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0"
      >
        {@render children?.()}
      </div>
    </main>

    {#if !isKeyboardOpen && !isLoginPage && !isMobileConvoOpen}
      <BottomNav />
    {/if}
  </div>

  {#if showLogs}
    <div class="fixed inset-0 z-50 flex justify-end pointer-events-none">
      <div class="pointer-events-auto h-full w-full md:w-80">
        <LogsPanel logs={statusLog} onClose={() => (showLogs = false)} />
      </div>
    </div>
  {/if}
</div>
