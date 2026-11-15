<script lang="ts">
  import { Bell, BellOff } from '@lucide/svelte';
  import AttachmentCard from '$lib/components/shared/AttachmentCard.svelte';
  import CanariLinkPreviewMedia from '$lib/components/shared/CanariLinkPreviewMedia.svelte';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    subscribeFormReminder,
    unsubscribeFormReminder,
    checkFormReminder,
  } from '$lib/posts/api';
  import Button from '$lib/components/ui/Button.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The form this card stands for: the key of its reminder. */
    formId: string;
    /** Where the card goes. */
    href: string;
    title: string;
    /** Whether the viewer has already answered. */
    submitted: boolean;
    /** When the form opens; a past or empty value means it is open now. */
    opensAt?: string | null;
    /** Drawn large, with its call to action: the post's only attachment (`planPostAttachments`). */
    hero?: boolean;
  }

  let { formId, href, title, submitted, opensAt, hero = false }: Props = $props();

  /**
   * AN ATTACHED FORM, IN THE ONE CARD FAMILY (`AttachmentCard`, owner 2026-11-15): the Canari tile,
   * the "Formulaire" chip and the state words of a form LINK's card (`formStateLabel`), so a form
   * reads the same whether it was attached or linked - and a post that does both draws it once
   * (`planPostAttachments`). The reminder bell belongs to the card whenever the form is not open
   * yet and not answered, so a reader never has to open the form to be told when it opens.
   */
  const notOpenYet = $derived(!submitted && formOpensAtIso(opensAt) !== null);

  let subscribed = $state(false);
  let toggling = $state(false);
  /** The form whose reminder state was last asked for: asking is per form, never per re-render. */
  let askedFor: string | null = null;

  // Reactive on the form and on whether it is not open yet - NOT on mount: a card handed its
  // `opensAt` after it mounted (the form is read after the post is drawn) must still get its bell.
  $effect(() => {
    const id = formId;
    if (!notOpenYet || askedFor === id) return;
    askedFor = id;
    checkFormReminder(id)
      .then((res) => {
        if (askedFor === id) subscribed = res.subscribed;
      })
      .catch((err) => {
        Log.d(
          'FORM_CARD',
          `reminder state of form ${id} not read, drawn as not subscribed: ${String(err)}`
        );
      });
  });

  /** The one subtitle line: answered, opening on a date, or open. */
  const status = $derived(
    submitted
      ? m.post_form_response_sent()
      : notOpenYet && opensAt
        ? m.post_form_opens_on_label({ date: formatFormOpensAt(opensAt) })
        : m.link_preview_form_open()
  );

  async function toggleReminder() {
    if (toggling) return;
    toggling = true;
    try {
      if (subscribed) {
        await unsubscribeFormReminder(formId);
        subscribed = false;
      } else {
        await subscribeFormReminder(formId);
        subscribed = true;
      }
    } catch (err) {
      Log.d('FORM_CARD', `reminder toggle of form ${formId} failed: ${String(err)}`);
    } finally {
      toggling = false;
    }
  }
</script>

{#snippet tile()}
  <CanariLinkPreviewMedia preview={null} />
{/snippet}

{#snippet bell()}
  <Button
    variant={subscribed ? 'soft' : 'ghost'}
    size="compact"
    class="shrink-0"
    onclick={toggleReminder}
    disabled={toggling}
    aria-pressed={subscribed}
    data-testid="form-card-bell"
    title={subscribed
      ? m.post_form_disable_reminder_label()
      : m.post_form_notify_when_available_label()}
  >
    {#if subscribed}
      <BellOff size={16} strokeWidth={2} />
      <span class="hidden sm:inline">{m.post_form_reminder_enabled_label()}</span>
    {:else}
      <Bell size={16} strokeWidth={2} />
      <span class="hidden sm:inline">{m.post_form_notify_me_label()}</span>
    {/if}
  </Button>
{/snippet}

<div data-testid="form-card">
  <AttachmentCard
    kind="form"
    {href}
    chip={m.link_label_form()}
    title={title || m.post_form_fallback_title()}
    subtitle={status}
    {tile}
    {hero}
    heroAction={submitted || notOpenYet ? undefined : m.post_form_fill_label()}
    trailing={notOpenYet ? bell : undefined}
  />
</div>
