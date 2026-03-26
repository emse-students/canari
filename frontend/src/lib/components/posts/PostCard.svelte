<script lang="ts">
  import {
    registerEvent,
    votePoll,
    submitForm,
    type PostEntity,
    type PostForm,
  } from '$lib/posts/api';
  import {
    getForm,
    submitForm as submitFormService,
    checkSubmission,
    getSubmission,
  } from '$lib/forms/api';
  import SvelteMarkdown from 'svelte-markdown';
  import PostImage from './PostImage.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Card from '$lib/components/ui/Card.svelte';

  interface Props {
    post: PostEntity;
    currentUserId: string;
    authToken?: string;
    currentUserEmail?: string;
    onRefresh: () => void;
  }

  let { post, currentUserId, authToken = '', currentUserEmail, onRefresh }: Props = $props();

  let actionMessage = $state('');
  let errorMessage = $state('');
  //   let pollSelections = $state<Record<string, string[]>>({});
  let selectedOptions = $state<string[]>([]);

  // Forms
  let forms = $state<PostForm[]>([]);
  let formSelections = $state<Record<string, Record<string, any>>>({});
  let formSubmitted = $state<Record<string, boolean>>({});
  let formExpanded = $state<Record<string, boolean>>({});

  // Forms attached to event buttons (keyed by btn.id, value is the PostForm)
  let btnForms = $state<Record<string, PostForm>>({});
  let btnFormExpanded = $state<Record<string, boolean>>({});
  let btnFormSelections = $state<Record<string, Record<string, any>>>({});
  let btnFormSubmitted = $state<Record<string, boolean>>({});

  $effect(() => {
    // Load forms attached to event buttons
    for (const btn of post.eventButtons ?? []) {
      if (btn.formId && !btnForms[btn.id]) {
        getForm(btn.formId)
          .then((f) => {
            const mapped: PostForm = {
              id: f._id,
              title: f.title,
              eventId: btn.id,
              basePrice: f.basePrice,
              currency: f.currency,
              submitLabel: f.submitLabel || "S'inscrire",
              items: f.items as any,
            };
            btnForms = { ...btnForms, [btn.id]: mapped };
            btnFormExpanded = { ...btnFormExpanded, [btn.id]: false };
            // initialise selections
            const initial: Record<string, any> = {};
            f.items.forEach((i: any) => {
              if (i.type === 'multiple_choice') initial[i.id] = [];
              else if (['matrix_single', 'matrix_multiple'].includes(i.type)) {
                initial[i.id] = {};
                (i.rows ?? []).forEach((r: string) => {
                  initial[i.id][r] = i.type === 'matrix_multiple' ? [] : '';
                });
              } else initial[i.id] = '';
            });
            btnFormSelections = { ...btnFormSelections, [btn.id]: initial };
            // check if already submitted
            checkSubmission(f._id)
              .then(({ hasSubmitted }) => {
                btnFormSubmitted = { ...btnFormSubmitted, [btn.id]: hasSubmitted };
              })
              .catch(() => {});
          })
          .catch((e) => console.error('Failed to load event button form', e));
      }
    }
  });

  async function handleBtnFormSubmit(btnId: string) {
    const form = btnForms[btnId];
    if (!form || !currentUserId.trim()) {
      errorMessage = 'Please sign in to submit.';
      return;
    }
    const selections = btnFormSelections[btnId] || {};
    try {
      const res = await submitFormService(form.id, {
        email: currentUserEmail || '',
        answers: selections,
      });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        btnFormSubmitted = { ...btnFormSubmitted, [btnId]: true };
        btnFormExpanded = { ...btnFormExpanded, [btnId]: false };
        actionMessage = res.message || 'Inscription enregistrée !';
        onRefresh();
      }
    } catch (e: any) {
      errorMessage = e.message || "Échec de l'inscription.";
    }
  }

  $effect(() => {
    if (post.forms && post.forms.length > 0) {
      forms = post.forms;
      ensureFormSelections(forms);
      checkSubmissions(forms);
    } else if (post.attachedFormId) {
      getForm(post.attachedFormId)
        .then((f) => {
          const mappedForm: PostForm = {
            id: f._id,
            title: f.title,
            eventId: 'N/A',
            basePrice: f.basePrice,
            currency: f.currency,
            submitLabel: f.submitLabel || 'Submit',
            items: f.items as any, // compatible
          };
          forms = [mappedForm];
          ensureFormSelections(forms);
          checkSubmissions(forms);
        })
        .catch((e) => console.error('Failed to load attached form', e));
    }
  });

  async function checkSubmissions(formsToCheck: PostForm[]) {
    // Don't rely on client-held user id; server derives identity from the JWT.
    for (const f of formsToCheck) {
      // Default: collapse if big
      if (formExpanded[f.id] === undefined) {
        formExpanded[f.id] = f.items.length <= 3;
      }

      try {
        const { hasSubmitted } = await checkSubmission(f.id);
        formSubmitted[f.id] = hasSubmitted;

        if (hasSubmitted) {
          formExpanded[f.id] = false;
          try {
            const submission = await getSubmission(f.id);
            if (submission && submission.answers) {
              formSelections[f.id] = submission.answers;
            }
          } catch (e) {
            console.error('Failed to load user submission', e);
          }
        }
      } catch (error) {
        console.error('Failed to check submission status', error);
      }
    }
  }

  function toggleOption(pollId: string, optionId: string, multipleChoice: boolean) {
    if (!multipleChoice) {
      selectedOptions = [optionId];
      return;
    }
    if (selectedOptions.includes(optionId)) {
      selectedOptions = selectedOptions.filter((id) => id !== optionId);
    } else {
      selectedOptions = [...selectedOptions, optionId];
    }
  }

  async function submitVote(pollId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Set user id before voting.';
      return;
    }
    if (selectedOptions.length === 0) {
      errorMessage = 'Select at least one option to vote.';
      return;
    }

    try {
      await votePoll(post._id, pollId, {
        optionIds: selectedOptions,
      });
      actionMessage = 'Vote submitted.';
      selectedOptions = []; // Reset local selection
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to submit vote';
    }
  }

  async function registerForEvent(buttonId: string) {
    if (!currentUserId.trim()) {
      errorMessage = 'Set user id before event registration.';
      return;
    }

    try {
      const response = await registerEvent(post._id, buttonId, {
        email: currentUserEmail?.trim() || undefined,
      });

      if (response.checkoutUrl) {
        window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
      }

      actionMessage =
        response.message ||
        (response.checkoutUrl ? 'Redirecting to Stripe checkout.' : 'Registration updated.');
      onRefresh();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Unable to register for event';
    }
  }

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (amountCents === undefined) return '';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }

  function ensureFormSelections(formList?: PostForm[]) {
    if (!formList) return;
    for (const f of formList) {
      if (!formSelections[f.id]) {
        const initial: Record<string, any> = {};
        f.items.forEach((i) => {
          if (['multiple_choice'].includes(i.type)) {
            initial[i.id] = [];
          } else if (['matrix_single', 'matrix_multiple'].includes(i.type)) {
            initial[i.id] = {};
            if (i.rows) {
              i.rows.forEach((row) => {
                initial[i.id][row] = i.type === 'matrix_multiple' ? [] : '';
              });
            }
          } else {
            initial[i.id] = '';
          }
        });
        formSelections[f.id] = initial;
      }
    }
  }

  $effect(() => {
    ensureFormSelections(post.forms);
  });

  function calculateFormTotal(form: PostForm): number {
    let total = form.basePrice;
    const selections = formSelections[form.id] || {};
    for (const item of form.items) {
      const val = selections[item.id];
      if (!val) continue;

      if (['single_choice', 'dropdown'].includes(item.type)) {
        const opt = item.options?.find((o) => o.id === val);
        if (opt) total += opt.priceModifier;
      } else if (['multiple_choice'].includes(item.type) && Array.isArray(val)) {
        val.forEach((id: string) => {
          const opt = item.options?.find((o) => o.id === id);
          if (opt) total += opt.priceModifier;
        });
      }
    }
    return Math.max(0, total);
  }

  async function handleFormSubmit(form: PostForm) {
    if (!currentUserId.trim()) {
      errorMessage = 'Please sign in to submit.';
      return;
    }

    const selections = formSelections[form.id] || {};
    for (const item of form.items) {
      const val = selections[item.id];
      if (item.required) {
        if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
          const rows = item.rows || [];
          if (!val) {
            errorMessage = `Please complete all rows for "${item.label}"`;
            return;
          }
          for (const row of rows) {
            const rowVal = val[row];
            if (
              rowVal === undefined ||
              rowVal === null ||
              rowVal === '' ||
              (Array.isArray(rowVal) && rowVal.length === 0)
            ) {
              errorMessage = `Please complete row "${row}" in "${item.label}"`;
              return;
            }
          }
        } else if (Array.isArray(val)) {
          if (val.length === 0) {
            errorMessage = `Please select an option for "${item.label}"`;
            return;
          }
        } else if (!val) {
          errorMessage = `Please provide an answer for "${item.label}"`;
          return;
        }
      }
    }

    try {
      let res;
      if (post.attachedFormId) {
        res = await submitFormService(form.id, {
          email: currentUserEmail || '',
          answers: selections,
        });
        if (!res.checkoutUrl) {
          formSubmitted[form.id] = true;
        }
      } else {
        res = await submitForm(post._id, form.id, {
          email: currentUserEmail,
          selections,
        });
      }

      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        actionMessage = res.message || 'Submitted successfully!';
      }
    } catch (e: any) {
      errorMessage = e.message || 'Form submission failed.';
    }
  }
