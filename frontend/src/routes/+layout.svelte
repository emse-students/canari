<script lang="ts">
  import '../app.css';
  import { goto } from '$app/navigation';
  import BackgroundBlobs from '$lib/components/shared/BackgroundBlobs.svelte';
  import CanariBrand from '$lib/components/navigation/CanariBrand.svelte';
  import PlaceSwitcher from '$lib/components/navigation/PlaceSwitcher.svelte';
  import ThemeToggleButton from '$lib/components/navigation/ThemeToggleButton.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { clearAuth } from '$lib/stores/auth';
  import { page } from '$app/state';
  import { LogOut } from 'lucide-svelte';

  let { children } = $props();

  const pathname = $derived(page.url.pathname);
  const isChatRoute = $derived(
    pathname === '/chat' ||
      pathname.startsWith('/chat/') ||
      pathname === '/communities' ||
      pathname.startsWith('/communities/')
  );
  const isAuthRoute = $derived(
    pathname === '/login' ||
      pathname.startsWith('/login') ||
      pathname === '/auth/callback' ||
      pathname.startsWith('/auth/')
  );

  let userId = $derived(currentUserId());

  // ── Theme toggle ──────────────────────────────────────────────────────────
  let isDarkMode = $state(false);

  function applyTheme(isDark: boolean) {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    localStorage.setItem('canari-theme', isDark ? 'dark' : 'light');
  }

  function toggleTheme() {
    isDarkMode = !isDarkMode;
    applyTheme(isDarkMode);
  }

  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('canari-theme');
    if (saved === 'dark' || (!saved && true)) {
      isDarkMode = true;
      applyTheme(true);
    } else {
      isDarkMode = false;
      applyTheme(false);
    }
  }

  // ── Auth guard ────────────────────────────────────────────────────────────
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (isAuthRoute) return;
    if (!currentUserId()) {
      void goto(`/login?returnTo=${encodeURIComponent(pathname)}`, { replaceState: true });
    }
  });

  // ── Logout from non-chat pages ────────────────────────────────────────────
  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }
</script>

<div class="relative min-h-dvh">
  <div class="fixed inset-0 z-0 pointer-events-none">
    <BackgroundBlobs />
  </div>

  {#if !isChatRoute && !isAuthRoute}
    <header
      class="sticky top-0 z-20 border-b border-cn-border/70 bg-[var(--surface-elevated)]/90 backdrop-blur-lg pt-[env(safe-area-inset-top)]"
    >
      <div
        class="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-3 py-2.5 sm:px-5"
      >
        <div class="flex items-center gap-2 flex-shrink-0">
          <CanariBrand />
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <PlaceSwitcher {pathname} />
          <ThemeToggleButton {isDarkMode} onToggle={toggleTheme} />
          {#if userId}
            <a href="/profile" class="flex-shrink-0" aria-label="Mon profil">
              <Avatar {userId} size="sm" />
            </a>
            <button
              onclick={handleLogout}
              title="Se déconnecter"
              class="p-2 rounded-lg text-text-muted hover:bg-red-50 hover:text-red-500 transition-colors"
              aria-label="Se déconnecter"
            >
              <LogOut size={20} />
            </button>
          {/if}
        </div>
      </div>
    </header>
  {/if}

  <div
    class="relative z-10 mx-auto flex w-full pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] {isChatRoute
      ? 'h-dvh max-w-none'
      : isAuthRoute
        ? 'min-h-dvh max-w-none'
        : 'h-[calc(100dvh-4.5rem-env(safe-area-inset-top,0px))] max-w-[1400px]'}"
  >
    <div class="h-full w-full">
      {@render children?.()}
    </div>
  </div>
</div>
