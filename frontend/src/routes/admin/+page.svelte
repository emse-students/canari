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
  } from '@lucide/svelte';

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
          title: 'Canari - test push global',
          message: `Diagnostic ${new Date().toLocaleTimeString()}`,
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
      pushTestResult = `Test envoyé — trace ${data.traceId}, ${data.sent}/${data.targetedDevices} appareils.`;
    } catch (e) {
      pushTestResult = e instanceof Error ? e.message : 'Erreur';
    } finally {
      isPushTestRunning = false;
    }
  }

  interface AdminCard {
    href?: string;
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
        label: 'Agenda en attente',
        description: 'Valider les événements proposés avant publication.',
        badge: pendingCount !== null && pendingCount > 0 ? `${pendingCount}` : undefined,
      },
    ];
    if (isGlobalAdminUser) {
      list.push(
        {
          href: '/admin/moderation',
          label: 'Posts signalés',
          description: 'Modération des publications signalées sur le fil.',
          globalOnly: true,
        },
        {
          href: '/admin/status',
          label: 'Présence & connexions',
          description: 'Surveillance WebSocket / Redis des appareils connectés.',
          globalOnly: true,
        },
        {
          href: '/admin/users',
          label: 'Gestion des admins',
          description: 'Attribuer ou retirer les droits administrateur globaux.',
          globalOnly: true,
        },
        {
          href: '/associations',
          label: 'Associations',
          description: 'Liste et pages publiques des associations.',
          globalOnly: true,
        },
        {
          href: '/associations/new',
          label: 'Créer une association',
          description: 'Nouvelle association sur la plateforme.',
          globalOnly: true,
        },
        {
          href: '/calendar',
          label: 'Agenda global',
          description: 'Vue mensuelle de tous les événements validés.',
          globalOnly: true,
        }
      );
    }
    return list;
  });
</script>

<div class="space-y-4">
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
    {#each cards as card (card.label)}
      {#if card.href}
        <a
          href={card.href}
          class="group flex items-start gap-4 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow transition-colors"
        >
          <span
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
          >
            {#if card.label.includes('Agenda en attente')}
              <CalendarClock size={20} />
            {:else if card.label.includes('signalés')}
              <ShieldAlert size={20} />
            {:else if card.label.includes('Présence')}
              <Activity size={20} />
            {:else if card.label.includes('admins')}
              <UserCog size={20} />
            {:else if card.label.includes('Associations')}
              <Users size={20} />
            {:else if card.label.includes('Créer')}
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
        <h2 class="text-sm font-bold text-text-main">Test notification push</h2>
      </div>
      <p class="text-xs text-text-muted">
        Envoie une notification de test à tous les appareils enregistrés (diagnostic).
      </p>
      <button
        type="button"
        onclick={() => void handleBroadcastPushTest()}
        disabled={isPushTestRunning}
        class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
      >
        {isPushTestRunning ? 'Envoi…' : 'Lancer le test push'}
      </button>
      {#if pushTestResult}
        <p class="text-xs text-text-muted">{pushTestResult}</p>
      {/if}
    </div>
  {/if}

  <p class="text-xs text-text-muted">
    La configuration Stripe Connect se fait sur chaque association : page publique → Modifier →
    onglet Paiements.
  </p>
</div>
