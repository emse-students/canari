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

/**
 * The log is redacted at WRITE and again at READ (an older build's lines leave under today's
 * rules), so a redacted line passed through again must come back identical and count nothing.
 */
function expectIdempotent(raw: string): void {
  const once = redactLogLine(raw).line;
  expect(redactLogLine(once)).toEqual({ line: once, redactions: 0 });
}

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
    // Found by the review of #1819 (2026-10-13), each one written to the log before the fix.
    [
      'a message body the payload renderer cut, under a sensitive key',
      `[WS] {"content":"hello my secret message about tonight ${'x '.repeat(120)}… (900 chars)`,
      'secret message',
    ],
    ['a PIN under a camelCase name', '[PIN] newPin: 482913', '482913'],
    ['a PIN under a snake_case name', '[PIN] user_pin=482913', '482913'],
    ['a token under a camelCase name', '[WS] sessionToken=abcdefghijklmnop', 'abcdefghijklmnop'],
    ['a one-word display name in JSON', '[X] {"displayName":"Jolan","id":"a1"}', 'Jolan'],
    ['a login in JSON', '[X] {"username":"jolan.boudin"}', 'jolan.boudin'],
    ['an unquoted two-word name field', '[X] name: Jean Dupont, id=5', 'Dupont'],
    ['a quoted one-word name', '[FORWARD] failed for "Jolan": boom', 'Jolan'],
    ['a quoted file name with no space', '[MEDIA] refused "CV_Jolan_Boudin.pdf"', 'Boudin'],
    ['a seed as a list', '[GRAINE] seed=[12,34,56,78]', '34,56'],
    ['a PIN behind a harmless field', '[X] mode=x pin=482913', '482913'],
    ['a percent-encoded e-mail in a path', '[API] GET /api/users/jean%40emse.fr', 'jean%40emse'],
    ['a number with a 00 prefix', '[PROFILE] 0033612345678', '612345678'],
    [
      'an invitation token with no digit',
      '[hooks] Processing URL: https://canari.emse.fr/c/join/AbCdEfGhIjKlMnOpQrStUvWx',
      'AbCdEfGh',
    ],
    // Found by the second review of #1819 (2026-10-13), from a fuzz of the real call sites.
    ['a single-quoted name', "[FORWARD] failed for 'Bureau des eleves': boom", 'Bureau'],
    ['a name in curly quotes', '[X] failed for “Jolan”', 'Jolan'],
    ['a name in guillemets', '[X] failed for «Jolan Boudin»', 'Jolan'],
    ['a name in backticks', '[X] failed for `Jolan Boudin`', 'Jolan'],
    ['a PIN after a space', '[PIN] pin 482913 wrong', '482913'],
    ['a PIN behind an arrow', '[PIN] otp -> 482913', '482913'],
    ['a PIN in an Error message', 'Error: Invalid PIN 482913', '482913'],
    ['the refresh header', '[API] X-Canari-Refresh: r3fr3shv4lue', 'r3fr3sh'],
    ['the refresh cookie', '[API] cookie canari_refresh=r3fr3shv4lue', 'r3fr3sh'],
    ['an OIDC subject', '[auth] {"sub":"jolan.boudin"}', 'jolan'],
    ['a search query', '[Cotisations] Loading roster search=Dupont', 'Dupont'],
    ['a query field', '[X] q=dupont', 'dupont'],
    ['a lower-case file name in JSON', '[X] {"filename":"cv_jolan.pdf"}', 'jolan'],
    ['an unquoted file name', '[MEDIA] refused CV_Jolan_Boudin.pdf (30 MB)', 'Jolan'],
    ['a file name in a path', '[API] GET /media/cv_jolan_boudin.pdf', 'jolan'],
    ['a prose value past a comma', '[X] description: hello, my secret plan', 'plan'],
    [
      'a byte list',
      `[MLS] ${JSON.stringify([...Array(32).keys()].map((i) => 200 + (i % 50)))}`,
      '201',
    ],
    ['an accent as a combining mark', '[NOTIF] soirée', 'soire'],
    ['full-width letters', '[X] Ｊｏｌａｎ', 'Ｊ'],
    ['a flag emoji', '[REACT] 🇫🇷', '🇫'],
    ['an IPv4 address', '[WS] peer 192.168.1.42', '192.168.1.42'],
    ['an IPv6 address', '[WS] peer 2a01:e0a:1f3:4560:1234:5678:9abc:def0', '9abc'],
    ['a position', '[MAP] lat=45.4397 lng=4.3872', '45.4397'],
  ];

  for (const [name, raw, secret] of hostile) {
    it(`removes ${name}`, () => {
      const { line, redactions } = redactLogLine(raw);
      expect(line).not.toContain(secret);
      expect(redactions).toBeGreaterThan(0);
    });
    it(`is a no-op on its own output: ${name}`, () => {
      expectIdempotent(raw);
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
    // `code` and `key` are secrets only after a word that makes them one.
    '[API] statusCode=500 conversationKey=67fde7aa… errorCode=E42',
    'Error: Request failed with status 500',
    // A sensitive NAME holding a harmless value: an exception's class, a status code.
    '[video] play() refused {"name":"NotAllowedError","muted":true}',
    '[WS] Disconnected. Code: 1000, Reason: ',
    // Apostrophes never pair into a quoted value; an enum in single quotes stays.
    "[GRAINE] the member's device can't answer: kind 'joined'",
    // A constant's name is not base64, a clock and a version are not addresses.
    '[Call] E2E media encryption disabled (VITE_CALL_E2E_ENCRYPTION=false)',
    '[A] 13:32:42.123 v1.2.6',
    // A status mark is not prose, although U+2139 is classified as a letter.
    '⚠ Push notifications degraded',
    'ℹ Private browsing mode',
    '[PIN] Verifying PIN... PIN verified, attempt 2',
  ];
  for (const raw of kept) {
    it(`keeps: ${raw}`, () => {
      expect(redactLogLine(raw)).toEqual({ line: raw, redactions: 0 });
    });
  }

  it('drops the emoji variation selector without counting it as a value removed', () => {
    expect(redactLogLine('⚠️ Push notifications degraded')).toEqual({
      line: '⚠ Push notifications degraded',
      redactions: 0,
    });
  });

  it('ends a prose value at the next field, so the fields after it survive', () => {
    expect(redact('[X] description: hello, my plan, id=5 mode=x')).toBe(
      '[X] description: [5 chars], id=5 mode=x'
    );
  });

  it('says WHAT was removed, so a reader knows a value existed', () => {
    expect(redact('[LOGIN] as a.b@c.fr pin=1234')).toBe('[LOGIN] as [email] pin=[redacted]');
    expect(redact('[MEDIA] refused "Photo de vacances.jpg"')).toBe('[MEDIA] refused "[21 chars]"');
  });
});

