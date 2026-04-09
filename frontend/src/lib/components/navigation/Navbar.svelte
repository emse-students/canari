<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import PlaceSwitcher from './PlaceSwitcher.svelte';
  import ThemeToggleButton from './ThemeToggleButton.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { clearAuth } from '$lib/stores/auth';
  import { globalSession } from '$lib/stores/globalChatSingleton.svelte';

  const pathname = $derived(page.url.pathname);

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
    if (saved === 'dark') {
      isDarkMode = true;
      applyTheme(true);
    } else if (saved === 'light') {
      isDarkMode = false;
      applyTheme(false);
    } else {
      isDarkMode = true;
      applyTheme(true);
    }
  }

  function handleToggleLogs() {
    window.dispatchEvent(new CustomEvent('canari:toggle-logs'));
  }

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }
</script>

<header
  class="sticky top-0 z-20 bg-[var(--surface-elevated)] border-b border-cn-border backdrop-blur-sm pt-[env(safe-area-inset-top)] flex-shrink-0"
>
  <div class="h-14 flex items-center justify-between px-4 md:px-6 gap-3">
    <!-- Left: Brand -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <CanariBrand compact={true} />
    </div>

    <!-- Center: Place switcher -->
    <div class="flex-1 flex justify-center">
      <div class="relative">
        <PlaceSwitcher {pathname} compact={true} />
      </div>
    </div>

    <!-- Right: Status + Theme + actions -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <StatusPill isConnected={globalSession.isWsConnected} />
      <ThemeToggleButton {isDarkMode} onToggle={toggleTheme} />
      <SessionActionButtons onToggleLogs={handleToggleLogs} onLogout={handleLogout} />
    </div>
  </div>
</header>
