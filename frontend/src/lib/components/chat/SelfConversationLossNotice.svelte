<script lang="ts">
  /**
   * THE LOSS NOTICE OF "MES NOTES" (owner, 2026-11-22, charter principle 2): while a single device
   * holds the notes (active, of a build that knows them, seated in the group), the conversation says
   * that losing it loses the notes, and links the `.canari` backup. The notes are end-to-end
   * encrypted (principle 1), so nothing on the server can bring them back. Read once per opening of
   * the conversation; an unreadable device list or seat list says nothing
   * (`readSelfConversationDeviceCover`).
   */
  import { HardDriveDownload } from '@lucide/svelte';
  import { resolve } from '$app/paths';
  import { globalSession as session } from '$lib/stores/globalChatSingleton.svelte';
  import {
    readSelfConversationDeviceCover,
    type SelfConversationDeviceCover,
  } from '$lib/utils/chat/selfConversationLossNotice';
  import { m } from '$lib/paraglide/messages';

  let { groupId }: { groupId: string } = $props();

  let cover = $state<SelfConversationDeviceCover>('unknown');

  $effect(() => {
    // Keyed by the conversation: a new opening reads again.
    void groupId;
    const userId = session.userId;
    let cancelled = false;
    cover = 'unknown';
    const mls = session.ensureMls();
    void readSelfConversationDeviceCover({
      listDevices: () => mls.listUserDevices(userId),
      listSeatedDevices: () => mls.getGroupMembers(groupId),
    }).then((read) => {
      if (!cancelled) cover = read;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if cover === 'single'}
  <div
    class="bg-cn-surface-alt text-text-main mx-auto my-2 flex max-w-xl flex-col gap-2 rounded-lg px-4 py-3 text-sm"
    role="note"
    data-self-conversation-loss-notice
  >
    <p class="leading-snug">{m.conversation_self_loss_notice()}</p>
    <a
      href={resolve('/settings/[section]', { section: 'backup' })}
      class="text-accent inline-flex min-h-11 items-center gap-2 self-start font-semibold"
    >
      <HardDriveDownload size={16} aria-hidden="true" />
      {m.conversation_self_loss_backup()}
    </a>
  </div>
{/if}
