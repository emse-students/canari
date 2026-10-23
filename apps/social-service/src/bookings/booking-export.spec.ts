/**
 * THE EXPORT NEVER WRITES A FORMULA (review of #2045). Every cell of the workbook is text a booker,
 * an organiser or the client chose - a name, an answer, a question's label, a word of the labels - so
 * a text starting with `=`, `+`, `-` or `@` must land as a STRING cell, never as a formula Excel would
 * evaluate when the organiser opens the file.
 */
import * as ExcelJS from 'exceljs';
import { bookingsWorkbook, type BookingExportLabels, type ExportBooking } from './booking-export';

const HOSTILE = ['=HYPERLINK("http://example.invalid","x")', '+1+1', '-2+3', '@SUM(A1:A2)', '=1+1'];

const LABELS: BookingExportLabels = {
  date: HOSTILE[0],
  start: 'Start',
  end: 'End',
  resource: 'Resource',
  holder: 'Holder',
  participants: 'Participants',
  status: 'Status',
  cancelled: HOSTILE[1],
  file: 'File',
  fileDeleted: 'File deleted',
};

const BOOKING: ExportBooking = {
  id: 'b1',
  resourceName: HOSTILE[2],
  holderName: HOSTILE[3],
  participantNames: [HOSTILE[4]],
  startsAt: new Date('2026-11-02T09:00:00Z'),
  endsAt: new Date('2026-11-02T09:30:00Z'),
  cancelled: true,
  answers: { q: HOSTILE[0] },
};

describe('bookingsWorkbook - formula injection', () => {
  it('writes every text starting with = + - @ as a string cell, no formula anywhere', async () => {
    const buffer = await bookingsWorkbook(
      'Space',
      [BOOKING],
      [{ id: 'q', type: 'text', label: HOSTILE[3] }],
      'Europe/Paris',
      LABELS,
      new Map()
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];

    const cells: Array<{ type: ExcelJS.ValueType; formula: unknown; value: unknown }> = [];
    sheet.eachRow((row) => {
      row.eachCell((cell) =>
        cells.push({ type: cell.type, formula: cell.formula, value: cell.value })
      );
    });
    expect(cells.filter((c) => c.type === ExcelJS.ValueType.Formula || c.formula)).toEqual([]);
    // The header's label, the question's label, the resource, the holder, a participant, the
    // cancelled word and the answer: each hostile text came back verbatim, as a STRING cell.
    const hostile = cells.filter((c) => typeof c.value === 'string' && HOSTILE.includes(c.value));
    expect(hostile.every((c) => c.type === ExcelJS.ValueType.String)).toBe(true);
    expect(hostile.map((c) => c.value as string).sort()).toEqual(
      [HOSTILE[0], HOSTILE[3], HOSTILE[2], HOSTILE[3], HOSTILE[4], HOSTILE[1], HOSTILE[0]].sort()
    );
  });
});