describe('redactLogLine - a content field is its length, whatever its shape', () => {
  // Found on the Mi 9T (v1.2.7-alpha.1): the value looked like an identifier, and the preceding
  // `contact="..."` field's tail had swallowed the `text=` name so it was never judged as a field.
  const send = (t: string) => `[SEND] handleSendChat: contact="jolan" text="${t}" files=0`;
  const cases: Array<[string, string, number]> = [
    ['a single word', 'ok', 2],
    ['an identifier-like text', 'refuse1-a127', 12],
    ['a number-like text', '12345', 5],
    ['an emoji', '\u{1F389}', 2],
    ['a lower-case word', 'bisous', 6],
  ];
  for (const [name, t, n] of cases) {
    it(`replaces ${name} by its length`, () => {
      const { line } = redactLogLine(send(t));
      expect(line).toBe(`[SEND] handleSendChat: contact="[5 chars]" text="[${n} chars]" files=0`);
    });
  }

  it('does it for the key=value and JSON forms', () => {
    expect(redact('[DRAFT] text=ok')).toBe('[DRAFT] text=[2 chars]');
    expect(redact('[WS] {"text":"bisous","id":"a1"}')).toBe('[WS] {"text":"[6 chars]","id":"a1"}');
    expect(redact('[X] title: "ok" count=3')).toBe('[X] title: "[2 chars]" count=3');
  });

  it('keeps the fields around it: ids, counts, enums', () => {
    expect(redact('[X] kind=poll id=67fde7aa… count=3 text="ok" mode=ready')).toBe(
      '[X] kind=poll id=67fde7aa… count=3 text="[2 chars]" mode=ready'
    );
  });
});

