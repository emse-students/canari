<script lang="ts">
  import { onMount } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { getFormResults, type FormResults } from '$lib/forms/api';
  import { formatMean, longest, percentOf } from '$lib/forms/resultsView';
  import { productGridCellKey } from '$lib/forms/productGridContract';
  import { intlLocale } from '$lib/utils/intlLocale';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE "RÉSUMÉ" TAB: one card per question, from the server's aggregates (G-RESULTS, owner,
   * 2026-11-21). Nothing here counts: the page asks `GET /forms/:id/results` and draws what comes
   * back - a bar per option, a distribution and a mean per scale, a table of counts per survey
   * grid, a table of pieces per priced grid, and for a text only how many answered, with a way to
   * the table. The bars are plain tokens (`bg-accent` on `bg-control-fill`); there is no chart.
   *
   * THE DENOMINATOR IS ON EVERY CARD: a percentage is over the answers to THAT question, said in
   * words, and a multiple choice says its total may pass 100 %. An ANONYMOUS form's thin question
   * arrives `suppressed` with no figure, and the page says why (principle 1, "your messages are
   * yours": a breakdown of two answers is those two answers read out).
   *
   * Mounted only while the tab is open, so reopening it re-reads: a payment settled in the other
   * tab is counted, a refund is not.
   */
  interface Props {
    formId: string;
    /** Switches to the responses table, where a text question's answers are read. */
    onShowTable: () => void;
  }

  let { formId, onShowTable }: Props = $props();

  let results = $state<FormResults | null>(null);
  let failed = $state(false);

  async function load() {
    failed = false;
    results = null;
    Log.d('FormResultsSummary', `loading results of ${formId.slice(0, 8)}`);
    try {
      results = await getFormResults(formId);
      Log.d(
        'FormResultsSummary',
        `${results.totalAnswers} answers, ${results.questions.length} questions`
      );
    } catch (error) {
      Log.w('FormResultsSummary', 'results failed to load', error);
      failed = true;
    }
  }

  onMount(() => {
    void load();
  });

  const answers = (count: number) => m.form_responses_summary_answers({ count });
</script>

<div class="flex flex-col gap-3" data-testid="form-results">
  <p class="text-text-muted text-xs">{m.form_responses_summary_managers_only()}</p>
  {#if failed}
    <div class="flex flex-wrap items-center gap-3" role="alert" data-testid="results-error">
      <p class="text-text-main text-sm">{m.form_results_error()}</p>
      <Button variant="secondary" onclick={() => void load()}>{m.form_results_retry()}</Button>
    </div>
  {:else if !results}
    <p class="text-text-muted text-sm" aria-live="polite">{m.form_results_loading()}</p>
  {:else}
    <p class="text-text-muted text-xs" data-testid="results-total">
      {m.form_results_total({ answers: answers(results.totalAnswers) })}
    </p>
    {#if results.anonymous && results.minAnswers !== null}
      <p class="text-text-muted text-xs" data-testid="results-anonymous">
        {m.form_results_anonymous_note({ min: results.minAnswers })}
      </p>
    {/if}
    {#each results.questions as question (question.id)}
      <section class="border-cn-border rounded-2xl border p-4" data-testid="result-{question.kind}">
        <h3 class="text-text-main font-bold whitespace-pre-line">{question.label}</h3>
        {#if question.suppressed}
          <p class="text-text-muted mt-1 text-xs" data-testid="result-suppressed">
            {m.form_results_suppressed({ min: results.minAnswers ?? 0 })}
          </p>
        {:else if question.kind === 'choice'}
          {@const max = longest(question.options.map((o) => o.count))}
          <p class="text-text-muted mb-3 text-xs">
            {question.multiple
              ? m.form_results_denominator_multiple({ answers: answers(question.answered) })
              : m.form_results_denominator_single({ answers: answers(question.answered) })}
          </p>
          <ul class="flex flex-col gap-2">
            {#each [...question.options, ...(question.unlisted > 0 ? [{ id: '', label: m.form_results_unlisted(), count: question.unlisted }] : [])] as option, index (index)}
              <li class="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
                <span class="text-text-main truncate" title={option.label}>{option.label}</span>
                <span class="bg-control-fill h-2.5 overflow-hidden rounded-full">
                  <span
                    class="bg-accent block h-full rounded-full"
                    style:width="{Math.round((100 * option.count) / max)}%"
                  ></span>
                </span>
                <span class="text-text-muted text-xs font-semibold tabular-nums">
                  {option.count} · {percentOf(option.count, question.answered)} %
                </span>
              </li>
            {/each}
          </ul>
        {:else if question.kind === 'scale'}
          {@const max = longest(question.distribution.map((d) => d.count))}
          <p class="text-text-main mb-3 text-sm font-semibold" data-testid="scale-mean">
            {m.form_results_scale_mean({
              mean: formatMean(question.mean, intlLocale()),
              answers: answers(question.answered),
            })}
          </p>
          <ul class="flex flex-col gap-2">
            {#each question.distribution as step (step.value)}
              <li class="grid grid-cols-[2rem_1fr_auto] items-center gap-3 text-sm">
                <span class="text-text-main tabular-nums">{step.value}</span>
                <span class="bg-control-fill h-2.5 overflow-hidden rounded-full">
                  <span
                    class="bg-accent block h-full rounded-full"
                    style:width="{Math.round((100 * step.count) / max)}%"
                  ></span>
                </span>
                <span class="text-text-muted text-xs font-semibold tabular-nums">
                  {step.count} · {percentOf(step.count, question.answered)} %
                </span>
              </li>
            {/each}
          </ul>
        {:else if question.kind === 'matrix'}
          <p class="text-text-muted mb-3 text-xs">
            {m.form_results_matrix_note({ answers: answers(question.answered) })}
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-text-muted text-xs font-bold">
                  <th class="py-1.5 pr-3 text-left"></th>
                  {#each question.columns as column (column.id)}
                    <th class="px-2 py-1.5 text-center">{column.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each question.rows as row, index (row.label)}
                  <tr class={index % 2 === 0 ? 'bg-cn-surface-alt' : ''}>
                    <th class="text-text-main py-1.5 pr-3 text-left font-semibold">{row.label}</th>
                    {#each row.counts as count, c (c)}
                      <td
                        class="px-2 py-1.5 text-center tabular-nums {count > 0
                          ? 'text-text-main font-bold'
                          : 'text-text-muted'}"
                        data-testid="matrix-cell-{index}-{c}">{count}</td
                      >
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if question.kind === 'grid'}
          {@const closed = new Set(question.closedCells)}
          <p class="text-text-muted mb-3 text-xs">
            {m.form_results_grid_note({ orders: answers(question.answered) })} · {m.form_responses_units(
              { count: question.totalUnits }
            )}
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-text-muted text-xs font-bold">
                  <th class="py-1.5 pr-3 text-left"></th>
                  {#each question.columns as column (column.id)}
                    <th class="px-2 py-1.5 text-center">{column.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each question.rows as row, index (row.id)}
                  <tr class={index % 2 === 0 ? 'bg-cn-surface-alt' : ''}>
                    <th class="text-text-main py-1.5 pr-3 text-left font-semibold">{row.label}</th>
                    {#each question.columns as column, c (column.id)}
                      {@const key = productGridCellKey(row.id, column.id)}
                      <td class="px-2 py-1.5 text-center tabular-nums">
                        {#if closed.has(key) && row.units[c] === 0}
                          <span class="text-text-muted line-through">{column.label}</span>
                        {:else}
                          <span
                            class={row.units[c] > 0
                              ? 'text-text-main font-bold'
                              : 'text-text-muted'}
                            data-testid="grid-cell-{key}">{row.units[c]}</span
                          >
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="text-text-muted mt-1 text-xs" data-testid="text-answered">
            {answers(question.answered)}
          </p>
          <Button variant="link" class="mt-2" onclick={onShowTable}>
            {m.form_results_see_table()}
          </Button>
        {/if}
      </section>
    {/each}
  {/if}
</div>
