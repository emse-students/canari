<script lang="ts">
  import { generateAvatarPlaceholder, getInitials } from '$lib/utils/avatar';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    releaseUserAvatarDisplayUrl,
    resolveUserAvatarDisplayUrl,
    type AvatarDisplay,
  } from '$lib/utils/userAvatarCache';

  interface Props {
    /** ID of the user whose avatar should be displayed. */
    userId: string;
    /** Avatar size preset. */
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** When true, the avatar stretches to fill its container instead of using a preset size. */
    fill?: boolean;
    /** Border-radius style of the avatar. */
    shape?: 'soft' | 'circle';
    /** Text used for initials when the display name cannot be resolved. */
    fallbackLabel?: string;
  }

  let { userId, size = 'md', fill = false, shape = 'soft', fallbackLabel = '' }: Props = $props();

  function getCoreUrl(): string {
    const url =
      typeof import.meta !== 'undefined'
        ? ((import.meta as any).env?.VITE_CORE_URL as string | undefined)
        : undefined;
    if (url?.trim()) return url.trim();
    return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3012';
  }

  /**
   * WHETHER THERE IS ANYONE TO ASK ABOUT.
   *
   * Two call sites hand this component `?? ''` on purpose - a post whose author is gone, a
   * parrainage entry with no `sub` - which is them stating a FACT: there is no user here. Passing it
   * on to the network turned that fact into `GET /api/users//avatar`, a 404 per mount, plus the
   * `GET /api/users/` its name lookup made beside it. Neither could have answered anything. The
   * initials placeholder below is the ANSWER for an absent user, not a fallback for a failed
   * request.
   */
  const identified = $derived(userId.trim().length > 0);

  const avatarSrc = $derived(`${getCoreUrl()}/api/users/${encodeURIComponent(userId)}/avatar`);
  const _fallbackSrc = $derived(generateAvatarPlaceholder(userId));

  let imageFailed = $state(false);
  let imageLoaded = $state(false);
  /** Null until the cache has answered. NOTHING IS REQUESTED BEFORE THAT - see the effect below. */
  let display = $state<AvatarDisplay | null>(null);
  let triedDirectFallback = $state(false);
  let displayLabel = $state('');
  let resolveToken = 0;
  const initials = $derived(getInitials(displayLabel));

  $effect(() => {
    const token = ++resolveToken;
    const fallback = fallbackLabel.trim();
    displayLabel = getUserDisplayNameSync(userId, fallback || undefined);
    resolveUserDisplayName(userId).then((resolved) => {
      if (token !== resolveToken) return;
      if (resolved) {
        displayLabel = resolved;
      } else if (fallback) {
        displayLabel = fallback;
      }
    });
  });

  // ONE EFFECT, AND IT OWNS EVERY PIECE OF PER-URL STATE. A second effect used to reset the same
  // flags when `userId` changed, which is the same event by another name - `avatarSrc` derives from
  // `userId` and from nothing else - so the two raced to reset each other on every switch.
  $effect(() => {
    const httpUrl = avatarSrc;
    display = null;
    imageFailed = false;
    imageLoaded = false;
    triedDirectFallback = false;
    if (!identified) {
      // Nothing requested, so nothing to retain and nothing to release.
      display = { kind: 'none' };
      return;
    }
    let cancelled = false;
    const pending = resolveUserAvatarDisplayUrl(httpUrl).then((resolved) => {
      if (cancelled) return;
      display = resolved;
      // Bytes already held locally: there is no round trip to wait for, so the initials placeholder
      // is not shown for one frame before an image that is already here.
      if (resolved.kind === 'blob') imageLoaded = true;
    });
    return () => {
      cancelled = true;
      // THE RELEASE WAITS FOR THE RETAIN. Unmounting before the bytes arrived used to decrement a
      // count that had not been incremented yet: the blob retained a moment later was then held by
      // nobody, so it lived for the whole page AND kept being handed to every later mount of that
      // same face - a stale photo with no owner and no way out.
      void pending.finally(() => releaseUserAvatarDisplayUrl(httpUrl));
    };
  });

  const sizeClasses = $derived(
    fill
      ? 'w-full h-full text-base'
      : size === 'xs'
        ? 'w-4 h-4 text-[0.5rem]'
        : size === 'sm'
          ? 'w-6 h-6 text-xs'
          : size === 'lg'
            ? 'w-12 h-12 text-base'
            : 'w-8 h-8 text-sm'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-2xl');
</script>

{#if imageFailed || display?.kind === 'none'}
  <div
    class="{shapeClasses} shrink-0 shadow-sm ring-1 ring-white/20 select-none {sizeClasses} bg-cn-dark text-cn-yellow flex items-center justify-center overflow-hidden font-bold"
    title={displayLabel}
    aria-label={`Avatar de ${displayLabel}`}
  >
    {initials}
  </div>
{:else}
  <div
    class="{shapeClasses} shrink-0 shadow-sm ring-1 ring-white/20 {sizeClasses} relative overflow-hidden"
    title={displayLabel}
    aria-label={`Avatar de ${displayLabel}`}
  >
    {#if !imageLoaded}
      <!-- Placeholder a initiales affiche immediatement (displayLabel est resolu de facon
           synchrone) : evite l'attente d'un round-trip reseau avant de voir quelque chose. -->
      <div
        class="bg-cn-dark text-cn-yellow absolute inset-0 flex items-center justify-center font-bold select-none"
      >
        {initials}
      </div>
    {/if}
    <!-- `none` is already excluded by the branch above, so this only waits for the answer. -->
    {#if display}
      <!-- THE ELEMENT IS NOT RENDERED BEFORE THE CACHE HAS ANSWERED. It used to be created with
           the HTTP URL straight away and re-pointed at the blob afterwards, so every avatar cost a
           network request the cache existed to avoid. -->
      <img
        src={display.url}
        alt={`Avatar de ${displayLabel}`}
        class="h-full w-full object-cover transition-opacity duration-150 select-none {imageLoaded
          ? 'opacity-100'
          : 'opacity-0'}"
        onload={() => {
          imageLoaded = true;
        }}
        onerror={() => {
          // A blob that will not decode is a damaged cache entry, not an answer about this avatar,
          // so the network is worth asking once. Anything else is a refusal already established.
          if (!triedDirectFallback && display?.kind === 'blob') {
            triedDirectFallback = true;
            display = { kind: 'direct', url: avatarSrc };
            return;
          }
          imageFailed = true;
        }}
      />
    {/if}
  </div>
{/if}
