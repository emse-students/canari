// @vitest-environment happy-dom
/**
 * AN HTML MAIL'S FRAME IS DRAWN ONCE ITS DOCUMENT IS FINAL (D9): the frame waits for the message's
 * own inline parts, so the first document it shows already carries them - a `srcdoc` changed while
 * the first one loads was seen to keep the first on screen - and a new document (images allowed) is
 * a new frame, never an in-place navigation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { AttachmentRef } from '$lib/mail/mailTypes';
import MailHtmlFrame from './MailHtmlFrame.svelte';

type FrameProps = ComponentProps<typeof MailHtmlFrame>;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

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
});
