<script lang="ts">
  import { getAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import { TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  const info = $derived(getAppVersionCheck());
  const message = $derived(info?.maintenance.message);
</script>

<div
  class="fixed top-0 inset-x-0 z-[120] flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-xs font-bold text-[#151B2C] shadow-md"
  role="status"
>
  <TriangleAlert size={14} />
  <span>
    {m.admin_maintenance_banner_text()}
    {#if message}
      {message}
    {/if}
  </span>
</div>
