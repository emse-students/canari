import * as ExcelJS from 'exceljs';
import { safeWorksheetName } from './worksheet-name';

describe('safeWorksheetName', () => {
  it('turns every character Excel refuses into a dash', () => {
    expect(safeWorksheetName("Service STO'Mines 19/11")).toBe("Service STO'Mines 19-11");
    expect(safeWorksheetName('a*b?c:d\\e/f[g]h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('keeps at most 31 characters, trimmed after the cut', () => {
    expect(safeWorksheetName('x'.repeat(40))).toHaveLength(31);
    expect(safeWorksheetName(`${'x'.repeat(29)} 'tail`)).toBe('x'.repeat(29));
  });

  it('drops a single quote at either end', () => {
    expect(safeWorksheetName("'quoted'")).toBe('quoted');
  });

  it('falls back when nothing acceptable is left, or on the reserved name', () => {
    expect(safeWorksheetName('')).toBe('-');
    expect(safeWorksheetName("  ''  ", 'Réponses')).toBe('Réponses');
    expect(safeWorksheetName('History')).toBe('-');
  });

  it('is accepted by ExcelJS for the titles that used to throw', () => {
    for (const title of ["Service STO'Mines 19/11", "'x'", '[a]:b?', 'History', '']) {
      const workbook = new ExcelJS.Workbook();
      expect(() => workbook.addWorksheet(safeWorksheetName(title))).not.toThrow();
    }
  });
});
