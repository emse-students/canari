<script lang="ts">
  import { Users } from '@lucide/svelte';
  import { mediaUrl } from '$lib/utils/apiUrl';
  import { getInitials } from '$lib/utils/avatar';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Media-service ID of the avatar image. When absent, falls back to icon/initials. */
    imageMediaId?: string | null;
    /** Display name used for initials fallback. */
    name?: string;
    /** Visual variant controls the fallback icon and color scheme. */
    variant?: 'group' | 'community';
    /** Avatar size preset. */
    size?: 'sm' | 'md' | 'lg';
    /** When true, the avatar stretches to fill its container instead of using a preset size. */
    fill?: boolean;
    /** Border-radius style of the avatar. */
    shape?: 'soft' | 'circle';
  }

  let {
    imageMediaId = null,
    name = '',
    variant = 'group',
    size = 'md',
    fill = false,
    shape = 'soft',
  }: Props = $props();

  let loadFailed = $state(false);

  const imageSrc = $derived(
    imageMediaId ? `${mediaUrl()}/api/media/public/${encodeURIComponent(imageMediaId)}` : null
  );

  const sizeClasses = $derived(
    fill
      ? 'w-full h-full text-base'
      : size === 'sm'
        ? 'w-6 h-6 text-xs'
        : size === 'lg'
          ? 'w-12 h-12 text-base'
          : 'w-8 h-8 text-sm'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'squircle');

  const iconSize = $derived(size === 'sm' ? 14 : size === 'lg' ? 22 : 18);

  const fallbackClasses = $derived(
    variant === 'community' ? 'bg-amber-500 text-cn-ink' : 'bg-cn-ink text-cn-yellow'
  );

  /**
   * The letters drawn when there is no image, or nothing when the icon should show instead.
   *
   * THE PRIVATE COPY THIS REPLACES CUT A NAME IN HALF, NOT A CHARACTER. It took `w[0]` of each
   * word - a UTF-16 code UNIT, not a character - so a group whose name begins with an emoji
   * rendered that emoji's lone high surrogate, which is not a character and draws as a placeholder
   * box. Reported from a real group on 2026-09-16. The shared `getInitials` had solved it from the
   * start by keeping only letters and digits, and is already the implementation the Carte uses; a
   * second one existed here only because this component was written later.
   *
   * The empty name is the one case the shared function answers differently: it returns `?`, which
   * is right for a USER whose name is missing, where a group with no name has an icon to show. So
   * emptiness is decided here and `?` can never reach the box.
   */
  const initials = $derived(name.trim() ? getInitials(name) : '');

  $effect(() => {
    void imageMediaId;
    loadFailed = false;
  });
</script>

{#if imageSrc && !loadFailed}
  <img
    src={imageSrc}
    alt={name || m.group_avatar_fallback_alt()}
    loading="lazy"
    decoding="async"
    class="{shapeClasses} shrink-0 object-cover shadow-sm select-none {sizeClasses}"
    onerror={() => (loadFailed = true)}
  />
{:else}
  <div
    class="{shapeClasses} flex shrink-0 items-center justify-center font-bold shadow-sm select-none {sizeClasses} {fallbackClasses}"
    title={name}
  >
    {#if initials}
      <span class="text-zoom-exempt">{initials}</span>
    {:else}
      <Users size={iconSize} />
    {/if}
  </div>
{/if}
