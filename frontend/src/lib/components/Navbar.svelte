<script lang="ts">
  import { Terminal, LogOut, Moon, Sun } from 'lucide-svelte';
  import StatusPill from './StatusPill.svelte';

  interface Props {
    isWsConnected: boolean;
    onToggleLogs: () => void;
    onLogout: () => void;
  }

  let { isWsConnected, onToggleLogs, onLogout }: Props = $props();

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
  class="min-h-16 pt-[env(safe-area-inset-top)] bg-white/40 dark:bg-gray-900/50 border-b border-white/50 dark:border-white/10 flex items-center justify-between px-4 md:px-6 z-20 backdrop-blur-md"
>
  <!-- Brand -->
  <div class="flex items-center gap-3">
    <div class="w-8 h-8 bg-[#122035] text-cn-yellow rounded-lg flex items-center justify-center">
      <img src="/favicon.png" alt="Canari" class="w-3/4 h-3/4 object-contain" />
    </div>
    <span class="font-black text-xl text-cn-dark">Canari</span>
  </div>

  <!-- Status -->
  <StatusPill isConnected={isWsConnected} />

  <!-- Actions -->
  <div class="flex gap-2">
    <button
      onclick={toggleTheme}
      title="Basculer le mode sombre"
      class="p-2 rounded-lg text-text-muted hover:bg-white/40 dark:hover:bg-black/35 hover:text-cn-dark transition-colors"
    >
      {#if isDarkMode}
        <Sun size={20} />
      {:else}
        <Moon size={20} />
      {/if}
    </button>
    <button
      onclick={onToggleLogs}
      title="Console de logs"
      class="p-2 rounded-lg text-text-muted hover:bg-white/40 dark:hover:bg-black/35 hover:text-cn-dark transition-colors"
    >
      <Terminal size={20} />
    </button>
    <button
      onclick={onLogout}
      title="Fermer la session"
      class="p-2 rounded-lg text-text-muted hover:bg-red-50/80 dark:hover:bg-red-500/20 hover:text-red-500 transition-colors"
    >
      <LogOut size={20} />
    </button>
  </div>
</header>
