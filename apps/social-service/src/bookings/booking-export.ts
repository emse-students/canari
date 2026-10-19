import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { answerText, type AnswerQuestion, type AnswerWords } from '../forms/answer-text';
import { localDate, localTime } from './zoned-time';
import { splitAnswerFiles, type BookingFileState } from './booking-views';

/**
 * THE XLSX EXPORT OF A SPACE'S BOOKINGS (D24, WP-B6) - the forms' export, for a booking.
 *
 * THE WORDS ARE THE CLIENT'S. This service has no Paraglide and no language it could trust, so every
 * header and every word written into a cell comes in the request, as forms' `ExportLabels` does
 * (`forms/export-labels.ts`); a missing one is refused, never replaced by English.
 *
 * One row per booking, by start: the local date and times IN THE SPACE'S ZONE (D25), the resource,
 * the holder and the participants still in (the names as snapshotted, D15), whether it was
 * cancelled, then one column per question. A FILE question's cell is a word, never the file (D24);
 * an answer the retention purge took (D18) is an empty cell - "answers already purged are gone".
 */

/** The words of the export, by role. Every key is required. */
export interface BookingExportLabels {
  date: string;
  start: string;
  end: string;
  resource: string;
  holder: string;
  participants: string;
  status: string;
  /** What the status cell of a cancelled booking reads. */
  cancelled: string;
  /** What a file answer reads, kept and purged. */
  file: string;
  fileDeleted: string;
}

const KEYS = [
  'date',
  'start',
  'end',
  'resource',
  'holder',
  'participants',
  'status',
  'cancelled',
  'file',
  'fileDeleted',
] as const satisfies readonly (keyof BookingExportLabels)[];

/**
 * Reads the `labels` query parameter, or refuses `export-labels`. THERE IS NO DEFAULT: a missing
 * word is a client that has not been updated, and the only substitute this side has is English.
 */
export function parseBookingExportLabels(raw: string | undefined): BookingExportLabels {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    throw new BadRequestException({ code: 'export-labels' });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException({ code: 'export-labels' });
  }
  const labels = parsed as Record<string, unknown>;
  const out = {} as BookingExportLabels;
  for (const key of KEYS) {
    const value = labels[key];
    if (typeof value !== 'string' || value === '' || value.length > 200) {
      throw new BadRequestException({ code: 'export-labels', key });
    }
    out[key] = value;
  }
  return out;
}

/** One booking as the export reads it. */
export interface ExportBooking {
  id: string;
  resourceName: string;
  holderName: string;
  participantNames: string[];
  startsAt: Date;
  endsAt: Date;
  cancelled: boolean;
  answers: Record<string, unknown> | null;
}

/** One cell's text per column, in order - the workbook below writes exactly these. */
export function exportRows(
  bookings: readonly ExportBooking[],
  items: ReadonlyArray<AnswerQuestion & { id: string }>,
  timeZone: string,
  labels: BookingExportLabels,
  files: ReadonlyMap<string, BookingFileState>
): string[][] {
  return bookings.map((b) => {
    const startMs = b.startsAt.getTime();
    const endMs = b.endsAt.getTime();
    const day = localDate(startMs, timeZone);
    const endDay = localDate(endMs, timeZone);
    // An end on the next local day (a night) names its date: `24:00` would hide the day it falls on.
    const end =
      endDay === day ? localTime(endMs, timeZone) : `${endDay} ${localTime(endMs, timeZone)}`;
    const words: AnswerWords = {
      file: labels.file,
      fileDeleted: labels.fileDeleted,
      deletedFiles: new Set(splitAnswerFiles(b.id, b.answers, items, files).deleted),
    };
    return [
      day,
      localTime(startMs, timeZone),
      end,
      b.resourceName,
      b.holderName,
      b.participantNames.join(', '),
      b.cancelled ? labels.cancelled : '',
      ...items.map((item) => answerText(b.answers?.[item.id], item, words)),
    ];
  });
}

/** The workbook of {@link exportRows}, with the headers of `labels` and each question's label. */
export async function bookingsWorkbook(
  sheetName: string,
  bookings: readonly ExportBooking[],
  items: ReadonlyArray<AnswerQuestion & { id: string; label?: string }>,
  timeZone: string,
  labels: BookingExportLabels,
  files: ReadonlyMap<string, BookingFileState>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  // Excel's sheet names are at most 31 characters and refuse `\ / ? * [ ] :`.
  const sheet = workbook.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || '-');
  sheet.columns = [
    { header: labels.date, width: 12 },
    { header: labels.start, width: 8 },
    { header: labels.end, width: 16 },
    { header: labels.resource, width: 24 },
    { header: labels.holder, width: 24 },
    { header: labels.participants, width: 32 },
    { header: labels.status, width: 12 },
    ...items.map((item) => ({ header: item.label ?? item.id, width: 30 })),
  ];
  for (const row of exportRows(bookings, items, timeZone, labels, files)) sheet.addRow(row);
  return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
}
