<script lang="ts">
  import {
    CircleCheck,
    ClipboardList,
    ArrowRight,
    ExternalLink,
    Clock,
    Bell,
    BellOff,
  } from '@lucide/svelte';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    subscribeFormReminder,
    unsubscribeFormReminder,
    checkFormReminder,
  } from '$lib/posts/api';
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
    /** The status line of an OPEN, unanswered form; defaults to the "fill out" call to action. */
    openLabel?: string;
    /** Taken over by a caller that must route the tap itself (an in-app link inside a post). */
    onclick?: (e: MouseEvent) => void;
  }

  let { formId, href, title, submitted, opensAt, openLabel, onclick }: Props = $props();

  /**
   * THE ONE FORM CARD: an attached form and a form link inside a post draw this and nothing else.
   * The reminder bell belongs to the card whenever the form is not open yet and not answered, so a
   * reader never has to open the form to be told when it opens.
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

<div
  class="bg-cn-surface relative flex items-center rounded-2xl border border-black/5 shadow-sm transition-all duration-300 dark:border-white/10 {submitted
    ? 'hover:border-emerald-500/30'
    : 'hover:border-accent/30'}"
  data-testid="form-card"
>
  <a
    {href}
    {onclick}
    class="group focus-visible:ring-accent/50 flex min-w-0 flex-1 items-center justify-between rounded-2xl p-4 outline-none focus-visible:ring-4"
  >
    <div class="flex min-w-0 items-center gap-3.5">
      <div
        class="shrink-0 rounded-xl p-2.5 transition-colors {submitted
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-accent/10 text-accent-text group-hover:bg-accent/20'}"
      >
        {#if submitted}
          <CircleCheck size={20} strokeWidth={2.5} />
        {:else}
          <ClipboardList size={20} strokeWidth={2.5} />
        {/if}
      </div>

      <div class="min-w-0 flex-1">
        <h3
          class="text-text-main truncate text-sm font-bold transition-colors {submitted
            ? 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400'
            : 'group-hover:text-accent-text'}"
        >
          {title || m.post_form_fallback_title()}
        </h3>
        <p
          class="text-2xs mt-0.5 font-semibold {submitted
            ? 'text-emerald-600/80 dark:text-emerald-400/80'
            : 'text-text-muted'}"
        >
          {#if submitted}
            {m.post_form_response_sent()}
          {:else if notOpenYet && opensAt}
            <span class="inline-flex items-center gap-1">
              <Clock size={12} strokeWidth={2.5} />
              {m.post_form_opens_on_label({ date: formatFormOpensAt(opensAt) })}
            </span>
          {:else}
            {openLabel ?? m.post_form_fill_label()}
          {/if}
        </p>
      </div>
    </div>

    <div
      class="ml-4 shrink-0 opacity-40 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100 {submitted
        ? 'group-hover:text-emerald-500'
        : 'group-hover:text-accent-text'}"
    >
      {#if submitted}
        <ArrowRight size={18} strokeWidth={2.5} />
      {:else}
        <ExternalLink size={18} strokeWidth={2.5} />
      {/if}
    </div>
  </a>

  {#if notOpenYet}
    <button
      type="button"
      onclick={toggleReminder}
      disabled={toggling}
      aria-pressed={subscribed}
      data-testid="form-card-bell"
      class="focus-visible:ring-accent/50 mr-3 flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors outline-none focus-visible:ring-4 {subscribed
        ? 'bg-accent/10 text-accent-text hover:bg-accent/20'
        : 'text-text-muted hover:text-text-main hover:bg-text-main/10'}"
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
    </button>
  {/if}
</div>
