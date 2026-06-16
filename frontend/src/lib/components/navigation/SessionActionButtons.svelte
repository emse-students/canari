<script lang="ts">
  import { LogOut } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Callback to log out the current user. */
    onLogout: () => void;
  }

  let { onLogout }: Props = $props();
</script>

<button
  onclick={onLogout}
  title={m.nav_logout_title()}
  aria-label={m.nav_logout_label()}
  class="p-2 rounded-lg text-text-muted hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors"
>
  <LogOut size={20} />
</button>
