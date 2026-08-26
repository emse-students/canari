<script lang="ts">
  import { onMount } from 'svelte';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import { listPendingCalendarEvents, ensureAssociationSuperAdmin } from '$lib/associations/api';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { deliveryUrl } from '$lib/utils/apiUrl';
  import {
    CalendarClock,
    Activity,
    Users,
    CalendarDays,
    CirclePlus,
    Bell,
    ChevronRight,
    ShieldAlert,
    UserCog,
    Wrench,
    FileCheckCorner,
    BookUser,
    Map,
    HardDrive,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let isGlobalAdminUser = $state(false);
  let isSuperAdminUser = $state(false);
  let pendingCount = $state<number | null>(null);
  let isPushTestRunning = $state(false);
  let pushTestResult = $state('');

  onMount(async () => {
    isGlobalAdminUser = isGlobalAdmin();
    void ensureAssociationSuperAdmin().then((v) => (isSuperAdminUser = v));
    try {
      const pending = await listPendingCalendarEvents();
      pendingCount = pending.events.length;
    } catch {
      pendingCount = null;
    }
  });

  async function handleBroadcastPushTest() {
    if (isPushTestRunning || !isGlobalAdminUser) return;
    isPushTestRunning = true;
    pushTestResult = '';
    try {
      const response = await apiFetch(`${deliveryUrl()}/api/mls/push/broadcast-test`, {
        method: 'POST',
        body: JSON.stringify({
          title: m.admin_push_test_title(),
          message: m.admin_push_test_diagnostic_label({
            time: new Date().toLocaleTimeString(getLocale() === 'en' ? 'en-US' : 'fr-FR'),
          }),
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
      }
      const data = (await response.json()) as {
        traceId: string;
        targetedDevices: number;
        sent: number;
        failed: number;
      };
      pushTestResult = m.admin_push_test_result_label({
        traceId: data.traceId,
        sent: data.sent,
        targetedDevices: data.targetedDevices,
      });
    } catch (e) {
      pushTestResult = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      isPushTestRunning = false;
    }
  }

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
    | 'storage';

  interface AdminCard {
    href?: string;
    kind: AdminCardKind;
    label: string;
    description: string;
    badge?: string;
    globalOnly?: boolean;
    action?: () => void;
    actionLabel?: string;
    actionBusy?: boolean;
  }

  const cards = $derived.by((): AdminCard[] => {
    const list: AdminCard[] = [
      {
        href: '/admin/agenda',
        kind: 'agenda',
        label: m.admin_pending_agenda_label(),
        description: m.admin_card_agenda_desc(),
        badge: pendingCount !== null && pendingCount > 0 ? `${pendingCount}` : undefined,
      },
      {
        href: '/directory',
        kind: 'directory',
        label: m.directory_heading(),
        description: m.directory_subtitle(),
      },
    ];
    if (isGlobalAdminUser) {
      list.push(
        {
          href: '/admin/moderation',
          kind: 'moderation',
          label: m.admin_reported_posts_label(),
          description: m.admin_card_moderation_desc(),
          globalOnly: true,
        },
        {
          href: '/admin/platform',
          kind: 'platform',
          label: m.admin_platform_label(),
          description: m.admin_card_platform_desc(),
          globalOnly: true,
        },
        {
          href: '/admin/status',
          kind: 'status',
          label: m.admin_presence_connections_label(),
          description: m.admin_card_status_desc(),
          globalOnly: true,
        },
        {
          href: '/admin/users',
          kind: 'users',
          label: m.admin_card_manage_admins_label(),
          description: m.admin_card_users_desc(),
          globalOnly: true,
        },
        {
          href: '/associations',
          kind: 'associations',
          label: m.admin_card_associations_label(),
          description: m.admin_card_associations_desc(),
          globalOnly: true,
        },
        {
          href: '/associations/new',
          kind: 'create-association',
          label: m.admin_card_create_association_label(),
          description: m.admin_card_create_association_desc(),
          globalOnly: true,
        },
        {
          href: '/calendar',
          kind: 'calendar',
          label: m.admin_card_global_calendar_label(),
          description: m.admin_card_calendar_desc(),
          globalOnly: true,
        },
        {
          href: '/admin/storage',
          kind: 'storage',
          label: m.admin_storage_label(),
          description: m.admin_card_storage_desc(),
          globalOnly: true,
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
            {:else}
              <CalendarDays size={20} />
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="text-text-main font-bold">{card.label}</span>
              {#if card.badge}
                <span
                  class="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white"
                >
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

  {#if isGlobalAdminUser}
    <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-4">
      <div class="flex items-center gap-2">
        <Bell size={18} class="text-cn-dark" />
        <h2 class="text-text-main text-sm font-bold">{m.admin_push_test_heading()}</h2>
      </div>
      <p class="text-text-muted text-xs">
        {m.admin_push_test_description()}
      </p>
      <button
        type="button"
        onclick={() => void handleBroadcastPushTest()}
        disabled={isPushTestRunning}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        {isPushTestRunning ? m.common_sending_label() : m.admin_push_test_button_label()}
      </button>
      {#if pushTestResult}
        <p class="text-text-muted text-xs">{pushTestResult}</p>
      {/if}
    </div>
  {/if}

  <p class="text-text-muted text-xs">
    {m.admin_stripe_connect_hint()}
  </p>
</div>
