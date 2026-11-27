<script lang="ts">
  import { Check } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Button from '$lib/components/ui/Button.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import LePic from '$lib/components/games/LePic.svelte';
  import {
    PATH_FAMILIES,
    TUTORIAL_TABS,
    countDone,
    firstUndone,
    shortName,
    tabLessons,
    type TutorialTab,
  } from '$lib/minesweeper/tutorial/path';
  import { parseTab, tabUrl } from '$lib/navigation/tabQuery';
  import { internalPath } from '$lib/utils/internalPath';
  import { loadTutorialProgress } from '$lib/minesweeper/tutorial/progress';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE TUTORIAL PATH (owner, 2026-11-27): two tabs, "Les bases" and "Motifs", each a zigzag of diamond tiles -
   * done is green with a check, the current one is yellow with Le Pic standing on it, the rest are plain.
   * **The order is advised and EVERYTHING STAYS OPEN**: every tile is a link, whatever is done. Under the tabs,
   * the progress of the family the player is in and a "Continue" button to the first lesson not done.
   * There is no streak, no flame, no medal and no points - a tutorial and its levels, nothing that calls the
   * player back (charter, principle 3). Progress is per device (`progress.ts`).
   * docs/wiki/frontend/modules/minesweeper.md, "The tutorial path"
   */
  const progress = loadTutorialProgress();
  const done = $derived(new Set(progress.done));

  /** With no `?tab=`, the path opens on the basics until they are all done, then on the patterns. */
  const autoTab: TutorialTab = firstUndone('basics', new Set(progress.done))
    ? 'basics'
    : 'patterns';
  /**
   * THE OPEN TAB LIVES IN THE URL (`?tab=`, read once, written with `replaceState` through `tabQuery`): a lesson's Back
   * link carries the tab of its family, so returning from a pattern lands on Motifs, not on the default.
   */
  let tab = $state<TutorialTab>(parseTab(page.url.searchParams.get('tab'), TUTORIAL_TABS, autoTab));

  function selectTab(next: TutorialTab) {
    tab = next;
    void goto(resolve(internalPath(tabUrl(page.url, next, autoTab))), {
      shallow: true,
      replace: true,
      state: page.state,
    });
  }

  const lessons = $derived(tabLessons(tab));
  const families = $derived(PATH_FAMILIES[tab]);
  const current = $derived(firstUndone(tab, done));
  /** The family the "Continue" button leads into, or null when the tab is complete. */
  const currentFamily = $derived(
    current ? (families.find((f) => f.lessons.includes(current)) ?? null) : null
  );

  /** The zigzag: each tile's horizontal offset from the centre of the path, in rem, cycling. */
  const ZIGZAG = [2.2, -2.2, -5.9, -1.6, 2.8, 5.9, 2.8, -1.6] as const;

  const tabItems = $derived(
    TUTORIAL_TABS.map((key) => {
      const all = tabLessons(key);
      const count = String(countDone(all, done));
      const total = String(all.length);
      return {
        key,
        label:
          key === 'basics'
            ? m.minesweeper_path_tab_basics({ done: count, total })
            : m.minesweeper_path_tab_patterns({ done: count, total }),
      };
    })
  );

  /** Where a lesson of this tab sits in the zigzag, counted across families so the path flows on. */
  function offsetOf(lessonId: string): number {
    const at = lessons.findIndex((l) => l.id === lessonId);
    return ZIGZAG[at % ZIGZAG.length];
  }

  function stateOf(id: string): 'done' | 'current' | 'todo' {
    return done.has(id) ? 'done' : id === current?.id ? 'current' : 'todo';
  }

  function tileLabel(id: string, title: string): string {
    const state = stateOf(id);
    return state === 'done'
      ? m.minesweeper_path_tile_done({ name: title })
      : state === 'current'
        ? m.minesweeper_path_tile_current({ name: title })
        : m.minesweeper_path_tile_todo({ name: title });
  }

  /** The 1-based position of a lesson within its family, for a tile too small for its name. */
  function positionInFamily(lessons: readonly { id: string }[], id: string): number {
    return lessons.findIndex((l) => l.id === id) + 1;
  }

  console.debug('[minesweeper] tutorial path opened', { done: progress.done.length });
</script>