</script>

<Card class="mb-6 relative group hover:shadow-md transition-shadow">
  <div class="flex justify-between items-start mb-4">
    <div class="flex items-center gap-3">
      <div
        class="w-10 h-10 rounded-full bg-cn-yellow/20 flex items-center justify-center text-cn-dark font-bold"
      >
        {post.authorId.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <div class="font-bold text-text-main">@{post.authorId}</div>
        <div class="text-xs text-text-muted">{new Date(post.createdAt).toLocaleDateString()}</div>
      </div>
    </div>
  </div>

  <div class="prose prose-sm max-w-none text-text-main mb-6">
    <SvelteMarkdown source={post.markdown} />
  </div>

  {#if post.images && post.images.length > 0 && authToken}
    <div class="grid grid-cols-2 gap-2 mb-6">
      {#each post.images as img (img.mediaId)}
        <div class="rounded-xl overflow-hidden border border-cn-border">
          <PostImage media={img} {authToken} />
        </div>
      {/each}
    </div>
  {/if}

  {#if post.polls && post.polls.length > 0}
    <div class="space-y-4 mb-6">
      {#each post.polls as poll (poll.id)}
        <div class="rounded-xl border border-cn-border bg-cn-surface/30 p-4">
          <h4 class="font-bold mb-3 text-lg">{poll.question}</h4>
          <div class="space-y-2">
            {#each poll.options as option (option.id)}
              {@const isSelected = selectedOptions.includes(option.id)}
              <button
                class="w-full text-left p-3 rounded-xl border-2 transition-all flex justify-between items-center group/opt
                {isSelected
                  ? 'border-cn-yellow bg-cn-yellow/5'
                  : 'border-cn-border hover:border-cn-yellow/50 bg-white'}"
                onclick={() => toggleOption(poll.id, option.id, poll.multipleChoice)}
              >
                <span class="font-medium">{option.label}</span>
                <span class="text-sm font-mono text-text-muted bg-cn-surface px-2 py-1 rounded-lg">
                  {option.votes} votes
                </span>
              </button>
            {/each}
          </div>
          <div class="mt-4 flex justify-end">
            <Button
              variant="primary"
              class="px-8"
              disabled={selectedOptions.length === 0}
              onclick={() => submitVote(poll.id)}
            >
              Vote
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if post.eventButtons && post.eventButtons.length > 0}
    <div class="space-y-4 mt-6 pt-6 border-t border-cn-border">
      {#each post.eventButtons as btn (btn.id)}
        {@const isRegistered = btn.registrants.includes(currentUserId)}
        {@const isFull = Boolean(btn.capacity && btn.registrants.length >= btn.capacity)}
        {@const btnForm = btnForms[btn.id]}

        <div class="flex flex-col gap-2">
          {#if btn.formId}
            <!-- Event button with attached registration form -->
            {#if btnFormSubmitted[btn.id]}
              <div class="flex items-center gap-2 text-green-600 font-semibold text-sm">
                <span>✓</span>
                <span>{btn.label} — Inscrit</span>
                <button
                  class="ml-2 text-xs text-text-muted underline"
                  onclick={() =>
                    (btnFormExpanded = { ...btnFormExpanded, [btn.id]: !btnFormExpanded[btn.id] })}
                >
                  Voir ma réponse
                </button>
              </div>
            {:else}
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-xl border border-cn-border bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-all disabled:opacity-60"
                disabled={isFull}
                onclick={() =>
                  (btnFormExpanded = { ...btnFormExpanded, [btn.id]: !btnFormExpanded[btn.id] })}
              >
                {isFull ? 'Complet' : btn.label}
                {#if btn.requiresPayment && !isFull}
                  <span class="opacity-80">({formatCurrency(btn.amountCents, btn.currency)})</span>
                {/if}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="h-4 w-4 transition-transform {btnFormExpanded[btn.id] ? 'rotate-180' : ''}"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fill-rule="evenodd"
                    d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            {/if}

            {#if btnFormExpanded[btn.id] && btnForm}
              <div class="rounded-xl border border-cn-border bg-white p-4 space-y-3">
                {#each btnForm.items as item (item.id)}
                  <div class="space-y-1">
                    <!-- svelte-ignore a11y_label_has_associated_control -->
                    <label class="block text-sm font-semibold text-text-main">
                      {item.label}{#if item.required}<span class="text-red-500 ml-0.5">*</span>{/if}
                    </label>
                    {#if item.type === 'short_text'}
                      <input
                        type="text"
                        class="w-full rounded-lg border border-cn-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cn-yellow disabled:bg-gray-100"
                        bind:value={btnFormSelections[btn.id][item.id]}
                        disabled={btnFormSubmitted[btn.id]}
                      />
                    {:else if item.type === 'long_text'}
                      <textarea
                        rows="3"
                        class="w-full rounded-lg border border-cn-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cn-yellow resize-y disabled:bg-gray-100"
                        bind:value={btnFormSelections[btn.id][item.id]}
                        disabled={btnFormSubmitted[btn.id]}
                      ></textarea>
                    {:else if item.type === 'single_choice' || item.type === 'dropdown'}
                      <select
                        class="w-full rounded-lg border border-cn-border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cn-yellow disabled:bg-gray-100"
                        bind:value={btnFormSelections[btn.id][item.id]}
                        disabled={btnFormSubmitted[btn.id]}
                      >
                        <option value="" disabled selected>Choisir...</option>
                        {#each item.options ?? [] as opt (opt.id)}
                          <option value={opt.id}
                            >{opt.label}{opt.priceModifier > 0
                              ? ` (+${formatCurrency(opt.priceModifier, btnForm.currency)})`
                              : ''}</option
                          >
                        {/each}
                      </select>
                    {:else if item.type === 'multiple_choice'}
                      <div class="space-y-1">
                        {#each item.options ?? [] as opt (opt.id)}
                          <label class="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              value={opt.id}
                              bind:group={btnFormSelections[btn.id][item.id]}
                              disabled={btnFormSubmitted[btn.id]}
                              class="accent-cn-yellow"
                            />
                            {opt.label}
                          </label>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
                {#if !btnFormSubmitted[btn.id]}
                  <div class="flex justify-end pt-2">
                    <Button variant="primary" onclick={() => handleBtnFormSubmit(btn.id)}>
                      {btnForm.submitLabel}
                      {#if btnForm.basePrice > 0}
                        <span class="ml-1 opacity-80"
                          >— {formatCurrency(btnForm.basePrice, btnForm.currency)}</span
                        >
                      {/if}
                    </Button>
                  </div>
                {/if}
              </div>
            {/if}
          {:else}
            <!-- Simple event button (no form) -->
            <div class="flex flex-col items-start gap-2">
              <Button
                variant={isRegistered ? 'ghost' : 'primary'}
                disabled={isRegistered || (isFull && !isRegistered)}
                onclick={() => registerForEvent(btn.id)}
                class="w-full sm:w-auto"
              >
                {isRegistered ? 'Registered ✓' : btn.label}
                {#if btn.requiresPayment && !isRegistered}
                  <span class="ml-1 opacity-80"
                    >({formatCurrency(btn.amountCents, btn.currency)})</span
                  >
                {/if}
              </Button>
              {#if isFull && !isRegistered}
                <span class="text-xs text-red-500 font-bold">Event Full</span>
              {/if}
              {#if isRegistered}
                <span class="text-xs text-green-600 font-bold">You are going!</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if forms && forms.length > 0}
    <div class="mt-6 border-t border-cn-border pt-6 space-y-6">
      {#each forms as form (form.id)}
        <div class="rounded-xl border border-cn-border overflow-hidden">
          {#if formSubmitted[form.id] && !formExpanded[form.id]}
            <!-- Submitted & Collapsed: "Voir ma réponse" Button -->
            <div class="bg-cn-surface/30 p-4 flex flex-col items-center gap-3">
              <h3 class="font-bold text-lg text-text-main text-center">
                {form.title} ✓
              </h3>
              <button
                class="px-4 py-2 bg-white border border-cn-border rounded-lg text-sm font-semibold hover:bg-gray-50 transition-colors shadow-sm text-center"
                onclick={() => (formExpanded[form.id] = true)}
              >
                Voir ma réponse
              </button>
            </div>
          {:else}
            <!-- Not Submitted OR Expanded: Normal Form Header + Content -->
            <div class="bg-cn-surface/30 p-4">
              <button
                class="w-full flex justify-between items-center mb-0 pb-2 border-b border-cn-border/50 hover:bg-black/5 rounded px-2 transition-colors cursor-pointer"
                onclick={() => (formExpanded[form.id] = !formExpanded[form.id])}
              >
                <div class="flex items-center gap-2">
                  <h3 class="font-bold text-lg text-text-main text-left">
                    {form.title}
                  </h3>
                  {#if formSubmitted[form.id]}
                    <span class="px-2 py-0.5 text-xs text-white bg-green-500 rounded-full"
                      >Répondu</span
                    >
                  {/if}
                </div>
                <div class="flex items-center gap-2">
                  {#if form.basePrice > 0}
                    <span
                      class="text-sm font-mono bg-cn-yellow/20 px-2 py-1 rounded text-cn-dark font-medium"
                    >
                      Base: {formatCurrency(form.basePrice, form.currency)}
                    </span>
                  {/if}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="h-5 w-5 text-text-muted transition-transform duration-200 {formExpanded[
                      form.id
                    ]
                      ? 'rotate-180'
                      : ''}"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </div>
              </button>

              {#if formExpanded[form.id]}
                <div class="space-y-4 mt-4 origin-top transition-all duration-300">
                  {#each form.items as item (item.id)}
                    <div class="space-y-1">
                      <!-- svelte-ignore a11y_label_has_associated_control -->
                      <label class="block text-sm font-semibold text-text-main">
                        {item.label}
                        {#if item.required}<span class="text-red-500 ml-0.5">*</span>{/if}
                      </label>

                      {#if ['short_text', 'long_text'].includes(item.type)}
                        {#if item.type === 'short_text'}
                          <input
                            type="text"
                            class="w-full rounded-lg border-cn-border bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-cn-yellow focus:border-cn-yellow outline-none transition-all placeholder:text-gray-400 disabled:bg-gray-100 disabled:text-gray-500"
                            bind:value={formSelections[form.id][item.id]}
                            placeholder="Your answer"
                            disabled={formSubmitted[form.id]}
                          />
                        {:else}
                          <textarea
                            rows="3"
                            class="w-full rounded-lg border-cn-border bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-cn-yellow focus:border-cn-yellow outline-none transition-all resize-y placeholder:text-gray-400 disabled:bg-gray-100 disabled:text-gray-500"
                            bind:value={formSelections[form.id][item.id]}
                            placeholder="Your answer"
                            disabled={formSubmitted[form.id]}
                          ></textarea>
                        {/if}
                      {:else if item.type === 'dropdown' || item.type === 'single'}
                        <select
                          class="w-full rounded-lg border-cn-border bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-cn-yellow focus:border-cn-yellow outline-none transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23131313%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[length:0.7em] bg-[right:0.7em_center] pr-8 disabled:bg-gray-100 disabled:text-gray-500"
                          bind:value={formSelections[form.id][item.id]}
                          disabled={formSubmitted[form.id]}
                        >
                          <option value="" disabled selected>Select an option...</option>
                          {#each item.options as opt (opt.id)}
                            <option value={opt.id}>
                              {opt.label}
                              {#if opt.priceModifier > 0}
                                (+{formatCurrency(opt.priceModifier, form.currency)})
                              {:else if opt.priceModifier < 0}
                                ({formatCurrency(opt.priceModifier, form.currency)})
                              {/if}
                            </option>
                          {/each}
                        </select>
                      {:else if item.type === 'single_choice'}
                        <div class="space-y-2 mt-2">
                          {#each item.options as opt (opt.id)}
                            <label
                              class="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-black/5 transition-colors group {formSubmitted[
                                form.id
                              ]
                                ? 'cursor-not-allowed opacity-75'
                                : ''}"
                            >
                              <input
                                type="radio"
                                name={`radio-${form.id}-${item.id}`}
                                value={opt.id}
                                bind:group={formSelections[form.id][item.id]}
                                class="mt-0.5 appearance-none w-4 h-4 rounded-full border border-gray-400 checked:border-cn-dark checked:bg-cn-yellow checked:ring-2 checked:ring-offset-1 checked:ring-cn-yellow transition-all relative disabled:bg-gray-200 disabled:border-gray-300"
                                disabled={formSubmitted[form.id]}
                              />
                              <div
                                class="text-sm text-text-main group-hover:text-cn-dark transition-colors"
                              >
                                {opt.label}
                                {#if opt.priceModifier !== 0}
                                  <span
                                    class="text-text-muted text-xs font-mono ml-1 font-medium bg-gray-100 px-1 rounded"
                                  >
                                    {opt.priceModifier > 0 ? '+' : ''}{formatCurrency(
                                      opt.priceModifier,
                                      form.currency
                                    )}
                                  </span>
                                {/if}
                              </div>
                            </label>
                          {/each}
                        </div>
                      {:else if item.type === 'multiple_choice'}
                        <div class="space-y-2 mt-2">
                          {#each item.options as opt (opt.id)}
                            <label
                              class="flex items-start gap-3 cursor-pointer p-2 rounded-lg hover:bg-black/5 transition-colors group {formSubmitted[
                                form.id
                              ]
                                ? 'cursor-not-allowed opacity-75'
                                : ''}"
                            >
                              <input
                                type="checkbox"
                                value={opt.id}
                                bind:group={formSelections[form.id][item.id]}
                                class="mt-0.5 appearance-none w-4 h-4 rounded border border-gray-400 checked:bg-cn-yellow checked:border-cn-dark checked:ring-2 checked:ring-offset-1 checked:ring-cn-yellow relative transition-all before:content-[''] before:absolute before:inset-0 before:m-auto before:w-2.5 before:h-1.5 before:border-l-2 before:border-b-2 before:border-cn-dark before:rotate-[-45deg] before:opacity-0 checked:before:opacity-100 disabled:bg-gray-200 disabled:border-gray-300"
                                disabled={formSubmitted[form.id]}
                              />
                              <div
                                class="text-sm text-text-main group-hover:text-cn-dark transition-colors"
                              >
                                {opt.label}
                                {#if opt.priceModifier !== 0}
                                  <span
                                    class="text-text-muted text-xs font-mono ml-1 font-medium bg-gray-100 px-1 rounded"
                                  >
                                    {opt.priceModifier > 0 ? '+' : ''}{formatCurrency(
                                      opt.priceModifier,
                                      form.currency
                                    )}
                                  </span>
                                {/if}
                              </div>
                            </label>
                          {/each}
                        </div>
                      {:else if item.type === 'linear_scale'}
                        <div class="py-4 px-2">
                          <div
                            class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-wider mb-2 px-1"
                          >
                            <span>{item.scale?.minLabel || item.scale?.min}</span>
                            <span>{item.scale?.maxLabel || item.scale?.max}</span>
                          </div>
                          <div
                            class="flex justify-between items-center gap-1 bg-white p-2 rounded-xl border border-cn-border"
                          >
                            {#each Array.from({ length: (item.scale?.max || 5) - (item.scale?.min || 1) + 1 }, (_, i) => (item.scale?.min || 1) + i) as val (val)}
                              <label
                                class="flex flex-col items-center gap-2 cursor-pointer flex-1 group {formSubmitted[
                                  form.id
                                ]
                                  ? 'cursor-not-allowed opacity-75'
                                  : ''}"
                              >
                                <input
                                  type="radio"
                                  name={`scale-${form.id}-${item.id}`}
                                  value={val}
                                  bind:group={formSelections[form.id][item.id]}
                                  class="appearance-none w-5 h-5 rounded-full border border-gray-300 checked:border-cn-dark checked:bg-cn-yellow checked:ring-2 checked:ring-offset-1 checked:ring-cn-yellow transition-all disabled:bg-gray-200"
                                  disabled={formSubmitted[form.id]}
                                />
                                <span
                                  class="text-xs font-bold text-text-muted group-hover:text-cn-dark transition-colors"
                                  >{val}</span
                                >
                              </label>
                            {/each}
                          </div>
                        </div>
                      {:else if ['matrix_single', 'matrix_multiple'].includes(item.type)}
                        <div class="overflow-x-auto mt-2 -mx-2 md:mx-0">
                          <table class="w-full text-sm border-separate border-spacing-0">
                            <thead>
                              <tr>
                                <th class="w-1/3 min-w-[120px] sticky left-0 bg-cn-surface z-10"
                                ></th>
                                {#each item.options as col (col.id)}
                                  <th
                                    class="px-2 py-2 text-center font-bold text-xs text-text-muted uppercase min-w-[80px]"
                                    >{col.label}</th
                                  >
                                {/each}
                              </tr>
                            </thead>
                            <tbody>
                              {#each item.rows || [] as row (row)}
                                <tr class="group hover:bg-white/50 transition-colors">
                                  <td
                                    class="py-3 pr-4 font-medium text-text-main sticky left-0 bg-cn-surface group-hover:bg-cn-surface/80 z-10 border-b border-dashed border-gray-100"
                                    >{row}</td
                                  >
                                  {#each item.options as col (col.id)}
                                    <td
                                      class="text-center py-3 border-b border-dashed border-gray-100"
                                    >
                                      <div class="flex justify-center">
                                        {#if item.type === 'matrix_single'}
                                          <input
                                            type="radio"
                                            name={`matrix-${form.id}-${item.id}-${row}`}
                                            value={col.id}
                                            bind:group={formSelections[form.id][item.id][row]}
                                            class="appearance-none w-4 h-4 rounded-full border border-gray-400 checked:border-cn-dark checked:bg-cn-yellow checked:ring-2 checked:ring-offset-1 checked:ring-cn-yellow transition-all disabled:bg-gray-200"
                                            disabled={formSubmitted[form.id]}
                                          />
                                        {:else}
                                          <input
                                            type="checkbox"
                                            value={col.id}
                                            bind:group={formSelections[form.id][item.id][row]}
                                            class="appearance-none w-4 h-4 rounded border border-gray-400 checked:bg-cn-yellow checked:border-cn-dark checked:ring-2 checked:ring-offset-1 checked:ring-cn-yellow relative transition-all before:content-[''] before:absolute before:inset-0 before:m-auto before:w-2.5 before:h-1.5 before:border-l-2 before:border-b-2 before:border-cn-dark before:rotate-[-45deg] before:opacity-0 checked:before:opacity-100 disabled:bg-gray-200"
                                            disabled={formSubmitted[form.id]}
                                          />
                                        {/if}
                                      </div>
                                    </td>
                                  {/each}
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {:else}
                        <div
                          class="p-3 bg-red-50 text-red-600 text-xs rounded-lg border border-red-100"
                        >
                          Unsupported field type: <strong>{item.type}</strong>
                        </div>
                      {/if}
                    </div>
                  {/each}

                  <div
                    class="pt-4 mt-2 border-t border-cn-border flex items-center justify-between"
                  >
                    <div class="font-bold text-lg text-cn-dark">
                      Total: {formatCurrency(calculateFormTotal(form), form.currency)}
                      {#if formSubmitted[form.id]}
                        <span class="text-xs text-green-600 ml-2">(Already Submitted)</span>
                      {/if}
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      class="px-6"
                      disabled={formSubmitted[form.id]}
                      onclick={() => handleFormSubmit(form)}
                    >
                      {formSubmitted[form.id] ? 'Submitted' : form.submitLabel}
                    </Button>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if errorMessage}
    <div
      class="mt-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm font-medium border border-red-100"
    >
      {errorMessage}
    </div>
  {/if}
  {#if actionMessage}
    <div
      class="mt-4 p-3 rounded-xl bg-green-50 text-green-600 text-sm font-medium border border-green-100"
    >
      {actionMessage}
    </div>
  {/if}
</Card>
