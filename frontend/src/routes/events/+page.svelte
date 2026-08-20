<script lang="ts">
  import { CalendarDays } from '@lucide/svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<div class="mx-auto flex h-full max-w-4xl flex-col px-4 py-6 sm:px-6">
  <h1 class="text-text-main mb-6 text-2xl font-extrabold tracking-tight">{m.events_heading()}</h1>
  <EmptyState
    icon={CalendarDays}
    title={m.events_empty_title()}
    description={m.events_empty_desc()}
  />
</div>
