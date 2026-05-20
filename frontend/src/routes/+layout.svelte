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
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { initHistoryOverlayStack, drainHistoryOverlayStack } from '$lib/utils/historyOverlayStack';
  import { refreshAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import AppUpdateModal from '$lib/components/shared/AppUpdateModal.svelte';

  // NOUVEAUX IMPORTS POUR LE PUSH :
  import { getStatusLog, globalSession, globalConvs } from '$lib/stores/globalChatSingleton.svelte';
  import { startPushService } from '$lib/services/PushNotificationService';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

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
  let isKeyboardOpen = $state(false);
  const statusLog = $derived(getStatusLog());

  function keyboardOpenThresholdPx(): number {
    const ua = navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua);
    // iOS : clavier flottant ou split → delta plus petit.
    if (isIos) return 100;
    // Android (phone + tablette) : seuil conservateur pour éviter les faux positifs
    // au changement d'orientation (qui réduit innerHeight temporairement).
    return 160;
  }

  beforeNavigate(() => {
    drainHistoryOverlayStack();
  });

  onMount(() => {
    const teardownHistory = initHistoryOverlayStack();

    // Redirige console.log/warn/error vers tauri-plugin-log → adb logcat sur Android.
    if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
      attachConsole().catch(() => {});
    }

    void refreshAppVersionCheck();
    const onFocus = () => void refreshAppVersionCheck();
    window.addEventListener('focus', onFocus);

    const handler = () => {
      showLogs = !showLogs;
    };

    // Hauteur de référence pour la détection du clavier.
    // Sur Android avec adjustResize (mode Tauri), window.innerHeight ET visualViewport.height
    // diminuent ensemble quand le clavier s'ouvre → delta naïf = 0 → isKeyboardOpen = false.
    // Solution : on mémorise la hauteur maximale observée en dehors du clavier (baseline)
    // et on compare visualViewport.height à cette baseline.
    let baselineHeight = window.innerHeight;

    const updateViewportHeight = () => {
      const vv = window.visualViewport;
      const winH = window.innerHeight;
      const height = vv?.height ?? winH;

      document.documentElement.style.setProperty('--app-viewport-height', `${height}px`);

      // Fonctionne en adjustPan (winH stable, height drop) ET adjustResize (les deux drop
      // depuis la baseline) : on prend le maximum des deux deltas.
      const delta = Math.max(baselineHeight - height, winH - height);
      isKeyboardOpen = delta > keyboardOpenThresholdPx();

      // Mise à jour de la baseline uniquement quand le clavier n'est pas ouvert,
      // pour qu'elle reflète toujours la vraie hauteur maximale disponible.
      if (!isKeyboardOpen) baselineHeight = Math.max(baselineHeight, winH);
    };

    // Réinitialiser la baseline après un changement d'orientation, le temps que la nouvelle
    // hauteur se stabilise (sinon l'ancienne baseline déclenche un faux positif clavier).
    const handleOrientationChange = () => {
      setTimeout(() => {
        baselineHeight = window.innerHeight;
        updateViewportHeight();
      }, 400);
    };

    window.addEventListener('canari:toggle-logs', handler);
    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      teardownHistory();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('canari:toggle-logs', handler);
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
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
  let touchStartX = 0;
  let touchStartY = 0;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }

  function handleTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Seuil : 60px minimum, et plus horizontal que vertical
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const currentIndex = APP_PLACES.findIndex((p) => p.id === activePlaceId);
    if (currentIndex === -1) return;
    if (dx < 0 && currentIndex < APP_PLACES.length - 1) {
      void goto(APP_PLACES[currentIndex + 1].href);
    } else if (dx > 0 && currentIndex > 0) {
      void goto(APP_PLACES[currentIndex - 1].href);
    }
  }
</script>

<AppUpdateModal />

<div
  role="presentation"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
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

    <main class="relative flex-1 overflow-hidden">
      <BackgroundBlobs />
      <div
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
