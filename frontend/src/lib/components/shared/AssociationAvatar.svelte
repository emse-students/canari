<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import { associationLogoSrc } from '$lib/associations/api';
  import {
    releaseAssociationLogoDisplayUrl,
    resolveAssociationLogoDisplayUrl,
  } from '$lib/utils/associationLogoCache';

  interface Props {
    /** Association display name, used for initials fallback. */
    name: string;
    /** Logo URL (relative /api/… path or absolute). Null/undefined shows initials only. */
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
  let displaySrc = $state<string | null>(null);
  let triedDirectFallback = $state(false);

  const src = $derived(associationLogoSrc(logoUrl ?? undefined));
  const initials = $derived(getInitials(name));

  // Resolve logo via Cache API (kept across sessions) when the URL changes. KEEPING IT FOR EVER IS
  // LEGITIMATE HERE AND ONLY HERE: a logo URL is `/api/media/public/<mediaId>?v=<updatedAt>`, so
  // replacing the logo produces a different URL and the old entry is simply never asked for again.
  // A user avatar is the opposite - one URL, a photo that changes behind it - which is why it does
  // not go through Cache Storage at all (`userAvatarCache.ts`).
  $effect(() => {
    const httpUrl = src;
    if (!httpUrl) {
      displaySrc = null;
      imageFailed = false;
      return;
    }
    imageFailed = false;
    triedDirectFallback = false;
    let cancelled = false;
    const pending = resolveAssociationLogoDisplayUrl(httpUrl).then((resolved) => {
      if (!cancelled) displaySrc = resolved;
    });
    return () => {
      cancelled = true;
      // The release waits for the retain: unmounting before the bytes arrive would otherwise
      // decrement a count that is incremented a moment later, leaving a blob URL owned by nobody
      // and revoked by nobody.
      void pending.finally(() => releaseAssociationLogoDisplayUrl(httpUrl));
    };
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

{#if !imageFailed && displaySrc}
  <img
    src={displaySrc}
    alt={name}
    class="{shapeClasses} flex-shrink-0 bg-white object-cover shadow-sm ring-1 ring-white/20 select-none {sizeClasses}"
    title={name}
    onerror={() => {
      if (!triedDirectFallback && src && displaySrc !== src) {
        triedDirectFallback = true;
        displaySrc = src;
        return;
      }
      imageFailed = true;
    }}
  />
{:else}
  <div
    class="{shapeClasses} flex-shrink-0 shadow-sm ring-1 ring-white/20 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center font-bold"
    title={name}
    aria-label={`Logo de ${name}`}
  >
    {initials}
  </div>
{/if}
