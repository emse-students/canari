<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import PlaceSwitcher from './PlaceSwitcher.svelte';
  import ThemeToggleButton from './ThemeToggleButton.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import { page } from '$app/state';

  interface Props {
    isWsConnected: boolean;
    onToggleLogs: () => void;
    onLogout: () => void;
  }

  let { isWsConnected, onToggleLogs, onLogout }: Props = $props();
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
</script>

<header
  class="bg-[var(--surface-elevated)] border-b border-cn-border z-20 backdrop-blur-sm pt-[env(safe-area-inset-top)]"
>
  <div class="h-14 flex items-center justify-between px-4 md:px-6 gap-3">
    <!-- Left: Brand -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <CanariBrand compact={true} />
    </div>

    <!-- Center: Connection status -->
    <div class="flex-1 flex justify-center">
      <StatusPill isConnected={isWsConnected} />
    </div>

    <!-- Right: Place switcher + actions -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <PlaceSwitcher {pathname} compact={true} />
      <ThemeToggleButton {isDarkMode} onToggle={toggleTheme} />
      <SessionActionButtons {onToggleLogs} {onLogout} />
    </div>
  </div>
</header>
