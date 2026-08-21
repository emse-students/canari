<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Subscribe options for an `.ics` feed. `webcal:` is historically defined as equivalent to
   * `http:`, not `https:` - a client that follows that literally (confirmed against Thunderbird)
   * requests plain HTTP, gets Cloudflare's 301 to HTTPS, and refuses to follow a cross-scheme
   * redirect for a calendar subscription, reporting no calendar found at the address. `webcals:`
   * is the less-common but real secure counterpart (equivalent to `https:`), which is what this
   * component hands out since our feed is always HTTPS-only - never plain `webcal:`, which can
   * only ever break against us. Even so, only some clients have a registered handler for either
   * scheme at all, and clicking one with none does nothing, no error, no dialog - so Google
   * Calendar's `cid=` link (works anywhere a browser does) and copy-the-URL-and-paste-it are
   * offered alongside rather than in place of it.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    /** https:// URL to the .ics feed; empty until computed (e.g. before the component mounts). */
    icsUrl: string;
    /** Intro line shown above the options - context-specific per caller (one club vs. everyone). */
    intro: string;
  }

  let { open, onClose, icsUrl, intro }: Props = $props();

  let isCopied = $state(false);

  const googleCalendarSubscribeUrl = $derived.by(() => {
    if (!icsUrl) return '';
    const httpUrl = icsUrl.replace(/^https:/, 'http:');
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(httpUrl)}`;
  });

  const webcalUrl = $derived(
    icsUrl ? icsUrl.replace(/^https:/, 'webcals:').replace(/^http:/, 'webcal:') : ''
  );

  function copyCalendarLink() {
    if (!icsUrl) return;
    void navigator.clipboard.writeText(icsUrl);
    isCopied = true;
    setTimeout(() => {
      isCopied = false;
    }, 2000);
  }
</script>

<Modal {open} title={m.asso_calendar_subscribe_modal_title()} maxWidth="max-w-lg" {onClose}>
  <div class="text-text-main space-y-6 text-sm">
    <p class="text-text-muted">
      {intro}
    </p>

    <div class="space-y-3">
      <h3 class="text-cn-dark text-sm font-bold">{m.asso_calendar_google_title()}</h3>
      {#if googleCalendarSubscribeUrl}
        <a
          href={googleCalendarSubscribeUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
        >
          {m.asso_calendar_google_add_button()}
        </a>
      {/if}

      <details class="group">
        <summary class="text-text-muted hover:text-text-main cursor-pointer">
          {m.asso_calendar_manual_add_summary()}
        </summary>
        <ol class="text-text-muted mt-3 ml-4 list-decimal space-y-1.5 leading-relaxed">
          <li>{m.asso_calendar_manual_step1()}</li>
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

        {#if icsUrl}
          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              readonly
              value={icsUrl}
              class="border-cn-border bg-cn-bg/50 text-text-main min-w-0 flex-1 rounded-xl border px-3 py-2 font-mono text-xs"
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
        {/if}
      </details>
    </div>

    <div class="space-y-3">
      <h3 class="text-cn-dark text-sm font-bold">{m.asso_calendar_apple_title()}</h3>
      <p class="text-text-muted">
        {m.asso_calendar_apple_intro()}
      </p>
      {#if webcalUrl}
        <a
          href={webcalUrl}
          class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
        >
          {m.asso_calendar_apple_subscribe_button()}
        </a>
      {/if}
    </div>

    <p class="text-text-muted text-[11px]">
      {m.asso_calendar_subscribe_note()}
    </p>
  </div>
</Modal>
