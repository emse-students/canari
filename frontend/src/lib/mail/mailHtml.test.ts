// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { bytesToDataUrl, mailFrameDocument, mailFramePolicy, remoteImageCount } from './mailHtml';

/**
 * The D9 sandbox's document: nothing that runs survives, nothing remote loads until the reader asks
 * for THIS message's images, `cid:` resolves only from the message's own parts, links open outside.
 */

const NONE = { showRemoteImages: false, inlineImages: new Map<string, string>() };

function frame(html: string, options = NONE): Document {
  return new DOMParser().parseFromString(mailFrameDocument(html, options), 'text/html');
}

describe('mailFrameDocument', () => {
  it('removes every script, frame, plugin and form, and every on* handler', () => {
    const doc = frame(
      `<p onclick="steal()" onmouseover="x()">hi</p><script>steal()</script>
       <frame title="x"><object data="x"></object><embed src="x">
       <form action="https://evil.test"><input name="p"><button formaction="https://evil.test">go</button></form>
       <svg><a xlink:href="javascript:x()"><text>t</text></a></svg>
       <img src="data:image/png;base64,AA" onerror="steal()">`
    );
    expect(
      doc.querySelectorAll('script, iframe, frame, object, embed, form, input, button')
    ).toHaveLength(0);
    const attributes = [...doc.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name.toLowerCase())
    );
    expect(attributes.filter((name) => name.startsWith('on'))).toEqual([]);
    expect(attributes).not.toContain('xlink:href');
    expect(doc.body.textContent).toContain('hi');
  });

  it("drops the mail's own base, meta and link, and puts its policy and link target first", () => {
    const doc = frame(
      `<head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">
       <link rel="author" href="https://evil.test/me"></head><body>x</body>`
    );
    const metas = [...doc.head.querySelectorAll('meta')];
    expect(metas.map((m) => m.getAttribute('http-equiv')).filter(Boolean)).toEqual([
      'Content-Security-Policy',
    ]);
    expect(doc.head.querySelectorAll('link')).toHaveLength(0);
    const bases = doc.head.querySelectorAll('base');
    expect(bases).toHaveLength(1);
    expect(bases[0].getAttribute('href')).toBeNull();
    expect(bases[0].getAttribute('target')).toBe('_blank');
  });

  it('blocks remote images (defanged or not) by default, and shows them once allowed', () => {
    const html = `<img src="https://track.test/p.gif"><img dfsrc="https://img.test/a.png">
      <img src="//cdn.test/b.png"><table><tr><td background="https://img.test/bg.png">c</td></tr></table>`;
    expect(remoteImageCount(html)).toBe(4);

    const blocked = frame(html);
    expect([...blocked.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      null,
      null,
      null,
    ]);
    expect(blocked.querySelector('[background]')).toBeNull();
    expect(mailFramePolicy(false)).toContain('img-src data:;');
    expect(mailFramePolicy(false)).not.toContain('https:');

    const shown = frame(html, { ...NONE, showRemoteImages: true });
    expect([...shown.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://track.test/p.gif',
      'https://img.test/a.png',
      'https://cdn.test/b.png',
    ]);
    expect(mailFramePolicy(true)).toContain('img-src data: https:');
  });

  it('the policy blocks every other remote load, whatever the choice', () => {
    for (const show of [false, true]) {
      const policy = mailFramePolicy(show);
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).not.toContain('script-src');
    }
    const doc = frame('<p>x</p>');
    const meta = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(meta?.getAttribute('content')).toBe(mailFramePolicy(false));
  });

  it("resolves cid: images from the message's own parts only", () => {
    const own = new Map([['logo@school', 'data:image/png;base64,QUJD']]);
    const doc = frame('<img src="cid:logo@school"><img src="cid:other@elsewhere">', {
      ...NONE,
      inlineImages: own,
    });
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'data:image/png;base64,QUJD',
      null,
    ]);
  });

  it('keeps web and mail links, opening outside, and drops every other scheme', () => {
    const doc = frame(
      `<a href="https://www.emse.fr">a</a><a href="mailto:bde@example.test">b</a>
       <a href="javascript:alert(1)">c</a><a href="data:text/html,x">d</a><a href="file:///etc">e</a>`
    );
    const links = [...doc.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.emse.fr',
      'mailto:bde@example.test',
      null,
      null,
      null,
    ]);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a data: source that is not an image is dropped', () => {
    const doc = frame('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(doc.querySelector('img')?.getAttribute('src')).toBeNull();
  });
});

describe('bytesToDataUrl', () => {
  it('writes an image as base64, and never labels anything else an image', () => {
    const bytes = new TextEncoder().encode('ABC');
    expect(bytesToDataUrl(bytes, 'image/png')).toBe('data:image/png;base64,QUJD');
    expect(bytesToDataUrl(bytes, 'text/html')).toBe('data:application/octet-stream;base64,QUJD');
  });
});
