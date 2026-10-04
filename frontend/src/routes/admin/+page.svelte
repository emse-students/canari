<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isGlobalAdmin,
    isAssociationSuperAdmin,
    isContentModerator,
    isEventValidator,
  } from '$lib/stores/user';
  import {
    listPendingCalendarEvents,
    ensureAssociationSuperAdmin,
    ensureContentModerator,
    ensureEventValidator,
  } from '$lib/associations/api';
  import {
    CalendarClock,
    Activity,
    Users,
    CalendarDays,
    CirclePlus,
    ChevronRight,
    ShieldAlert,
    UserCog,
    Wrench,
    FileCheckCorner,
    BookUser,
    Map,
    HardDrive,
    Database,
    History,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let isGlobalAdminUser = $state(false);
  let isSuperAdminUser = $state(false);
  let isModeratorUser = $state(false);
  let isEventValidatorUser = $state(false);
  let pendingCount = $state<number | null>(null);

  async function loadPendingCount() {
    if (!isEventValidatorUser) return;
    try {
      const pending = await listPendingCalendarEvents();
      pendingCount = pending.events.length;
    } catch {
      pendingCount = null;
    }
  }

  onMount(async () => {
    isGlobalAdminUser = isGlobalAdmin();
    isSuperAdminUser = isGlobalAdminUser || isAssociationSuperAdmin();
    isModeratorUser = isGlobalAdminUser || isContentModerator();
    isEventValidatorUser = isGlobalAdminUser || isEventValidator();
    // Both tiers resolve from ONE membership request, already warm if the layout asked first.
    if (!isGlobalAdminUser) {
      void Promise.all([
        ensureAssociationSuperAdmin(),
        ensureContentModerator(),
        ensureEventValidator(),
      ]).then(([superAdmin, moderator, eventValidator]) => {
        isSuperAdminUser = superAdmin;
        isModeratorUser = moderator;
        isEventValidatorUser = eventValidator;
        void loadPendingCount();
      });
    }
    await loadPendingCount();
  });

  type AdminCardKind =
    | 'agenda'
    | 'moderation'
    | 'platform'
    | 'status'
    | 'users'
    | 'associations'
    | 'create-association'
    | 'calendar'
    | 'directory'
    | 'doc-reviewers'
    | 'carte'
    | 'storage'
    | 'database'
    | 'legacy';

  interface AdminCard {
    href?: string;
    kind: AdminCardKind;
    label: string;
    description: string;
    badge?: string;
    action?: () => void;
    actionLabel?: string;
    actionBusy?: boolean;
  }

  const cards = $derived.by((): AdminCard[] => {
    const list: AdminCard[] = [
      {
        href: '/directory',
        kind: 'directory',
        label: m.directory_heading(),
        description: m.directory_subtitle(),
      },
    ];
    if (isEventValidatorUser) {
      list.unshift({
        href: '/admin/agenda',
        kind: 'agenda',
        label: m.admin_pending_agenda_label(),
        description: m.admin_card_agenda_desc(),
        badge: pendingCount !== null && pendingCount > 0 ? `${pendingCount}` : undefined,
      });
    }
    // Moderation is the moderator tier's card, not the platform administrator's alone.
    if (isModeratorUser) {
      list.push({
        href: '/admin/moderation',
        kind: 'moderation',
        label: m.admin_reported_posts_label(),
        description: m.admin_card_moderation_desc(),
      });
    }
    if (isGlobalAdminUser) {
      list.push(
        {
          href: '/admin/platform',
          kind: 'platform',
          label: m.admin_platform_label(),
          description: m.admin_card_platform_desc(),
        },
        {
          href: '/admin/status',
          kind: 'status',
          label: m.admin_presence_connections_label(),
          description: m.admin_card_status_desc(),
        },
        {
          href: '/admin/users',
          kind: 'users',
          label: m.admin_card_manage_admins_label(),
          description: m.admin_card_users_desc(),
        },
        {
          href: '/associations',
          kind: 'associations',
          label: m.admin_card_associations_label(),
          description: m.admin_card_associations_desc(),
        },
        {
          href: '/associations/new',
          kind: 'create-association',
          label: m.admin_card_create_association_label(),
          description: m.admin_card_create_association_desc(),
        },
        {
          href: '/calendar',
          kind: 'calendar',
          label: m.admin_card_global_calendar_label(),
          description: m.admin_card_calendar_desc(),
        },
        {
          href: '/admin/storage',
          kind: 'storage',
          label: m.admin_storage_label(),
          description: m.admin_card_storage_desc(),
        },
        {
          href: '/admin/database',
          kind: 'database',
          label: m.admin_database_label(),
          description: m.admin_card_database_desc(),
        },
        {
          href: '/admin/legacy-cotisations',
          kind: 'legacy',
          label: m.admin_legacy_label(),
          description: m.admin_card_legacy_desc(),
        }
      );
    }
    // Document-reviewer grants + Carte de la Vie Asso: global admins and BDE super-admins.
    if (isGlobalAdminUser || isSuperAdminUser) {
      list.push(
        {
          href: '/admin/document-reviewers',
          kind: 'doc-reviewers',
          label: m.docreview_card_label(),
          description: m.docreview_card_desc(),
        },
        {
          href: '/admin/carte',
          kind: 'carte',
          label: m.carte_card_label(),
          description: m.carte_card_desc(),
        }
      );
    }
    return list;
  });
</script>

<div class="space-y-4">
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    {#each cards as card (card.kind)}
      {#if card.href}
        <a
          href={card.href}
          class="group border-cn-border hover:border-cn-yellow flex items-start gap-4 rounded-2xl border bg-(--cn-surface) p-4 transition-colors"
        >
          <span
            class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          >
            {#if card.kind === 'agenda'}
              <CalendarClock size={20} />
            {:else if card.kind === 'moderation'}
              <ShieldAlert size={20} />
            {:else if card.kind === 'status'}
              <Activity size={20} />
            {:else if card.kind === 'platform'}
              <Wrench size={20} />
            {:else if card.kind === 'users'}
              <UserCog size={20} />
            {:else if card.kind === 'associations'}
              <Users size={20} />
            {:else if card.kind === 'create-association'}
              <CirclePlus size={20} />
            {:else if card.kind === 'directory'}
              <BookUser size={20} />
            {:else if card.kind === 'carte'}
              <Map size={20} />
            {:else if card.kind === 'storage'}
              <HardDrive size={20} />
            {:else if card.kind === 'database'}
              <Database size={20} />
            {:else if card.kind === 'legacy'}
              <History size={20} />
            {:else}
              <CalendarDays size={20} />
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="text-text-main font-bold">{card.label}</span>
              {#if card.badge}
                <span class="text-2xs text-cn-ink rounded-full bg-amber-500 px-2 py-0.5 font-bold">
                  {card.badge}
                </span>
              {/if}
            </span>
            <span class="text-text-muted mt-0.5 block text-sm">{card.description}</span>
          </span>
          <ChevronRight size={18} class="text-text-muted group-hover:text-cn-dark shrink-0" />
        </a>
      {/if}
    {/each}
  </div>

  <p class="text-text-muted text-xs">
    {m.admin_payments_connect_hint()}
  </p>
</div>
