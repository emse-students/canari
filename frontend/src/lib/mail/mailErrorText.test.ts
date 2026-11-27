import { describe, expect, it } from 'vitest';
import type { MailErrorKind } from './mailErrors';
import { mailAskText, mailErrorRetryable, mailErrorText } from './mailErrorText';
import type { PasswordAskReason } from './mailSession';

/**
 * Every typed failure has its sentence (the table is a Record over the union, so a new kind fails
 * the build first; this checks the sentences exist and differ), and only a hiccup is retried as is.
 */

const KINDS = {
  bad_credentials: false,
  password_change_required: false,
  account_closed: false,
  account_unavailable: false,
  maintenance: true,
  session_expired: false,
  not_found: false,
  invalid_query: false,
  too_large: false,
  quota_exceeded: false,
  address_unknown: false,
  not_eligible: false,
  not_signed_in: false,
  transport: true,
  server: true,
  internal: true,
  not_sent: true,
  incompatible: false,
  wait_lost: true,
} satisfies Record<MailErrorKind, boolean>;

const REASONS = {
  not_remembered: true,
  password_refused: true,
  remembered_unopenable: true,
  device_locked: true,
  session_refused: true,
} satisfies Record<PasswordAskReason, true>;

describe('mailErrorText', () => {
  it('says every kind, each in its own words', () => {
    const texts = (Object.keys(KINDS) as MailErrorKind[]).map(mailErrorText);
    expect(texts.every((t) => t.trim().length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('offers a retry only for what can succeed again unchanged', () => {
    for (const [kind, retryable] of Object.entries(KINDS)) {
      expect(mailErrorRetryable(kind as MailErrorKind), kind).toBe(retryable);
    }
  });

  it('says why the password is asked again', () => {
    const texts = (Object.keys(REASONS) as PasswordAskReason[]).map(mailAskText);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
