<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Check, RotateCcw } from '@lucide/svelte';
  import { currentUserId } from '$lib/stores/user';
  import {
    getPublicForm,
    submitPublicForm,
    PublicFormUnavailableError,
    type PublicForm,
  } from '$lib/forms/api';
  import {
    firstMissingAnswer,
    initialSelections,
    missingAnswerMessage,
    visibleAnswers,
    visibleItems as visibleItemsOf,
    type Selections,
  } from '$lib/forms/fillAnswers';
  import { formatFormOpensAt } from '$lib/posts/postComposerDraft';
  import FormHeader from '$lib/components/forms/FormHeader.svelte';
  import FormQuestion from '$lib/components/forms/FormQuestion.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * A PUBLIC FORM, ANSWERED WITHOUT AN ACCOUNT (user, 2026-09-30) - the page a shared link opens.
   *
   * It is not the member's fill page with the member parts switched off: that page is a payment
   * flow, a grid slice, saved cards and a reminder, none of which a guest can have. What the two
   * share is what a question IS - its card, the rules for an answer, the header - and those are the
   * components both render, so a question type added once works on both.
   *
   * A signed-in member is sent to the member page, where the form knows who they are.
   */
  const formId = $derived(page.params.id ?? '');

  let form = $state<PublicForm | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let selections = $state<Selections>({});
  let honeypot = $state('');
  let error = $state('');
  let submitting = $state(false);
  let submitted = $state(false);

  const isNotOpenYet = $derived(!!form?.opensAt && new Date(form.opensAt) > new Date());
  const isClosed = $derived(!!form?.closedAt && new Date(form.closedAt) < new Date());
  // No profile half: the server refuses a public form whose questions depend on who answers.
  const visibleItems = $derived(form ? visibleItemsOf(form.items, selections) : []);
  const blocked = $derived(!form || isNotOpenYet || isClosed || form.formFull);

  onMount(async () => {
    if (currentUserId()) {
      Log.d('PublicForm', `member on a guest link, sent to the member page form=${formId}`);
      await goto(`/forms/${formId}`, { replaceState: true });
      return;
    }
    try {
      form = await getPublicForm(formId);
      selections = initialSelections(form.items);
      Log.d('PublicForm', `loaded form=${formId} items=${form.items.length}`);
    } catch (e) {
      Log.d('PublicForm', `load failed form=${formId}: ${e}`);
      loadError =
        e instanceof PublicFormUnavailableError && e.notFound
          ? m.form_view_not_found()
          : m.form_view_load_error();
    } finally {
      loading = false;
    }
  });

  async function handleSubmit() {
    if (!form || submitting || blocked) return;
    const missing = firstMissingAnswer(visibleItems, selections);
    if (missing) {
      error = missingAnswerMessage(missing);
      return;
    }
    error = '';
    submitting = true;
    try {
      await submitPublicForm(form.id, {
        answers: visibleAnswers(visibleItems, selections),
        website: honeypot,
      });
      Log.d('PublicForm', `answer sent form=${form.id}`);
      submitted = true;
    } catch (e) {
      Log.d('PublicForm', `submit refused form=${form.id}: ${e}`);
      // The server's sentence is English and for the log; the guest reads ours.
      error = m.form_guest_submit_failed();
    } finally {
      submitting = false;
    }
  }

  /** A public form takes several answers: start a fresh one from the same link. */
  function answerAgain() {
    if (!form) return;
    selections = initialSelections(form.items);
    submitted = false;
    error = '';
    window.scrollTo({ top: 0 });
  }
</script>

<PageContainer width="reading">
  {#if loading}
    <div class="flex justify-center py-24">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if loadError || !form}
    <div class="border-cn-border rounded-3xl border bg-(--cn-surface) p-10 text-center">
      <p class="text-red-err font-semibold">{loadError}</p>
    </div>
  {:else}
    <FormHeader {form} priceLabel={null} {submitted} />

    {#if submitted}
      <div class="border-cn-border space-y-4 rounded-3xl border bg-(--cn-surface) p-8 text-center">
        <div class="bg-green-ok/15 text-green-ok mx-auto w-fit rounded-full p-3">
          <Check size={24} />
        </div>
        <p class="text-text-main font-bold">{m.form_guest_sent_title()}</p>
        <Button variant="secondary" onclick={answerAgain}>
          <RotateCcw size={16} class="mr-1.5" />{m.form_guest_answer_again()}
        </Button>
      </div>
    {:else}
      {#if isNotOpenYet && form.opensAt}
        <p
          class="mb-4 rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-4 text-sm font-semibold text-amber-800 dark:bg-amber-950/20 dark:text-amber-300"
        >
          {m.form_view_opens_at({ date: formatFormOpensAt(form.opensAt) })}
        </p>
      {:else if isClosed}
        <p class="text-text-muted mb-4 text-center text-sm font-medium">{m.form_view_closed()}</p>
      {:else if form.formFull}
        <p class="text-text-muted mb-4 text-center text-sm font-medium">
          {m.form_view_form_full_note()}
        </p>
      {/if}

      <div class="space-y-4">
        {#each visibleItems as item, index (item.id)}
          <FormQuestion
            {item}
            {index}
            bind:value={selections[item.id]}
            disabled={blocked || submitting}
            formId={form.id}
          />
        {/each}
      </div>

      <!-- THE HONEYPOT. Off-screen and out of the tab order, so a person never meets it; a bot that
           fills every field it finds fills this one too, and the server drops that answer. -->
      <div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label>
          {m.form_guest_honeypot_label()}
          <input
            type="text"
            name="website"
            tabindex="-1"
            autocomplete="off"
            bind:value={honeypot}
          />
        </label>
      </div>

      {#if error}
        <p class="text-red-err mt-4 text-center text-sm font-medium">{error}</p>
      {/if}

      <div class="mt-6 flex justify-center">
        <Button
          variant="primary"
          class="px-8"
          disabled={blocked || submitting}
          loading={submitting}
          onclick={handleSubmit}
        >
          <Check size={16} class="mr-1.5" />{m.form_view_submit()}
        </Button>
      </div>
    {/if}

    <p class="text-text-muted mt-10 pb-6 text-center text-xs">{m.form_guest_footer()}</p>
  {/if}
</PageContainer>
