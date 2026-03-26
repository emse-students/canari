<script lang="ts">
  import StatusPill from '../shared/StatusPill.svelte';
  import CanariBrand from './CanariBrand.svelte';
  import PlaceSwitcher from './PlaceSwitcher.svelte';
  import ThemeToggleButton from './ThemeToggleButton.svelte';
  import SessionActionButtons from './SessionActionButtons.svelte';
  import { page } from '$app/stores';

  interface Props {
    isWsConnected: boolean;
    onToggleLogs: () => void;
    onLogout: () => void;
  }

  let { isWsConnected, onToggleLogs, onLogout }: Props = $props();
  const pathname = $derived($page.url.pathname);

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
  <div class="h-16 flex items-center justify-between px-4 md:px-6">
    <CanariBrand compact={true} />

    <div class="flex items-center gap-3 min-w-0">
      <PlaceSwitcher {pathname} compact={true} />
      <StatusPill isConnected={isWsConnected} />
    </div>

    <!-- Actions -->
    <div class="flex gap-2">
      <ThemeToggleButton {isDarkMode} onToggle={toggleTheme} />
      <SessionActionButtons {onToggleLogs} {onLogout} />
    </div>
  </div>
</header>
