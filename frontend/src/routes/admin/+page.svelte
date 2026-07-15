<script lang="ts">
  import { onMount } from 'svelte';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listPendingCalendarEvents } from '$lib/associations/api';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { deliveryUrl } from '$lib/utils/apiUrl';
  import {
    CalendarClock,
    Activity,
    Users,
    CalendarDays,
    PlusCircle,
    Bell,
    ChevronRight,
    ShieldAlert,
    UserCog,
    Wrench,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let isGlobalAdminUser = $state(false);
  let pendingCount = $state<number | null>(null);
  let isPushTestRunning = $state(false);
  let pushTestResult = $state('');

  onMount(async () => {
    isGlobalAdminUser = isGlobalAdmin();
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
    | 'calendar';

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
        }
      );
    }
    return list;
  });
</script>

<div class="space-y-4">
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
    {#each cards as card (card.kind)}
      {#if card.href}
        <a
          href={card.href}
          class="group flex items-start gap-4 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow transition-colors"
        >
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
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
              <PlusCircle size={20} />
            {:else}
              <CalendarDays size={20} />
            {/if}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="font-bold text-text-main">{card.label}</span>
              {#if card.badge}
                <span
                  class="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white"
                >
                  {card.badge}
                </span>
              {/if}
            </span>
            <span class="block text-sm text-text-muted mt-0.5">{card.description}</span>
          </span>
          <ChevronRight size={18} class="shrink-0 text-text-muted group-hover:text-cn-dark" />
        </a>
      {/if}
    {/each}
  </div>

  {#if isGlobalAdminUser}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-3">
      <div class="flex items-center gap-2">
        <Bell size={18} class="text-cn-dark" />
        <h2 class="text-sm font-bold text-text-main">{m.admin_push_test_heading()}</h2>
      </div>
      <p class="text-xs text-text-muted">
        {m.admin_push_test_description()}
      </p>
      <button
        type="button"
        onclick={() => void handleBroadcastPushTest()}
        disabled={isPushTestRunning}
        class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
      >
        {isPushTestRunning ? m.common_sending_label() : m.admin_push_test_button_label()}
      </button>
      {#if pushTestResult}
        <p class="text-xs text-text-muted">{pushTestResult}</p>
      {/if}
    </div>
  {/if}

  <p class="text-xs text-text-muted">
    {m.admin_stripe_connect_hint()}
  </p>
</div>
