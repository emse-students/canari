<script lang="ts">
  /**
   * THE MAIL TAB (docs/wiki/mail-client-transport.md#as-built---lot-3; mockups validated by the owner,
   * 2026-11-27).
   *
   * It renders what the session's state says: the sign-in (password only), a closed or unavailable
   * account, or the mailbox. The mailbox is ONE column below `xl` - the list, the open conversation in
   * its place, the folders in a drawer, "Écrire" as a floating button - and THREE from `xl` up:
   * folders, list, conversation. The layout is chosen by the viewport (`overlayLayout`), not hidden
   * by a breakpoint, so the column that is not drawn is not mounted.
   *
   * Every action is ONE call for every id (`MailStore.act`, `MailStore.archive`), and its failure is
   * said in the reader's words (`mailErrorText`). An action that takes the open conversation out of
   * the folder closes it.
   */
  import { untrack } from 'svelte';
  import {
    Archive,
    CircleSlash,
    FolderInput,
    Inbox,
    Mail,
    MailX,
    Menu,
    OctagonAlert,
    Pencil,
    ShieldCheck,
    Star,
    StarOff,
    Trash2,
    Wrench,
  } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import type { MenuListSection } from '$lib/components/ui/menuList';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';
  import AvatarPlaceholder from '$lib/components/shared/AvatarPlaceholder.svelte';
  import MailActionBar from './MailActionBar.svelte';
  import MailCompose from './MailCompose.svelte';
  import MailFolderList from './MailFolderList.svelte';
  import MailList from './MailList.svelte';
  import MailSignIn from './MailSignIn.svelte';
  import MailStatePanel from './MailStatePanel.svelte';
  import MailThread from './MailThread.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MailClient } from '$lib/mail/mailClient.svelte';
  import { emptyMessage, forwardMessage, replyMessage } from '$lib/mail/mailCompose';
  import { classifyMailFailure } from '$lib/mail/mailErrors';
  import { mailErrorText } from '$lib/mail/mailErrorText';
  import { mailListQuery, type MailListFilter } from '$lib/mail/mailFormat';
  import { mailSwipeSides, type MailSwipeAction } from '$lib/mail/mailGestures';
  import { isArchiveFolder } from '$lib/mail/mailStore.svelte';
  import type { MailMessage, MailActionOp } from '$lib/mail/mailTypes';
  import {
    viewScope,
    type MailComposeState,
    type MailUiAction,
    type MailView,
  } from '$lib/mail/mailView';
  import { flattenFolders } from '$lib/mail/zimbraParse';
  import { overlayLayout } from '$lib/stores/phoneViewport.svelte';
  import { startSchoolMailActivation } from '$lib/stores/auth';
  import { showToast } from '$lib/stores/toast.svelte';
  import { getInitials } from '$lib/utils/avatar';
  import { Log } from '$lib/utils/Log';

  interface Props {
    client: MailClient;
    /** The conversation open (the route's), or none. */
    conversationId: string | null;
    /** Opens a conversation, or goes back to the list (`null`). */
    onNavigate: (conversationId: string | null) => void;
    /** The folder drawer (narrow layout). */
    drawerOpen?: boolean;
    /** The composer, when open. */
    compose?: MailComposeState | null;
  }

  let {
    client,
    conversationId,
    onNavigate,
    drawerOpen = $bindable(false),
    compose = $bindable(null),
  }: Props = $props();

  const store = $derived(client.store);
  const session = $derived(store.sessionState);
  const wide = $derived(!overlayLayout());

  let address = $state<string | null>(null);
  let addressRead = $state(false);
  let view = $state<MailView | null>(null);
  let search = $state('');
  let filter = $state<MailListFilter>('all');
  /** The ids a "Plus d'actions" or "Déplacer vers" sheet acts on, and whether they are flagged. */
  let sheet = $state<{ kind: 'more' | 'move'; ids: string[]; flagged: boolean } | null>(null);
  /** "Se reconnecter" pressed on a closed or unavailable account: the sign-in form is drawn. */
  let signInAsked = $state(false);

  $effect(() => {
    const c = client;
    untrack(() => {
      addressRead = false;
      void c.ownAddress().then((a) => {
        address = a;
        addressRead = true;
      });
    });
  });

  const account = $derived(session.kind === 'ready' ? session.account : null);
  const self = $derived(account ? [account.address, ...account.aliases] : []);
  const folders = $derived(store.folders);
  const currentFolder = $derived(store.currentFolder);
  const inArchive = $derived(currentFolder !== null && isArchiveFolder(currentFolder));
  const sides = $derived(mailSwipeSides(currentFolder?.role ?? null, inArchive));
  const selecting = $derived(store.selected.length > 0);

  /** The open list's title: the folder's name in the reader's words, or "Suivis". */
  const listTitle = $derived.by(() => {
    if (view?.kind === 'flagged') return m.mail_folder_flagged();
    const folder = currentFolder;
    if (!folder) return m.mail_title();
    switch (folder.role) {
      case 'inbox':
        return m.mail_folder_inbox();
      case 'sent':
        return m.mail_folder_sent();
      case 'drafts':
        return m.mail_folder_drafts();
      case 'junk':
        return m.mail_folder_junk();
      case 'trash':
        return m.mail_folder_trash();
      default:
        return isArchiveFolder(folder) ? m.mail_folder_archive() : folder.name;
    }
  });

  /** Lists `next` with the current search and filter. */
  async function openView(next: MailView) {
    view = next;
    const { folderId, term } = viewScope(next);
    await store.openFolder(
      folderId,
      [mailListQuery(search, filter), term].filter(Boolean).join(' ')
    );
  }

  /** The mailbox just opened (a sign-in, a resume): folders, then the inbox. */
  async function openMailbox() {
    Log.d('MAIL-UI', 'mailbox opened - folders and inbox');
    await store.refreshFolders();
    const inbox = store.folders.find((f) => f.role === 'inbox');
    if (inbox) await openView({ kind: 'folder', folderId: inbox.id });
  }

  $effect(() => {
    if (session.kind !== 'ready') return;
    untrack(() => {
      signInAsked = false;
      if (!store.opened) void openMailbox();
    });
  });

  async function refresh() {
    await store.refreshFolders();
    if (view) await openView(view);
  }

  function selectView(next: MailView) {
    drawerOpen = false;
    store.clearSelection();
    if (conversationId) onNavigate(null);
    void openView(next);
  }

  function onQuery(nextSearch: string, nextFilter: MailListFilter) {
    search = nextSearch;
    filter = nextFilter;
    if (view) void openView(view);
  }

  /** The actions that take a conversation out of the list it was opened from. */
  const LEAVES: ReadonlySet<MailUiAction> = new Set([
    'archive',
    'trash',
    'spam',
    'not_spam',
    'delete',
  ]);

  /** Applies `action` to `ids` in ONE call; says a failure; closes the conversation if it left. */
  async function apply(action: MailUiAction, ids: string[]) {
    if (action === 'move') {
      sheet = { kind: 'move', ids, flagged: false };
      return;
    }
    sheet = null;
    Log.d('MAIL-UI', `action ${action} on ${ids.length}`);
    try {
      if (action === 'archive') await store.archive(ids);
      else await store.act(action as MailActionOp, ids, spamDestination(action));
      if (conversationId && ids.includes(conversationId) && LEAVES.has(action)) onNavigate(null);
    } catch (err) {
      showToast(mailErrorText(classifyMailFailure(err).kind));
    }
  }

  /** "Pas indésirable" moves back to the inbox. */
  function spamDestination(action: MailUiAction): string | undefined {
    return action === 'not_spam' ? folders.find((f) => f.role === 'inbox')?.id : undefined;
  }

  async function moveTo(folderId: string) {
    const ids = sheet?.ids ?? [];
    sheet = null;
    Log.d('MAIL-UI', `move ${ids.length}`);
    try {
      await store.act('move', ids, folderId);
      if (conversationId && ids.includes(conversationId)) onNavigate(null);
    } catch (err) {
      showToast(mailErrorText(classifyMailFailure(err).kind));
    }
  }

  function swiped(action: MailSwipeAction, id: string) {
    void apply(action, [id]);
  }

  function openCompose(kind: 'new' | 'reply' | 'reply_all' | 'forward', original?: MailMessage) {
    Log.d('MAIL-UI', `compose ${kind}`);
    const initial =
      kind === 'new' || !original
        ? emptyMessage()
        : kind === 'forward'
          ? forwardMessage(original)
          : replyMessage(original, kind, account ?? { address: '', aliases: [] });
    const title =
      kind === 'new'
        ? m.mail_compose_new()
        : kind === 'forward'
          ? m.mail_forward()
          : kind === 'reply_all'
            ? m.mail_reply_all()
            : m.mail_reply();
    compose = { initial, title };
  }

  async function signIn(password: string, remember: boolean) {
    await client.session.signIn(password, remember);
  }

  /**
   * "Activer le mail": lot 1's re-run of the MiConnect sign-in, which brings the school address and
   * comes back here. It leaves the page.
   */
  async function activate() {
    await startSchoolMailActivation('/mail');
  }

  async function retryUnavailable() {
    try {
      if (!(await client.session.resume())) signInAsked = true;
    } catch (err) {
      showToast(mailErrorText(classifyMailFailure(err).kind));
    }
  }

  const sheetSections = $derived.by((): MenuListSection[] => {
    if (!sheet) return [];
    const junk = currentFolder?.role === 'junk';
    const trash = currentFolder?.role === 'trash';
    return [
      {
        items: [
          { key: 'move', label: m.mail_action_move(), Icon: FolderInput },
          sheet.flagged
            ? { key: 'unflag', label: m.mail_action_unflag(), Icon: StarOff }
            : { key: 'flag', label: m.mail_action_flag(), Icon: Star },
          junk
            ? { key: 'not_spam', label: m.mail_action_not_spam(), Icon: ShieldCheck }
            : { key: 'spam', label: m.mail_action_spam(), Icon: OctagonAlert },
          ...(trash
            ? [{ key: 'delete', label: m.mail_action_delete(), Icon: CircleSlash, danger: true }]
            : []),
        ],
      },
    ];
  });

  const moveSections = $derived.by((): MenuListSection[] => [
    {
      items: flattenFolders(folders)
        .filter((f) => f.id !== store.currentFolderId && f.role !== 'drafts' && f.role !== 'sent')
        .map((f) => ({
          key: f.id,
          label:
            f.role === 'inbox'
              ? m.mail_folder_inbox()
              : f.role === 'junk'
                ? m.mail_folder_junk()
                : f.role === 'trash'
                  ? m.mail_folder_trash()
                  : isArchiveFolder(f)
                    ? m.mail_folder_archive()
                    : f.name,
          Icon:
            f.role === 'inbox'
              ? Inbox
              : f.role === 'trash'
                ? Trash2
                : isArchiveFolder(f)
                  ? Archive
                  : Mail,
        })),
    },
  ]);

  const anySelectedUnread = $derived(
    store.conversations.some((c) => store.selected.includes(c.id) && c.unreadCount > 0)
  );
