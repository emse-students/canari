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
  class="text-text-muted hover:bg-red-err/10 rounded-lg p-2 transition-colors hover:text-red-500"
>
  <LogOut size={20} />
</button>
