<script lang="ts">
  import { Terminal, LogOut } from 'lucide-svelte';

  interface Props {
    /** Callback to toggle the logs panel visibility. */
    onToggleLogs: () => void;
    /** Callback to log out the current user. */
    onLogout: () => void;
  }

  let { onToggleLogs, onLogout }: Props = $props();
</script>

<button
  onclick={onToggleLogs}
  title="Console de logs"
  class="p-2 rounded-lg text-text-muted hover:bg-cn-bg hover:text-cn-dark transition-colors"
>
  <Terminal size={20} />
</button>
<button
  onclick={onLogout}
  title="Fermer la session"
  class="p-2 rounded-lg text-text-muted hover:bg-red-50 hover:text-red-500 transition-colors"
>
  <LogOut size={20} />
</button>