</script>

{#snippet folderColumn()}
  {#if account}
    <MailFolderList {folders} {view} {account} onSelect={selectView} />
  {/if}
{/snippet}

{#snippet listColumn()}
  {#if selecting}
    <MailActionBar
      mode="selection"
      count={store.selected.length}
      anyUnread={anySelectedUnread}
      canArchive={!inArchive}
      onBack={() => store.clearSelection()}
      onAction={(action) => void apply(action, [...store.selected])}
      onMore={() => (sheet = { kind: 'more', ids: [...store.selected], flagged: false })}
    />
  {:else}
    <header class="flex min-h-14 items-center gap-2 px-4 pt-2 pb-1">
      {#if !wide}
        <Button
          variant="soft"
          icon
          class="rounded-full"
          aria-label={m.mail_folders_open()}
          onclick={() => (drawerOpen = true)}
        >
          <Menu size={22} />
        </Button>
      {/if}
      <h1
        class="font-display text-text-main min-w-0 flex-1 text-2xl font-semibold break-words"
        data-mail-list-title
      >
        {listTitle}
      </h1>
      {#if account && !wide}
        <AvatarPlaceholder
          seed={account.address}
          initials={getInitials(account.displayName ?? account.address)}
          class="h-10 w-10 shrink-0 rounded-full text-base"
          ariaLabel={account.address}
        />
      {/if}
    </header>
  {/if}
  <MailList
    {store}
    {self}
    {sides}
    activeId={conversationId}
    bind:search
    {filter}
    {onQuery}
    onOpen={(id) => onNavigate(id)}
    onSwipe={swiped}
    onRefresh={refresh}
  />
{/snippet}

{#snippet threadColumn(id: string)}
  <MailThread
    {client}
    conversationId={id}
    {self}
    canArchive={!inArchive}
    showBack={!wide}
    onBack={() => onNavigate(null)}
    onAction={(action, ids) => void apply(action, ids)}
    onMore={(ids, flagged) => (sheet = { kind: 'more', ids, flagged })}
    onCompose={(kind, message) => openCompose(kind, message)}
  />
{/snippet}

<div class="bg-cn-surface relative flex h-full min-h-0 flex-col" data-mail-screen>
  {#if session.kind === 'ready'}
    {#if wide}
      <div class="flex min-h-0 flex-1 gap-3 p-3" data-mail-layout="wide">
        <aside class="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto">
          <Button class="justify-start rounded-2xl" onclick={() => openCompose('new')}>
            <Pencil size={18} aria-hidden="true" />{m.mail_compose_open()}
          </Button>
          {@render folderColumn()}
        </aside>
        <section
          class="bg-cn-surface-card border-cn-border flex min-h-0 w-96 shrink-0 flex-col overflow-hidden rounded-2xl border"
          aria-label={m.mail_list_label()}
        >
          {@render listColumn()}
        </section>
        <section
          class="bg-cn-surface-card border-cn-border flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border"
          aria-label={m.mail_thread_label()}
        >
          {#if conversationId}
            {#key conversationId}
              {@render threadColumn(conversationId)}
            {/key}
          {:else}
            <MailStatePanel Icon={Mail} title={m.mail_thread_none()} />
          {/if}
        </section>
      </div>
    {:else if conversationId}
      {@render threadColumn(conversationId)}
    {:else}
      {@render listColumn()}
      {#if !selecting}
        <Button
          class="absolute right-4 bottom-4 z-10 h-13 rounded-full px-5 shadow-lg"
          onclick={() => openCompose('new')}
          data-mail-compose-fab
        >
          <Pencil size={20} aria-hidden="true" />{m.mail_compose_open()}
        </Button>
      {/if}
    {/if}
  {:else if (session.kind === 'closed' || session.kind === 'unavailable') && !signInAsked}
    <MailStatePanel
      Icon={session.kind === 'closed' ? MailX : Wrench}
      tone="error"
      title={mailErrorText(session.kind === 'closed' ? 'account_closed' : 'account_unavailable')}
      onRetry={session.kind === 'unavailable' ? () => void retryUnavailable() : undefined}
    >
      <Button variant="link" onclick={() => (signInAsked = true)}>{m.mail_signin_again()}</Button>
    </MailStatePanel>
  {:else if addressRead}
    <MailSignIn
      {address}
      reason={session.kind === 'needs_password' ? session.reason : null}
      onSignIn={signIn}
      onActivate={activate}
    />
  {/if}
</div>

{#if !wide}
  <ModalOverlay
    open={drawerOpen}
    onClose={() => (drawerOpen = false)}
    label={m.mail_folders_label()}
    panelClass="bg-cn-surface max-h-full w-full max-w-sm overflow-y-auto rounded-2xl p-3"
  >
    {@render folderColumn()}
  </ModalOverlay>
{/if}

<ModalOverlay
  open={compose !== null}
  onClose={() => (compose = null)}
  label={compose?.title ?? m.mail_compose_new()}
  panelClass="h-full w-full max-w-3xl overflow-hidden rounded-2xl sm:h-[min(85vh,100%)]"
>
  {#if compose}
    <MailCompose
      api={client.api}
      initial={compose.initial}
      from={account?.address ?? address ?? ''}
      title={compose.title}
      onClose={() => (compose = null)}
      onSent={() => {
        compose = null;
        void refresh();
      }}
    />
  {/if}
</ModalOverlay>

<ModalOverlay
  open={sheet !== null}
  onClose={() => (sheet = null)}
  label={sheet?.kind === 'move' ? m.mail_action_move() : m.mail_action_more()}
  panelClass="bg-cn-surface max-h-full w-full max-w-sm overflow-y-auto rounded-2xl p-2"
>
  {#if sheet?.kind === 'move'}
    <MenuList
      sections={moveSections}
      label={m.mail_action_move()}
      onSelect={(key) => void moveTo(key)}
    />
  {:else if sheet}
    {@const ids = sheet.ids}
    <MenuList
      sections={sheetSections}
      label={m.mail_action_more()}
      onSelect={(key) => void apply(key as MailUiAction, ids)}
    />
  {/if}
</ModalOverlay>
