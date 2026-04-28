<script lang="ts">
  import '../app.css';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import ChatBackgroundService from '$lib/components/layout/ChatBackgroundService.svelte';
  import Navbar from '$lib/components/navigation/Navbar.svelte';
  import AppSidebar from '$lib/components/navigation/AppSidebar.svelte';
  import BottomNav from '$lib/components/navigation/BottomNav.svelte';
  import LogsPanel from '$lib/components/dev/LogsPanel.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { page } from '$app/state';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { getStatusLog } from '$lib/stores/globalChatSingleton.svelte';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isAuthRoute = $derived(
    pathname === '/login' ||
      pathname.startsWith('/login') ||
      pathname === '/auth/callback' ||
      pathname.startsWith('/auth/')
  );
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

  // ── Logs panel (global — fonctionne sur toutes les routes) ──────────────────
  let showLogs = $state(false);
  let isKeyboardOpen = $state(false);
  const statusLog = $derived(getStatusLog());

  function keyboardOpenThresholdPx(): number {
    const ua = navigator.userAgent.toLowerCase();
    const isAndroid = ua.includes('android');
    const isIos = /iphone|ipad|ipod/.test(ua);

    // iOS a souvent un delta plus petit (barres système + clavier flottant).
    if (isIos) return 100;
    // Android a généralement un delta plus important en mode portrait.
    if (isAndroid) return 140;
    // Fallback navigateurs mobiles/desktop.
    return 120;
  }

  onMount(() => {
    const handler = () => {
      showLogs = !showLogs;
    };

    const updateViewportHeight = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-viewport-height', `${height}px`);

      // Sur mobile, le clavier virtuel réduit fortement visualViewport.height.
      // On utilise ce signal pour retirer l'espace réservé à la BottomNav.
      const keyboardDelta = window.innerHeight - height;
      isKeyboardOpen = keyboardDelta > keyboardOpenThresholdPx();
    };

    window.addEventListener('canari:toggle-logs', handler);
    updateViewportHeight();
    window.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('resize', updateViewportHeight);
    window.visualViewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      window.removeEventListener('canari:toggle-logs', handler);
      window.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('resize', updateViewportHeight);
      window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
    };
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('keyboard-open', isKeyboardOpen);
  });

  let _authNavigating = false;
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (isAuthRoute) {
      return;
    }
    if (!currentUserId()) {
      if (_authNavigating) return;
      _authNavigating = true;
      console.log(
        `[NAV] Auth guard — aucun userId, redirection vers /login (returnTo=${pathname})`
      );
      setTimeout(() => {
        goto(`/login?returnTo=${encodeURIComponent(pathname)}`, { replaceState: true })
          .catch(() => {})
          .finally(() => {
            _authNavigating = false;
          });
      }, 0);
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
    if (isAuthRoute) return;
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

<div
  role="presentation"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
  class="flex h-[var(--app-viewport-height,100dvh)] w-screen overflow-hidden pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
>
  <ChatBackgroundService />

  {#if !isAuthRoute}
    <AppSidebar />
  {/if}

  <div class="relative z-10 flex flex-1 flex-col overflow-hidden md:pl-[4.5rem]">
    {#if !isAuthRoute}
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

    {#if !isAuthRoute && !isKeyboardOpen}
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
