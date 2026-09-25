import { describe, it, expect } from 'vitest';
import {
  filesFromTransfer,
  carriesUninsertableMarkup,
  localFileAddressesFromTransfer,
} from './composerTransfer';

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

/** A drop carrying only strings, keyed by type - what a file manager hands a refusing engine. */
function stringDrop(data: Record<string, string>): DataTransfer {
  return {
    files: [],
    items: [],
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer;
}

describe('localFileAddressesFromTransfer', () => {
  it('recognises what Nemo hands Firefox: a file URI and a path, no file', () => {
    const dt = stringDrop({
      'text/uri-list': 'file:///home/leon/Documents/affiche.pdf\r\n',
      'text/plain': '/home/leon/Documents/affiche.pdf',
    });
    expect(filesFromTransfer(dt)).toEqual([]);
    expect(localFileAddressesFromTransfer(dt)).toEqual(['file:///home/leon/Documents/affiche.pdf']);
  });

  it('recognises an absolute path alone, one per dragged file', () => {
    const dt = stringDrop({ 'text/plain': '/tmp/a.png\n/tmp/b.png' });
    expect(localFileAddressesFromTransfer(dt)).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });

  it('skips the comment lines a URI list may carry', () => {
    const dt = stringDrop({ 'text/uri-list': '# from nemo\nfile:///tmp/a.png' });
    expect(localFileAddressesFromTransfer(dt)).toEqual(['file:///tmp/a.png']);
  });

  it('leaves ordinary text and web links alone - those ARE text to insert', () => {
    expect(localFileAddressesFromTransfer(stringDrop({ 'text/plain': 'bonjour' }))).toEqual([]);
    expect(
      localFileAddressesFromTransfer(
        stringDrop({
          'text/uri-list': 'https://canari-emse.fr',
          'text/plain': 'https://canari-emse.fr',
        })
      )
    ).toEqual([]);
  });
});
