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

  $effect(() => {
    if (typeof window === 'undefined') return;
    if (isAuthRoute) return;
    if (!currentUserId()) {
      void goto(`/login?returnTo=${encodeURIComponent(pathname)}`, { replaceState: true });
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
  class="relative flex flex-col {isAuthRoute
    ? 'min-h-dvh'
    : 'pt-[env(safe-area-inset-top)] md:pt-0'}"
  style={isAuthRoute ? undefined : `height: var(--app-viewport-height, 100dvh);`}
>
  <ChatBackgroundService />

  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  {#if !isAuthRoute}
    <Navbar />
  {/if}

  <!-- Sidebar desktop (fixed, hors flux) -->
  {#if !isAuthRoute}
    <AppSidebar />
  {/if}

  <!-- Zone principale : sidebar desktop + contenu -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="relative z-10 flex flex-1 min-h-0 w-full pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    ontouchstart={handleTouchStart}
    ontouchend={handleTouchEnd}
  >
    <!-- Contenu — md:pl-14 laisse la place au rail replié de la sidebar fixe -->
    <div
      class="flex-1 min-w-0 h-full overflow-y-auto {!isAuthRoute
        ? `${isKeyboardOpen ? 'pb-0' : 'pb-[calc(4rem+env(safe-area-inset-bottom))]'} md:pb-0 md:pl-[4.5rem]`
        : ''}"
    >
      {@render children?.()}
    </div>
  </div>

  {#if !isAuthRoute && !isKeyboardOpen}
    <BottomNav />
  {/if}

  {#if showLogs && !isAuthRoute}
    <div class="fixed inset-0 z-50 flex justify-end pointer-events-none">
      <div class="pointer-events-auto h-full w-full md:w-80">
        <LogsPanel logs={statusLog} onClose={() => (showLogs = false)} />
      </div>
    </div>
  {/if}
</div>