<div class="space-y-4" data-testid="tutorial-path">
  <SegmentedControl
    items={tabItems}
    value={tab}
    onSelect={selectTab}
    label={m.minesweeper_path_tabs_label()}
  />

  <div class="flex items-start gap-3">
    <LePic size={56} mood={current ? 'happy' : 'neutral'} pose="rest" />
    <p class="bg-cn-surface text-text-main flex-1 rounded-2xl px-3 py-2.5 text-sm">
      {tab === 'basics' ? m.minesweeper_path_intro_basics() : m.minesweeper_path_intro_patterns()}
    </p>
  </div>

  <section class="bg-cn-surface space-y-3 rounded-2xl p-3" data-testid="tutorial-continue">
    {#if current && currentFamily}
      {@const total = currentFamily.lessons.length}
      {@const count = countDone(currentFamily.lessons, done)}
      <div class="flex items-center gap-3">
        <span class="text-text-muted text-sm font-semibold">{currentFamily.label()}</span>
        <div
          class="bg-cn-bg h-2.5 flex-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={count}
          aria-label={currentFamily.label()}
        >
          <div class="bg-green-ok h-full rounded-full" style:width="{(count / total) * 100}%"></div>
        </div>
        <span class="text-text-main text-sm font-bold">{count} / {total}</span>
      </div>
      <Button href={resolve('/games/tutorial/[id]', { id: current.id })} class="w-full">
        {m.minesweeper_path_continue({ name: shortName(current.title()) })}
      </Button>
    {:else}
      <p class="text-text-main text-sm font-semibold">{m.minesweeper_path_all_done()}</p>
      <Button href={resolve('/games/play')} class="w-full">{m.minesweeper_tutorial_play()}</Button>
    {/if}
  </section>

  {#each families as family (family.key)}
    {@const count = countDone(family.lessons, done)}
    <section aria-labelledby="family-{tab}-{family.key}" data-testid="path-family">
      <h2
        id="family-{tab}-{family.key}"
        class="text-text-muted flex items-center justify-between text-sm font-bold"
      >
        <span>{family.label()}</span>
        <span>{count} / {family.lessons.length}</span>
      </h2>
      <ol class="mt-2">
        {#each family.lessons as lesson (lesson.id)}
          {@const state = stateOf(lesson.id)}
          {@const dx = offsetOf(lesson.id)}
          {@const name = shortName(lesson.title())}
          <li class="relative flex h-18 items-center justify-center">
            <a
              href={resolve('/games/tutorial/[id]', { id: lesson.id })}
              class="path-tile"
              data-state={state}
              data-lesson={lesson.id}
              aria-label={tileLabel(lesson.id, lesson.title())}
              title={lesson.title()}
              style:--path-dx="{dx}rem"
            >
              <span class="path-face">
                {#if state === 'done'}
                  <Check size={26} strokeWidth={3.5} />
                {:else}
                  <span class="path-name" class:path-name-long={name.length > 5}>
                    {name.length > 5 ? String(positionInFamily(family.lessons, lesson.id)) : name}
                  </span>
                {/if}
              </span>
            </a>
            {#if name.length > 5}
              <span
                class="text-text-muted pointer-events-none absolute top-1/2 max-w-2/5 -translate-y-1/2 text-xs font-semibold {dx >=
                0
                  ? 'left-0 text-left'
                  : 'right-0 text-right'}"
              >
                {name}
              </span>
            {/if}
            {#if state === 'current'}
              <span
                class="pointer-events-none absolute bottom-1 {dx >= 0
                  ? 'path-pic-left'
                  : 'path-pic-right'}"
                style:--path-dx="{dx}rem"
              >
                <LePic size={64} mood="happy" pose="rest" />
              </span>
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  {/each}
</div>

<style>
  /* A diamond tile: a rounded square turned 45 degrees, its label turned back. Colour comes from the app's
     tokens (green-ok, accent, surface); the hard edge is the same colour pulled toward black. */
  .path-tile {
    display: block;
    transform: translateX(var(--path-dx, 0));
    width: 3.5rem;
    height: 3.5rem;
    flex: none;
  }
  .path-face {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: var(--radius-lg);
    transform: rotate(45deg);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 120ms ease-out;
  }
  .path-face > :global(*) {
    transform: rotate(-45deg);
  }
  .path-tile[data-state='done'] .path-face {
    background: var(--green-ok);
    color: var(--cn-surface);
    box-shadow: 0.3rem 0.3rem 0 color-mix(in srgb, var(--green-ok) 70%, black);
  }
  .path-tile[data-state='current'] .path-face {
    background: var(--accent);
    color: var(--color-cn-ink);
    box-shadow:
      0.3rem 0.3rem 0 color-mix(in srgb, var(--accent) 70%, black),
      0 0 0 0.375rem color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .path-tile[data-state='todo'] .path-face {
    background: var(--cn-surface);
    color: var(--text-muted);
    box-shadow: 0.3rem 0.3rem 0 var(--cn-border);
  }
  .path-tile:hover .path-face,
  .path-tile:focus-visible .path-face {
    transform: rotate(45deg) translateY(-0.125rem);
  }
  .path-tile:focus-visible {
    outline: 2px solid var(--accent-icon);
    outline-offset: 0.5rem;
  }
  .path-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-base);
  }
  /* Le Pic stands beside the current tile, on the side with the room. */
  .path-pic-left {
    right: 50%;
    margin-right: calc(2.5rem - var(--path-dx, 0rem));
  }
  .path-pic-right {
    left: 50%;
    margin-left: calc(2.5rem + var(--path-dx, 0rem));
  }
  @media (prefers-reduced-motion: reduce) {
    .path-face {
      transition: none;
    }
  }
</style>
