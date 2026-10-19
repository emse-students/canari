<script lang="ts">
  import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
  import {
    googleCalendarTemplateUrl,
    buildIcsCalendar,
    downloadTextFile,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';
  import { navigateExternal, isTauriRuntime } from '$lib/utils/openExternal';
  import { Log } from '$lib/utils/Log';
  import { showToast } from '$lib/stores/toast.svelte';
  import { CalendarPlus, Download, ExternalLink } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    event: AgendaExportEvent;
    /**
     * Asks for the hosted `.ics` URL at the moment it is needed, when the event carries none: a
     * signed link (a booking's, D13) is fetched on the tap, never for every card on screen.
     */
    resolveIcsUrl?: () => Promise<string>;
  }

  let { event, resolveIcsUrl }: Props = $props();
  const hasHostedFile = $derived(Boolean(event.icsUrl || resolveIcsUrl));

  const os = detectRuntimeDeviceOs('desktop');
  const isAndroid = os === 'android';
  const isIos = os === 'ios';
  const isMac = os === 'macos';

  let showModal = $state(false);

  /** Downloads a single-event ICS file; on iOS/macOS the OS opens it in Calendar. */
  function downloadIcs() {
    downloadTextFile(
      `canari-event-${event.id}.ics`,
      buildIcsCalendar([event]),
      'text/calendar;charset=utf-8'
    );
  }

  /**
   * Hands the server-hosted `.ics` of this event to the system browser, which gives it to the
   * calendar app: iOS Safari answers a text/calendar response with its "Add to Calendar" sheet,
   * Android downloads it for whichever app owns .ics. Our own backend's URL, so no Safe Browsing
   * round trip (`navigateExternal`'s contract); on the web a new tab keeps the SPA alive.
   */
  async function openHostedIcs() {
    Log.d('AddToCalendar', `opening the hosted .ics of ${event.id} on ${os}`);
    // A browser opens a tab only inside the tap itself: when the URL must be asked for first, the
    // tab is opened now and pointed at it once it is known.
    const pending = !isTauriRuntime() && !event.icsUrl ? window.open('', '_blank') : null;
    try {
      const url = event.icsUrl ?? (await resolveIcsUrl!());
      if (isTauriRuntime()) await navigateExternal(url);
      else if (pending) {
        pending.opener = null;
        pending.location.href = url;
      } else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      pending?.close();
      Log.i('AddToCalendar', `the hosted .ics did not open on ${os}: ${String(e)}`);
      showToast(m.calendar_add_failed(), 'error');
    }
  }

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (isIos) {
      // A pending event is not in the feed, so it has no hosted file: the local one is saved to
      // Files, which is all a WebView can do with a blob.
      if (hasHostedFile) void openHostedIcs();
      else downloadIcs();
    } else {
      showModal = true;
    }
  }
</script>

<button
  type="button"
  onclick={handleClick}
  class="ui-icon-button text-text-muted hover:text-cn-dark hover:bg-cn-bg rounded-lg transition-colors"
  title={m.calendar_add_title()}
  aria-label={m.calendar_add_title()}
>
  <CalendarPlus size={16} />
</button>

{#if !isIos}
  <Modal title={m.calendar_add_title()} open={showModal} onClose={() => (showModal = false)}>
    <div class="flex flex-col gap-2">
      <button
        type="button"
        onclick={() => {
          if (isAndroid && hasHostedFile) void openHostedIcs();
          else downloadIcs();
          showModal = false;
        }}
        class="border-cn-border text-text-main hover:bg-cn-bg flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition-colors"
      >
        <Download size={18} class="text-text-muted shrink-0" />
        {isAndroid
          ? m.calendar_add_android_app()
          : isMac
            ? 'Apple Calendar'
            : 'iCalendar (Outlook, Thunderbird…)'}
      </button>
      <a
        href={googleCalendarTemplateUrl(event)}
        target="_blank"
        rel="noopener noreferrer"
        onclick={() => (showModal = false)}
        class="border-cn-border text-text-main hover:bg-cn-bg flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition-colors"
      >
        <ExternalLink size={18} class="text-text-muted shrink-0" />
        Google Calendar
      </a>
    </div>
  </Modal>
{/if}
