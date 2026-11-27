import { describe, expect, it, vi } from 'vitest';
import { HttpProtocolError } from './http1';
import { classifyMailFailure, faultKind, MailError } from './mailErrors';
import { ZimbraFault, ZimbraUnreadableAnswer } from './soapClient';
import { MailTlsError } from './tlsConnection';
import { MailTransportError } from './transport';

/** D7: every failure typed by its class and code, never by its message. */

describe('faultKind', () => {
  it('maps every Zimbra fault code this client names', () => {
    const table: Record<string, string> = {
      'account.AUTH_FAILED': 'bad_credentials',
      'account.CHANGE_PASSWORD': 'password_change_required',
      'account.ACCOUNT_INACTIVE': 'account_unavailable',
      'account.NO_SUCH_ACCOUNT': 'not_found',
      'account.MAINTENANCE_MODE': 'maintenance',
      'service.AUTH_REQUIRED': 'session_expired',
      'service.AUTH_EXPIRED': 'session_expired',
      'mail.NO_SUCH_MSG': 'not_found',
      'mail.NO_SUCH_CONV': 'not_found',
      'mail.NO_SUCH_FOLDER': 'not_found',
      'mail.NO_SUCH_ITEM': 'not_found',
      'mail.NO_SUCH_PART': 'not_found',
      'mail.NO_SUCH_UPLOAD': 'not_found',
      'mail.QUERY_PARSE_ERROR': 'invalid_query',
      'mail.MESSAGE_TOO_BIG': 'too_large',
      'mail.UPLOAD_REJECTED': 'too_large',
      'mail.QUOTA_EXCEEDED': 'quota_exceeded',
      'service.FAILURE': 'server',
      'unknown.CODE': 'server',
    };
    for (const [code, kind] of Object.entries(table)) expect(faultKind(code)).toBe(kind);
  });

  it('NO_SUCH_ACCOUNT closes the account ONLY when the session asks about itself (I1)', () => {
    expect(faultKind('account.NO_SUCH_ACCOUNT', 'auth')).toBe('account_closed');
    expect(faultKind('account.NO_SUCH_ACCOUNT', 'call')).toBe('not_found');
    expect(faultKind('account.ACCOUNT_INACTIVE', 'auth')).toBe('account_unavailable');
    expect(faultKind('account.AUTH_FAILED', 'auth')).toBe('bad_credentials');
    expect(
      classifyMailFailure(new ZimbraFault('account.NO_SUCH_ACCOUNT', 500, 'x'), 'auth')
    ).toMatchObject({ kind: 'account_closed' });
  });
});

describe('classifyMailFailure', () => {
  it('a fault keeps its code; the same message with another code is another kind', () => {
    const a = classifyMailFailure(new ZimbraFault('account.AUTH_FAILED', 500, 'same text'));
    const b = classifyMailFailure(new ZimbraFault('account.ACCOUNT_INACTIVE', 500, 'same text'));
    expect(a).toMatchObject({ kind: 'bad_credentials', code: 'account.AUTH_FAILED' });
    expect(b).toMatchObject({ kind: 'account_unavailable', code: 'account.ACCOUNT_INACTIVE' });
  });

  it('transport, TLS and HTTP framing failures are transport; an unreadable answer is server', () => {
    expect(classifyMailFailure(new MailTransportError('unreachable', 'x'))).toMatchObject({
      kind: 'transport',
      code: 'unreachable',
    });
    expect(classifyMailFailure(new MailTlsError('certificate', 'x'))).toMatchObject({
      kind: 'transport',
      code: 'tls-certificate',
    });
    expect(classifyMailFailure(new HttpProtocolError('ended', 'x'))).toMatchObject({
      kind: 'transport',
      code: 'http-ended',
    });
    expect(classifyMailFailure(new ZimbraUnreadableAnswer(502, 'x'))).toMatchObject({
      kind: 'server',
      code: 'unreadable-502',
    });
  });

  it('a MailError passes as it is; an untyped throw is internal, and logged as a defect', () => {
    const typed = new MailError('not_found', 'x');
    expect(classifyMailFailure(typed)).toBe(typed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classifyMailFailure(new Error('session expired'))).toMatchObject({ kind: 'internal' });
    warn.mockRestore();
  });
});
