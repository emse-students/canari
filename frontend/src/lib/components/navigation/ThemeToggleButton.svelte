<script lang="ts">
  import { Moon, Sun } from '@lucide/svelte';

  interface Props {
    /** Whether dark mode is currently active. */
    isDarkMode: boolean;
    /** Callback to toggle between light and dark mode. */
    onToggle: () => void;
  }

  let { isDarkMode, onToggle }: Props = $props();
</script>

<button
  onclick={onToggle}
  title="Basculer le mode sombre"
  class="p-2 rounded-lg text-text-muted hover:bg-cn-bg hover:text-cn-dark transition-colors"
>
  {#if isDarkMode}
    <Sun size={20} />
  {:else}
    <Moon size={20} />
  {/if}
</button>
