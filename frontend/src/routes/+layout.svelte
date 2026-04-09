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
  import {
    globalSession,
    globalConvs,
    appendLog,
    getStatusLog,
  } from '$lib/stores/globalChatSingleton.svelte';

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
  const statusLog = $derived(getStatusLog());

  onMount(() => {
    const handler = () => {
      showLogs = !showLogs;
    };
    window.addEventListener('canari:toggle-logs', handler);
    return () => window.removeEventListener('canari:toggle-logs', handler);
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────
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

<div class="relative {isAuthRoute ? 'min-h-dvh' : 'h-dvh'} flex flex-col">
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
    <div class="flex-1 min-w-0 h-full {!isAuthRoute ? 'pb-14 md:pb-0 md:pl-[4.5rem]' : ''}">
      {@render children?.()}
    </div>
  </div>

  {#if !isAuthRoute}
    <BottomNav />
  {/if}

  {#if showLogs && !isAuthRoute}
    <div class="fixed inset-0 z-50 flex justify-end pointer-events-none">
      <div class="pointer-events-auto h-full w-full md:w-80">
        <LogsPanel
          logs={statusLog}
          onClose={() => (showLogs = false)}
          onGenerateKeyPackage={() => globalSession.devGenerateKeyPackage(appendLog)}
          onAddMember={() =>
            globalSession.devAddMember(
              globalConvs.selectedContact
                ? (globalConvs.conversations.get(globalConvs.selectedContact)?.id ?? '')
                : '',
              appendLog
            )}
          onProcessWelcome={() => globalSession.devProcessWelcome(appendLog)}
          lastKeyPackage={globalSession.lastKeyPackage}
          lastCommit={globalSession.lastCommit}
          lastWelcome={globalSession.lastWelcome}
          incomingBytesHex={globalSession.incomingBytesHex}
          onIncomingBytesChange={(value) => (globalSession.incomingBytesHex = value)}
        />
      </div>
    </div>
  {/if}
</div>
