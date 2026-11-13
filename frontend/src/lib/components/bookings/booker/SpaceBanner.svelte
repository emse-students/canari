<script lang="ts">
  import { CalendarClock, MessageCircle, QrCode, Settings2, Share2 } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { internalPath } from '$lib/utils/internalPath';
  import Button from '$lib/components/ui/Button.svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import type { BookerSpace } from '$lib/bookings/api';
  import { spaceDashboardHref, spaceHref } from '$lib/bookings/routes';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import { canShareOut, runShareOut, shareTextOut } from '$lib/sharing/shareOut';
  import { getSavedUserId } from '$lib/stores/user';
  import { requestDirectConversationWith } from '$lib/utils/chat/pendingChatOpening';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE HEAD OF A SPACE'S PAGE (D44, D45): its picture as a banner, its name, its description and the
   * labelled "Partager", "QR code" and - for whoever manages it - "Gerer" buttons that were two bare
   * icons. "Partager" opens the system share sheet where the build has one (the phone apps) and
   * copies the link, with the helper's confirmation, everywhere else: the same split the post share
   * makes, never a copy standing in for a sheet that failed to open.
   */
  interface Props {
    space: BookerSpace;
    onQr: () => void;
  }

  let { space, onQr }: Props = $props();

  function share() {
    if (canShareOut()) {
      void runShareOut(`space ${space.id.slice(0, 8)}`, () =>
        shareTextOut(publicAppUrl(spaceHref(space.id)))
      );
    } else {
      void copyPublicShareLink(spaceHref(space.id));
    }
  }

  /** The person responsible, unless that is the reader: nobody writes to themselves. */
  const contact = $derived(
    space.contact && space.contact.userId !== getSavedUserId() ? space.contact : null
  );

  /**
   * Asks the chat page for the DM with the person responsible - found or created there, the same
   * hand-over as a profile's "Message" button (`pendingChatOpening.ts`).
   */
  function writeToContact() {
    const owner = getSavedUserId();
    if (!contact || !owner) {
      console.warn('[BOOKINGS] "Contact" pressed with no contact or no signed-in account');
      return;
    }
    Log.d(`[BOOKINGS] "Contact": asking the chat page for the DM with the space's responsible`);
    requestDirectConversationWith(owner, contact.userId, sessionStorage);
    goto(resolve('/chat'));
  }

  const button =
    'border-cn-border bg-cn-bg text-text-main hover:bg-cn-border/30 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors';
</script>

<div class="mb-4 space-y-3">
  {#if space.poster}
    <!-- Capped on a desktop (owner, 2026-11-01): the grid below, not the picture, is the page. -->
    <div class="md:max-w-2xl">
      <SpacePoster poster={space.poster} alt={m.bookings_poster_alt({ name: space.name })} />
    </div>
  {:else}
    <div
      class="border-cn-border from-accent/25 to-cn-bg text-text-muted/60 flex h-28 w-full items-center justify-center overflow-hidden rounded-xl border bg-linear-to-br sm:h-40"
      aria-hidden="true"
      data-testid="space-banner-placeholder"
    >
      <CalendarClock size={48} />
    </div>
  {/if}

  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div class="min-w-0">
      <h1 class="text-text-main text-2xl font-bold break-words">{space.name}</h1>
      {#if space.description}
        <p class="text-text-main mt-1 text-sm">{space.description}</p>
      {/if}
      {#if contact}
        <p
          class="text-text-muted mt-2 flex flex-wrap items-center gap-2 text-sm"
          data-testid="space-contact"
        >
          <span>{m.bookings_space_contact_label({ name: contact.displayName })}</span>
          <Button variant="secondary" size="compact" onclick={writeToContact}>
            <MessageCircle size={16} />{m.bookings_space_contact_button()}
          </Button>
        </p>
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-2 sm:shrink-0">
      <button type="button" class={button} onclick={share}>
        <Share2 size={16} />{m.bookings_space_share()}
      </button>
      <button type="button" class={button} onclick={onQr}>
        <QrCode size={16} />{m.qr_button()}
      </button>
      {#if space.canManage}
        <a href={resolve(internalPath(spaceDashboardHref(space.id)))} class={button}>
          <Settings2 size={16} />{m.bookings_space_manage_short()}
        </a>
      {/if}
    </div>
  </div>
</div>
