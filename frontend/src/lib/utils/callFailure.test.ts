import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { CallInitiateError, describeCallFailure } from './callFailure';

/**
 * A CALL THAT COULD NOT START SAYS WHAT THE SERVER ANSWERED, NOT WHAT IT WROTE.
 *
 * The site this replaces chose between two toasts with
 * `msg.includes('Groupe introuvable') || msg.includes('Group not found')`, and showed the raw
 * message for everything else. So the assertions are about the two halves of that defect: the
 * distinction now comes from the status, and NO path can return the thrown sentence.
 */
const SERVER_SENTENCE = 'calls/initiate failed (403): Groupe introuvable pour cet utilisateur';

describe('describeCallFailure', () => {
  it('reads a 404 as a group that has diverged, not as a missing item', () => {
    // The one deliberate departure from `describeApiRefusal`: its 404 line ("l'element n'existe
    // plus") is true and leaves the reader with nothing to do, while this one tells them the local
    // conversation and the server's have split and how to get out of it.
    const out = describeCallFailure(new CallInitiateError(404, SERVER_SENTENCE));

    expect(out).toBe(m.chat_call_group_desynced());
  });

  it.each([
    [401, 'an expired session'],
    [403, 'a caller the group no longer holds'],
    [429, 'too many attempts'],
  ])('answers %i through the one refusal mapper', (status) => {
    const out = describeCallFailure(new CallInitiateError(status, SERVER_SENTENCE));

    expect(out).not.toBe(m.chat_call_error_generic());
    expect(out).not.toBe(m.chat_call_group_desynced());
    expect(out).toContain(m.chat_call_action_start());
  });

  it.each([[500], [502], [400]])(
    'keeps the generic line for %i, which the mapper deliberately says nothing about',
    (status) => {
      const out = describeCallFailure(new CallInitiateError(status, SERVER_SENTENCE));

      expect(out).toBe(m.chat_call_error_generic());
    }
  );

  it('treats a transport failure as an absent answer, not as a refusal', () => {
    // A server that never answered carries no status, so there is nothing to report but the
    // generic line - the same rule that keeps a 5xx out of the mapper.
    expect(describeCallFailure(new TypeError('Failed to fetch'))).toBe(m.chat_call_error_generic());
    expect(describeCallFailure('a string nobody typed')).toBe(m.chat_call_error_generic());
  });

  it('never returns the thrown sentence, whatever the status', () => {
    // The defect in one assertion: every arm above was reachable before, and all of them rendered
    // the server's own body to a French reader.
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      expect(describeCallFailure(new CallInitiateError(status, SERVER_SENTENCE))).not.toContain(
        'Groupe introuvable'
      );
    }
  });

  it('carries the status as a field, so no consumer has to parse the message', () => {
    const error = new CallInitiateError(409, SERVER_SENTENCE);

    expect(error.status).toBe(409);
    expect(error.name).toBe('CallInitiateError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(SERVER_SENTENCE);
  });
});
