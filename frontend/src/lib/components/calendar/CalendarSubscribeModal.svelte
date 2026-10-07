<script lang="ts">
  import type { Snippet } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    calendarAppSubscribeUrl,
    googleCalendarSubscribeUrl,
    isPhoneOs,
  } from '$lib/calendar/subscribeLinks';
  import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
  import { navigateExternal } from '$lib/utils/openExternal';
  import { copyText } from '$lib/utils/clipboard';
  import { Log } from '$lib/utils/Log';
  import type { FeedSigningStatus } from '$lib/calendar/signedFeedUrl.svelte';

  /**
   * Subscribe options for an `.ics` feed, ordered by what works on the platform reading them.
   *
   * Which scheme reaches a calendar app is `subscribeLinks.ts`'s question, and its answer differs
   * per platform. Only some platforms register a handler at all - the Mi 9T resolves NONE, measured
   * 2026-10-01 - so the calendar-app link is never offered alone:
   *
   * - **On a phone** the calendar-app link comes first (iOS turns it into a subscription prompt),
   *   then the URL to copy, visible rather than folded, then Google Calendar's add-by-URL. Inside
   *   the app the link leaves the WebView through the opener plugin, and Android REJECTS it when no
   *   activity resolves the intent - so a phone with no handler is TOLD, and pointed at the copy
   *   row, instead of watching a button that did nothing.
   * - **On a desktop** Google Calendar's `cid=` link first, the manual steps and the copy row
   *   folded under it, the calendar-app link last - the order this modal always had there.
   */
  interface Props {
    /** Drawn under the intro: the selector of a feed that needs one (D40). */
    selector?: Snippet;
    open: boolean;
    onClose: () => void;
    /** https:// URL to the .ics feed; empty until computed (e.g. before the component mounts). */
    icsUrl: string;
    /** Intro line shown above the options - context-specific per caller (one club vs. everyone). */
    intro: string;
    /**
     * Where the link's signature stands (2026-10-06): the URL is empty until the server has signed
     * the selection, and an empty URL with `error` is a refusal the reader must be told about.
     */
    signing?: FeedSigningStatus;
  }

  let { open, onClose, icsUrl, intro, selector, signing = 'ready' }: Props = $props();

  const os = detectRuntimeDeviceOs('desktop');
  const isPhone = isPhoneOs(os);

  let isCopied = $state(false);
  let copyFailed = $state(false);
  let appOpenFailed = $state(false);

  const googleUrl = $derived(googleCalendarSubscribeUrl(icsUrl));
  const appUrl = $derived(calendarAppSubscribeUrl(icsUrl, os));

  async function copyCalendarLink() {
    if (!icsUrl) return;
    const copied = await copyText(icsUrl, 'calendar feed URL');
    copyFailed = !copied;
    if (!copied) return;
    isCopied = true;
    setTimeout(() => {
      isCopied = false;
    }, 2000);
  }

  /**
   * Hands the subscription link to the OS. A rejection is the one answer a WebView can get about
   * whether a handler exists (Android's opener rejects an intent nothing resolves), so it is shown,
   * not swallowed.
   */
  async function openInCalendarApp() {
    if (!appUrl) return;
    Log.d('CalendarSubscribe', `opening the calendar-app link on ${os}`);
    appOpenFailed = false;
    try {
      await navigateExternal(appUrl);
    } catch (e) {
      Log.d('CalendarSubscribe', `no app took the subscription link on ${os}: ${String(e)}`);
      appOpenFailed = true;
    }
  }
</script>

