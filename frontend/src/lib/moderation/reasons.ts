import { m } from '$lib/paraglide/messages';

/** The four reasons a report can carry, as the server's `reason` field accepts them. */
export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'other';

/** One reason, with the label shown to the reporter. */
export interface ReportReasonOption {
  label: string;
  value: ReportReason;
}

/**
 * The reason list every report surface offers - a post, a comment, a person.
 *
 * ONE LIST, because they had drifted into three different questions: a post asked for a reason, a
 * comment sent `inappropriate` with no question asked, and a person could not be reported at all.
 * A moderator reading the queue has to compare rows, and rows are only comparable when the same
 * question produced them.
 *
 * Called rather than exported as a constant: the labels come from Paraglide, so they must be read
 * inside the caller's reactive scope to follow a locale change.
 */
export function reportReasons(): ReportReasonOption[] {
  return [
    { label: m.post_spam(), value: 'spam' },
    { label: m.post_harassment(), value: 'harassment' },
    { label: m.post_inappropriate(), value: 'inappropriate' },
    { label: m.post_autre(), value: 'other' },
  ];
}
