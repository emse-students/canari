// @vitest-environment happy-dom
/**
 * AN HTML MAIL'S FRAME IS DRAWN ONCE ITS DOCUMENT IS FINAL (D9): the frame waits for the message's
 * own inline parts, so the first document it shows already carries them - a `srcdoc` changed while
 * the first one loads was seen to keep the first on screen - and a new document (images allowed) is
 * a new frame, never an in-place navigation. The frame is an opaque origin running only our script,
 * and the parent acts on a message only from THAT frame, in a shape it knows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { MAIL_FRAME_MAX_HEIGHT_PX } from '$lib/mail/mailFrameMessages';
import type { AttachmentRef } from '$lib/mail/mailTypes';
import MailHtmlFrame from './MailHtmlFrame.svelte';

const openExternal = vi.hoisted(() =>
  vi.fn(async (_url: string, _options?: { siteHandoff?: boolean }) => {})
);
vi.mock('$lib/utils/openExternal', () => ({ openExternal }));

type FrameProps = ComponentProps<typeof MailHtmlFrame>;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  openExternal.mockClear();
});

/** Posts `data` to the app's window as if it came from `source`. */
function post(data: unknown, source: MessageEventSource | null) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
  flushSync();
}

const LOGO: AttachmentRef = {
  messageId: '801',
  part: '2',
  filename: 'logo.png',
  contentType: 'image/png',
  size: 3,
  contentId: 'logo@example.test',
  inline: true,
};

function render(props: Partial<FrameProps>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MailHtmlFrame, {
    target,
    props: {
      html: '<p>Bonjour</p>',
      attachments: [],
      api: { download: vi.fn() },
      title: 'Sujet',
      onMailto: vi.fn(),
      ...props,
    } as FrameProps,
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

/** Lets the frame's download promises settle and the component redraw. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
  flushSync();
}

describe('MailHtmlFrame', () => {
  it('a mail without inline parts is drawn at once', () => {
    const root = render({});
    expect(root.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Bonjour');
    expect(root.querySelector('[data-mail-frame-pending]')).toBeNull();
  });

  it('waits for the inline parts, then draws ONE frame that already carries them', async () => {
    let release!: (bytes: Uint8Array) => void;
    const download = vi.fn(() => new Promise<Uint8Array>((resolve) => (release = resolve)));
    const root = render({
      html: '<img src="cid:logo@example.test" alt="logo">',
      attachments: [LOGO],
      api: { download },
    });
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('[data-mail-frame-pending]')).not.toBeNull();

    release(new Uint8Array([1, 2, 3]));
    await settle();
    const frames = root.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute('srcdoc')).toContain('src="data:image/png;base64,AQID"');
    expect(download).toHaveBeenCalledOnce();
  });

  it('a part that fails to load still lets the frame be drawn, the image left empty', async () => {
    const root = render({
      html: '<img src="cid:logo@example.test" alt="logo">',
      attachments: [LOGO],
      api: { download: vi.fn(() => Promise.reject(new Error('gone'))) },
    });
    await settle();
    const srcdoc = root.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('alt="logo"');
    expect(srcdoc).not.toContain('cid:');
  });

  it('allowing remote images replaces the frame rather than navigating it', async () => {
    const root = render({ html: '<img src="https://tracker.example.test/p.gif" alt="pixel">' });
    const before = root.querySelector('iframe');
    expect(before?.getAttribute('srcdoc')).not.toContain('tracker.example.test');

    const show = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.mail_images_show()
    );
    show!.click();
    await settle();
    const after = root.querySelector('iframe');
    expect(after).not.toBe(before);
    expect(after?.getAttribute('srcdoc')).toContain('https://tracker.example.test/p.gif');
  });

  it('is an opaque origin running scripts only: no same-origin, popup, form or navigation', () => {
    const tokens = render({}).querySelector('iframe')?.getAttribute('sandbox')?.split(/\s+/);
    expect(tokens).toEqual(['allow-scripts']);
  });

  it("takes its height from ITS frame's messages, capped, and ignores any other window", () => {
    const root = render({});
    const iframe = root.querySelector('iframe')!;
    const own = iframe.contentWindow;
    expect(own).not.toBeNull();

    post({ type: 'mail-frame-height', h: 640 }, own);
    expect(iframe.style.height).toBe('640px');

    post({ type: 'mail-frame-height', h: 9999 }, window); // another window: ignored
    post({ type: 'mail-frame-height', h: 9999 }, null);
    expect(iframe.style.height).toBe('640px');

    post({ type: 'mail-frame-height', h: MAIL_FRAME_MAX_HEIGHT_PX * 10 }, own);
    expect(iframe.style.height).toBe(`${MAIL_FRAME_MAX_HEIGHT_PX}px`);
  });

  it('routes a pressed link through the app link path WITHOUT the sibling-site handoff (I-2)', async () => {
    const root = render({ html: '<a href="https://example.test/a">a</a>' });
    const own = root.querySelector('iframe')!.contentWindow;

    post({ type: 'mail-frame-link', href: 'https://example.test/a' }, own);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/a', {
      siteHandoff: false,
    });
    await settle();

    post({ type: 'mail-frame-link', href: 'javascript:alert(1)' }, own);
    post({ type: 'mail-frame-link', href: 'https://example.test/b' }, window);
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('opens the same address once while it is still opening - one gesture (M-1)', async () => {
    let finish!: () => void;
    openExternal.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const root = render({});
    const own = root.querySelector('iframe')!.contentWindow;
    const link = { type: 'mail-frame-link', href: 'https://example.test/a' };

    post(link, own);
    post(link, own);
    expect(openExternal).toHaveBeenCalledOnce();

    finish();
    await settle();
    post(link, own);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it("opens Canari's composer for a mailto link, never the browser (M-6)", () => {
    const onMailto = vi.fn();
    const root = render({ onMailto });
    const own = root.querySelector('iframe')!.contentWindow;

    post({ type: 'mail-frame-link', href: 'mailto:bde@example.test?subject=Gala' }, own);
    expect(openExternal).not.toHaveBeenCalled();
    expect(onMailto).toHaveBeenCalledOnce();
    expect(onMailto.mock.calls[0][0]).toMatchObject({
      to: [{ address: 'bde@example.test', name: null }],
      subject: 'Gala',
    });
  });
});
