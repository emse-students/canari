<script lang="ts">
  /**
   * THE ACTIONS ON A SELECTION OR ON THE OPEN CONVERSATION (mockups "Sélection multiple", "Lecture
   * d'un fil"): archive, trash, read or unread, and "Plus d'actions" (move, flag, spam) in a sheet.
   * The bar only names what was pressed; the screen applies it in ONE call for every id.
   */
  import { Archive, ArrowLeft, Ellipsis, Mail, MailOpen, Trash2, X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailUiAction } from '$lib/mail/mailView';

  interface Props {
    /** `selection` draws the count and a close; `thread` a back arrow. */
    mode: 'selection' | 'thread';
    /** How many conversations are selected (selection mode). */
    count?: number;
    /** Whether any of them is unread: the read toggle marks read, otherwise unread. */
    anyUnread: boolean;
    /** The folder listed is the archive folder: no archive action. */
    canArchive: boolean;
    /** The back arrow / the close is drawn. */
    showBack?: boolean;
    onBack: () => void;
    onAction: (action: MailUiAction) => void;
    onMore: () => void;
  }

  let {
    mode,
    count = 0,
    anyUnread,
    canArchive,
    showBack = true,
    onBack,
    onAction,
    onMore,
  }: Props = $props();
</script>

<div
  class="flex min-h-14 items-center gap-1 px-2 {mode === 'selection' ? 'bg-accent/20' : ''}"
  data-mail-action-bar={mode}
>
  {#if showBack}
    <Button
      variant="ghost"
      icon
      aria-label={mode === 'selection' ? m.mail_selection_close() : m.mail_back()}
      onclick={onBack}
    >
      {#if mode === 'selection'}<X size={22} />{:else}<ArrowLeft size={22} />{/if}
    </Button>
  {/if}
  {#if mode === 'selection'}
    <span class="text-text-main flex-1 px-2 text-base font-extrabold" aria-live="polite">
      {m.mail_selection_count({ count })}
    </span>
  {:else}
    <span class="flex-1"></span>
  {/if}
  {#if canArchive}
    <Button
      variant="ghost"
      icon
      aria-label={m.mail_action_archive()}
      onclick={() => onAction('archive')}
    >
      <Archive size={22} />
    </Button>
  {/if}
  <Button variant="ghost" icon aria-label={m.mail_action_trash()} onclick={() => onAction('trash')}>
    <Trash2 size={22} />
  </Button>
  {#if anyUnread}
    <Button variant="ghost" icon aria-label={m.mail_action_read()} onclick={() => onAction('read')}>
      <MailOpen size={22} />
    </Button>
  {:else}
    <Button
      variant="ghost"
      icon
      aria-label={m.mail_action_unread()}
      onclick={() => onAction('unread')}
    >
      <Mail size={22} />
    </Button>
  {/if}
  <Button variant="ghost" icon aria-label={m.mail_action_more()} onclick={onMore}>
    <Ellipsis size={22} />
  </Button>
</div>
