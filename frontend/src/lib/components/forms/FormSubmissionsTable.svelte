<script lang="ts">
  import { ChevronDown, ChevronRight, X } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { reportClipped } from '$lib/actions/reportClipped';
  import { statusClass, statusLabel } from '$lib/forms/paymentStatus';
  import type { FormItem, Submission } from '$lib/forms/api';
  import type { AnsweredItem } from '$lib/forms/submissionTable';
  import {
    answerColumns,
    answeredItems,
    maxAnswerColumns,
    panelAddsNothing,
    submitterName,
  } from '$lib/forms/submissionTable';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  /**
   * ONE FORM'S RESPONSES, AND THE ANSWERS IN THEM.
   *
   * This was four fixed columns inside the list page - date, name, status, amount - and no answer
   * anywhere, so the one thing a manager opens the accordion for was the one thing it did not show.
   * The answers were already in the browser: `getSubmissions` returns them and `getForms` returns
   * the questions that label them. Nothing here fetches anything.
   *
   * WHAT IS A COLUMN IS DECIDED BY THE FORM, not by the viewport and not by a setting - see
   * `submissionTable.ts`. Everything a column cannot hold reads in the row's panel, so a form of
   * twenty paragraphs and a form of three short questions both lay themselves out correctly.
   *
   * THAT RULE DECIDES THE STATUS AND AMOUNT COLUMNS TOO, and since 2026-09-21 it is applied to them:
   * a FREE form draws neither, because both are one repeated value down the whole table, and the
   * ~180px each of them cost buys a fourth question instead. For the same reason a row whose panel
   * would only repeat its own line has no chevron - `panelAddsNothing` - so nothing on screen is a
   * control that opens a box a reader has already read.
   *
   * The table is the `sm`-and-up layout only. Below it the same rows are cards: a five-column table
   * already overflowed a phone before any answer was added to it, and a horizontal scrollbar is not
   * a reading of anything. The two layouts share every piece through snippets, so the status pill,
   * the panel and the two controls have ONE definition each.
   */
  interface Props {
    /** The form's questions - the labels every answer is read through. */
    items: FormItem[];
    /**
     * Whether this form asks for money, which is what decides the status and amount columns.
     *
     * Passed rather than inferred from the submissions: a paid form whose responses are all still
     * `pending` would infer as free, and a column must not appear the day somebody finally pays.
     */
    requiresPayment: boolean;
    submissions: Submission[];
    /** The submission currently being deleted, so its control can say so. */
    deletingId: string | null;
    onDelete: (sub: Submission) => void;
  }

  let { items, requiresPayment, submissions, deletingId, onDelete }: Props = $props();

  const columns = $derived(answerColumns(items ?? [], maxAnswerColumns(requiresPayment)));

  /**
   * Every submission's answers, read once per render rather than per cell.
   *
   * The table asks for them twice on every row - once for the columns, once for the panel - and the
   * card layout a third time. Reading them per cell made the work quadratic in the number of
   * questions for no gain: the answers do not change while the accordion is open.
   */
  const answersById = $derived(
    new Map(submissions.map((sub) => [sub.id, answeredItems(items ?? [], sub.answers)]))
  );

  /** Which rows have their answer panel open. */
  let expanded = $state<Record<string, boolean>>({});

  function toggle(id: string) {
    expanded = { ...expanded, [id]: !expanded[id] };
  }

  /**
   * The cells that are NOT showing their answer in full, as `<submission id>:<item id>`.
   *
   * Filled by the cells themselves through `reportClipped`, because only the browser knows whether a
   * string fits a box. Nothing else may decide it: a character count stood here until 2026-09-22 and
   * gave a reader rows that expanded next to rows that did not, on answers of the same length.
   */
  const clippedCells = new SvelteSet<string>();

  const cellKey = (submissionId: string, itemId: string) => `${submissionId}:${itemId}`;

  function noteClipped(key: string, clipped: boolean) {
    if (clipped) clippedCells.add(key);
    else clippedCells.delete(key);
  }

  /** Formats an ISO date string as "DD/MM/YYYY HH:MM". */
  function formatDate(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** Formats cents as a currency string, or "-" for zero. */
  function formatAmount(cents: number): string {
    if (!cents) return '-';
    return (cents / 100).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      style: 'currency',
      currency: 'eur',
    });
  }
</script>

