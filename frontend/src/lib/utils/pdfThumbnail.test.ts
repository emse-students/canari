import { isPdfAttachment, PDF_MIME_TYPE } from './pdfThumbnail';

describe('isPdfAttachment', () => {
  it('trusts an explicit PDF mime type', () => {
    expect(isPdfAttachment(PDF_MIME_TYPE)).toBe(true);
    expect(isPdfAttachment('APPLICATION/PDF')).toBe(true);
    // Some servers append a charset; the prefix is what identifies the type.
    expect(isPdfAttachment('application/pdf; charset=binary')).toBe(true);
  });

  it('rejects other types even when the name looks like a PDF', () => {
    expect(isPdfAttachment('image/png', 'not-really.pdf')).toBe(false);
    expect(isPdfAttachment('text/plain')).toBe(false);
  });

  it('falls back to the extension only when the mime type says nothing', () => {
    // Some mobile pickers upload everything as octet-stream.
    expect(isPdfAttachment('application/octet-stream', 'Rev03.PDF')).toBe(true);
    expect(isPdfAttachment(undefined, 'notes.pdf')).toBe(true);
    expect(isPdfAttachment('application/octet-stream', 'archive.zip')).toBe(false);
    expect(isPdfAttachment('application/octet-stream')).toBe(false);
  });

  it('is false when nothing is known', () => {
    expect(isPdfAttachment()).toBe(false);
  });
});
