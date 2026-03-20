<script lang="ts">
  import {
    CalendarDays,
    ChevronDown,
    MessageCircle,
    Newspaper,
    Phone,
    Users,
  } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';

  interface Props {
    pathname: string;
    compact?: boolean;
    className?: string;
  }

  let { pathname, compact = false, className = '' }: Props = $props();

  let activePlaceId = $derived(resolveActivePlaceId(pathname));
  let isOpen = $state(false);

  const ICONS = {
    'message-circle': MessageCircle,
    newspaper: Newspaper,
    users: Users,
    phone: Phone,
    'calendar-days': CalendarDays,
  } as const;

  let activePlace = $derived(APP_PLACES.find((place) => place.id === activePlaceId) ?? APP_PLACES[0]);
  let ActiveIcon = $derived(getIcon(activePlace.icon));

  function getIcon(icon: keyof typeof ICONS) {
    return ICONS[icon];
  }

  async function handleSelect(selectedId: string) {
    const place = APP_PLACES.find((item) => item.id === selectedId);
    if (!place || !place.enabled) return;
    isOpen = false;
    await goto(place.href);
  }

  function toggleMenu() {
    isOpen = !isOpen;
  }

  function closeMenuOnWindowClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('[data-place-switcher]')) return;
    isOpen = false;
  }
</script>

<svelte:window onclick={closeMenuOnWindowClick} />

<div class="relative inline-flex items-center gap-2 {className}" data-place-switcher>
  {#if !compact}
    <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">Lieu</span>
  {/if}
  <button
    type="button"
    onclick={toggleMenu}
    class="inline-flex items-center gap-2 rounded-xl border border-cn-border bg-white/80 px-3 py-1.5 text-sm font-semibold text-text-main hover:bg-white focus:ring-2 focus:ring-amber-400/45"
    aria-haspopup="menu"
    aria-expanded={isOpen}
    aria-label="Choisir un espace"
  >
    <ActiveIcon size={15} />
    <span>{activePlace.label}</span>
    <ChevronDown size={14} class={isOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
  </button>

  {#if isOpen}
    <div
      role="menu"
      class="absolute right-0 top-[calc(100%+0.35rem)] z-50 w-[min(90vw,23rem)] overflow-hidden rounded-2xl border border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_92%,white)] shadow-xl backdrop-blur-md"
    >
      <div class="p-1.5">
        {#each APP_PLACES as place (place.id)}
          {@const PlaceIcon = getIcon(place.icon)}
          <button
            type="button"
            role="menuitem"
            onclick={() => handleSelect(place.id)}
            disabled={!place.enabled}
            class="mb-1 flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left last:mb-0 {place.id === activePlaceId
              ? 'bg-[color-mix(in_srgb,var(--cn-yellow)_23%,white)]'
              : 'hover:bg-white/80'} {place.enabled ? 'text-text-main' : 'text-text-muted opacity-70'}"
          >
            <span class="mt-[1px] rounded-lg border border-cn-border bg-white/70 p-1.5">
              <PlaceIcon size={14} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold leading-4">
                {place.label}
                {#if place.badge}
                  <span class="ml-2 rounded-full border border-cn-border bg-white/80 px-1.5 py-0.5 text-[0.63rem] font-bold uppercase tracking-wide">{place.badge}</span>
                {/if}
              </span>
              <span class="mt-1 block text-xs leading-4 text-text-muted">{place.description}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
