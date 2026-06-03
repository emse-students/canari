<script lang="ts">
  import { CalendarDays } from '@lucide/svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto h-full flex flex-col">
  <h1 class="text-2xl font-extrabold text-text-main tracking-tight mb-6">Événements</h1>
  <EmptyState
    icon={CalendarDays}
    title="Aucun événement pour le moment"
    description="Les événements à venir apparaîtront ici."
  />
</div>
