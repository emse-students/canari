<script lang="ts">
  import { CalendarDays } from '@lucide/svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto h-full flex flex-col">
  <h1 class="text-2xl font-extrabold text-text-main tracking-tight mb-6">{m.events_heading()}</h1>
  <EmptyState
    icon={CalendarDays}
    title={m.events_empty_title()}
    description={m.events_empty_desc()}
  />
</div>
