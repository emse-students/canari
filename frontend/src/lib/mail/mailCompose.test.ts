import { describe, expect, it } from 'vitest';
import { setLocale } from '$lib/paraglide/runtime';
import {
  emptyMessage,
  escapeHtml,
  formatAddress,
  forwardMessage,
  htmlToText,
  quoteLines,
  replyMessage,
} from './mailCompose';
import type { MailMessage } from './mailTypes';

/** Reply, reply-all and forward: recipients, subject, the quote, and what the message answers. */

const ME = 'me@etu.emse.fr';
const SELF = { address: ME, aliases: ['me@emse.fr'] };

function original(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: '40',
    conversationId: '-40',
    folderId: '2',
    subject: 'Exam',
    fragment: 'frag',
    date: Date.UTC(2026, 10, 27, 9, 30),
    from: { address: 'prof@emse.fr', name: 'Prof' },
    to: [
      { address: ME, name: 'Me' },
      { address: 'bob@etu.emse.fr', name: null },
    ],
    cc: [
      { address: 'carol@etu.emse.fr', name: null },
      { address: 'PROF@emse.fr', name: null },
    ],
    replyTo: [],
    flags: {
      unread: false,
      flagged: false,
      attachment: true,
      replied: false,
      forwarded: false,
      draft: false,
    },
    messageIdHeader: '<abc@x>',
    html: null,
    text: 'line 1\n> earlier',
    attachments: [
      {
        messageId: '40',
        part: '2',
        filename: 'a.pdf',
        contentType: 'application/pdf',
        size: 1,
        contentId: null,
        inline: false,
      },
    ],
    ...overrides,
  };
}

describe('replyMessage', () => {
  it('answers the sender, prefixes the subject once, quotes the text and names the original', () => {
    setLocale('en', { reload: false });
    const reply = replyMessage(original(), 'reply', SELF);
    expect(reply.to).toEqual([{ address: 'prof@emse.fr', name: 'Prof' }]);
    expect(reply.cc).toEqual([]);
    expect(reply.subject).toBe('Re: Exam');
    expect(replyMessage(original({ subject: 'RE: Exam' }), 'reply', SELF).subject).toBe('RE: Exam');
    expect(reply.text).toMatch(/^\n\nOn .+, Prof <prof@emse\.fr> wrote:\n> line 1\n>> earlier$/);
    expect(reply.html).toContain('<blockquote type="cite">line 1<br>&gt; earlier</blockquote>');
    expect(reply.origin).toEqual({ kind: 'reply', messageId: '40', messageIdHeader: '<abc@x>' });
    expect(reply.forwardedParts).toEqual([]);
  });

  it('the attribution is in the app locale', () => {
    setLocale('fr', { reload: false });
    expect(replyMessage(original(), 'reply', SELF).text).toContain('a écrit :');
  });

  it('reply-all adds the other recipients, without self or duplicates (case aside)', () => {
    const reply = replyMessage(original(), 'reply_all', {
      address: 'ME@etu.emse.fr',
      aliases: [],
    });
    expect(reply.to.map((a) => a.address)).toEqual(['prof@emse.fr']);
    expect(reply.cc.map((a) => a.address)).toEqual(['bob@etu.emse.fr', 'carol@etu.emse.fr']);
  });

  it('goes to Reply-To when the original named one, and to its recipients when self sent it', () => {
    const list = { address: 'list@emse.fr', name: null };
    expect(replyMessage(original({ replyTo: [list] }), 'reply', SELF).to).toEqual([list]);
    const fromSelf = original({ from: { address: ME, name: null } });
    expect(replyMessage(fromSelf, 'reply', SELF).to.map((a) => a.address)).toEqual([
      'bob@etu.emse.fr',
    ]);
  });

  it('quotes an HTML-only original as text too', () => {
    const reply = replyMessage(
      original({ text: null, html: '<p>Hello&nbsp;<b>you</b></p><script>x()</script><p>2</p>' }),
      'reply',
      SELF
    );
    expect(reply.text).toContain('> Hello you\n> 2');
    expect(reply.html).toContain('<blockquote type="cite">Hello you<br>2</blockquote>');
    expect(reply.html).not.toContain('<p>');
  });

  it('never quotes the server HTML: remote images and markup stay out of the reply (M9)', () => {
    const reply = replyMessage(
      original({
        text: null,
        html: '<p>Hi <img dfsrc="https://tracker.example/p.gif"><a href="x">link</a></p>',
      }),
      'reply',
      SELF
    );
    expect(reply.html).not.toContain('dfsrc');
    expect(reply.html).not.toContain('<img');
    expect(reply.html).not.toContain('<a ');
    expect(reply.html).toContain('Hi link');
  });

  it('an alias of the account counts as the account: from-self and reply-all (M10)', () => {
    const viaAlias = original({
      from: { address: 'ME@emse.fr', name: null },
      to: [{ address: 'bob@etu.emse.fr', name: null }],
      cc: [{ address: 'me@emse.fr', name: null }],
    });
    expect(replyMessage(viaAlias, 'reply', SELF).to.map((a) => a.address)).toEqual([
      'bob@etu.emse.fr',
    ]);
    const toAlias = original({ to: [{ address: 'me@emse.fr', name: null }], cc: [] });
    const all = replyMessage(toAlias, 'reply_all', SELF);
    expect([...all.to, ...all.cc].map((a) => a.address)).toEqual(['prof@emse.fr']);
  });

  it('every message carries its own send id (suid, M6)', () => {
    const a = replyMessage(original(), 'reply', SELF);
    const b = replyMessage(original(), 'reply', SELF);
    expect(a.suid).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.suid).not.toBe(b.suid);
    expect(emptyMessage().suid).not.toBe(emptyMessage().suid);
  });
});

describe('forwardMessage', () => {
  it('no recipient, the header block, the body, and every part carried by reference', () => {
    setLocale('en', { reload: false });
    const forward = forwardMessage(
      original({
        attachments: [
          ...original().attachments,
          {
            messageId: '40',
            part: '3',
            filename: 'logo.png',
            contentType: 'image/png',
            size: 1,
            contentId: 'logo@x',
            inline: true,
          },
        ],
      })
    );
    expect(forward.to).toEqual([]);
    expect(forward.subject).toBe('Fwd: Exam');
    expect(forwardMessage(original({ subject: 'TR: Exam' })).subject).toBe('TR: Exam');
    expect(forward.text).toContain(
      '---------- Forwarded message ----------\nFrom: Prof <prof@emse.fr>'
    );
    expect(forward.text).toContain('Subject: Exam\nTo: Me <me@etu.emse.fr>, bob@etu.emse.fr');
    expect(forward.text.endsWith('line 1\n> earlier')).toBe(true);
    expect(forward.forwardedParts).toEqual([
      { messageId: '40', part: '2' },
      { messageId: '40', part: '3' },
    ]);
    expect(forward.origin).toEqual({
      kind: 'forward',
      messageId: '40',
      messageIdHeader: '<abc@x>',
    });
  });
});

describe('helpers', () => {
  it('formatAddress, escapeHtml, quoteLines, htmlToText', () => {
    expect(formatAddress({ address: 'a@b', name: null })).toBe('a@b');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
    expect(quoteLines('a\r\n>b')).toBe('> a\n>>b');
    expect(htmlToText('a<br>b&#233;&#x41;&unknown;')).toBe('a\nbéA&unknown;');
    expect(emptyMessage()).toMatchObject({ to: [], html: null, origin: null, draftId: null });
  });
});
