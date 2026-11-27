// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MAIL_FRAME_SCRIPT, MAIL_FRAME_SCRIPT_HASH } from '$lib/security/mailFrameScript.js';
import {
  bytesToDataUrl,
  INLINE_IMAGE_MAX_BYTES,
  isImageMediaType,
  isInlineImagePart,
  isSafeMailLink,
  MAIL_LINK_ATTRIBUTE,
  mailFrameDocument,
  mailFramePolicy,
  mediaTypeOf,
  neutraliseViewportUnits,
  remoteImageCount,
} from './mailHtml';
import type { AttachmentRef } from './mailTypes';

/**
 * The D9 sandbox's document: nothing of the mail runs, only OUR script (by hash); nothing remote
 * loads until the reader asks for THIS message's images; `cid:` resolves only from the message's
 * own parts; no link navigates in the frame - a safe address is handed to the app.
 */

const NONE = { showRemoteImages: false, inlineImages: new Map<string, string>() };

function frame(html: string, options = NONE): Document {
  return new DOMParser().parseFromString(mailFrameDocument(html, options), 'text/html');
}

/** Every attribute name left in the document, lower case. */
function attributeNames(doc: Document): string[] {
  return [...doc.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].map((a) => a.name.toLowerCase())
  );
}

describe('mailFrameDocument', () => {
  it('removes every script of the mail, frame, plugin and form, and every on* handler and ping', () => {
    const doc = frame(
      `<p onclick="steal()" onmouseover="x()">hi</p><script>steal()</script>
       <frame title="x"><object data="x"></object><embed src="x">
       <form action="https://evil.test"><input name="p"><button formaction="https://evil.test">go</button></form>
       <a href="https://example.test" ping="https://track.test/p">l</a>
       <img src="data:image/png;base64,AA" onerror="steal()">`
    );
    expect(doc.querySelectorAll('iframe, frame, object, embed, form, input, button')).toHaveLength(
      0
    );
    // ONE script is left: ours, last in the body, byte for byte the text its hash names.
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts.map((s) => s.textContent)).toEqual([MAIL_FRAME_SCRIPT]);
    expect(doc.body.lastElementChild).toBe(scripts[0]);
    const attributes = attributeNames(doc);
    expect(attributes.filter((name) => name.startsWith('on'))).toEqual([]);
    expect(attributes).not.toContain('ping');
    expect(doc.body.textContent).toContain('hi');
  });

  it("drops the mail's own base, meta and link, and puts its policy first, with no base of its own", () => {
    const doc = frame(
      `<head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">
       <link rel="author" href="https://evil.test/me"></head><body>x</body>`
    );
    const metas = [...doc.head.querySelectorAll('meta')];
    expect(metas.map((m) => m.getAttribute('http-equiv')).filter(Boolean)).toEqual([
      'Content-Security-Policy',
    ]);
    expect(doc.head.querySelectorAll('link')).toHaveLength(0);
    expect(doc.querySelectorAll('base')).toHaveLength(0);
  });

  it('blocks remote images (defanged, SVG or not) by default, and shows them upgraded once allowed', () => {
    const html = `<img src="https://track.test/p.gif"><img dfsrc="http://img.test/a.png">
      <img src="//cdn.test/b.png"><table><tr><td background="https://img.test/bg.png">c</td></tr></table>
      <svg><image href="https://img.test/s.png"></image></svg>`;
    expect(remoteImageCount(html)).toBe(5);

    const blocked = frame(html);
    expect([...blocked.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      null,
      null,
      null,
    ]);
    expect(blocked.querySelector('[background]')).toBeNull();
    expect(blocked.querySelector('image')?.getAttribute('href')).toBeNull();
    expect(mailFramePolicy(false)).toContain('img-src data:;');
    expect(mailFramePolicy(false)).not.toContain('https:');

    const shown = frame(html, { ...NONE, showRemoteImages: true });
    // A plain-HTTP image is fetched over HTTPS (review M1), never in the clear.
    expect([...shown.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://track.test/p.gif',
      'https://img.test/a.png',
      'https://cdn.test/b.png',
    ]);
    expect(shown.querySelector('image')?.getAttribute('href')).toBe('https://img.test/s.png');
    expect(mailFramePolicy(true)).toContain('img-src data: https:');
  });

  it('the policy allows OUR script by hash and nothing else, and blocks every other load', () => {
    for (const show of [false, true]) {
      const policy = mailFramePolicy(show);
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("form-action 'none'");
      expect(policy).toContain(`script-src '${MAIL_FRAME_SCRIPT_HASH}'`);
      expect(policy).not.toMatch(/script-src[^;]*(unsafe|https?:|\*)/);
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

  it('makes every link inert: a web or mail address moves to the data attribute, no href is left', () => {
    const doc = frame(
      `<a href="https://www.emse.fr" target="_top">a</a><a href=" mailto:bde@example.test ">b</a>
       <a href="javascript:alert(1)">c</a><a href="data:text/html,x">d</a><a href="file:///etc">e</a>
       <a href="fr.emse.canari://chat/1">f</a>
       <map name="m"><area href="https://area.test" alt="z"></map>`
    );
    expect(attributeNames(doc)).not.toContain('href');
    expect(attributeNames(doc)).not.toContain('target');
    const links = [...doc.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute(MAIL_LINK_ATTRIBUTE))).toEqual([
      'https://www.emse.fr',
      'mailto:bde@example.test',
      null,
      null,
      null,
      null,
    ]);
    expect(links[0].getAttribute('role')).toBe('link');
    expect(links[0].getAttribute('tabindex')).toBe('0');
    expect(doc.querySelector('area')?.getAttribute(MAIL_LINK_ATTRIBUTE)).toBe('https://area.test');
  });

  it('applies the same rule to SVG links, xlink:href included (review I1)', () => {
    const doc = frame(
      `<svg><a href="data:text/html,<script>x()</script>"><text>d</text></a>
       <a xlink:href="javascript:x()"><text>j</text></a>
       <a href="https://svg.test"><text>ok</text></a>
       <use href="https://evil.test/sprite.svg#x"></use></svg>`
    );
    const names = attributeNames(doc);
    expect(names).not.toContain('href');
    expect(names).not.toContain('xlink:href');
    const kept = [...doc.querySelectorAll(`[${MAIL_LINK_ATTRIBUTE}]`)].map((el) =>
      el.getAttribute(MAIL_LINK_ATTRIBUTE)
    );
    expect(kept).toEqual(['https://svg.test']);
  });

  it('a data: source that is not an image is dropped, its media type parsed (review M3)', () => {
    const doc = frame(
      '<img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:IMAGE/PNG;base64,QUJD">'
    );
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      null,
      'data:IMAGE/PNG;base64,QUJD',
    ]);
  });

  it('turns viewport-height lengths into pixels, in style attributes and style sheets', () => {
    const doc = frame(
      '<style>body{min-height:100vh}</style><div style="height:150vh;width:50vw">x</div>'
    );
    expect(doc.querySelector('div')?.getAttribute('style')).toBe('height:1200px;width:50vw');
    const sheets = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '');
    expect(sheets.join('')).toContain('body{min-height:800px}');
    expect(sheets.join('')).not.toMatch(/\d(dvh|svh|lvh|vh|vmin|vmax)\b/);
  });
});

