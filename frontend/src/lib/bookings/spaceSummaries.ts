/**
 * THE ONE LINE UNDER EACH SECTION'S TITLE (WP-R6, D51): the section's CURRENT answer, so a closed or
 * scrolled-past section still reads. Pure over the draft - what the organiser sees is what the
 * fields hold right now, saved or not - and every sentence is Paraglide.
 *
 * The three sections that hold plain choices read their choices; the two collapsed ones (rules, data)
 * keep a fixed hint and the badge that counts what is set.
 */
import { m } from '$lib/paraglide/messages';
import type { SettingsDraft } from './spaceSettings.svelte';

export interface SectionSummaries {
  essentials: string;
  when: string;
  who: string;
  rules: string;
  data: string;
}

const isCount = (v: string) => /^\d+$/.test(v.trim());

/**
 * `columnCount` is the space's columns: a hidden default column (D44) is one and says nothing, so
 * the sentence names columns only from two.
 */
export function sectionSummaries(draft: SettingsDraft, columnCount: number): SectionSummaries {
  const mode =
    draft.slotMode === 'slots'
      ? m.bookings_summary_when_slots()
      : isCount(draft.stepMinutes) && isCount(draft.maxSteps)
        ? m.bookings_summary_when_step({
            step: draft.stepMinutes.trim(),
            max: draft.maxSteps.trim(),
          })
        : m.bookings_summary_when_step_any();
  const who = [
    draft.audience == null ? m.bookings_summary_audience_all() : m.bookings_summary_audience_some(),
    draft.nameVisibility === 'names'
      ? m.bookings_summary_names_visible()
      : m.bookings_summary_names_hidden(),
    draft.discoverability === 'listed'
      ? m.bookings_summary_listed()
      : m.bookings_summary_link_only(),
    draft.items.length === 0
      ? m.bookings_summary_no_question()
      : m.bookings_summary_questions({ count: draft.items.length }),
  ];
  return {
    essentials: m.bookings_summary_essentials(),
    when: [mode, columnCount > 1 ? m.bookings_summary_columns({ count: columnCount }) : null]
      .filter(Boolean)
      .join(' \u00b7 '),
    who: who.join(' \u00b7 '),
    rules: m.bookings_summary_rules(),
    data: m.bookings_summary_data(),
  };
}
