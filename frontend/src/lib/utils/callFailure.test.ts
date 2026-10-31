import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  CallE2eBypassedError,
  CallE2eSetupError,
  CallE2eUnsupportedError,
  CallInitiateError,
  CallRelayWithheldError,
  describeCallFailure,
} from './callFailure';

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
    const out = describeCallFailure(new CallInitiateError('initiate', 404, SERVER_SENTENCE));

    expect(out).toBe(m.chat_call_group_desynced());
  });

  it.each([
    [401, 'an expired session'],
    [403, 'a caller the group no longer holds'],
    [429, 'too many attempts'],
  ])('answers %i through the one refusal mapper', (status) => {
    const out = describeCallFailure(new CallInitiateError('initiate', status, SERVER_SENTENCE));

    expect(out).not.toBe(m.chat_call_error_generic());
    expect(out).not.toBe(m.chat_call_group_desynced());
    expect(out).toContain(m.chat_call_action_start());
  });

  it.each([['initiate'], ['room-token']] as const)(
    'reads a USER_BLOCKED refusal from %s as the neutral "cannot be placed", never as a rights problem',
    (step) => {
      // WP-C7: a block on either side refuses the call. The status is a plain 403, so only the code
      // separates it from "you are not in this group" - and the sentence must not say who blocked.
      const out = describeCallFailure(
        new CallInitiateError(step, 403, 'calls failed (403)', 'USER_BLOCKED')
      );

      expect(out).toBe(m.call_unavailable());
    }
  );

  it.each([['initiate'], ['ring'], ['room-token']] as const)(
    'reads a REVIEW_COHORT_BOUNDARY refusal from %s as the same neutral "cannot be placed"',
    (step) => {
      const out = describeCallFailure(
        new CallInitiateError(step, 403, 'calls failed (403)', 'REVIEW_COHORT_BOUNDARY')
      );

      expect(out).toBe(m.call_unavailable());
    }
  );

  it.each([['initiate'], ['ring'], ['room-token'], ['ice-servers']] as const)(
    'reads the kill switch (CALLS_DISABLED) from %s as "calls are unavailable", not as a failure',
    (step) => {
      const out = describeCallFailure(
        new CallInitiateError(step, 403, 'calls failed (403)', 'CALLS_DISABLED')
      );

      expect(out).toBe(m.call_calls_disabled());
    }
  );

  it('reads an audio-only server refusing a video ring (CALLS_VIDEO_DISABLED) as such', () => {
    const out = describeCallFailure(
      new CallInitiateError('ring', 403, 'calls/ring failed (403)', 'CALLS_VIDEO_DISABLED')
    );

    expect(out).toBe(m.call_video_disabled());
  });

  it('a 403 with no code keeps the generic refusal line', () => {
    const out = describeCallFailure(new CallInitiateError('initiate', 403, SERVER_SENTENCE));

    expect(out).not.toBe(m.call_unavailable());
  });

  it('reads a 410 from room-token as a call that is over, not as a failure', () => {
    // The callee answered after the server's ring window closed: the caller had stopped ringing.
    const out = describeCallFailure(
      new CallInitiateError('room-token', 410, 'calls/room-token failed (410)')
    );

    expect(out).toBe(m.call_over());
    expect(out).not.toBe(m.chat_call_error_generic());
  });

  it.each([[410], [403]])(
    'reads a %i from the CALLER\'s ring as a call that could not start, never as "over"',
    (status) => {
      const out = describeCallFailure(new CallInitiateError('ring', status, 'calls/ring failed'));
      expect(out).toBe(m.call_setup_failed());
    }
  );

  it.each([[500], [502], [400]])(
    'keeps the generic line for %i, which the mapper deliberately says nothing about',
    (status) => {
      const out = describeCallFailure(new CallInitiateError('initiate', status, SERVER_SENTENCE));

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
    for (const status of [400, 401, 403, 404, 409, 410, 429, 500, 503]) {
      expect(
        describeCallFailure(new CallInitiateError('initiate', status, SERVER_SENTENCE))
      ).not.toContain('Groupe introuvable');
    }
  });

  it('carries the status as a field, so no consumer has to parse the message', () => {
    const error = new CallInitiateError('initiate', 409, SERVER_SENTENCE);

    expect(error.status).toBe(409);
    expect(error.name).toBe('CallInitiateError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(SERVER_SENTENCE);
  });

  it('reads an engine that cannot encrypt as exactly that, by type and never by its message', () => {
    // The call is refused rather than placed unencrypted, so the reader must be told WHY - and the
    // English sentence carried for the log must never be what they read.
    const error = new CallE2eUnsupportedError();

    expect(describeCallFailure(error)).toBe(m.call_e2e_unsupported());
    expect(describeCallFailure(error)).not.toBe(error.message);
  });

  it('reads media that flowed around the transform as an E2E failure, by type', () => {
    const error = new CallE2eBypassedError(['sender:audio', 'receiver:video']);

    expect(describeCallFailure(error)).toBe(m.call_e2e_bypassed());
    expect(error.message).toContain('sender:audio and receiver:video');
  });

  it('reads a transform that could not be attached as its own E2E failure, by type', () => {
    const error = new CallE2eSetupError('receiver (video)');

    expect(describeCallFailure(error)).toBe(m.call_e2e_setup_failed());
    expect(describeCallFailure(error)).not.toBe(m.call_connection_lost());
  });

  it.each(['TURN_BUDGET_REACHED', 'TURN_METER_UNAVAILABLE'])(
    'reads a never-connected call whose relay was withheld (%s) as its own sentence',
    (code) => {
      expect(describeCallFailure(new CallRelayWithheldError(code))).toBe(m.call_relay_withheld());
    }
  );

  it('reads TURN off by configuration as permanent, not as a passing outage', () => {
    expect(describeCallFailure(new CallRelayWithheldError('TURN_DISABLED'))).toBe(
      m.call_relay_disabled()
    );
  });
});