{#snippet copyRow()}
  {#if icsUrl}
    <div class="flex flex-col gap-2 sm:flex-row">
      <input
        type="text"
        readonly
        value={icsUrl}
        class="border-cn-border bg-cn-bg text-text-main min-w-0 flex-1 rounded-xl border px-3 py-2 font-mono text-xs"
        onclick={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        onclick={copyCalendarLink}
        class="border-cn-border hover:bg-cn-bg shrink-0 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors"
      >
        {isCopied ? m.asso_calendar_copied() : m.asso_calendar_copy_button()}
      </button>
    </div>
    {#if copyFailed}
      <p class="text-red-err text-xs" role="alert">{m.calendar_subscribe_copy_failed()}</p>
    {/if}
  {/if}
{/snippet}

{#snippet googleSection()}
  <div class="space-y-3" data-subscribe-section="google">
    <h3 class="text-cn-dark text-sm font-bold">{m.asso_calendar_google_title()}</h3>
    {#if googleUrl}
      <a
        href={googleUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="{isPhone
          ? 'border-cn-border text-text-main hover:bg-cn-bg border'
          : 'bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-sm'} inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold transition-colors"
      >
        {m.asso_calendar_google_add_button()}
      </a>
    {/if}

    <details class="group">
      <summary class="text-text-muted hover:text-text-main cursor-pointer">
        {m.asso_calendar_manual_add_summary()}
      </summary>
      <ol class="text-text-muted mt-3 ml-4 list-decimal space-y-1.5 leading-relaxed">
        <li>
          {isPhone ? m.calendar_subscribe_manual_step1_above() : m.asso_calendar_manual_step1()}
        </li>
        <li>
          {m.asso_calendar_manual_step2_open()}
          <a
            href="https://calendar.google.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-cn-dark font-semibold underline"
          >
            {m.asso_calendar_manual_step2_link()}
          </a>
        </li>
        <li>{m.asso_calendar_manual_step3()}</li>
        <li>{m.asso_calendar_manual_step4()}</li>
        <li>{m.asso_calendar_manual_step5()}</li>
      </ol>

      {#if !isPhone}
        <div class="mt-3">
          {@render copyRow()}
        </div>
      {/if}
    </details>
  </div>
{/snippet}

{#snippet appSection()}
  <div class="space-y-3" data-subscribe-section="app">
    <h3 class="text-cn-dark text-sm font-bold">
      {isPhone ? m.calendar_subscribe_app_title() : m.asso_calendar_apple_title()}
    </h3>
    <p class="text-text-muted">
      {isPhone ? m.calendar_subscribe_app_intro() : m.asso_calendar_apple_intro()}
    </p>
    {#if appUrl}
      <button
        type="button"
        onclick={openInCalendarApp}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
      >
        {isPhone ? m.calendar_subscribe_app_button() : m.asso_calendar_apple_subscribe_button()}
      </button>
    {/if}
    {#if appOpenFailed}
      <p class="text-red-err text-xs" role="alert">{m.calendar_subscribe_app_none()}</p>
    {/if}
  </div>
{/snippet}

<Modal {open} title={m.asso_calendar_subscribe_modal_title()} maxWidth="max-w-lg" {onClose}>
  <div class="text-text-main space-y-6 text-sm">
    <p class="text-text-muted">
      {intro}
    </p>

    {@render selector?.()}

    <p class="text-text-muted text-xs" data-subscribe-old-links>
      {m.calendar_subscribe_old_links_notice()}
    </p>
    {#if signing === 'signing'}
      <p class="text-text-muted text-xs" role="status" data-subscribe-signing>
        {m.calendar_subscribe_signing()}
      </p>
    {:else if signing === 'error'}
      <p class="text-red-err text-xs" role="alert" data-subscribe-sign-failed>
        {m.calendar_subscribe_sign_failed()}
      </p>
    {:else if signing === 'unavailable'}
      <p class="text-red-err text-xs" role="alert" data-subscribe-sign-unavailable>
        {m.calendar_subscribe_sign_unavailable()}
      </p>
    {/if}

    {#if isPhone}
      {@render appSection()}
      <div class="space-y-3" data-subscribe-section="copy">
        <h3 class="text-cn-dark text-sm font-bold">{m.calendar_subscribe_copy_title()}</h3>
        {@render copyRow()}
      </div>
      {@render googleSection()}
    {:else}
      {@render googleSection()}
      {@render appSection()}
    {/if}

    <p class="text-text-muted text-2xs">
      {m.asso_calendar_subscribe_note()}
    </p>
  </div>
</Modal>
