<script lang="ts">
  import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
  import {
    googleCalendarTemplateUrl,
    buildIcsCalendar,
    downloadTextFile,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';
  import { openExternal } from '$lib/utils/openExternal';
  import { CalendarPlus, Download, ExternalLink } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';

  let { event }: { event: AgendaExportEvent } = $props();

  const os = detectRuntimeDeviceOs('desktop');
  const isAndroid = os === 'android';
  const isIos = os === 'ios';
  const isMac = os === 'macos';
  const isMobile = isAndroid || isIos;

  let showModal = $state(false);

  /** Downloads a single-event ICS file; on iOS/macOS the OS opens it in Calendar. */
  function downloadIcs() {
    downloadTextFile(
      `canari-event-${event.id}.ics`,
      buildIcsCalendar([event]),
      'text/calendar;charset=utf-8'
    );
  }

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (isAndroid) {
      void openExternal(googleCalendarTemplateUrl(event));
    } else if (isIos) {
      downloadIcs();
    } else {
      showModal = true;
    }
  }
</script>

<button
  type="button"
  onclick={handleClick}
  class="shrink-0 p-1.5 rounded-lg text-text-muted hover:text-cn-dark hover:bg-cn-bg/60 transition-colors"
  title="Ajouter à mon calendrier"
>
  <CalendarPlus size={16} />
</button>

{#if !isMobile}
  <Modal title="Ajouter à mon calendrier" open={showModal} onClose={() => (showModal = false)}>
    <div class="flex flex-col gap-2">
      <button
        type="button"
        onclick={() => {
          downloadIcs();
          showModal = false;
        }}
        class="flex items-center gap-3 rounded-xl border border-cn-border px-4 py-3 text-sm font-medium text-text-main hover:bg-cn-bg transition-colors"
      >
        <Download size={18} class="shrink-0 text-text-muted" />
        {isMac ? 'Apple Calendar' : 'iCalendar (Outlook, Thunderbird…)'}
      </button>
      <a
        href={googleCalendarTemplateUrl(event)}
        target="_blank"
        rel="noopener noreferrer"
        onclick={() => (showModal = false)}
        class="flex items-center gap-3 rounded-xl border border-cn-border px-4 py-3 text-sm font-medium text-text-main hover:bg-cn-bg transition-colors"
      >
        <ExternalLink size={18} class="shrink-0 text-text-muted" />
        Google Calendar
      </a>
    </div>
  </Modal>
{/if}