describe('redactLogLine - a second pass changes nothing (it runs at write AND at export)', () => {
  const lines = [
    '[SEND] handleSendChat: contact="jolan" text="bisous" files=0',
    '[SEND] handleSendChat: contact="jolan" text="ok" files=0',
    '[DRAFT] text=ok',
    '[WS] {"text":"bisous","id":"a1"}',
    '[X] description: hello, my plan, id=5 mode=x',
    '[X] name: Jean Dupont, id=5',
    '[WS] frame {"type":"msg","body":"rendez-vous a 18h"}',
    '[API] Authorization: Bearer abc.def-ghi_jkl',
    '[LOGIN] as a.b@c.fr pin=1234',
    // A value the payload renderer cut, left with one quote open.
    '[WS] {"kind":"draft","x":"the plan for tonight is to meet at… (900 chars)',
    // The per-line cap's suffix, and the input cut's marker.
    `[DUMP] ${'word '.repeat(500)}`,
    `[DUMP] ${'a'.repeat(5000)}`,
    // What must survive survives twice.
    '[SELECT] 67fde7aa… is not in the conversation map - selection dropped, nothing opens',
  ];
  for (const raw of lines) {
    it(`is a no-op on: ${raw.slice(0, 60)}`, () => {
      expectIdempotent(raw);
    });
  }

  // Review of #1861: the cap cut inside a marker (`name: [11 ch… (1140 chars)`), and the second
  // pass read the fragment as a new value - so EVERY export re-counted this build's own lines.
  const capped = [
    `[DUMP] ${'name: Jean Dupont, '.repeat(60)}`,
    `[DUMP] ${'text="hello there" '.repeat(40)}`,
    `[DUMP] ${'"abc def" '.repeat(80)}`,
    `[DUMP] ${'{"body":"hi"} /api/x?y=1 '.repeat(30)}`,
  ];
  for (const raw of capped) {
    it(`a capped line ends between whole tokens and stays put: ${raw.slice(0, 40)}`, () => {
      const once = redactLogLine(raw).line;
      expect(once).toMatch(/\S… \(\d+ chars\)$/);
      expect(once.replace(/… \(\d+ chars\)$/, '').length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS);
      expectIdempotent(raw);
    });
  }

  it('redacts an OLD build`s line by today`s rules, and its own output no further', () => {
    const old = '[SEND] handleSendChat: contact="jolan" text="bisous" files=0';
    const today = '[SEND] handleSendChat: contact="[5 chars]" text="[6 chars]" files=0';
    expect(redactLogLine(old)).toEqual({ line: today, redactions: 2 });
    expect(redactLogLine(today)).toEqual({ line: today, redactions: 0 });
  });
});

describe('redactLogLine - a member`s text that IMITATES a marker is still redacted', () => {
  // The second pass keeps a value this stage already wrote. A member types the same characters:
  // only the WHOLE value may be recognised, never a marker followed by more (review of #1861).
  const imitations: Array<[string, string]> = [
    ['text=[3 chars] secret message', 'secret'],
    ['contact=[redacted] jolan dupont', 'jolan'],
    ['name: [redacted] Jean Dupont', 'Dupont'],
    ['note=[0 chars] hello there friend', 'friend'],
    ['description: [5 chars], my secret plan', 'secret'],
    ['body=[12 chars]; my secret plan', 'secret'],
    ['title: [redacted], jolan', 'jolan'],
    ['[SEND] text="[3 chars]" secret message"', 'secret'],
    // A bare value that starts another field is swallowed whole under a CONTENT name.
    ['text=a="ok" my secret message', 'secret'],
    ['contact=foo="x" jolan', 'jolan'],
    // The [SEND] lines JSON-quote the text, so a `"` the member typed stays inside the value.
    [
      `[SEND] handleSendChat: contact="jolan" text=${JSON.stringify('he said "meet me at the bar"')} files=0`,
      'meet',
    ],
  ];
  for (const [raw, secret] of imitations) {
    it(`loses "${secret}" in: ${raw}`, () => {
      const { line } = redactLogLine(raw);
      expect(line).not.toContain(secret);
      expect(redactLogLine(line).line).not.toContain(secret);
    });
  }

  it('counts a marker followed by more words, and measures the whole value', () => {
    expect(redactLogLine('text=[3 chars] secret message')).toEqual({
      line: 'text=[24 chars]',
      redactions: 1,
    });
    expect(redactLogLine('text="jolan [3 chars]"')).toEqual({
      line: 'text="[15 chars]"',
      redactions: 1,
    });
  });

  it('keeps a marker that IS the whole value, and counts nothing', () => {
    expect(redactLogLine('text=[3 chars]')).toEqual({ line: 'text=[3 chars]', redactions: 0 });
  });
});

describe('redactLogLine - cost', () => {
  // Several patterns rescan from every position of a run with no separator, so an uncut 32 KB
  // line took minutes. The input is cut first; this pins the CUT, which is what bounds the cost -
  // never a wall clock, which a loaded CI runner would make flaky.
  it('cuts a 1 MB line with no separator before any pattern runs, and keeps no half of it', () => {
    const { line } = redactLogLine(`[DUMP] ${'a'.repeat(1_000_000)}`);
    expect(line).toBe('[DUMP] [cut 1000007 chars]');
  });

  it('never leaves the cut half of an e-mail address as the last word', () => {
    const raw = `[X] ${'w '.repeat(497)}jean.dupont@emse.fr tail`;
    expect(redactLogLine(raw).line).not.toContain('jean');
  });
});
