<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import { birthdaysToday } from '$lib/birthdays/birthdaysToday.svelte';
  import { confettiLayout } from '$lib/birthdays/confettiLayout';
  import { getInitials } from '$lib/utils/avatar';
  import { avatarUrl } from '$lib/utils/avatarUrl';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    releaseUserAvatarDisplay,
    resolveUserAvatarDisplay,
    type AvatarDisplay,
  } from '$lib/utils/userAvatarCache';

  interface Props {
    /** ID of the user whose avatar should be displayed. */
    userId: string;
    /** Avatar size preset. */
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
    /** When true, the avatar stretches to fill its container instead of using a preset size. */
    fill?: boolean;
    /** Border-radius style of the avatar. */
    shape?: 'soft' | 'circle';
    /** Text used for initials when the display name cannot be resolved. */
    fallbackLabel?: string;
  }

  let { userId, size = 'md', fill = false, shape = 'circle', fallbackLabel = '' }: Props = $props();

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

  // ONE EFFECT, AND IT OWNS EVERY PIECE OF PER-FACE STATE. A second effect used to reset the same
  // flags when `userId` changed, which is the same event by another name, so the two raced to reset
  // each other on every switch. The cache is keyed by the id, never by the URL: the URL carries the
  // viewer's avatar token (`avatarUrl.ts`), which the cache builds at the request.
  $effect(() => {
    const subject = userId;
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
    const pending = resolveUserAvatarDisplay(subject).then((resolved) => {
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
      void pending.finally(() => releaseUserAvatarDisplay(subject));
    };
  });

  const textClass = $derived(
    fill
      ? 'text-base'
      : size === 'xs'
        ? 'text-2xs'
        : size === 'sm'
          ? 'text-xs'
          : size === 'xl'
            ? 'text-lg'
            : size === 'lg'
              ? 'text-base'
              : 'text-sm'
  );
  const boxClass = $derived(
    fill
      ? 'w-full h-full'
      : size === 'xs'
        ? 'w-4 h-4'
        : size === 'sm'
          ? 'w-6 h-6'
          : size === 'xl'
            ? 'w-14 h-14'
            : size === 'lg'
              ? 'w-12 h-12'
              : 'w-8 h-8'
  );
  const shapeClasses = $derived(shape === 'circle' ? 'rounded-full' : 'squircle');
  /**
   * THE BIRTHDAY RING (decision 3, docs/wiki/birthdays.md): drawn HERE, on the one component every
   * person's face goes through, for a member whose birthday the server says is today - to every
   * reader, wherever the face appears, never per call site.
   *
   * The ring sits FLUSH against the photo and OUTSIDE it, with confetti floating round it, so the
   * decoration cannot live inside the `overflow-hidden` face. EVERY avatar is therefore a WRAPPER
   * with the avatar's own layout box (`boxClass`, so nothing reflows) around the clipped face; a
   * celebrating one adds the ring and the confetti as SIBLINGS of the face, which only overflow
   * visually. The wrapper is always there so the face node is the same node before and after a
   * member starts celebrating at runtime: its loaded photo is kept, and no placeholder flashes.
   * When a presence dot also applies (ChatHeader), the dot is a sibling painted after the wrapper,
   * so it WINS the bottom-right corner over the ring.
   */
  const celebrating = $derived(identified && birthdaysToday.has(userId));
  let wrap = $state<HTMLElement | null>(null);
  /**
   * The wrapper's measured width in px, 0 until measured. THE CONFETTI IS NOT DRAWN BEFORE IT IS
   * KNOWN: its count and its piece sizes depend on the size, so drawing at a guess and redrawing
   * would make the pieces jump. Only a celebrating avatar observes its box (one observer per
   * celebrated face, none for the other thousands).
   */
  let measuredPx = $state(0);
  $effect(() => {
    if (!celebrating || !wrap) {
      measuredPx = 0;
      return;
    }
    const el = wrap;
    const read = () => {
      measuredPx = el.offsetWidth;
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  });
  const confetti = $derived(celebrating && measuredPx > 0 ? confettiLayout(measuredPx) : []);
</script>

{#snippet face()}
  <!-- The ring and the confetti are POSITIONED, and a positioned element paints above a static one:
       the face must be positioned too (`relative`) or the ring disc would be drawn over it. -->
  {#if imageFailed || display?.kind === 'none'}
    <AvatarPlaceholder
      seed={userId}
      {initials}
      class="{shapeClasses} h-full w-full shrink-0 overflow-hidden shadow-sm {textClass} relative"
      title={displayLabel}
      ariaLabel={m.avatar_aria_label({ name: displayLabel })}
    />
  {:else}
    <div
      class="{shapeClasses} h-full w-full shrink-0 shadow-sm {textClass} relative overflow-hidden"
      title={displayLabel}
      aria-label={m.avatar_aria_label({ name: displayLabel })}
    >
      {#if !imageLoaded}
        <!-- Placeholder a initiales affiche immediatement (displayLabel est resolu de facon
             synchrone) : evite l'attente d'un round-trip reseau avant de voir quelque chose. -->
        <AvatarPlaceholder seed={userId} {initials} class="absolute inset-0" />
      {/if}
      <!-- `none` is already excluded by the branch above, so this only waits for the answer. -->
      {#if display}
        <!-- THE ELEMENT IS NOT RENDERED BEFORE THE CACHE HAS ANSWERED. It used to be created with
             the HTTP URL straight away and re-pointed at the blob afterwards, so every avatar cost a
             network request the cache existed to avoid. -->
        <img
          src={display.url}
          alt={m.avatar_aria_label({ name: displayLabel })}
          decoding="async"
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
              display = { kind: 'direct', url: avatarUrl(userId) };
              return;
            }
            imageFailed = true;
          }}
        />
      {/if}
    </div>
  {/if}
{/snippet}

<div
  class="avatar-wrap shrink-0 {boxClass}"
  data-birthday={celebrating ? 'today' : undefined}
  bind:this={wrap}
>
  {#if celebrating}
    <span class="birthday-ring {shapeClasses}" aria-hidden="true"></span>
  {/if}
  {@render face()}
  {#each confetti as piece, i (i)}
    <span
      class="birthday-confetti {piece.dot ? 'birthday-confetti-dot' : ''}"
      aria-hidden="true"
      data-confetti
      style="left:{piece.xPct}%;top:{piece.yPct}%;width:{piece.widthPx}px;height:{piece.heightPx}px;background:var(--birthday-c{piece.colour});--birthday-rot:{piece.rotationDeg}deg;--birthday-delay:{piece.delayS}s"
    ></span>
  {/each}
</div>
