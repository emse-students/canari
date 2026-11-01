<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import { getInitials } from '$lib/utils/avatar';
  import { User } from '@lucide/svelte';
  import type { SlotUnit } from '$lib/bookings/api';

  /**
   * THE AVATAR OF A TAKEN UNIT, shared by the week grid and the phone's planning: the booker's photo
   * where the server sent their id (exactly where it sent the name), their initials where it sent
   * only the name, and an anonymous icon where the name is hidden. The seed is the booking's id, so
   * a booking keeps its colour.
   */
  interface Props {
    unit: SlotUnit;
  }
  let { unit }: Props = $props();

  const booking = $derived(unit.state === 'booked' ? unit.booking : null);
  const seed = $derived(booking?.id ?? '');
</script>

{#if booking?.holderId}
  <Avatar
    userId={booking.holderId}
    size="sm"
    shape="circle"
    fallbackLabel={booking.holderName ?? ''}
  />
{:else if booking?.holderName}
  <AvatarPlaceholder
    {seed}
    initials={getInitials(booking.holderName)}
    class="h-6 w-6 shrink-0 rounded-full text-xs"
  />
{:else}
  <AvatarPlaceholder {seed} class="h-6 w-6 shrink-0 rounded-full">
    <User class="h-3 w-3" aria-hidden="true" />
  </AvatarPlaceholder>
{/if}
