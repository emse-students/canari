<script lang="ts">
  /**
   * THE FOLDERS, WITH THEIR COUNTS (mockups "Dossiers" and the desktop's first column).
   *
   * The system folders first, in the webmail's order, with the "Suivis" view (every flagged
   * conversation of the mailbox) after the inbox and the archive folder after the drafts; then the
   * account's own folders under "Mes dossiers", nested folders indented. A count is the unread
   * messages, except Drafts, whose count is how many there are (a draft is never unread).
   */
  import {
    Archive,
    FilePen,
    Folder,
    Inbox,
    OctagonAlert,
    Send,
    Star,
    Trash2,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { FolderRole, MailFolder } from '$lib/mail/mailTypes';
  import { isArchiveFolder } from '$lib/mail/mailStore.svelte';
  import { getInitials } from '$lib/utils/avatar';
  import type { MailView } from '$lib/mail/mailView';

  interface Props {
    folders: readonly MailFolder[];
    view: MailView | null;
    /** The signed-in mailbox, drawn at the top. */
    account: { address: string; displayName: string | null };
    onSelect: (view: MailView) => void;
  }

  let { folders, view, account, onSelect }: Props = $props();

  interface Row {
    key: string;
    view: MailView;
    label: string;
    Icon: Component<any>;
    count: number;
    depth: number;
  }

  const ROLE_ICONS: Record<FolderRole, Component<any>> = {
    inbox: Inbox,
    sent: Send,
    drafts: FilePen,
    junk: OctagonAlert,
    trash: Trash2,
  };

  const ROLE_LABELS: Record<FolderRole, () => string> = {
    inbox: m.mail_folder_inbox,
    sent: m.mail_folder_sent,
    drafts: m.mail_folder_drafts,
    junk: m.mail_folder_junk,
    trash: m.mail_folder_trash,
  };

  function folderRow(folder: MailFolder, depth = 0): Row {
    const role = folder.role;
    return {
      key: folder.id,
      view: { kind: 'folder', folderId: folder.id },
      label: role
        ? ROLE_LABELS[role]()
        : isArchiveFolder(folder)
          ? m.mail_folder_archive()
          : folder.name,
      Icon: role ? ROLE_ICONS[role] : isArchiveFolder(folder) ? Archive : Folder,
      count:
        role === 'drafts' ? folder.total : role === 'trash' || role === 'sent' ? 0 : folder.unread,
      depth,
    };
  }

  const systemRows = $derived.by(() => {
    const byRole = (role: FolderRole) => folders.find((f) => f.role === role);
    const rows: Row[] = [];
    const inbox = byRole('inbox');
    if (inbox) rows.push(folderRow(inbox));
    rows.push({
      key: 'flagged',
      view: { kind: 'flagged' },
      label: m.mail_folder_flagged(),
      Icon: Star,
      count: 0,
      depth: 0,
    });
    for (const role of ['sent', 'drafts'] as const) {
      const folder = byRole(role);
      if (folder) rows.push(folderRow(folder));
    }
    const archive = folders.find(isArchiveFolder);
    if (archive) rows.push(folderRow(archive));
    for (const role of ['junk', 'trash'] as const) {
      const folder = byRole(role);
      if (folder) rows.push(folderRow(folder));
    }
    return rows;
  });

  const ownRows = $derived.by(() => {
    const rows: Row[] = [];
    const walk = (list: readonly MailFolder[], depth: number) => {
      for (const folder of list) {
        if (folder.role === null && !isArchiveFolder(folder)) rows.push(folderRow(folder, depth));
        walk(folder.children, depth + 1);
      }
    };
    walk(folders, 0);
    return rows;
  });

  function isCurrent(row: Row): boolean {
    if (!view) return false;
    if (row.view.kind === 'flagged') return view.kind === 'flagged';
    return view.kind === 'folder' && view.folderId === row.view.folderId;
  }

  const accountName = $derived(account.displayName ?? account.address);
</script>

{#snippet folderRowView(row: Row)}
  {@const current = isCurrent(row)}
  <li>
    <Button
      variant="bare"
      class="flex min-h-11 w-full items-center gap-3 rounded-full px-4 text-left {current
        ? 'bg-accent/30 text-text-main font-extrabold'
        : 'text-text-main font-semibold hover:bg-black/5 dark:hover:bg-white/10'}"
      style="padding-left: calc(1rem + {row.depth} * 1rem)"
      aria-current={current ? 'page' : undefined}
      onclick={() => onSelect(row.view)}
      data-mail-folder={row.key}
    >
      <row.Icon
        size={20}
        class={current ? 'text-text-main' : 'text-text-muted'}
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate text-sm">{row.label}</span>
      {#if row.count > 0}
        <span class="text-text-main text-xs font-extrabold">{row.count}</span>
        <span class="sr-only">{m.mail_folder_count_label({ count: row.count })}</span>
      {/if}
    </Button>
  </li>
{/snippet}

<nav aria-label={m.mail_folders_label()} class="flex flex-col gap-2" data-mail-folders>
  <div class="flex items-center gap-3 px-2 py-2">
    <AvatarPlaceholder
      seed={account.address}
      initials={getInitials(accountName)}
      class="h-10 w-10 shrink-0 rounded-full text-base"
    />
    <div class="flex min-w-0 flex-col">
      <span class="text-text-main truncate text-sm font-bold">{m.mail_account_title()}</span>
      <span class="text-text-muted truncate text-xs">{account.address}</span>
    </div>
  </div>
  <ul class="flex flex-col gap-0.5">
    {#each systemRows as row (row.key)}
      {@render folderRowView(row)}
    {/each}
  </ul>
  {#if ownRows.length}
    <p class="text-text-muted px-4 pt-3 text-xs font-bold">
      {m.mail_folders_mine()}
    </p>
    <ul class="flex flex-col gap-0.5">
      {#each ownRows as row (row.key)}
        {@render folderRowView(row)}
      {/each}
    </ul>
  {/if}
</nav>
