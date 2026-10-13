/**
 * THE IN-APP LOG LEAVES THE DEVICE, SO EVERY LINE IS TREATED AS HOSTILE.
 *
 * Each case below is a value a console line could plausibly carry and a member never agreed to
 * send. The assertion is always the same shape: the secret is NOT in the output, and the line still
 * says that something was there. The last block pins what must SURVIVE, because a scrubber that
 * eats `[SELECT] 67fde7aa…` has made the log useless for the one reading it exists for.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LOG_LINE_CHARS, redactLogLine } from './appLogRedact';

const redact = (raw: string) => redactLogLine(raw).line;

describe('redactLogLine - what must never enter', () => {
  const hostile: Array<[string, string, string]> = [
    // [case, raw line, secret that must be gone]
    [
      'a JWT',
      '[auth] got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    ['a bearer header', '[API] Authorization: Bearer abc.def-ghi_jkl', 'abc.def-ghi_jkl'],
    [
      'an OIDC code in a query',
      '[auth] callback https://canari.emse.fr/cb?code=Xy9kLm2Q&state=s1',
      'Xy9kLm2Q',
    ],
    ['a token in a relative URL', '[API] -> GET /api/ws?token=sekret123', 'sekret123'],
    ['a fragment', '[auth] https://x.fr/cb#access_token=abc123def', 'abc123def'],
    ['an e-mail', '[LOGIN] signed in as jean.dupont@emse.fr', 'jean.dupont@emse.fr'],
    ['a PIN as a field', '[PIN] check pin=482913 ok', '482913'],
    ['a PIN as JSON', '[PIN] {"pin":"482913","mode":"keypad"}', '482913'],
    ['a password with spaces quoted', '[Vault] password: "correct horse battery"', 'correct horse'],
    ['a refresh token field', '[auth] refresh_token=r3fr3sh-T0ken-value', 'r3fr3sh'],
    ['a message body field', '[WS] frame {"type":"msg","body":"rendez-vous a 18h"}', 'rendez-vous'],
    ['a text field unquoted', '[DRAFT] text=hello', 'hello'],
    ['a French mobile number', '[PROFILE] phone 06 12 34 56 78 saved', '06 12 34 56 78'],
    ['an international number', '[PROFILE] +33 6 12 34 56 78', '6 12 34 56 78'],
    [
      'a base64 key',
      '[MLS] key AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= loaded',
      'AAECAwQFBgcICQoLDA0ODxAREhMU',
    ],
    ['a base64url token', '[Push] fcm dGhpc2lzYXRva2VuMTIzNDU2Nzg5MA-_xyz', 'dGhpc2lzYXRva2Vu'],
    [
      'a quoted file name with spaces',
      '[MEDIA] refused "Photo de vacances.jpg" - 30 Mo',
      'vacances',
    ],
    ['a quoted channel name', '[FORWARD] failed for "Bureau des eleves": boom', 'Bureau'],
    ['French prose with accents', '[NOTIF] Salut, tu viens à la soirée ce soir ?', 'soirée'],
    ['an emoji reaction', '[REACT] added 🎉 to the message', '🎉'],
    ['a JSON key that is a name', '[UNREAD] {"Club théâtre":3}', 'théâtre'],
    [
      'a body cut by the payload renderer (unbalanced quote)',
      '[WS] {"kind":"draft","x":"the plan for tonight is to meet at… (900 chars)',
      'plan for tonight',
    ],
  ];

  for (const [name, raw, secret] of hostile) {
    it(`removes ${name}`, () => {
      const { line, redactions } = redactLogLine(raw);
      expect(line).not.toContain(secret);
      expect(redactions).toBeGreaterThan(0);
    });
  }

  // Shortened, not removed: the 8-character prefix is the convention every log of this project
  // follows, and what lets a line be matched against a server log. It is not counted as redacted.
  it('shortens a full 64-hex user id and a UUID to their first 8 characters', () => {
    expect(
      redact('[LOGOUT] userId=d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2')
    ).toBe('[LOGOUT] userId=d82cd226…');
    expect(redact('[SELECT] 67fde7aa-94b5-4529-8798-883ef0faad42 dropped')).toBe(
      '[SELECT] 67fde7aa… dropped'
    );
  });

  it('keeps every entry on one line, whatever the payload carried', () => {
    const nul = String.fromCharCode(0);
    const line = redact(`[ERR] first\nsecond\r\nthird${nul}`);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.includes(nul)).toBe(false);
  });

  it('caps a line, so a dump cannot take the ring over', () => {
    const line = redact(`[DUMP] ${'word '.repeat(500)}`);
    expect(line.length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS + 20);
    expect(line).toMatch(/\(\d+ chars\)$/);
  });
});

describe('redactLogLine - what the reading needs must survive', () => {
  const kept = [
    '[SELECT] 67fde7aa… is not in the conversation map - selection dropped, nothing opens',
    '[QUEUE] drained 3 entries in 412ms',
    '[GRAINE] seed v2 for epoch 41 refused: SENDER_MISMATCH',
    '[API] ← 200 GET /api/users/batch (623ms)',
    '[API] → GET /api/associations/calendar/feed.ics',
    '[A] refresh✓ 272ms exp=3601s',
    'Initialised in TAURI mode',
    '[WS] state {"state":"open","attempt":2,"paused":false}',
    '[download] wrote 1234 bytes to "mls.bin"',
    'installConsoleIdTruncation ran once',
    // A key=value is not one base64 run: `=` only ever closes one, as padding.
    '[WS] Connected to Chat Gateway - device=tauri-43319a65…-mv5ybc47-ycj7',
  ];
  for (const raw of kept) {
    it(`keeps: ${raw}`, () => {
      expect(redactLogLine(raw)).toEqual({ line: raw, redactions: 0 });
    });
  }

  it('says WHAT was removed, so a reader knows a value existed', () => {
    expect(redact('[LOGIN] as a.b@c.fr pin=1234')).toBe('[LOGIN] as [email] pin=[redacted]');
    expect(redact('[MEDIA] refused "Photo de vacances.jpg"')).toBe('[MEDIA] refused "[21 chars]"');
  });
});

describe('redactLogLine - cost', () => {
  // Several patterns rescan from every position of a run with no separator, so an uncut 32 KB
  // line took minutes. The input is cut first; this pins that it stays cheap.
  it('handles a 1 MB line with no separator in milliseconds, and keeps no half of it', () => {
    const started = performance.now();
    const { line } = redactLogLine(`[DUMP] ${'a'.repeat(1_000_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(line).toBe('[DUMP] [cut 1000007 chars]');
  });

  it('never leaves the cut half of an e-mail address as the last word', () => {
    const raw = `[X] ${'w '.repeat(497)}jean.dupont@emse.fr tail`;
    expect(redactLogLine(raw).line).not.toContain('jean');
  });
});
