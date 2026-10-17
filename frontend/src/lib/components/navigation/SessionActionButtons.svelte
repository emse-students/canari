<script lang="ts">
  import { LoaderCircle, LogOut } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Callback to log out the current user. */
    onLogout: () => void;
    /**
     * A sign-out is under way. It may wait up to the logout deadline for the server's revocation,
     * so the button says so and refuses a second tap, which would send a second logout.
     */
    busy?: boolean;
  }

  let { onLogout, busy = false }: Props = $props();
</script>

<button
  onclick={onLogout}
  disabled={busy}
  aria-busy={busy}
  title={m.nav_logout_title()}
  aria-label={m.nav_logout_label()}
  class="ui-icon-button text-text-muted hover:bg-red-err/10 rounded-lg transition-colors hover:text-red-500 disabled:pointer-events-none disabled:opacity-60"
>
  {#if busy}
    <LoaderCircle size={20} class="animate-spin" />
  {:else}
    <LogOut size={20} />
  {/if}
</button>
