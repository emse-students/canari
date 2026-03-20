<script lang="ts">
  import StatusPill from './StatusPill.svelte';
  import CanariBrand from './navigation/CanariBrand.svelte';
  import PlaceSwitcher from './navigation/PlaceSwitcher.svelte';
  import ThemeToggleButton from './navigation/ThemeToggleButton.svelte';
  import SessionActionButtons from './navigation/SessionActionButtons.svelte';
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
  class="h-16 bg-[var(--surface-elevated)] border-b border-cn-border flex items-center justify-between px-4 md:px-6 z-20 backdrop-blur-sm"
>
  <CanariBrand compact={true} />

  <div class="flex items-center gap-3 min-w-0">
    <PlaceSwitcher {pathname} compact={true} />
    <StatusPill isConnected={isWsConnected} />
  </div>

  <!-- Actions -->
  <div class="flex gap-2">
    <ThemeToggleButton isDarkMode={isDarkMode} onToggle={toggleTheme} />
    <SessionActionButtons {onToggleLogs} {onLogout} />
  </div>
</header>
