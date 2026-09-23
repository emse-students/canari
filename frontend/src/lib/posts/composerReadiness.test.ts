/**
 * WHAT IS PINNED IS THAT THE COMPOSER REFUSES BEFORE IT ASKS, AND THAT ONE RULE HAS ONE SPELLING.
 *
 * The report behind this file cost two production round trips to learn a fact the client held:
 * `mute-status` answered `200` twice on 2026-09-23 and no `POST /api/posts` ever followed, because
 * a poll had been opened and never filled. The assertions below are the two halves that a screen
 * cannot assert about itself - that every locally-answerable refusal is named without a network
 * call, and that the button's rule and the throw's rule are the same function.
 *
 * The poll's own rules are pinned next door in `pollDraft.test.ts`; what belongs here is which
 * STAGE each refusal is attributed to, and in what order.
 */
import { describe, it, expect } from 'vitest';
import { hasContent, localPublishBlocker, type ComposerContents } from './composerReadiness';
import { newPollOption, type PollDraft } from './pollDraft';
import { m } from '$lib/paraglide/messages';

/** A poll that publishes, with whatever the case at hand wants changed. */
function poll(overrides: Partial<PollDraft> = {}): PollDraft {
  return {
    question: 'On y va ?',
    options: [newPollOption('Oui'), newPollOption('Non')],
    multipleChoice: false,
    maxSelections: null,
    endsAt: '',
    ...overrides,
  };
}

/** A draft that publishes: text, no attachment of any kind. */
function publishable(overrides: Partial<ComposerContents> = {}): ComposerContents {
  return {
    markdown: 'Bonjour',
    fileCount: 0,
    poll: null,
    form: null,
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

describe('localPublishBlocker', () => {
  it('lets a complete draft through to the network', () => {
    expect(localPublishBlocker(publishable())).toBeNull();
    expect(localPublishBlocker(publishable({ poll: poll() }))).toBeNull();
  });

  it('names an empty draft rather than sending it', () => {
    const blocker = localPublishBlocker(publishable({ markdown: '  ' }));
    expect(blocker).toEqual({ stage: 'content', message: m.post_create_content_required() });
  });

  it('names a poll opened and left without a question - the reported case', () => {
    // The reader typed their question in the post body and left the poll card's own field empty,
    // which is the shape of the 2026-09-21 report as the reporter described it.
    const blocker = localPublishBlocker(publishable({ poll: poll({ question: '  ' }) }));
    expect(blocker?.stage).toBe('poll');
    expect(blocker?.message).toBe(m.post_create_poll_requires_options());
    // And the card is told WHICH field, so the reader is not sent looking for it.
    expect(blocker?.pollIssue).toBe('question');
  });

  it('names a poll whose options do not reach two', () => {
    const blocker = localPublishBlocker(
      publishable({ poll: poll({ options: [newPollOption('Oui'), newPollOption('   ')] }) })
    );
    expect(blocker?.stage).toBe('poll');
    expect(blocker?.pollIssue).toBe('options');
  });

  it('ignores a half-filled poll the reader has since removed', () => {
    // A closed card passes `null`, whatever its `$state` still holds - the stale question below
    // must not block anything.
    expect(localPublishBlocker(publishable({ poll: null }))).toBeNull();
  });

  it('names a form attachment with nothing chosen', () => {
    const blocker = localPublishBlocker(
      publishable({ form: { selectedFormId: '', availableCount: 3 } })
    );
    expect(blocker).toEqual({ stage: 'form', message: m.post_create_form_required() });
  });

  it('says so differently when there is no form to choose', () => {
    // "Veuillez selectionner un formulaire" asks for something the reader cannot do: the picker is
    // empty. `GET /api/forms` answered `[]` for the 2026-09-21 reporter's account.
    const blocker = localPublishBlocker(
      publishable({ form: { selectedFormId: '', availableCount: 0 } })
    );
    expect(blocker?.message).toBe(m.post_create_form_none_available());
  });

  it('reports the FIRST unmet precondition, in the order the stages used to run', () => {
    // A console line reading `failed at content` has to keep meaning what it meant before this
    // function existed, which is only true if the order is preserved.
    const blocker = localPublishBlocker(
      publishable({
        markdown: '',
        poll: poll({ question: '' }),
        form: { selectedFormId: '', availableCount: 2 },
      })
    );
    expect(blocker?.stage).toBe('content');
  });

  it('does not re-judge a deadline the reader never touched', () => {
    // An edit form loads a poll that may have closed long ago. Judging its stored deadline as if
    // it had just been typed would make an old poll uneditable.
    const stored = '2020-01-01T10:00';
    expect(
      localPublishBlocker(publishable({ poll: poll({ endsAt: stored }), storedPollEndsAt: stored }))
    ).toBeNull();
    expect(localPublishBlocker(publishable({ poll: poll({ endsAt: stored }) }))?.pollIssue).toBe(
      'endsAt'
    );
  });
});
