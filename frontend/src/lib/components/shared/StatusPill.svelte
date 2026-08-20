<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the WebSocket connection is currently active. */
    isConnected: boolean;
  }

  let { isConnected }: Props = $props();
</script>

<div class="flex items-center">
  <div
    class="bg-cn-bg text-text-main flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold"
  >
    <span
      class="h-2 w-2 rounded-full {isConnected
        ? 'bg-green-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
        : 'bg-gray-400'}"
    ></span>
    {isConnected ? m.status_pill_connected() : m.status_pill_offline()}
  </div>
</div>
