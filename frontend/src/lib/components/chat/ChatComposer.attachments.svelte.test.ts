/**
 * AN ATTACHMENT'S NAME IS WRITTEN ONCE, AND A RECORDING IS NOT WRITTEN AT ALL.
 *
 * Two things measured on the Mi 9T on 2026-09-09, both in the composer's pending-attachment strip.
 *
 * THE NAME WAS PAINTED TWICE. The caption strip under a tile always writes the filename; the
 * icon-and-name placeholder, used whenever there is no usable preview, wrote it again inside the
 * tile. Two boxes 62px wide and 19px apart, overlapping by 7px, one wrapping to two lines and the
 * other hiding 70 characters behind an ellipsis - the same string abbreviated two different ways in
 * one 62px column.
 *
 * A RECORDING WAS A DOCUMENT GLYPH. A voice note arrived as an 80px square captioned
 * `vocal_1788949514272.m4a`, so the reader could neither see how long it was nor hear it before
 * sending. It now renders through `VoiceMessagePlayer`, the same component the sent message uses.
 *
 * THE PREDICATE IS THE MIME TYPE AND THE TEST PINS THAT. A `File` named `vocal_*` with an image
 * type must NOT get the player, and an audio file with any other name must. The recorder happens to
 * write `vocal_<timestamp>`; a component keying on that string would be reading prose, and would
 * miss an audio file the reader picked from disk.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

/**
 * happy-dom has no object URLs, and the audio branch is gated on one existing.
 *
 * Stubbed per mount rather than globally: the composer revokes what it creates, and a shared
 * counter would let one test's teardown revoke a URL the next one is still rendering.
 */
function withObjectUrls(): void {
  let n = 0;
  URL.createObjectURL = () => `blob:probe/${(n += 1)}`;
  URL.revokeObjectURL = () => {};
}

function file(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function mountWith(files: File[]): void {
  withObjectUrls();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, {
    target,
    props: {
      messageText: '',
      onMessageChange: () => {},
      onSend: () => {},
      pendingFiles: files.map((f) => ({ file: f })),
      onRemovePendingFile: () => {},
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
}

/** Every element whose whole text is exactly this filename - the count IS the defect. */
function timesNamed(name: string): number {
  return [...document.querySelectorAll('*')].filter(
    (e) => e.children.length === 0 && (e.textContent ?? '').trim() === name
  ).length;
}

function hasPlayer(): boolean {
  return !!document.querySelector('audio');
}

describe('the composer names an attachment once', () => {
  it('writes a plain file name exactly once, where it used to write it twice', () => {
    mountWith([file('rapport-de-stage.docx', 'application/msword')]);

    // One, not two: this is the assertion the previous build fails.
    expect(timesNamed('rapport-de-stage.docx')).toBe(1);
  });

  it('still names a file that has no preview at all', () => {
    mountWith([file('archive.zip', 'application/zip')]);

    expect(timesNamed('archive.zip')).toBe(1);
  });
});

describe('the composer plays a recording rather than naming it', () => {
  it('gives an audio attachment the player and no filename', () => {
    mountWith([file('vocal_1788949514272.m4a', 'audio/mp4')]);

    expect(hasPlayer()).toBe(true);
    // The name is a generated timestamp; showing it tells the reader nothing they can act on.
    expect(timesNamed('vocal_1788949514272.m4a')).toBe(0);
  });

  it('keys on the MIME type, so an audio file the reader picked gets the player too', () => {
    mountWith([file('interview-final.mp3', 'audio/mpeg')]);

    expect(hasPlayer()).toBe(true);
  });

  it('does NOT key on the name, so a `vocal_*` image stays an image', () => {
    // The inverse of the case above, and the one that catches a filename predicate.
    mountWith([file('vocal_1788949514272.png', 'image/png')]);

    expect(hasPlayer()).toBe(false);
  });

  it('keeps the remove control on a recording, which is the only way to take it back', () => {
    mountWith([file('vocal_1788949514272.m4a', 'audio/mp4')]);

    const remove = [...document.querySelectorAll('button')].filter((b) =>
      /retirer|remove/i.test(b.getAttribute('aria-label') ?? '')
    );

    expect(remove.length).toBeGreaterThan(0);
  });
});
