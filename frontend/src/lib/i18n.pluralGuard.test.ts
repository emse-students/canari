/**
 * Guard: a message that prints `{count}` straight before a word must be plural-aware.
 *
 * A bare `"{count} questions"` reads "1 questions" for a count of one (and, in French, for zero).
 * The repo's mechanism is a Paraglide plural message (`declarations` + `countPlural` selector), so
 * a plain-string message with `{count} <word>` is either fixed or listed in ALLOWED with the reason
 * its count can never read wrong. Twin messages (`key_one`, `key_many`, `key_other`) are the
 * older, call-site-branching form and are accepted when their `_one` half exists.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Messages = Record<string, unknown>;

const load = (locale: string): Messages =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8'));

/** Audited exceptions: key -> why a count of 1 (or 0) never reaches the string. */
const ALLOWED: Record<string, string> = {
  chat_community_invite_max_uses_count: '"max" is a label, not a noun to inflect',
  chat_send_held: '"waiting" is a participle; "(1 waiting)" reads right',
  time_minutes_ago: '"min" is an invariable abbreviation',
  replay_time_left_minutes: '"min" is an invariable abbreviation',
  asso_member_access_some: '"sur" introduces a total, not a noun',
  moderation_live_standing_cuts: '"sur" introduces a total, not a noun',
  admin_hub_pending_count: '"pending" is invariable',
  calendar_event_coorganisers_pending: '"pending" is invariable',
  reactors_more_label: '"more" is invariable in English; French is plural-aware',
  bookings_column_free_count: '"free" is invariable in English; French is plural-aware',
  bookings_stranded_more: '"more" is invariable',
  post_show_comments_label: 'the button is hidden below two comments',
  post_comment_show_replies_label: 'the button is hidden below two replies',
  post_poll_max_selections_option: 'a limit option exists for two answers or more only',
  post_poll_max_selections_badge: 'a limit exists for two answers or more only',
  post_poll_selection_full_hint: 'a limit exists for two answers or more only',
  calendar_owners_and_others: 'shown for three owners or more (the first is named)',
  directory_results_truncated: 'a truncation never leaves one result',
  notif_grouped_many_others: 'a grouped notification carries at least two others',
  reel_sendto_cap: 'the send cap is a fixed number above one',
  reel_sendto_failed_in_many: 'chosen only when more than one conversation failed',
  reel_sendto_cancel_all_hint: 'shown only when the take reaches two conversations or more',
  reel_sendto_delete_everywhere_hint: 'shown only when the take reaches two conversations or more',
  bookings_row_resources: 'shown only when a space has more than one resource',
  post_reach_chip_spaces: 'the chip names the one space, and counts only two or more',
};

const BARE = /\{count\}\s+[^\W\d_]{3,}/i;

describe('plural-aware messages', () => {
  for (const locale of ['fr', 'en']) {
    it(`${locale}: no bare "{count} noun" outside the audited exceptions`, () => {
      const messages = load(locale);
      const offenders = Object.entries(messages)
        .filter(([, value]) => typeof value === 'string' && BARE.test(value))
        .map(([key]) => key)
        .filter((key) => !/_(one|many|other)$/.test(key))
        .filter((key) => !(`${key}_one` in messages))
        .filter((key) => !(key in ALLOWED));
      expect(offenders).toEqual([]);
    });
  }
});