describe('neutraliseViewportUnits', () => {
  it('turns every height-tied unit into pixels, and leaves widths and other text', () => {
    expect(neutraliseViewportUnits('a:10vh;b:.5dvh;c:2svh;d:3lvh;e:1vmin;f:1vmax;g:10vw')).toBe(
      'a:80px;b:4px;c:16px;d:24px;e:8px;f:8px;g:10vw'
    );
    expect(neutraliseViewportUnits('calc(100vh - 20px)')).toBe('calc(800px - 20px)');
  });
});

describe('isSafeMailLink', () => {
  it('accepts the web and mail addresses only', () => {
    expect(isSafeMailLink('https://a.test')).toBe(true);
    expect(isSafeMailLink(' HTTP://a.test')).toBe(true);
    expect(isSafeMailLink('mailto:x@y.test')).toBe(true);
    for (const href of [
      'javascript:x()',
      'data:text/html,x',
      'fr.emse.canari://x',
      'file:///x',
      '',
    ]) {
      expect(isSafeMailLink(href)).toBe(false);
    }
  });
});

describe('media types and inline parts', () => {
  const part = (over: Partial<AttachmentRef>): AttachmentRef => ({
    messageId: '1',
    part: '2',
    filename: 'a.png',
    contentType: 'image/png',
    size: 10,
    contentId: 'a@b',
    inline: true,
    ...over,
  });

  it('reads a media type without its parameters (review M3)', () => {
    expect(mediaTypeOf('Image/PNG; name="a.png"')).toBe('image/png');
    expect(isImageMediaType('image/jpeg; name=x.jpg')).toBe(true);
    expect(isImageMediaType('text/html')).toBe(false);
    expect(isImageMediaType('image/')).toBe(false);
  });

  it('draws in the body only an inline image with a Content-ID, up to the cap (review M4)', () => {
    expect(isInlineImagePart(part({}))).toBe(true);
    expect(isInlineImagePart(part({ size: INLINE_IMAGE_MAX_BYTES }))).toBe(true);
    expect(isInlineImagePart(part({ size: INLINE_IMAGE_MAX_BYTES + 1 }))).toBe(false);
    expect(isInlineImagePart(part({ contentType: 'application/pdf' }))).toBe(false);
    expect(isInlineImagePart(part({ contentId: null }))).toBe(false);
    expect(isInlineImagePart(part({ inline: false }))).toBe(false);
  });
});

describe('bytesToDataUrl', () => {
  it('writes an image as base64 under its bare media type, and never labels anything else one', () => {
    const bytes = new TextEncoder().encode('ABC');
    expect(bytesToDataUrl(bytes, 'image/png')).toBe('data:image/png;base64,QUJD');
    expect(bytesToDataUrl(bytes, 'Image/PNG; name="a.png"')).toBe('data:image/png;base64,QUJD');
    expect(bytesToDataUrl(bytes, 'text/html')).toBe('data:application/octet-stream;base64,QUJD');
  });
});
