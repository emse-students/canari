/**
 * WHAT IS PINNED IS THAT THE COMPOSER REFUSES BEFORE IT ASKS, AND THAT ONE RULE HAS ONE SPELLING.
 *
 * The report behind this file cost two production round trips to learn a fact the client held:
 * `mute-status` answered `200` twice on 2026-09-23 and no `POST /api/posts` ever followed, because
 * a poll had been opened and never filled. The assertions below are the two halves that a screen
 * cannot assert about itself - that every locally-answerable refusal is named without a network
 * call, and that the button's rule and the throw's rule are the same function.
 */
import { describe, it, expect } from 'vitest';
import {
  hasContent,
  localPublishBlocker,
  parsePollOptions,
  type ComposerContents,
} from './composerReadiness';
import { m } from '$lib/paraglide/messages';

/** A draft that publishes: text, no attachment of any kind. */
function publishable(overrides: Partial<ComposerContents> = {}): ComposerContents {
  return {
    markdown: 'Bonjour',
    fileCount: 0,
    includePoll: false,
    pollQuestion: '',
    pollOptionsRaw: 'Oui\nNon',
    includeForm: false,
    selectedFormId: '',
    ...overrides,
  };
}

describe('hasContent', () => {
  it('accepts a body, or a file with no body at all', () => {
    expect(hasContent('Bonjour', 0)).toBe(true);
    expect(hasContent('', 1)).toBe(true);
  });

  it('refuses whitespace, which is what the disabled button has always refused', () => {
    expect(hasContent('   \n  ', 0)).toBe(false);
    expect(hasContent('', 0)).toBe(false);
  });
});

describe('parsePollOptions', () => {
  it('reads one option per line and drops the blanks', () => {
    expect(parsePollOptions('Oui\n\n  Non  \n')).toEqual([{ label: 'Oui' }, { label: 'Non' }]);
  });

  it('reads a comma-separated line as the ONE option it is', () => {
    // The mistake the textarea's label ("Options (une par ligne)") exists to prevent, and the
    // reason the refusal has to name itself: this is what a reader typing "Oui, Non" produces.
    expect(parsePollOptions('Oui, Non')).toHaveLength(1);
  });
});

describe('localPublishBlocker', () => {
  it('lets a complete draft through to the network', () => {
    expect(localPublishBlocker(publishable())).toBeNull();
  });

  it('names an empty draft rather than sending it', () => {
    const blocker = localPublishBlocker(publishable({ markdown: '  ' }));
    expect(blocker).toEqual({ stage: 'content', message: m.post_create_content_required() });
  });

  it('names a poll opened and left without a question - the reported case', () => {
    // The reader typed their question in the post body and left the poll card's own field empty,
    // which is the shape of the 2026-09-21 report as the reporter described it.
    const blocker = localPublishBlocker(publishable({ includePoll: true, pollQuestion: '  ' }));
    expect(blocker?.stage).toBe('poll');
    expect(blocker?.message).toBe(m.post_create_poll_requires_options());
  });

  it('names a poll whose options do not reach two', () => {
    const blocker = localPublishBlocker(
      publishable({ includePoll: true, pollQuestion: 'On y va ?', pollOptionsRaw: 'Oui' })
    );
    expect(blocker?.stage).toBe('poll');
  });

  it('counts the options exactly as the payload builder will', () => {
    // The two must never disagree: refusing on a count the payload then recomputes differently is
    // one rule with two implementations, and the reader meets it as a post that vanishes.
    const contents = publishable({
      includePoll: true,
      pollQuestion: 'On y va ?',
      pollOptionsRaw: '  Oui  \n\nNon\n',
    });
    expect(localPublishBlocker(contents)).toBeNull();
    expect(parsePollOptions(contents.pollOptionsRaw)).toHaveLength(2);
  });

  it('ignores a half-filled poll the reader has since removed', () => {
    // `includePoll` is what the card is drawn from, so it is what the refusal must read - the
    // stale question below is still in `$state` and must not block anything.
    expect(localPublishBlocker(publishable({ includePoll: false, pollQuestion: '' }))).toBeNull();
  });

  it('names a form attachment with nothing chosen', () => {
    const blocker = localPublishBlocker(publishable({ includeForm: true, selectedFormId: '' }));
    expect(blocker).toEqual({ stage: 'form', message: m.post_create_form_required() });
  });

  it('reports the FIRST unmet precondition, in the order the stages used to run', () => {
    // A console line reading `failed at content` has to keep meaning what it meant before this
    // function existed, which is only true if the order is preserved.
    const blocker = localPublishBlocker(
      publishable({ markdown: '', includePoll: true, pollQuestion: '', includeForm: true })
    );
    expect(blocker?.stage).toBe('content');
  });
});
