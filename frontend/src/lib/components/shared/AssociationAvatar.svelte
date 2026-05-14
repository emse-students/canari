<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import { associationLogoSrc } from '$lib/associations/api';

  interface Props {
    /** Association display name, used for initials fallback. */
    name: string;
    /** Logo URL (relative /api/... path or absolute). Null/undefined shows initials only. */
    logoUrl?: string | null;
    /** Avatar size preset. */
    size?: 'sm' | 'md' | 'lg';
    /** When true, stretches to fill its container. */
    fill?: boolean;
    /** Border-radius style. */
    shape?: 'soft' | 'circle';
  }

  let { name, logoUrl, size = 'md', fill = false, shape = 'soft' }: Props = $props();

  let imageFailed = $state(false);
  let lastSrc = $state<string | null>(null);

  const src = $derived(associationLogoSrc(logoUrl ?? undefined));
  const initials = $derived(getInitials(name));

  // Reset error state when the logo URL changes (e.g., after an upload).
  $effect(() => {
    if (src !== lastSrc) {
      lastSrc = src;
      imageFailed = false;
    }
  });

  const sizeClasses = $derived(
    fill
      ? 'w-full h-full text-base'
      : size === 'sm'
        ? 'w-6 h-6 text-xs'
        : size === 'lg'
          ? 'w-12 h-12 text-base'
          : 'w-8 h-8 text-sm'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-2xl');
</script>

{#if !imageFailed && src}
  <img
    {src}
    alt={name}
    class="{shapeClasses} object-cover shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses}"
    title={name}
    onerror={() => { imageFailed = true; }}
  />
{:else}
  <div
    class="{shapeClasses} shadow-sm ring-1 ring-white/20 flex-shrink-0 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center font-bold"
    title={name}
    aria-label={`Logo de ${name}`}
  >
    {initials}
  </div>
{/if}
