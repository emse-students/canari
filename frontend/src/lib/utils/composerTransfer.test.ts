import { describe, it, expect } from 'vitest';
import { filesFromTransfer, carriesUninsertableMarkup } from './composerTransfer';

/**
 * A `DataTransfer` stub shaped like the real thing rather than like the code under test: `files`
 * and `items` are independent, because that is exactly the disagreement this module exists for.
 */
function transfer(opts: {
  files?: File[];
  items?: { kind: string; file?: File }[];
  types?: string[];
}): DataTransfer {
  return {
    files: opts.files ?? [],
    items: (opts.items ?? []).map((item) => ({
      kind: item.kind,
      getAsFile: () => item.file ?? null,
    })),
    types: opts.types ?? [],
  } as unknown as DataTransfer;
}

const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
const pdf = new File([new Uint8Array([2])], 'notes.pdf', { type: 'application/pdf' });

describe('filesFromTransfer', () => {
  it('reads a drop, which fills `files`', () => {
    expect(filesFromTransfer(transfer({ files: [png, pdf] }))).toEqual([png, pdf]);
  });

  it('reads a pasted screenshot, which fills `items` and leaves `files` empty', () => {
    const dt = transfer({ files: [], items: [{ kind: 'file', file: png }] });
    expect(filesFromTransfer(dt)).toEqual([png]);
  });

  it('ignores the string entries a rich drag carries beside its file', () => {
    const dt = transfer({
      items: [{ kind: 'string' }, { kind: 'file', file: pdf }, { kind: 'string' }],
    });
    expect(filesFromTransfer(dt)).toEqual([pdf]);
  });

  it('drops a `kind: file` entry whose `getAsFile` returns null rather than passing null on', () => {
    expect(filesFromTransfer(transfer({ items: [{ kind: 'file' }] }))).toEqual([]);
  });

  it('prefers `files` when both are populated, so one file is never attached twice', () => {
    const dt = transfer({ files: [png], items: [{ kind: 'file', file: png }] });
    expect(filesFromTransfer(dt)).toHaveLength(1);
  });

  it('answers empty for a transfer that is not there at all', () => {
    expect(filesFromTransfer(null)).toEqual([]);
    expect(filesFromTransfer(undefined)).toEqual([]);
  });
});

describe('carriesUninsertableMarkup', () => {
  // THE 2026-09-18 REPORT, IN ITS OWN SHAPE: dragging a picture out of a Messenger tab carries no
  // file at all - only markup naming a blob on an origin this page may not read.
  it('recognises a drag that carries markup and no file', () => {
    const dt = transfer({ types: ['text/html', 'text/plain'] });
    expect(filesFromTransfer(dt)).toEqual([]);
    expect(carriesUninsertableMarkup(dt)).toBe(true);
  });

  it('recognises a dragged link', () => {
    expect(carriesUninsertableMarkup(transfer({ types: ['text/uri-list'] }))).toBe(true);
  });

  it('does not accuse a plain text drag', () => {
    expect(carriesUninsertableMarkup(transfer({ types: ['text/plain'] }))).toBe(false);
  });

  it('does not accuse a file drop', () => {
    expect(carriesUninsertableMarkup(transfer({ files: [png], types: ['Files'] }))).toBe(false);
  });
});
