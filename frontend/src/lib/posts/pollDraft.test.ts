/**
 * THE RULES A POLL IS COMPOSED BY, PINNED WHERE THEY ARE WRITTEN.
 *
 * Each case below is a thing the old textarea got wrong or could not express: an option was a line
 * of text, so "Oui, Non" was one of them and the refusal named nothing (user, 2026-09-21); an
 * option had no identity, so an edit minted new ids and emptied the poll; and a cap on how many
 * answers a voter may give did not exist at all.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyPollOptions,
  filledPollOptions,
  newPollOption,
  normalizeMaxSelections,
  pollDraftIssue,
  POLL_MIN_OPTIONS,
  type PollDraft,
} from './pollDraft';
import { toDatetimeLocalValue } from '$lib/utils/dates';

function draft(overrides: Partial<PollDraft> = {}): PollDraft {
  return {
    question: 'On y va ?',
    options: [newPollOption('Oui'), newPollOption('Non')],
    multipleChoice: false,
    maxSelections: null,
    endsAt: '',
    ...overrides,
  };
}

describe('poll options', () => {
  it('opens on two blank rows, each with its own identity', () => {
    const options = emptyPollOptions();
    expect(options).toHaveLength(POLL_MIN_OPTIONS);
    expect(new Set(options.map((o) => o.id)).size).toBe(POLL_MIN_OPTIONS);
  });

  it('drops the blank rows and trims the rest, keeping the ids', () => {
    // A blank row is an input the reader has not filled yet, not an error: a poll must be buildable
    // by adding three rows and filling them in any order.
    const kept = newPollOption('  Oui  ');
    const filled = filledPollOptions([kept, newPollOption('   '), newPollOption('Non')]);
    expect(filled.map((o) => o.label)).toEqual(['Oui', 'Non']);
    expect(filled[0].id).toBe(kept.id);
  });

  it('keeps a comma-separated answer as the ONE option it is', () => {
    // The mistake the old textarea's label ("Options (une par ligne)") existed to prevent, and
    // failed to: a line break is not a control a text box advertises. One row is now one option.
    expect(filledPollOptions([newPollOption('Oui, Non')])).toHaveLength(1);
  });
});

describe('normalizeMaxSelections', () => {
  it('is null whenever it cannot mean anything', () => {
    expect(normalizeMaxSelections(2, 4, false)).toBeNull(); // single choice caps at one already
    expect(normalizeMaxSelections(null, 4, true)).toBeNull();
    expect(normalizeMaxSelections(1, 4, true)).toBeNull();
  });

  it('drops a cap that allows every option, rather than storing it as a number', () => {
    // "4 of 4" is no cap. Stored as one, a later edit removing an option would silently turn it
    // into a real limit nobody set.
    expect(normalizeMaxSelections(4, 4, true)).toBeNull();
    expect(normalizeMaxSelections(5, 4, true)).toBeNull();
    expect(normalizeMaxSelections(3, 4, true)).toBe(3);
  });
});

describe('pollDraftIssue', () => {
  it('passes a poll that can be sent', () => {
    expect(pollDraftIssue(draft())).toBeNull();
  });

  it('names the question before anything else', () => {
    expect(pollDraftIssue(draft({ question: '  ', options: [] }))).toBe('question');
  });

  it('names the options when fewer than two are filled', () => {
    expect(pollDraftIssue(draft({ options: [newPollOption('Oui'), newPollOption('')] }))).toBe(
      'options'
    );
  });

  it('names a cap that contradicts the poll it caps', () => {
    // Below two, a multiple-choice poll is single-choice by another name: a contradiction the
    // reader wrote, and must see rather than have silently rewritten.
    expect(pollDraftIssue(draft({ multipleChoice: true, maxSelections: 1 }))).toBe('maxSelections');
    expect(pollDraftIssue(draft({ multipleChoice: false, maxSelections: 1 }))).toBeNull();
  });

  it('refuses a deadline that has already passed', () => {
    expect(pollDraftIssue(draft({ endsAt: '2020-01-01T10:00' }))).toBe('endsAt');
  });

  it('accepts the stored deadline of a poll being edited, however old', () => {
    // The edit form loads a poll that may have closed long ago. Only a CHANGED deadline has to be
    // ahead of us - otherwise fixing a typo on last term's poll would be impossible.
    const stored = '2020-01-01T10:00';
    expect(pollDraftIssue(draft({ endsAt: stored }), stored)).toBeNull();
    expect(pollDraftIssue(draft({ endsAt: '2020-02-01T10:00' }), stored)).toBe('endsAt');
  });

  it('accepts a deadline in the future', () => {
    // Through the same converter the inputs use: an ISO string sliced to 16 characters is UTC, and
    // a test that spelled it that way would pass or fail depending on the runner's timezone.
    const inAnHour = toDatetimeLocalValue(new Date(Date.now() + 3600_000).toISOString());
    expect(pollDraftIssue(draft({ endsAt: inAnHour }))).toBeNull();
  });
});
