<script lang="ts">
  import { Check, Target } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { getInstitutionReachOptions } from '$lib/posts/api';
  import {
    INSTITUTION_REACH_PUBLICS,
    sameSpace,
    type InstitutionReachDraft,
    type InstitutionReachPublic,
    type ReachSpace,
  } from '$lib/posts/institutionReach';
  import {
    CAMPUSES,
    campusLabel,
    formationLabel,
    type Campus,
    type Formation,
  } from '$lib/profile/miconnectProfile';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE REACH OF AN INSTITUTION'S POST OR EVENT, as the composer, the reel step, the post edit form
   * and the event form draw it (owner, 2026-11-10; events 2026-11-13, "the same picker block"): ONE
   * block - the spaces of the institution's own audience as chips grouped by
   * campus (a campus chip ticks or unticks the whole campus, a formation row does the same for a
   * formation present on several campuses), then the public, Tous / Étudiants / Personnel, then ONE
   * line saying who will see the post as chosen, or what is still missing. NOTHING IS PRE-SELECTED:
   * the caller keeps its publish button disabled until `isReachComplete`.
   */
  interface Props {
    /** Bindable: the spaces ticked and the public chosen (null until chosen). */
    reach: InstitutionReachDraft;
    /** The institution publishing: its audience is what may be ticked. */
    associationId: string;
    /** Named in the hint line. */
    associationName: string;
    /** A save is in flight (the edit form): every control holds still. */
    busy?: boolean;
    /**
     * Whether an empty choice blocks the caller (true: a new post). The edit form of a post published
     * before the reach existed passes false: left empty, its post keeps its stored audience, so the
     * missing-choice line is drawn muted rather than as a warning.
     */
    required?: boolean;
    /**
     * Called when the AUTHOR changes a choice - never when the picker prunes a space on its own. The
     * edit form sends a reach only after it (review of #3314).
     */
    ontouch?: () => void;
    /**
     * What the reach is for: the missing-choice line names the act it blocks ("publier" a post,
     * "déposer" an event). Everything else is the same block.
     */
    subject?: 'post' | 'event';
    /**
     * Where the offered spaces come from - the posts' route by default; the event form passes the
     * events' (`getEventReachOptions`), which asks the right to file the institution's events.
     */
    loadOptions?: (associationId: string) => Promise<{ spaces: ReachSpace[] }>;
  }

  let {
    reach = $bindable(),
    associationId,
    associationName,
    busy = false,
    required = true,
    ontouch,
    subject = 'post',
    loadOptions = getInstitutionReachOptions,
  }: Props = $props();

  let options = $state<ReachSpace[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  /** Bumped by the Retry of a failed load: the effect reads it, so a bump loads again. */
  let attempt = $state(0);

  $effect(() => {
    const id = associationId;
    void attempt;
    let cancelled = false;
    loading = true;
    failed = false;
    loadOptions(id)
      .then(({ spaces }) => {
        if (cancelled) return;
        options = spaces;
        // A space ticked earlier that the audience no longer holds (a restored draft, an edited post
        // whose institution lost a space) would be refused by the server: it is dropped here.
        const kept = reach.spaces.filter((s) => spaces.some((o) => sameSpace(o, s)));
        if (kept.length !== reach.spaces.length) {
          Log.d(
            'INSTITUTION_REACH',
            `${reach.spaces.length - kept.length} ticked space(s) left the audience: dropped`
          );
          reach = { ...reach, spaces: kept };
        }
        Log.d('INSTITUTION_REACH', `${spaces.length} space(s) offered`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[INSTITUTION_REACH] the reach options could not be loaded', err);
        failed = true;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  /**
   * The options on a campus this build knows, the only ones it can draw. A campus it does not know
   * (a server ahead of the build, or a value outside the profile's list) is a defect upstream, so
   * it is ACCUSED once per load - and if nothing is left to draw, the author is told so.
   */
  const drawable = $derived(
    options.filter((o) => (CAMPUSES as readonly string[]).includes(o.campus))
  );
  $effect(() => {
    const unknown = [...new Set(options.map((o) => o.campus))].filter(
      (c) => !(CAMPUSES as readonly string[]).includes(c)
    );
    if (unknown.length > 0) {
      console.warn(
        `[INSTITUTION_REACH] ${unknown.length} campus(es) of the audience unknown to this build, not drawn: ${unknown.join(', ')}`
      );
    }
  });
  /** The campuses the options cover, in the profile's order. */
  const campuses = $derived(CAMPUSES.filter((c) => drawable.some((o) => o.campus === c)));
  /** The formations present on more than one campus: only those earn a "whole formation" chip. */
  const sharedFormations = $derived(
    [...new Set(drawable.map((o) => o.formation))].filter(
      (f) => new Set(drawable.filter((o) => o.formation === f).map((o) => o.campus)).size > 1
    )
  );

  const isTicked = (space: ReachSpace) => reach.spaces.some((s) => sameSpace(s, space));
  const allTicked = (group: ReachSpace[]) => group.length > 0 && group.every(isTicked);

  /** Ticks every space of `group`, or unticks them all when they were all ticked. */
  function toggleGroup(group: ReachSpace[], what: string) {
    if (busy) return;
    const off = allTicked(group);
    const rest = reach.spaces.filter((s) => !group.some((g) => sameSpace(g, s)));
    reach = { ...reach, spaces: off ? rest : [...rest, ...group] };
    Log.d('INSTITUTION_REACH', `${what} ${off ? 'unticked' : 'ticked'}`);
    ontouch?.();
  }

  function choosePublic(next: InstitutionReachPublic) {
    if (busy) return;
    reach = { ...reach, public: next };
    Log.d('INSTITUTION_REACH', `public chosen: ${next}`);
    ontouch?.();
  }

  const publicLabel = (p: InstitutionReachPublic) =>
    p === 'all'
      ? m.post_reach_public_all()
      : p === 'students'
        ? m.post_reach_public_students()
        : m.post_reach_public_staff();

  const hint = $derived.by(() => {
    const noSpace = reach.spaces.length === 0;
    const event = subject === 'event';
    if (noSpace && reach.public === null) {
      return event ? m.event_reach_missing_both() : m.post_reach_missing_both();
    }
    if (noSpace) return event ? m.event_reach_missing_spaces() : m.post_reach_missing_spaces();
    if (reach.public === null) {
      return event ? m.event_reach_missing_public() : m.post_reach_missing_public();
    }
    const name = associationName;
    if (reach.public === 'students') return m.post_reach_hint_students({ name });
    // Staff by campus is decided for posts only (owner, 2026-11-14): an event keeps the old reach.
    if (reach.public === 'staff') {
      return event ? m.event_reach_hint_staff({ name }) : m.post_reach_hint_staff({ name });
    }
    return event ? m.event_reach_hint_all({ name }) : m.post_reach_hint_all({ name });
  });
  const complete = $derived(reach.spaces.length > 0 && reach.public !== null);
  const untouched = $derived(reach.spaces.length === 0 && reach.public === null);
  const warn = $derived(!complete && (required || !untouched));

  /** One name per picker for its public radios, so two pickers on a page never share a group. */
  const uid = $props.id();

  /**
   * A chip is a LABEL around a native checkbox or radio: the input carries the state and the
   * keyboard, the label the look - so no control is drawn by hand (`controlsGuard.test.ts`).
   */
  const chip =
    'inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50';
  const on = 'border-accent-icon bg-accent/15 text-accent-text';
  const off = 'border-cn-border text-text-muted hover:bg-cn-bg';
</script>

<fieldset class="border-cn-border rounded-lg border p-3" data-institution-reach-picker>
  <legend class="text-text-main flex items-center gap-1.5 px-1 text-sm font-bold">
    <Target size={14} strokeWidth={2.5} class="text-accent-text" aria-hidden="true" />
    {m.post_reach_title()}
  </legend>

  {#if loading}
    <p class="text-text-muted text-xs">{m.post_reach_loading()}</p>
  {:else if failed}
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-xs font-semibold text-red-600 dark:text-red-400" role="alert">
        {m.post_reach_load_error({ name: associationName })}
      </p>
      <Button
        variant="secondary"
        size="compact"
        disabled={busy}
        data-reach-retry
        onclick={() => {
          Log.d('INSTITUTION_REACH', 'the author retries loading the reach options');
          attempt += 1;
        }}
      >
        {m.common_retry_button()}
      </Button>
    </div>
  {:else if options.length === 0}
    <p class="text-text-muted text-xs">{m.post_reach_no_space({ name: associationName })}</p>
  {:else if drawable.length === 0}
    <p class="text-xs font-semibold text-red-600 dark:text-red-400" role="alert">
      {m.post_reach_unknown_campus({ name: associationName })}
    </p>
  {:else}
    <p class="text-text-muted text-2xs mb-1.5 font-semibold">{m.post_reach_spaces_label()}</p>
    <div class="space-y-2">
      {#each campuses as campus (campus)}
        {@const group = drawable.filter((o) => o.campus === campus)}
        {@const whole = allTicked(group)}
        <div class="flex flex-wrap items-center gap-1.5" data-reach-campus-row={campus}>
          <label
            class="{chip} {whole ? on : off}"
            title={m.post_reach_whole_campus({ campus: campusLabel(campus as Campus) })}
          >
            <input
              type="checkbox"
              class="sr-only"
              checked={whole}
              disabled={busy}
              aria-label={m.post_reach_whole_campus({ campus: campusLabel(campus as Campus) })}
              data-reach-campus={campus}
              onchange={() => toggleGroup(group, `campus ${campus}`)}
            />
            {#if whole}<Check size={12} strokeWidth={3} aria-hidden="true" />{/if}
            {campusLabel(campus as Campus)}
          </label>
          {#each group as space (space.formation)}
            {@const ticked = isTicked(space)}
            <label class="{chip} {ticked ? on : off}">
              <input
                type="checkbox"
                class="sr-only"
                checked={ticked}
                disabled={busy}
                data-reach-space="{space.formation}|{space.campus}"
                onchange={() => toggleGroup([space], `space ${space.formation}|${space.campus}`)}
              />
              {#if ticked}<Check size={12} strokeWidth={3} aria-hidden="true" />{/if}
              {formationLabel(space.formation as Formation)}
            </label>
          {/each}
        </div>
      {/each}
      {#if sharedFormations.length > 0}
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-text-muted text-2xs font-semibold">{m.post_reach_formation_row()}</span>
          {#each sharedFormations as formation (formation)}
            {@const group = drawable.filter((o) => o.formation === formation)}
            {@const whole = allTicked(group)}
            <label class="{chip} {whole ? on : off}">
              <input
                type="checkbox"
                class="sr-only"
                checked={whole}
                disabled={busy}
                aria-label={m.post_reach_whole_formation({
                  formation: formationLabel(formation as Formation),
                })}
                data-reach-formation={formation}
                onchange={() => toggleGroup(group, `formation ${formation}`)}
              />
              {#if whole}<Check size={12} strokeWidth={3} aria-hidden="true" />{/if}
              {formationLabel(formation as Formation)}
            </label>
          {/each}
        </div>
      {/if}
    </div>

    <p class="text-text-muted text-2xs mt-3 mb-1.5 font-semibold" id="{uid}-public">
      {m.post_reach_public_label()}
    </p>
    <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby="{uid}-public">
      {#each INSTITUTION_REACH_PUBLICS as option (option)}
        {@const chosen = reach.public === option}
        <label class="{chip} {chosen ? on : off}">
          <input
            type="radio"
            class="sr-only"
            name="{uid}-public"
            value={option}
            checked={chosen}
            disabled={busy}
            data-reach-public={option}
            onchange={() => choosePublic(option)}
          />
          {#if chosen}<Check size={12} strokeWidth={3} aria-hidden="true" />{/if}
          {publicLabel(option)}
        </label>
      {/each}
    </div>

    <p
      class="text-2xs mt-2 leading-snug {warn
        ? 'text-amber-warn-text font-semibold'
        : 'text-text-muted'}"
      aria-live="polite"
      data-reach-hint
    >
      {hint}
    </p>
  {/if}
</fieldset>
