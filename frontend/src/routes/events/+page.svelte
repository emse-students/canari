<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { CalendarDays } from '@lucide/svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<PageContainer>
  <PageHeader title={m.events_heading()} />
  <EmptyState
    icon={CalendarDays}
    title={m.events_empty_title()}
    description={m.events_empty_desc()}
  />
</PageContainer>