{#snippet statusPill(sub: Submission)}
  <span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold {statusClass(
      sub.paymentStatus
    )}"
  >
    {statusLabel(sub.paymentStatus)}
  </span>
{/snippet}

<!-- Disabled, rather than absent, when the panel holds nothing new: the control keeps its place in
     the row, so the columns of a table whose rows differ still line up under their headers. -->
{#snippet expandControl(sub: Submission, answered: AnsweredItem[], drawn: FormItem[])}
  <button
    onclick={() => toggle(sub.id)}
    disabled={panelAddsNothing(answered, drawn, (itemId) =>
      clippedCells.has(cellKey(sub.id, itemId))
    )}
    class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg transition-colors disabled:opacity-30"
    aria-expanded={expanded[sub.id] === true}
    title={expanded[sub.id] ? m.form_list_answers_hide() : m.form_list_answers_show()}
  >
    {#if expanded[sub.id]}
      <ChevronDown size={16} />
    {:else}
      <ChevronRight size={16} />
    {/if}
  </button>
{/snippet}

{#snippet deleteControl(sub: Submission)}
  <button
    onclick={() => onDelete(sub)}
    disabled={deletingId === sub.id}
    class="ui-icon-button text-text-muted hover:bg-red-err/10 rounded-lg transition-colors hover:text-red-600 disabled:opacity-50"
    title={m.form_list_delete_response_title()}
  >
    <X size={13} />
  </button>
{/snippet}

<!-- Every answer this person gave, label above value. A two-column grid from `sm` up, because a
     label and a short answer side by side waste the width the panel was opened to use, while a
     paragraph needs all of it - so a long answer spans both. -->
{#snippet answersPanel(sub: Submission)}
  {@const answered = answersById.get(sub.id) ?? []}
  {#if answered.length === 0}
    <p class="text-text-muted text-xs">{m.form_list_answers_none()}</p>
  {:else}
    <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {#each answered as { item, text } (item.id)}
        <div class={text.length > 80 ? 'sm:col-span-2' : ''}>
          <dt class="text-text-muted text-2xs font-semibold tracking-wide uppercase">
            {item.label}
          </dt>
          <dd class="text-text-main mt-0.5 text-sm break-words whitespace-pre-wrap">{text}</dd>
        </div>
      {/each}
    </dl>
  {/if}
{/snippet}

<!-- FROM `sm` UP: the table. -->
<div class="hidden overflow-x-auto sm:block">
  <table class="w-full text-sm">
    <thead>
      <tr
        class="text-text-muted border-cn-border border-b text-left text-xs font-bold tracking-wide uppercase"
      >
        <th class="w-10 pb-2"><span class="sr-only">{m.form_list_answers_show()}</span></th>
        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_date()}</th>
        <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_name()}</th>
        {#each columns as column (column.id)}
          <!-- The width lives on a DIV, not on the cell: `max-width` on a `<th>` or `<td>` is a
               suggestion under auto table layout and the browser widens it anyway, so the column was
               never bounded and `truncate` never fired. A block inside the cell is. -->
          <th class="pr-4 pb-2">
            <div class="max-w-48 truncate" title={column.label}>{column.label}</div>
          </th>
        {/each}
        {#if requiresPayment}
          <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_status()}</th>
          <th class="pr-4 pb-2 whitespace-nowrap">{m.form_list_col_amount()}</th>
        {/if}
        <th class="pb-2"></th>
      </tr>
    </thead>
    <tbody class="divide-cn-border/50 divide-y">
      {#each submissions as sub (sub.id)}
        {@const answered = answersById.get(sub.id) ?? []}
        <tr class="text-text-main">
          <td class="py-2">{@render expandControl(sub, answered, columns)}</td>
          <td class="text-text-muted py-2 pr-4 font-mono text-xs whitespace-nowrap"
            >{formatDate(sub.createdAt)}</td
          >
          <td class="py-2 pr-4 whitespace-nowrap">{submitterName(sub)}</td>
          {#each columns as column (column.id)}
            {@const text = answered.find((a) => a.item.id === column.id)?.text}
            <td class="py-2 pr-4">
              <div
                class="max-w-48 truncate"
                title={text ?? ''}
                use:reportClipped={{
                  key: cellKey(sub.id, column.id),
                  text: text ?? '',
                  onMeasure: noteClipped,
                }}
              >
                {#if text}{text}{:else}<span class="text-text-muted/50">-</span>{/if}
              </div>
            </td>
          {/each}
          {#if requiresPayment}
            <td class="py-2 pr-4">{@render statusPill(sub)}</td>
            <td class="py-2 pr-4 text-xs font-medium">{formatAmount(sub.totalPaid)}</td>
          {/if}
          <td class="py-2">{@render deleteControl(sub)}</td>
        </tr>
        {#if expanded[sub.id]}
          <tr>
            <td
              colspan={columns.length + (requiresPayment ? 6 : 4)}
              class="bg-cn-border/10 px-3 py-3"
            >
              {@render answersPanel(sub)}
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>
</div>

<!-- BELOW `sm`: the same rows as cards. -->
<ul class="space-y-2 sm:hidden">
  {#each submissions as sub (sub.id)}
    {@const answered = answersById.get(sub.id) ?? []}
    <li class="border-cn-border rounded-2xl border bg-(--cn-surface) p-3">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <p class="text-text-muted text-2xs font-mono">{formatDate(sub.createdAt)}</p>
          <p class="text-text-main truncate font-semibold">{submitterName(sub)}</p>
          {#if requiresPayment}
            <p class="mt-1 flex items-center gap-2">
              {@render statusPill(sub)}
              <span class="text-text-muted text-xs font-medium">{formatAmount(sub.totalPaid)}</span>
            </p>
          {/if}
        </div>
        <div class="flex shrink-0 items-center">
          {@render expandControl(sub, answered, [])}
          {@render deleteControl(sub)}
        </div>
      </div>
      {#if expanded[sub.id]}
        <div class="border-cn-border/60 mt-3 border-t pt-3">
          {@render answersPanel(sub)}
        </div>
      {/if}
    </li>
  {/each}
</ul>
